//! tear model check of Bane's send path (admission, campaigns, dispatcher, recovery).
//!
//! The reference model (`model.rs`) predicts every step; the host (`host.ts`, one long-lived
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
use statecheck::{Error, Host, R, conformance, search, stdio::StdioFixture, temporal::{Monitor, Property}};
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
/// Configuration 7 adds a second owner and two-row runner leases (the owner-cursor wrap).
/// Configurations 4-6 put a small SES 24-hour quota (2, 3 or 4: one reserved for
/// transactional mail, leaving 1-3 campaign credits, below the shard count at 2) under two
/// dispatcher shards and a four-recipient campaign; they are checked as invariants.
fn configs() -> Vec<Cfg> {
    let exact = |seed, pace, campaign| Cfg { seed, pace, campaign, recipients: 2, quota: None, owners: 1, drain_batch: 24, exact_quota: None };
    let quota = |q| Cfg { seed: 0, pace: None, campaign: P::Ok, recipients: 4, quota: Some(q), owners: 1, drain_batch: 24, exact_quota: None };
    let owners = Cfg { owners: 2, drain_batch: 2, ..exact(0, None, P::Ok) };
    // A 24-hour quota of 2 keeps 1 for transactional mail: one marketing recipient fits, so a
    // two-recipient marketing envelope never does. One owner with 24-row leases, or two owners
    // with two-row leases (each lease holds every owner's head).
    let allowance = Cfg { exact_quota: Some(2), ..exact(0, None, P::Ok) };
    let allowance2 = Cfg { exact_quota: Some(2), ..owners.clone() };
    vec![exact(0, None, P::Ok), exact(0, Some(1), P::Ok), exact(0, None, P::Thr), exact(9_998, None, P::Unk), quota(2), quota(3), quota(4), owners, allowance, allowance2]
}
fn cfgs_for(profile: &str) -> Vec<usize> {
    match profile {
        "quota" => vec![4, 5, 6],
        "owners" => vec![7],
        "allowance" => vec![8],
        "allowance2" => vec![9],
        "admission" => vec![3],
        "dispatch" => vec![0],
        "campaign" => vec![0, 1, 2],
        _ => vec![0, 1, 2, 3],
    }
}

/// tear's temporal monitor over the host's log of provider calls and campaign releases,
/// one stream per process run, per message and for the campaign's releases.
#[derive(Default)]
struct Temporal {
    streams: BTreeMap<String, Monitor>,
}
impl Temporal {
    fn monitor(kind: &str) -> Monitor {
        let props = match kind {
            // A throttled response holds that process's next provider call for a second.
            // The host marks the moment the dispatcher has handled a throttled response; the
            // first call after it starts at least a second after the throttled call.
            // Two throttles handled in one turn leave two markers: the second carries the obligation on.
            "proc" => vec![Property::next("brake: a throttled process waits 1 s", "/at", |f| f["out"] == "braked", |t, f| {
                (f["out"] == "braked" && f["since"].as_u64() >= t["since"].as_u64()) || f["at"].as_u64() >= t["since"].as_u64().map(|a| a + 990)
            })],
            // A throttled row is retried no sooner than its 2 s backoff, never twice at once.
            "mail" => vec![
                Property::next("backoff: a throttled row waits 2 s", "/at", |f| f["out"] == "throttled", |t, f| f["at"].as_u64() >= t["at"].as_u64().map(|a| a + 1990)),
                Property::next("once: a possibly accepted row is never resent", "/out", |f| matches!(f["out"].as_str(), Some("accepted" | "unknown")), |_, _| false),
            ],
            // A full daily window holds the next release until 24 h after the window opened.
            _ => vec![
                Property::always("pace: a window never exceeds its daily cap", "/windowN", |f| f["pace"].as_u64().is_none_or(|p| f["windowN"].as_u64().is_some_and(|n| n <= p))),
                Property::next("pace: a full window holds until it ends", "/at", |f| f["pace"].as_u64().is_some_and(|p| f["windowN"].as_u64() >= Some(p)), |t, f| {
                    f["at"].as_u64() >= t["windowStart"].as_u64().map(|w| w + 86_400_000)
                }),
            ],
        };
        Monitor::new(props).expect("valid temporal properties")
    }
    fn push(&mut self, log: &Value) -> R<()> {
        for e in log.as_array().into_iter().flatten() {
            let at = e["at"].as_u64().unwrap_or(0);
            let keys = match (e["kind"].as_str(), e["out"].as_str()) {
                (Some("send"), Some("braked")) => vec![("proc", format!("proc {}", e["proc"]))],
                (Some("send"), _) => vec![("proc", format!("proc {}", e["proc"])), ("mail", format!("mail {}", e["mail"]))],
                _ => vec![("release", "release".to_owned())],
            };
            for (kind, key) in keys {
                self.streams.entry(key).or_insert_with(|| Temporal::monitor(kind)).push(at, e.clone())?;
            }
        }
        Ok(())
    }
    fn violations(&self) -> Value {
        let mut ids: Vec<String> = vec![];
        for (key, m) in &self.streams {
            for p in m.receipt()["properties"].as_array().into_iter().flatten() {
                if p["status"] == "violation" {
                    ids.push(format!("{} ({key})", p["id"].as_str().unwrap_or_default()));
                }
            }
        }
        ids.sort();
        ids.dedup();
        json!(ids)
    }
}

