//! tear for Bane access control and idempotency (see `model.rs` for the edge-case checklist).
//!
//! From `api/`, with `DATABASE_URL` pointing at an isolated, migrated, loopback PostgreSQL:
//!
//!   cargo run --release --manifest-path tear/Cargo.toml -- ci [--seed S] [-j 4] [--budget 45]  # < 60 s
//!   cargo run --release --manifest-path tear/Cargo.toml -- random 2000 30 [--seed S] [-j 8]
//!   cargo run --release --manifest-path tear/Cargo.toml -- edges 3 [MAX_STATES] [-j 8]
//!   cargo run --release --manifest-path tear/Cargo.toml -- trace "mint key" "create list key k1 b1" ...
//!
//! `random` runs seeded random walks over the full alphabet; `edges` maps the model's state graph
//! (core alphabet) with tear's BFS and runs the shortest path to every edge. Each distinct
//! mismatch is reduced with tear's `minimizeTrace`. `--budget SECS` stops starting new traces.
//! Workers (`-j`) each own a Bun host process; traces are independent fixtures (workspaces).
mod model;

use model::{Alphabet, CHECKLIST, Model};
use serde_json::{Value, json};
use statecheck::{Error, Host, R, conformance, search};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, BufWriter, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const PROPERTY: &str = "bane.access.idempotency-and-revocation";

/// The shortest witness of every bug this model found, replayed by `ci` as regressions, then a
/// few traces for checklist items the CI-sized graphs do not reach.
const WITNESSES: &[&[&str]] = &[
    // A lost commit acknowledgement let the retry create twice (c8fee43).
    &["mint key", "lost list key k1 b1", "create list key k1 b1"],
    &["mint grant", "lost list grant k1 b1", "create list grant k1 b1"],
    // A provisioning inbox key's retry of its own create was a conflict (177ce7c).
    &["mint key", "mint ikey", "create inbox ikey k1", "create inbox ikey k1"],
    // A duplicate whose lookup followed the holder's release got a non-retryable conflict (8f9ecc7).
    &["mint key", "A begin list key k1 b1", "A step", "B begin list key k1 bad", "B step", "B step", "A step", "B step", "A step"],
    // A grant-derived key create racing the revoke answered 500 (d956bc8).
    &["mint grant", "A begin apikey grant k1 fixed", "A step", "A step", "revoke grant", "A step", "A step"],
    // Listings offered what REST refuses (54d74e1).
    &["mint grant2", "probe grant2 code", "probe grant2 plain"],
    &["promote member", "mint grant2", "probe grant2 code"],
    &["mint grant", "probe grant code", "probe grant plain"],
    // A read-only grant was not offered (or allowed) REST's read-level operations (review of #51).
    &["mint grant3", "probe grant3 code", "probe grant3 plain", "probe grant3 delegate", "probe grant3 query"],
    // Checklist items the bounded graphs do not reach: C1 (8 steps), R6, R7, I7.
    &["mint key", "A begin list key k1 b1", "A step", "A step", "B begin list key k1 b1", "B step", "B step", "B step"],
    &["mint key", "mint box", "delete box", "probe bkey rest", "probe bkey mcp"],
    &["mint key", "mint ikey", "revoke key", "probe ikey rest", "probe ikey mcp"],
    &["mint grant", "create list grant k1 b1", "receiving grant", "create list grant k1 b1"],
];

fn model(v: &Value) -> R<Model> {
    serde_json::from_value(v.clone()).map_err(|e| Error::new(e.to_string()))
}

