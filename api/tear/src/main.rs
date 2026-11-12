//! tear model check of Bane's send path (admission, campaigns, dispatcher, recovery).
//!
//! The reference model (`model.rs`) predicts every step; the host (`../host.ts`, one long-lived
//! Node process over an isolated PostgreSQL database) runs the real API code. tear's runTrace
//! compares them step by step and minimizeTrace reduces each distinct mismatch.
//!
//!   TEAR_DATABASE_URL=postgresql://... cargo run --release -- random [TRACES] [LEN] [--profile P] [--budget SECS]
//!   ... -- edges [DEPTH] [MAX_STATES] [--profile P] [--budget SECS]
//!   ... -- trace [--cfg N] ACTION...        (e.g. "send ok" "send ok" "D1 step" ...)
//!   ... -- ci                               (the pull-request run, about a minute)
//!
//! Profiles: dispatch (direct mail, stepped processes, crashes, recovery), campaign (launch,
//! schedule, pause, resume, cancel, the run job, pacing), admission (Idempotency-Key and the
//! pending cap), all (random walks only).
mod model;

use model::{Cfg, Model, P, alphabet};
use serde_json::{Value, json};
use statecheck::{Error, Host, R, conformance, search, stdio::StdioFixture};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

const PROPERTY: &str = "bane.dispatch.send-path";

fn model(v: &Value) -> R<Model> {
    serde_json::from_value(v.clone()).map_err(|e| Error::new(e.to_string()))
}

/// Trace configurations: campaign recipients' provider behaviour, an optional daily cap, and a
/// pending-cap seed two below the 10,000 floor.
fn configs() -> Vec<Cfg> {
    vec![
        Cfg { seed: 0, pace: None, campaign: P::Ok },
        Cfg { seed: 0, pace: Some(1), campaign: P::Ok },
        Cfg { seed: 0, pace: None, campaign: P::Thr },
        Cfg { seed: 9_998, pace: None, campaign: P::Unk },
    ]
}