/// Conformance host: the model predicts, the Node host runs the real code.
struct Check {
    fixture: StdioFixture,
    cfg: Cfg,
    at: u32,
    traces: u64,
    temporal: Temporal,
}
impl Check {
    fn open() -> R<Check> {
        let api = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let url = std::env::var("TEAR_DATABASE_URL").map_err(|_| Error::new("set TEAR_DATABASE_URL to an isolated local database"))?;
        let mut command = Command::new("node");
        command.args(["--import", "tsx", "tear/dispatch/host.ts"]).current_dir(api).env("TEAR_DATABASE_URL", url);
        let fixture = StdioFixture::open(&mut command, Duration::from_secs(60))?;
        Ok(Check { fixture, cfg: configs()[0].clone(), at: 0, traces: 0, temporal: Temporal::default() })
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
                self.temporal = Temporal::default();
                let c = &self.cfg;
                let recipients: Vec<&str> = (0..c.recipients).map(|_| c.campaign.name()).collect();
                self.fixture.act(&json!({"reset": {"seed": c.seed, "pace": c.pace, "recipients": recipients,
                    "quota": c.quota.or(c.exact_quota).map_or(-1, i64::from), "shards": c.quota.is_some(), "invariants": c.quota.is_some(),
                    "owners": c.owners, "drainBatch": c.drain_batch}}))?;
                Value::Null
            }
            "act" => {
                let mut observed = self.fixture.act(&json!({"at": self.at, "action": args[1]}))?;
                if let Some(log) = observed.as_object_mut().and_then(|o| o.remove("log")) {
                    self.temporal.push(&log)?;
                }
                observed["temporal"] = self.temporal.violations();
                observed
            }
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

/// Hand-written traces for edge cases that random walks rarely reach: each must match the
/// model and reach its checklist tag. (configuration, actions, tag)
const SCENARIOS: &[(usize, &[&str], &str)] = &[
    (2, &["launch", "jobs", "D1 step", "D1 step", "D1 step", "D1 step", "drain", "wait 4s", "drain", "wait 1m", "wait 1m", "wait 1m", "wait 1s", "recover", "D1 step"], "late refusal reopens a done campaign"),
    (0, &["send ok", "D1 step", "D1 step", "D1 step", "D1 step", "wait 1m", "wait 1m", "wait 1m", "wait 1s", "recover", "D1 step"], "record after the sweep"),
    (0, &["send ok", "D1 step", "D1 step", "D1 step", "D1 step", "D1 crash", "wait 1m", "wait 1m", "wait 1m", "wait 1s", "recover", "drain"], "crash after the provider accepted"),
    (0, &["send ok", "D1 step", "D1 step", "D1 crash", "wait 1m", "wait 59s", "D2 step", "D2 step"], "lease -1 s still held"),
    (0, &["send ok", "D1 step", "D1 step", "D1 crash", "wait 1m", "wait 59s", "wait 1s", "wait 1s", "D2 step", "D2 step"], "expired lease (+1 s) taken by another lease"),
    (0, &["send ok", "D1 step", "D1 step", "D1 step", "D1 crash", "wait 1m", "wait 1m", "wait 59s", "recover"], "sweep at attempt +3 min -1 s leaves it"),
    (0, &["send ok", "D1 step", "D1 step", "D1 step", "D1 crash", "wait 1m", "wait 1m", "wait 1m", "wait 1s", "recover", "drain"], "sweep at attempt +3 min +1 s"),
    (0, &["send thr", "drain", "wait 1s", "drain"], "backoff -1 s still waiting"),
    (0, &["send thr", "drain", "wait 1s", "wait 1s", "wait 1s", "drain"], "backoff +1 s retried"),
    (0, &["send ok", "D1 step", "D1 step", "wait 4s", "D1 step", "D1 step"], "pre-send deadline -1 s"),
    (0, &["send ok", "D1 step", "D1 step", "wait 4s", "wait 1s", "wait 1s", "D1 step", "D1 step", "D1 step"], "pre-send deadline +1 s"),
    // A row in flight at cancel is throttled, comes back queued, and the next claim cancels it.
    (2, &["launch", "jobs", "D1 step", "D1 step", "D1 step", "cancel", "D1 step", "D1 step", "D1 step", "wait 4s", "D1 step", "D1 step", "D1 step"], "cancel between lease and claim"),
    (0, &["launch", "jobs", "D1 step", "D1 step", "D1 step", "cancel", "D1 step", "D1 step"], "in-flight send after cancel"),
    (1, &["launch", "jobs", "pause", "drain", "resume", "jobs", "wait 1d", "wait 1s", "jobs", "drain"], "queued campaign mail dispatches while paused"),
    (1, &["launch", "jobs", "wait 1d", "wait 1s", "jobs", "drain"], "next window +1 s releases"),
    (0, &["schedule", "jobs", "wait 59s", "jobs"], "run job -1 s not yet due"),
    (0, &["schedule", "jobs", "wait 1m", "wait 1s", "jobs", "drain"], "schedule +1 s releases"),
    (0, &["schedule", "jobs", "pause", "resume", "wait 1m", "wait 1s", "jobs", "drain"], "resume to scheduled"),
    (3, &["send ok", "send ok", "send ok"], "pending cap +1 refused"),
    (3, &["send ok", "send ok", "sendk k1 ok", "drain", "sendk k1 ok", "sendk k1 rej"], "refused admission releases its key"),
    (0, &["dupk k2 ok", "sendk k2 ok", "sendk k2 rej"], "two concurrent sends with one key"),
    (0, &["send thr", "send thr", "send ok", "drain", "wait 4s", "drain"], "throttle brake delays the next send"),
    // The original owner-cursor bug through the ordinary runner: two owners fill a two-row lease.
    (7, &["send ok", "send2 ok", "send ok", "drain"], "a run with a lease's worth of owners leases past the last owner"),
    (7, &["send2 ok", "send ok", "send2 ok", "send ok", "send2 ok", "drain", "send ok", "drain"], "a run with a lease's worth of owners leases past the last owner"),
    // Recheck of #52 (P1): one owner's full page of envelopes the allowance cannot afford.
    (8, &["mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2",
        "mkt2", "mkt2", "mkt2", "mkt2", "drain"], "the lease skips an envelope the allowance cannot afford"),
    (8, &["mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2", "mkt2",
        "mkt2", "mkt2", "mkt2", "mkt2", "mkt1", "drain"], "affordable mail behind an oversized head sends"),
    // Recheck of #52 (P2): every owner's head is too large; their affordable followers still send.
    (9, &["mkt2", "mkt2b", "mkt1", "mkt1b", "drain"], "affordable mail behind an oversized head sends"),
    (9, &["mkt2", "mkt2b", "mkt1", "mkt1b", "drain", "wait 1d", "wait 1m", "drain"], "affordable mail behind an oversized head sends"),
    // The reserve: transactional mail spends the room marketing would have used, never the reverse.
    (9, &["mkt1", "send ok", "mkt1b", "drain", "wait 1m", "wait 1s", "drain", "wait 1d", "wait 1m", "drain"], "the allowance delays an envelope in its page"),
    // Review of #52 (P2): one drain is a whole run, not one 24-row page.
    (0, &["send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok",
        "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "send ok", "drain"], "drain leases a second page"),
];

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

fn scenarios(check: &mut Check) -> R<Value> {
    let cfgs = configs();
    let mut failed = vec![];
    for (cfg, actions, tag) in SCENARIOS {
        check.cfg = cfgs[*cfg].clone();
        let run = conformance::dispatch("runTrace", &json!({"actions": actions}), check)?;
        let trace: Vec<String> = actions.iter().map(|a| (*a).to_owned()).collect();
        let mut reached = BTreeMap::new();
        coverage(&trace, &cfgs[*cfg], &mut reached);
        if run["status"] != "match" || !reached.contains_key(tag) {
            let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
            let path = run["mismatch"]["path"].as_str().unwrap_or_default();
            failed.push(json!({"tag": tag, "status": run["status"], "reached": reached.contains_key(tag), "mismatch": run["mismatch"], "disabled": run["disabled"], "error": run["error"],
                "failingStep": if path.is_empty() { Value::Null } else { focus(&run["steps"][at], path) }}));
        }
    }
    Ok(json!({"campaign": "scenarios", "traces": SCENARIOS.len(), "matched": SCENARIOS.len() - failed.len(), "mismatched": failed.len(), "errors": [], "steps": 0, "checkMs": 0, "witnesses": failed}))
}

/// Why a report must fail the process: a trace that did not match, or any campaign (a run,
/// the scenarios, each part of `ci`) with a mismatch, an error or a trace that neither matched
/// nor mismatched.
fn failures(report: &Value) -> Vec<String> {
    let mut out = vec![];
    match report {
        Value::Array(parts) => parts.iter().for_each(|p| out.extend(failures(p))),
        Value::Object(o) if o.contains_key("campaign") => {
            let name = o["campaign"].as_str().unwrap_or("campaign");
            let n = |k: &str| o.get(k).and_then(Value::as_u64).unwrap_or(0);
            if n("mismatched") > 0 {
                out.push(format!("{name}: {} mismatched", n("mismatched")));
            }
            let errors = o.get("errors").and_then(Value::as_array).map_or(0, Vec::len);
            if errors > 0 || n("matched") + n("mismatched") < n("traces") {
                out.push(format!("{name}: {} traces neither matched nor mismatched", n("traces") - n("matched") - n("mismatched")));
            }
        }
        Value::Object(o) => {
            let status = o.get("status").and_then(Value::as_str).unwrap_or("missing");
            if status != "match" {
                out.push(format!("trace: {status}"));
            }
        }
        _ => out.push("report: unexpected shape".to_owned()),
    }
    out
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
            for i in cfgs_for(&profile) {
                let cfg = &configs()[i];
                let (info, traces) = edges(depth, max, alphabet(&profile), cfg)?;
                let mut r = campaign(&mut check, &format!("edges {profile} cfg {i}"), traces.into_iter().map(|t| (i, t)).collect(), budget)?;
                r["model"] = info;
                reports.push(r);
            }
            json!(reports)
        }
        Some("scenarios") => scenarios(&mut check)?,
        Some("ci") => {
            // The pull-request run (about 50 s): the scenarios, seeded random walks over the
            // exact configurations and over the quota profile, then every edge of the dispatch
            // profile's model graph to depth 3, each time-bounded.
            let cfgs = configs();
            let walks = |profile: &str, n: u64, len: usize| -> Vec<(usize, Vec<String>)> {
                let (labels, pool) = (alphabet(profile), cfgs_for(profile));
                (0..n).map(|s| (pool[s as usize % pool.len()], walk(s, len, &labels, &cfgs[pool[s as usize % pool.len()]]))).collect()
            };
            let scenarios = scenarios(&mut check)?;
            let random = campaign(&mut check, "ci random 100x24", walks("all", 100, 24), Some(Instant::now() + Duration::from_secs(22)))?;
            let quota = campaign(&mut check, "ci quota 30x24", walks("quota", 30, 24), Some(Instant::now() + Duration::from_secs(8)))?;
            let owners = campaign(&mut check, "ci owners 30x12", walks("owners", 30, 12), Some(Instant::now() + Duration::from_secs(5)))?;
            let allowance = campaign(&mut check, "ci allowance 40x16", [walks("allowance", 20, 16), walks("allowance2", 20, 16)].concat(), Some(Instant::now() + Duration::from_secs(8)))?;
            let (info, traces) = edges(3, 20_000, alphabet("dispatch"), &cfgs[0])?;
            let mut edge = campaign(&mut check, "ci edges dispatch depth 3", traces.into_iter().map(|t| (0, t)).collect(), Some(Instant::now() + Duration::from_secs(18)))?;
            edge["model"] = info;
            json!([scenarios, random, quota, owners, allowance, edge])
        }
        _ => {
            let (n, len) = (nums.first().copied().unwrap_or(500), nums.get(1).copied().unwrap_or(30));
            let base = flag(&args, "--seed").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let labels = alphabet(&profile);
            let (cfgs, pool) = (configs(), cfgs_for(&profile));
            let traces = (base..base + n)
                .map(|s| {
                    let i = pool[(s as usize) % pool.len()];
                    (i, walk(s, len as usize, &labels, &cfgs[i]))
                })
                .collect();
            campaign(&mut check, &format!("random {profile} {n}x{len} seed {base}"), traces, budget)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&json!({"report": report, "fixtures": check.traces, "wallMs": started.elapsed().as_millis() as u64})).unwrap_or_default());
    check.fixture.close()?;
    // The JSON report stays on stdout for diagnosis; a failing check fails the process.
    let failed = failures(&report);
    if !failed.is_empty() {
        eprintln!("tear: FAILED: {}", failed.join("; "));
        std::process::exit(1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::failures;
    use serde_json::json;

    fn run(traces: u64, matched: u64, mismatched: u64, errors: usize) -> serde_json::Value {
        json!({"campaign": "c", "traces": traces, "matched": matched, "mismatched": mismatched, "errors": vec![json!({}); errors]})
    }

    #[test]
    fn a_clean_report_passes() {
        assert!(failures(&run(10, 10, 0, 0)).is_empty());
        assert!(failures(&json!({"status": "match"})).is_empty());
        assert!(failures(&json!([run(22, 22, 0, 0), run(100, 100, 0, 0), run(1112, 1112, 0, 0)])).is_empty());
    }

    // Review of #52 (P2): a mismatching trace or a failed ci part exited 0.
    #[test]
    fn mismatches_errors_and_failed_scenarios_fail() {
        for status in ["mismatch", "error", "disabled"] {
            assert_eq!(failures(&json!({"status": status})), vec![format!("trace: {status}")]);
        }
        assert_eq!(failures(&run(10, 9, 1, 0)).len(), 1);
        assert_eq!(failures(&run(10, 9, 0, 1)).len(), 1);
        assert_eq!(failures(&run(10, 3, 0, 0)).len(), 1, "errors beyond the five kept still count");
        assert_eq!(failures(&json!([run(25, 24, 1, 0), run(100, 100, 0, 0), run(30, 30, 0, 0)])).len(), 1);
        assert_eq!(failures(&json!(null)).len(), 1);
    }
}