/// One long-lived Bun host; each fixture is a fresh workspace in the same process.
struct HostProc {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    id: u64,
}
impl HostProc {
    fn spawn() -> R<Self> {
        // The host silences API logs unless TEAR_HOST_LOG=1, so its stderr carries only real
        // failures (such as refusing a database that is not marked disposable).
        let mut child = Command::new(std::env::var("BUN").unwrap_or_else(|_| "bun".into()))
            .arg("tear/host.ts")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| Error::new(format!("spawn bun tear/host.ts (run from api/): {e}")))?;
        let stdin = BufWriter::new(child.stdin.take().unwrap());
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Ok(Self { child, stdin, stdout, id: 0 })
    }
    fn call(&mut self, op: &str, action: Option<&str>) -> R<Value> {
        self.id += 1;
        let mut msg = json!({"v": 1, "id": self.id, "op": op});
        if let Some(a) = action {
            msg["action"] = json!(a);
        }
        let e = |e: std::io::Error| Error::new(format!("host {op}: {e}"));
        writeln!(self.stdin, "{msg}").map_err(e)?;
        self.stdin.flush().map_err(e)?;
        let mut line = String::new();
        if self.stdout.read_line(&mut line).map_err(e)? == 0 {
            return Err(Error::new(format!("host {op}: exited")));
        }
        let reply: Value = serde_json::from_str(&line).map_err(|err| Error::new(format!("host {op}: {err}: {line}")))?;
        if reply["id"] != json!(self.id) {
            return Err(Error::new(format!("host {op}: reply id mismatch")));
        }
        match reply["ok"].as_bool() {
            Some(true) => Ok(reply["value"].clone()),
            _ => Err(Error::new(format!("host {op} {}: {}", action.unwrap_or_default(), reply["error"].as_str().unwrap_or("failed")))),
        }
    }
}
impl Drop for HostProc {
    fn drop(&mut self) {
        let _ = self.call("exit", None);
        let _ = self.child.wait();
    }
}