/// Conformance host: the model predicts, the Node host runs the real code.
struct Check {
    fixture: StdioFixture,
    cfg: Cfg,
    at: u32,
    traces: u64,
}
impl Check {
    fn open() -> R<Check> {
        let api = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let url = std::env::var("TEAR_DATABASE_URL").map_err(|_| Error::new("set TEAR_DATABASE_URL to an isolated local database"))?;
        let mut command = Command::new("node");
        command.args(["--import", "tsx", "tear/host.ts"]).current_dir(api).env("TEAR_DATABASE_URL", url);
        let fixture = StdioFixture::open(&mut command, Duration::from_secs(60))?;
        Ok(Check { fixture, cfg: configs()[0].clone(), at: 0, traces: 0 })
    }
}
impl Host for Check {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        Ok(match name {
            "id" => json!(PROPERTY),
            "initial" => json!(Model::initial(self.cfg.clone())),
            "enabled" => json!(model(&args[0])?.enabled(args[1].as_str().unwrap_or_default())),
            "step" => {
                let mut m = model(&args[0])?;
                self.at = m.t;
                let r = m.step_action(args[1].as_str().unwrap_or_default());
                json!({"expected": m.expected(r), "state": m})
            }
            "open" => {
                self.traces += 1;
                let c = &self.cfg;
                self.fixture.act(&json!({"reset": {"seed": c.seed, "pace": c.pace, "recipients": [c.campaign.name(), c.campaign.name()]}}))?;
                Value::Null
            }
            "act" => self.fixture.act(&json!({"at": self.at, "action": args[1]}))?,
            "close" => {
                self.fixture.act(&json!({"end": true}))?;
                Value::Null
            }
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

/// Model-only host for tear's breadth-first state mapping.
struct Space {
    labels: Vec<String>,
}
impl Host for Space {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        let mut m = model(&args[0])?;
        Ok(match name {
            "actions" => json!(self.labels.iter().filter(|l| m.enabled(l)).collect::<Vec<_>>()),
            "step" => {
                m.step_action(args[1].as_str().unwrap_or_default());
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

/// Stepping a process and short waits are weighted up so walks reach deep interleavings;
/// long waits and crashes are rarer.
fn weight(label: &str) -> u64 {
    match label {
        l if l.ends_with(" step") => 5,
        "jobs" | "drain" | "recover" | "pause" | "resume" | "cancel" | "wait 1s" | "wait 1m" => 2,
        _ => 1,
    }
}

/// Walks start from one of these prefixes (a launched campaign, a process mid-send, a
/// throttled row) so a short random suffix reaches deep states.
const PREFIXES: &[&[&str]] = &[
    &[],
    &["launch", "jobs"],
    &["launch", "jobs", "D1 step", "D1 step"],
    &["schedule", "jobs"],
    &["send ok", "D1 step", "D1 step", "D1 step"],
    &["send thr", "send ok", "D1 step", "D1 step", "D1 step", "D1 step"],
    &["launch", "jobs", "D1 step", "D1 step", "D1 step", "D1 step"],
    &["send unk", "send ok", "D2 step", "D2 step", "D2 step", "D2 step", "D2 step"],
];

fn walk(seed: u64, len: usize, labels: &[String], cfg: &Cfg) -> Vec<String> {
    let mut x = seed;
    let mut m = Model::initial(cfg.clone());
    let mut out = vec![];
    let prefix = PREFIXES[(splitmix(&mut x) % PREFIXES.len() as u64) as usize];
    for a in prefix {
        if out.len() < len && labels.iter().any(|l| l == a) && m.enabled(a) {
            m.step_action(a);
            out.push((*a).to_owned());
        }
    }
    while out.len() < len {
        let enabled: Vec<_> = labels.iter().filter(|l| m.enabled(l)).collect();
        let total: u64 = enabled.iter().map(|l| weight(l)).sum();
        let mut roll = splitmix(&mut x) % total;
        let pick = enabled.iter().find(|l| {
            let w = weight(l);
            if roll < w {
                return true;
            }
            roll -= w;
            false
        });
        let pick = pick.expect("a weighted pick");
        m.step_action(pick);
        out.push((*pick).clone());
    }
    out
}

/// Group key: the action verb plus the mismatching field, or the first safety violation.
fn signature(run: &Value) -> String {
    let index = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
    let step = &run["steps"][index];
    let label = step["action"].as_str().unwrap_or_default();
    let verb = label.split(' ').take(2).collect::<Vec<_>>().join(" ");
    let path = run["mismatch"]["path"].as_str().unwrap_or_default();
    let detail = if path.starts_with("/safety") {
        step["observed"]["safety"][0].as_str().unwrap_or_default().split(':').next().unwrap_or_default().to_owned()
    } else {
        path.split('/').take(3).collect::<Vec<_>>().join("/")
    };
    let detail: String = detail.chars().map(|c| if c.is_ascii_digit() { '#' } else { c }).collect();
    format!("{verb}: {detail}")
}

fn focus(step: &Value, path: &str) -> Value {
    let key = path.split('/').nth(1).unwrap_or_default();
    json!({"expected": step["expected"][key], "observed": step["observed"][key]})
}

/// Replay a trace through the model alone and count the edge cases it reached.
fn coverage(trace: &[String], cfg: &Cfg, into: &mut BTreeMap<&'static str, u64>) {
    let mut m = Model::initial(cfg.clone());
    for a in trace {
        if !m.enabled(a) {
            break;
        }
        m.step_action(a);
        for tag in &m.cov {
            *into.entry(tag).or_default() += 1;
        }
    }
}

struct Stats {
    traces: u64,
    matched: u64,
    steps: u64,
    errors: Vec<Value>,
    groups: BTreeMap<String, (u64, Vec<String>, usize)>,
}

fn campaign(check: &mut Check, name: &str, traces: Vec<(usize, Vec<String>)>, budget: Option<Instant>) -> R<Value> {
    let start = Instant::now();
    let cfgs = configs();
    let mut s = Stats { traces: 0, matched: 0, steps: 0, errors: vec![], groups: BTreeMap::new() };
    let mut reached = BTreeMap::new();
    for (cfg, trace) in traces {
        if budget.is_some_and(|b| Instant::now() >= b) {
            break;
        }
        check.cfg = cfgs[cfg].clone();
        let run = conformance::dispatch("runTrace", &json!({"actions": trace}), check)?;
        s.traces += 1;
        s.steps += run["steps"].as_array().map_or(0, |x| x.len() as u64);
        match run["status"].as_str() {
            Some("match") => {
                s.matched += 1;
                coverage(&trace, &cfgs[cfg], &mut reached);
            }
            Some("mismatch") => s.groups.entry(signature(&run)).or_insert((0, trace, cfg)).0 += 1,
            _ => {
                if s.errors.len() < 5 {
                    s.errors.push(json!({"cfg": cfg, "trace": trace, "run": run}));
                }
            }
        }
    }
    let checked = start.elapsed();
    let mut witnesses = vec![];
    for (sig, (count, trace, cfg)) in &s.groups {
        check.cfg = cfgs[*cfg].clone();
        let reduced = conformance::dispatch("minimizeTrace", &json!({"actions": trace, "options": {"maxReplays": 400}}), check)?;
        let outcome = &reduced["outcome"];
        let path = outcome["mismatch"]["path"].as_str().unwrap_or_default();
        let last = outcome["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
        witnesses.push(json!({
            "signature": sig, "traces": count, "cfg": cfg, "originalLength": trace.len(),
            "reduction": reduced["status"], "replays": reduced["replays"], "length": reduced["actions"].as_array().map_or(0, Vec::len),
            "actions": reduced["actions"], "path": path, "failingStep": focus(&outcome["steps"][last], path),
        }));
    }
    Ok(json!({
        "campaign": name, "traces": s.traces, "matched": s.matched,
        "mismatched": s.groups.values().map(|g| g.0).sum::<u64>(), "errors": s.errors,
        "steps": s.steps, "checkMs": checked.as_millis() as u64, "totalMs": start.elapsed().as_millis() as u64,
        "witnesses": witnesses, "coverage": reached,
    }))
}

/// Map the model graph breadth-first and return the shortest path to every edge.
fn edges(depth: u64, max_states: u64, labels: Vec<String>, cfg: &Cfg) -> R<(Value, Vec<Vec<String>>)> {
    let start = Instant::now();
    let mut space = Space { labels };
    let graph = search::map_states(&json!(Model::initial(cfg.clone())), &json!({"maxDepth": depth, "maxStates": max_states}), &mut space)?;
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
    // Only edges into new states or at the depth frontier add information beyond their prefix.
    let traces = edges
        .iter()
        .map(|e| {
            let mut t = path(e["from"].as_u64().unwrap_or(0) as usize);
            t.push(e["action"].as_str().unwrap_or_default().to_owned());
            t
        })
        .collect();
    let info = json!({"graph": graph["status"], "states": nodes, "edges": edges.len(), "maxDepth": depth, "mapMs": start.elapsed().as_millis() as u64});
    Ok((info, traces))
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
}

fn main() -> R<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let profile = flag(&args, "--profile").unwrap_or("all").to_owned();
    let budget = flag(&args, "--budget").and_then(|s| s.parse::<u64>().ok()).map(|s| Instant::now() + Duration::from_secs(s));
    let cfg_index = flag(&args, "--cfg").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
    let positional: Vec<&String> = {
        let mut out = vec![];
        let mut skip = false;
        for a in args.iter().skip(1) {
            if skip {
                skip = false;
                continue;
            }
            if a.starts_with("--") {
                skip = true;
                continue;
            }
            out.push(a);
        }
        out
    };
    let nums: Vec<u64> = positional.iter().filter_map(|a| a.parse().ok()).collect();
    let mut check = Check::open()?;
    let started = Instant::now();
    let report = match args.first().map(String::as_str) {
        Some("trace") => {
            let actions: Vec<_> = positional.iter().map(|s| s.as_str()).collect();
            check.cfg = configs()[cfg_index].clone();
            let run = conformance::dispatch("runTrace", &json!({"actions": actions, "options": {"maxStepsAfterMismatch": 3}}), &mut check)?;
            let path = run["mismatch"]["path"].as_str().unwrap_or_default().to_owned();
            let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
            json!({"status": run["status"], "mismatch": run["mismatch"], "error": run["error"], "disabled": run["disabled"],
                "failingStep": if path.is_empty() { Value::Null } else { focus(&run["steps"][at], &path) }, "steps": run["steps"]})
        }
        Some("edges") => {
            let (depth, max) = (nums.first().copied().unwrap_or(4), nums.get(1).copied().unwrap_or(50_000));
            let mut reports = vec![];
            for (i, cfg) in configs().iter().enumerate() {
                if profile == "admission" && cfg.seed == 0 || profile != "admission" && cfg.seed != 0 {
                    continue;
                }
                if profile == "dispatch" && i > 0 {
                    continue;
                }
                let (info, traces) = edges(depth, max, alphabet(&profile), cfg)?;
                let mut r = campaign(&mut check, &format!("edges {profile} cfg {i}"), traces.into_iter().map(|t| (i, t)).collect(), budget)?;
                r["model"] = info;
                reports.push(r);
            }
            json!(reports)
        }
        Some("ci") => {
            // The pull-request run: seeded random walks over every profile and configuration,
            // then exhaustive edges of the dispatch profile at depth 4, each time-bounded.
            let labels = alphabet("all");
            let n = configs().len();
            let walks = (0..120).map(|s| ((s as usize) % n, walk(s, 24, &labels, &configs()[(s as usize) % n]))).collect();
            let random = campaign(&mut check, "ci random 120x24", walks, Some(Instant::now() + Duration::from_secs(30)))?;
            let (info, traces) = edges(3, 20_000, alphabet("dispatch"), &configs()[0])?;
            let mut edge = campaign(&mut check, "ci edges dispatch depth 3", traces.into_iter().map(|t| (0, t)).collect(), Some(Instant::now() + Duration::from_secs(25)))?;
            edge["model"] = info;
            json!([random, edge])
        }
        _ => {
            let (n, len) = (nums.first().copied().unwrap_or(500), nums.get(1).copied().unwrap_or(30));
            let base = flag(&args, "--seed").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let labels = alphabet(&profile);
            let cfgs = configs();
            let traces = (base..base + n).map(|s| ((s as usize) % cfgs.len(), walk(s, len as usize, &labels, &cfgs[(s as usize) % cfgs.len()]))).collect();
            campaign(&mut check, &format!("random {profile} {n}x{len} seed {base}"), traces, budget)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&json!({"report": report, "fixtures": check.traces, "wallMs": started.elapsed().as_millis() as u64})).unwrap_or_default());
    check.fixture.close()?;
    Ok(())
}