/// Conformance host: the model predicts each step, the Bun host runs it on the real API.
struct Check {
    host: Option<HostProc>,
}
impl Check {
    fn new() -> Self {
        Self { host: None }
    }
    /// A host that died (or broke the protocol) is replaced at the next fixture.
    fn host(&mut self, op: &str, action: Option<&str>) -> R<Value> {
        if self.host.is_none() {
            if op != "open" {
                return Err(Error::new(format!("host {op}: no live host")));
            }
            self.host = Some(HostProc::spawn()?);
        }
        let result = self.host.as_mut().unwrap().call(op, action);
        if result.as_ref().is_err_and(|e| e.message.contains("exited") || e.message.contains("Broken pipe") || e.message.contains("reply id")) {
            self.host = None;
        }
        result
    }
}
impl Host for Check {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        Ok(match name {
            "id" => json!(PROPERTY),
            "initial" => json!(Model::initial()),
            "enabled" => json!(model(&args[0])?.enabled(args[1].as_str().unwrap_or_default())),
            "step" => {
                let mut m = model(&args[0])?;
                let expected = m.step(args[1].as_str().unwrap_or_default());
                json!({"expected": expected, "state": m})
            }
            "open" => {
                self.host("open", None)?;
                Value::Null
            }
            "act" => self.host("act", args[1].as_str())?,
            "close" => self.host("close", None)?,
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

/// Model-only host for tear's breadth-first state mapping over one alphabet.
struct Space(Alphabet);
impl Host for Space {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        let mut m = model(&args[0])?;
        Ok(match name {
            "actions" => json!(m.actions(self.0)),
            "step" => {
                m.step(args[1].as_str().unwrap_or_default());
                json!(m)
            }
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9e3779b97f4a7c15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

/// A seeded walk. Setup actions (mints) are weighted up, and an active request slot is stepped
/// half the time, so walks reach deep states and real interleavings.
fn walk(seed: u64, len: usize) -> Vec<String> {
    let mut x = seed;
    let mut m = Model::initial();
    let mut out = vec![];
    for _ in 0..len {
        let actions = m.actions(Alphabet::Full);
        let pick_from = |x: &mut u64, pool: &[&String]| pool[(splitmix(x) % pool.len() as u64) as usize].clone();
        let mints: Vec<&String> = actions.iter().filter(|a| a.starts_with("mint ")).collect();
        let slots: Vec<&String> = actions.iter().filter(|a| a.starts_with("A ") || a.starts_with("B ")).collect();
        let creates: Vec<&String> = actions.iter().filter(|a| a.starts_with("create ") || a.starts_with("lost ")).collect();
        let roll = splitmix(&mut x) % 10;
        let pick = if !mints.is_empty() && roll < 2 {
            pick_from(&mut x, &mints)
        } else if !slots.is_empty() && roll < 6 {
            pick_from(&mut x, &slots)
        } else if !creates.is_empty() && roll < 8 {
            pick_from(&mut x, &creates)
        } else {
            pick_from(&mut x, &actions.iter().collect::<Vec<_>>())
        };
        m.step(&pick);
        out.push(pick);
    }
    out
}

/// Group key: the action verb and the mismatch path.
fn signature(run: &Value) -> String {
    let index = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
    let action = run["steps"][index]["action"].as_str().unwrap_or_default();
    let w: Vec<&str> = action.split(' ').collect();
    let verb = match w[0] {
        "A" | "B" => format!("slot {} {}", w[1], w.get(2).copied().unwrap_or_default()),
        "probe" => format!("probe {} {}", w[1], w[2]),
        _ => w.iter().take(3).copied().collect::<Vec<_>>().join(" "),
    };
    format!("{verb}: {}", run["mismatch"]["path"].as_str().unwrap_or_default())
}

fn focus(step: &Value, path: &str) -> Value {
    let key = path.split('/').nth(1).unwrap_or_default();
    if key.is_empty() {
        return json!({"expected": step["expected"], "observed": step["observed"]});
    }
    json!({"expected": step["expected"][key], "observed": step["observed"][key], "expectedStep": step["expected"], "observedStep": step["observed"]})
}

/// Checklist coverage: replay the model over each executed (matching) prefix.
fn cover(run: &Value, coverage: &mut BTreeMap<&'static str, u64>) {
    let mut m = Model::initial();
    let last = run["mismatch"]["index"].as_u64().map(|i| i as usize);
    for (i, step) in run["steps"].as_array().into_iter().flatten().enumerate() {
        if last.is_some_and(|l| i >= l) {
            break;
        }
        let action = step["action"].as_str().unwrap_or_default();
        for tag in m.tags(action, &step["observed"]) {
            *coverage.entry(tag).or_default() += 1;
        }
        m.step(action);
    }
}

struct Outcome {
    matched: u64,
    steps: u64,
    errors: Vec<Value>,
    groups: BTreeMap<String, (u64, Vec<String>)>,
    coverage: BTreeMap<&'static str, u64>,
    traces: u64,
}

/// Run traces on `jobs` workers. The first `required` traces always run; the budget only stops
/// starting the rest.
fn run_parallel(traces: Vec<Vec<String>>, jobs: usize, budget: Option<Duration>, required: usize) -> R<Outcome> {
    let start = Instant::now();
    let queue = Arc::new(Mutex::new(traces.into_iter().enumerate().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>()));
    let results = Arc::new(Mutex::new(Outcome { matched: 0, steps: 0, errors: vec![], groups: BTreeMap::new(), coverage: BTreeMap::new(), traces: 0 }));
    let mut handles = vec![];
    for _ in 0..jobs.max(1) {
        let queue = queue.clone();
        let results = results.clone();
        handles.push(thread::spawn(move || -> R<()> {
            let mut check = Check::new();
            loop {
                let Some((index, trace)) = queue.lock().unwrap().pop() else { return Ok(()) };
                if index >= required && budget.is_some_and(|b| start.elapsed() >= b) {
                    return Ok(());
                }
                let run = conformance::dispatch("runTrace", &json!({"actions": trace}), &mut check)?;
                let mut r = results.lock().unwrap();
                r.traces += 1;
                r.steps += run["steps"].as_array().map_or(0, |s| s.len() as u64);
                cover(&run, &mut r.coverage);
                match run["status"].as_str() {
                    Some("match") => r.matched += 1,
                    Some("mismatch") => r.groups.entry(signature(&run)).or_insert((0, trace)).0 += 1,
                    _ => {
                        if r.errors.len() < 5 {
                            r.errors.push(json!({"trace": trace, "run": run}));
                        }
                    }
                }
            }
        }));
    }
    for h in handles {
        h.join().map_err(|_| Error::new("worker panicked"))??;
    }
    Ok(Arc::try_unwrap(results).ok().unwrap().into_inner().unwrap())
}

fn report(name: &str, o: Outcome, start: Instant, reduce: bool) -> R<Value> {
    let checked = start.elapsed();
    let mut witnesses = vec![];
    if reduce && !o.groups.is_empty() {
        let mut check = Check::new();
        for (sig, (count, trace)) in &o.groups {
            let reduced = conformance::dispatch("minimizeTrace", &json!({"actions": trace, "options": {"maxReplays": 600}}), &mut check)?;
            let outcome = &reduced["outcome"];
            let path = outcome["mismatch"]["path"].as_str().unwrap_or_default();
            let last = outcome["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
            witnesses.push(json!({
                "signature": sig, "traces": count, "originalLength": trace.len(), "reduction": reduced["status"],
                "length": reduced["actions"].as_array().map_or(0, Vec::len), "actions": reduced["actions"], "path": path,
                "failingStep": focus(&outcome["steps"][last], path),
            }));
        }
    }
    let coverage: Vec<Value> = CHECKLIST
        .iter()
        .map(|(id, what)| {
            let hits = o.coverage.get(id).copied().unwrap_or(0);
            json!({"id": id, "what": what, "hits": hits, "reached": hits > 0 || id.starts_with('X')})
        })
        .collect();
    let unreached: Vec<&str> = CHECKLIST.iter().map(|(id, _)| *id).filter(|id| !id.starts_with('X') && o.coverage.get(id).copied().unwrap_or(0) == 0).collect();
    Ok(json!({
        "campaign": name, "traces": o.traces, "matched": o.matched, "mismatched": o.groups.values().map(|g| g.0).sum::<u64>(),
        "errors": o.errors, "steps": o.steps, "checkMs": checked.as_millis() as u64, "totalMs": start.elapsed().as_millis() as u64,
        "witnesses": witnesses, "unreached": unreached, "coverage": coverage,
    }))
}

fn edge_traces(alphabet: Alphabet, depth: u64, max_states: u64) -> R<(Value, Vec<Vec<String>>)> {
    let start = Instant::now();
    let graph = search::map_states(&json!(Model::initial()), &json!({"maxDepth": depth, "maxStates": max_states}), &mut Space(alphabet))?;
    let nodes = graph["nodes"].as_array().map_or(0, Vec::len);
    let edges = graph["edges"].as_array().cloned().unwrap_or_default();
    // Nodes are numbered in discovery order, so each node's first incoming edge is its BFS parent.
    let mut parent: Vec<Option<(usize, String)>> = vec![None; nodes];
    for e in &edges {
        let (from, to) = (e["from"].as_u64().unwrap_or(0) as usize, e["to"].as_u64().unwrap_or(0) as usize);
        if to != 0 && parent[to].is_none() {
            parent[to] = Some((from, e["action"].as_str().unwrap_or_default().to_owned()));
        }
    }
    let path = |mut n: usize| {
        let mut out = vec![];
        while let Some((p, a)) = &parent[n] {
            out.push(a.clone());
            n = *p;
        }
        out.reverse();
        out
    };
    let traces = edges
        .iter()
        .map(|e| {
            let mut t = path(e["from"].as_u64().unwrap_or(0) as usize);
            t.push(e["action"].as_str().unwrap_or_default().to_owned());
            t
        })
        .collect();
    Ok((json!({"graph": graph["status"], "states": nodes, "edges": edges.len(), "maxDepth": depth, "mapMs": start.elapsed().as_millis() as u64}), traces))
}

fn flag(args: &[String], name: &str) -> Option<u64> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).and_then(|v| v.parse().ok())
}

fn main() -> R<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let jobs = flag(&args, "-j").map_or_else(|| thread::available_parallelism().map_or(4, |n| n.get().min(8)), |j| j as usize);
    let budget = flag(&args, "--budget").map(Duration::from_secs);
    let seed = flag(&args, "--seed").unwrap_or(0);
    let flagged: Vec<usize> = ["-j", "--budget", "--seed", "--alphabet"].iter().filter_map(|f| args.iter().position(|a| a == f)).flat_map(|i| [i, i + 1]).collect();
    let nums: Vec<u64> = args.iter().enumerate().skip(1).filter(|(i, _)| !flagged.contains(i)).filter_map(|(_, a)| a.parse().ok()).collect();
    let start = Instant::now();
    let report = match args.first().map(String::as_str) {
        Some("trace") => {
            let actions: Vec<&String> = args[1..].iter().collect();
            let mut check = Check::new();
            let run = conformance::dispatch("runTrace", &json!({"actions": actions}), &mut check)?;
            let path = run["mismatch"]["path"].as_str().unwrap_or_default();
            let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
            json!({"status": run["status"], "mismatch": run["mismatch"], "error": run["error"],
                "failingStep": if path.is_empty() { Value::Null } else { focus(&run["steps"][at], path) }, "steps": run["steps"]})
        }
        Some("edges") => {
            let (depth, max) = (nums.first().copied().unwrap_or(2), nums.get(1).copied().unwrap_or(200_000));
            let alphabet = match args.iter().position(|a| a == "--alphabet").and_then(|i| args.get(i + 1)).map(String::as_str) {
                Some("race") => Alphabet::Race,
                Some("revoke") => Alphabet::Revoke,
                _ => Alphabet::Core,
            };
            let (info, traces) = edge_traces(alphabet, depth, max)?;
            let mut r = report(&format!("edge coverage, depth {depth}"), run_parallel(traces, jobs, budget, 0)?, start, true)?;
            r["model"] = info;
            r
        }
        Some("ci") => {
            // CI: every bug witness, every edge of the core graph at depth 3, of the two-slot race
            // at depth 7 and of the in-flight revocation at depth 8, then seeded random walks over
            // the full alphabet until the budget (default 45 s) runs out.
            let mut traces: Vec<Vec<String>> = WITNESSES.iter().map(|w| w.iter().map(|a| a.to_string()).collect()).collect();
            let mut models = vec![];
            for (alphabet, depth) in [(Alphabet::Core, 3), (Alphabet::Race, 7), (Alphabet::Revoke, 8)] {
                let (info, t) = edge_traces(alphabet, depth, 200_000)?;
                models.push(info);
                traces.extend(t);
            }
            let edges = traces.len();
            traces.extend((0..20_000).map(|i| walk(seed.wrapping_add(i), 24)));
            let mut r = report("ci: witnesses + edges (core 3, race 7, revoke 8) + random walks", run_parallel(traces, jobs, Some(budget.unwrap_or(Duration::from_secs(45))), edges)?, start, true)?;
            r["model"] = json!(models);
            r["edgeTraces"] = json!(edges);
            r
        }
        _ => {
            let (n, len) = (nums.first().copied().unwrap_or(500), nums.get(1).copied().unwrap_or(30));
            let traces = (0..n).map(|i| walk(seed.wrapping_add(i), len as usize)).collect();
            report(&format!("random walks {n} x {len}, seed {seed}"), run_parallel(traces, jobs, budget, 0)?, start, true)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    let failed = report["mismatched"].as_u64().unwrap_or(0) > 0 || report["errors"].as_array().is_some_and(|e| !e.is_empty()) || report["status"].as_str().is_some_and(|s| s != "match");
    std::process::exit(if failed { 1 } else { 0 });
}
