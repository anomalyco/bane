//! tear model checks for the Rust IMAP/SMTP gateway: the real core and store adapters,
//! checked step by step against independent reference models through tear's conformance
//! runner, with failing traces shrunk to replayable witnesses.
//!
//! ```text
//! cargo run --release -- ci                         # the PR gate, well under 60 s
//! cargo run --release -- random [TRACES] [LEN] [--remote] [--shared-kid] [--split] [--sessions 3]
//! cargo run --release -- edges  [DEPTH] [MAX_STATES] [--remote] [--minimal]
//! cargo run --release -- trace  [--remote ...] ACTION...       # replay one witness
//! cargo run --release -- transcript FILE [--remote ...]         # replay a client transcript
//! cargo run --release -- smtp   [TRACES] [LEN] [--remote]
//! cargo run --release -- dovecot [TRACES] [LEN]                  # Docker: RFC conformance
//! ```
//!
//! Options: `--seconds N` bounds a run by time, `--seed N` shifts the random seeds,
//! `--no-silent` drops `.SILENT` STOREs (the spike's control), `--no-faults`, `--no-folders`.
//!
//! # Edge-case checklist
//!
//! Every item is reachable from the action alphabet unless marked otherwise; `coverage`
//! in each report counts the events and actions that reach it (`ci` prints the table).
//!
//!
//! **Concurrency and interleavings**
//!
//! - [C1] two or three sessions interleave every command on one inbox (edges: all
//!   interleavings to the depth bound; random: three sessions).
//! - [C2] one session changes a message's flags while another stores `.SILENT` on it.
//! - [C3] EXPUNGE, MOVE or an external delete races another session's STORE/FETCH/COPY on the
//!   same UID (the target vanished between the client's view and the command).
//! - [C4] a hint arrives while a session idles, while it is mid-command (pending, consumed
//!   before its next line), and for several commits at once (coalesced).
//! - [C5] two sessions with the same credential wake on one hint and share the wake cache;
//!   a commit lands between the cache fill and the second session's use.
//! - [C6] copy of a message into the selected folder itself (a new UID appears mid-view).
//! - [C7] up to four sessions hold spooled APPEND literals (`append-begin`) at once against
//!   the credential (3), inbox (3) and workspace (4) upload lanes and the process pool (8);
//!   a busy lane answers `NO [LIMIT]` after its 2 s wait (a paused clock here).
//! - [C8] SMTP: concurrent DATA phases against the DATA lanes (2 per credential and inbox).
//!
//! **Crashes, aborts, retries and duplicates**
//!
//! - [R1] a session's connection drops (failed refresh before a command, failed wake reload)
//!   and the client reconnects and resynchronizes.
//! - [R2] the internal API commits a mutation but the refresh after it fails: the command
//!   must still report success (RFC 3501 6.4.7: a failed COPY leaves no copy).
//! - [R3] a hint is lost (commits without hints), duplicated (hint twice), or reordered
//!   relative to commits (hint before the change it announces).
//! - [R4] SMTP: a client retries after a rejected or failed submission; pipelined commands
//!   after a failed MAIL/RCPT.
//! - [R5] a mutation commits but its response is lost (503): the command fails, the client
//!   retries; a COPY retry on the same connection replays its ticket's receipts.
//! - [R6] a batched command (over 1,000 UIDs) meets a failing batch, a process crash after a
//!   batch committed, or another writer between batches: committed batches stay and are
//!   reported, the command answers NO (or nothing, if the process died); a retry completes
//!   it, replaying COPY batches on the same connection.
//!
//! **Lease, lock and staleness expiry; clocks**
//!
//! - [L1] a Remote snapshot passes the 240 s refresh age (`age`) while idle and while busy.
//! - [L2] the tombstone floor rises past a session's since-MODSEQ (prune, folder delete):
//!   the next since-reload must fall back to a full read and never miss an expunge.
//! - [L3] SMTP caps across the UTC day and month boundary, ±1 s, and a clock that steps back.
//! - [L4] not reached: the 5 s per-command store deadline and the 1 s admission sleep use
//!   wall time inside the adapter; tear cannot advance them deterministically.
//!
//! **Limits at the boundary, empty, zero, huge**
//!
//! - [B1] STORE/FETCH/COPY/MOVE/UID EXPUNGE on an empty view (empty sequence and UID sets).
//! - [B2] snapshot paging at page size 2: folders with 0, 1, 2, 3 or more entries, deltas
//!   that end exactly on a page boundary, gone lists and entries paging together.
//! - [B3] SMTP: exactly 50 recipients then the 51st, caps at limit-1/limit/limit+1 with
//!   multi-RCPT messages, the DATA size bound.
//! - [B5] 1,000 and 1,001 UIDs: STORE, COPY, MOVE, UID EXPUNGE and a Remote EXPUNGE run in
//!   1,000-UID batches inside one command (`--bulk`); 50k folders are in the e2e gate.
//! - [B4] not reached here: 2048-row pages, 50k-message folders, 8 MiB literals and the
//!   view byte budget (covered by e2e `large-folder` and unit tests; too slow per step).
//!
//! **Revocation and deletion racing in-flight work; permissions**
//!
//! - [D1] the selected folder is deleted by another session (BYE at the next command), or by
//!   this session, then recreated with a new UIDVALIDITY.
//! - [D2] COPY/MOVE/APPEND to a folder another session deleted after this session's snapshot.
//! - [D3] credentials revoked while sessions are idle or busy: BYE at the next wake, no login.
//! - [D4] EXAMINE (read-only): STORE/EXPUNGE/MOVE refused, FETCH BODY[] sets no `\Seen`.
//! - [D5] SMTP sender ownership: envelope and header From/Sender, aliases, foreign addresses.
//!
//! **Old and new gateway overlap during deploys**
//!
//! - [O1] sessions on two gateway processes (`--split`): separate login and wake caches and
//!   hint listeners over one internal API; hints reaching only one process.
//! - [O2] not reached: two different gateway versions at once (one binary under test).
//!
//! **Partial failures of external calls**
//!
//! - [P1] snapshot reads failing on SELECT, before a command, after a mutation, on wake.
//! - [P2] SMTP: the internal submit refuses (cap, sender) or fails; SES, R2 and webhooks sit
//!   behind the internal API and are out of this crate's reach (API-side tear hosts).
//!
//! **Conformance**
//!
//! - [X1] generated traces against Dovecot at sync points (`dovecot`), with Bane's documented
//!   differences (shared flags across copies, no `\Recent`) normalized.
//! - [X2] replay of a failing client transcript as a shrinkable trace (`transcript`).
#[allow(dead_code, clippy::all)]
#[path = "../../mailgw/src/admission.rs"]
mod admission;
mod client;
mod dovecot;
mod fake_api;
mod fixture;
#[allow(dead_code, clippy::all)]
#[path = "../../mailgw/src/hints.rs"]
mod hints;
mod model;
#[allow(dead_code, clippy::all)]
#[path = "../../mailgw/src/remote.rs"]
mod remote;
mod smtp;
mod transcript;
#[allow(dead_code, clippy::all)]
#[path = "../../mailgw/src/upload.rs"]
mod upload;

use fixture::Fixture;
use model::{Act, Backend, Config, Model, alphabet, parse, weight};
use serde_json::{Value, json};
use statecheck::{Error, Host, R, conformance, search};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

pub fn model_of(v: &Value) -> R<Model> {
    serde_json::from_value(v.clone()).map_err(|e| Error::new(e.to_string()))
}
fn act(v: &Value) -> R<Act> {
    v.as_str()
        .and_then(parse)
        .ok_or_else(|| Error::new(format!("unknown action {v}")))
}

/// Conformance host: the model predicts each step, the fixture runs it on the gateway.
pub struct Check {
    pub cfg: Config,
    fixture: Option<Fixture>,
    fixtures: u64,
    counting: bool,
    coverage: BTreeMap<String, u64>,
}
impl Check {
    pub fn new(cfg: Config) -> Self {
        Self {
            cfg,
            fixture: None,
            fixtures: 0,
            counting: true,
            coverage: BTreeMap::new(),
        }
    }
}
impl Host for Check {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        Ok(match name {
            "id" => json!(match self.cfg.backend {
                Backend::Memory => "bane.imap.memory-mirror",
                Backend::Remote => "bane.imap.remote-mirror",
            }),
            "initial" => json!(Model::initial(&self.cfg)),
            "enabled" => json!(model_of(&args[0])?.enabled(&self.cfg, act(&args[1])?)),
            "step" => {
                let mut m = model_of(&args[0])?;
                let a = act(&args[1])?;
                let out = m.step(&self.cfg, a);
                if self.counting {
                    for e in &out.events {
                        *self.coverage.entry((*e).into()).or_default() += 1;
                    }
                    let label = args[1].as_str().unwrap_or_default();
                    let verb = label
                        .split(' ')
                        .nth(1)
                        .filter(|_| a.session().is_some())
                        .unwrap_or(label);
                    *self.coverage.entry(format!("action:{verb}")).or_default() += 1;
                    if !out.ok {
                        *self.coverage.entry(format!("failed:{verb}")).or_default() += 1;
                    }
                }
                json!({"expected": m.expected(&out), "state": m})
            }
            "open" => {
                self.fixture = Some(Fixture::open(self.cfg)?);
                self.fixtures += 1;
                Value::Null
            }
            "act" => self
                .fixture
                .as_mut()
                .ok_or_else(|| Error::new("no open fixture"))?
                .act(args[1].as_str().unwrap_or_default())?,
            "close" => {
                if self.cfg.backend == Backend::Remote {
                    fake_api::abort_connections();
                }
                self.fixture = None;
                Value::Null
            }
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

/// Model-only host for tear's breadth-first state mapping.
struct Space {
    cfg: Config,
    labels: Vec<String>,
}
impl Host for Space {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        let mut m = model_of(&args[0])?;
        Ok(match name {
            "actions" => json!(
                self.labels
                    .iter()
                    .filter(|l| parse(l).is_some_and(|a| m.enabled(&self.cfg, a)))
                    .collect::<Vec<_>>()
            ),
            "step" => {
                m.step(&self.cfg, act(&args[1])?);
                json!(m.canonical())
            }
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

pub fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9e3779b97f4a7c15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

/// The action kind a label belongs to (its verb), so each kind gets the same share of a
/// walk however many flag and set variants it has.
fn kind(label: &str) -> &str {
    let mut w = label.split(' ');
    let first = w.next().unwrap_or_default();
    if model::SESSIONS.contains(&first) {
        w.next().unwrap_or(first)
    } else {
        first
    }
}

pub fn walk(seed: u64, len: usize, labels: &[String], cfg: &Config) -> Vec<String> {
    let mut x = seed;
    let mut m = Model::initial(cfg);
    let mut out: Vec<String> = vec![];
    let mut failed: Option<String> = None;
    for _ in 0..len {
        // A client retries a refused or failed command half the time (COPY replay, upload
        // lanes, refreshes after faults all hinge on the retry).
        if let Some(label) = failed.take()
            && splitmix(&mut x).is_multiple_of(2)
            && parse(&label).is_some_and(|a| m.enabled(cfg, a))
        {
            let a = parse(&label).unwrap_or(Act::Deliver);
            let o = m.step(cfg, a);
            if !o.ok && a.session().is_some() {
                failed = Some(label.clone());
            }
            out.push(label);
            continue;
        }
        let enabled: Vec<(&String, Act)> = labels
            .iter()
            .filter_map(|l| parse(l).filter(|a| m.enabled(cfg, *a)).map(|a| (l, a)))
            .collect();
        let mut kinds: BTreeMap<&str, u64> = BTreeMap::new();
        for (l, _) in &enabled {
            *kinds.entry(kind(l)).or_default() += 1;
        }
        let weighted: Vec<(&String, u64)> = enabled
            .iter()
            .map(|(l, a)| (*l, (weight(*a) * 840 / kinds[kind(l)]).max(1)))
            .collect();
        let total: u64 = weighted.iter().map(|e| e.1).sum();
        if total == 0 {
            break;
        }
        let mut pick = splitmix(&mut x) % total;
        let mut label = weighted[0].0;
        for (l, w) in &weighted {
            if pick < *w {
                label = l;
                break;
            }
            pick -= w;
        }
        if let Some(a) = parse(label) {
            let o = m.step(cfg, a);
            if !o.ok && a.session().is_some() {
                failed = Some(label.clone());
            }
        }
        out.push(label.clone());
    }
    out
}

/// A seeded random walk where each action kind (verb) gets an equal share before weights.
pub fn walk_weighted<S>(
    seed: u64,
    len: usize,
    labels: &[String],
    state: &mut S,
    weight: impl Fn(&S, &str) -> Option<u64>,
    mut step: impl FnMut(&mut S, &str),
) -> Vec<String> {
    let mut x = seed;
    let mut out = vec![];
    for _ in 0..len {
        let enabled: Vec<(&String, u64)> = labels
            .iter()
            .filter_map(|l| weight(state, l).map(|w| (l, w)))
            .collect();
        let mut kinds: BTreeMap<&str, u64> = BTreeMap::new();
        for (l, _) in &enabled {
            *kinds.entry(kind(l)).or_default() += 1;
        }
        let weighted: Vec<(&String, u64)> = enabled
            .iter()
            .map(|(l, w)| (*l, (w * 840 / kinds[kind(l)]).max(1)))
            .collect();
        let total: u64 = weighted.iter().map(|e| e.1).sum();
        if total == 0 {
            break;
        }
        let mut pick = splitmix(&mut x) % total;
        let mut label = weighted[0].0;
        for (l, w) in &weighted {
            if pick < *w {
                label = l;
                break;
            }
            pick -= w;
        }
        step(state, label);
        out.push(label.clone());
    }
    out
}

/// Group key: the action verb plus the mismatch path (digits elided), or the safety message.
pub fn signature(run: &Value) -> String {
    let index = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
    let step = &run["steps"][index];
    let label = step["action"].as_str().unwrap_or_default();
    let verb = label.split(' ').nth(1).unwrap_or(label);
    let path = run["mismatch"]["path"].as_str().unwrap_or_default();
    let detail = if path.starts_with("/safety") {
        step["observed"]["safety"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    } else {
        path.to_owned()
    };
    let detail: String = detail
        .chars()
        .map(|c| if c.is_ascii_digit() { '#' } else { c })
        .collect();
    format!("{verb}: {detail}")
}

pub fn focus(step: &Value, path: &str) -> Value {
    let key = path.split('/').nth(1).unwrap_or_default();
    json!({"expected": step["expected"][key], "observed": step["observed"][key]})
}

/// Run every trace, group mismatches by signature and reduce one witness per group.
pub fn campaign(
    name: &str,
    traces: impl Iterator<Item = Vec<String>>,
    host: &mut dyn Host,
    deadline: Option<Instant>,
) -> R<Value> {
    let start = Instant::now();
    let (mut total, mut matched, mut steps, mut errors) = (0u64, 0u64, 0u64, vec![]);
    let mut groups: BTreeMap<String, (u64, Vec<String>)> = BTreeMap::new();
    for trace in traces {
        if deadline.is_some_and(|d| Instant::now() > d) {
            break;
        }
        total += 1;
        let run = conformance::dispatch("runTrace", &json!({"actions": trace}), host)?;
        steps += run["steps"].as_array().map_or(0, |s| s.len() as u64);
        match run["status"].as_str() {
            Some("match") => matched += 1,
            Some("mismatch") => groups.entry(signature(&run)).or_insert((0, trace)).0 += 1,
            _ => {
                if errors.len() < 5 {
                    errors.push(json!({"trace": trace, "run": run}));
                }
            }
        }
    }
    let checked = start.elapsed();
    let mut witnesses = vec![];
    for (sig, (count, trace)) in &groups {
        let reduced = conformance::dispatch(
            "minimizeTrace",
            &json!({"actions": trace, "options": {"maxReplays": 2000}}),
            host,
        )?;
        let outcome = &reduced["outcome"];
        let path = outcome["mismatch"]["path"].as_str().unwrap_or_default();
        let last = outcome["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
        witnesses.push(json!({
            "signature": sig, "traces": count, "originalLength": trace.len(),
            "reduction": reduced["status"], "replays": reduced["replays"],
            "length": reduced["actions"].as_array().map_or(0, Vec::len),
            "actions": reduced["actions"], "path": path,
            "failingStep": focus(&outcome["steps"][last], path),
        }));
    }
    Ok(json!({
        "campaign": name, "traces": total, "matched": matched,
        "mismatched": groups.values().map(|g| g.0).sum::<u64>(), "errors": errors,
        "steps": steps, "checkMs": checked.as_millis() as u64,
        "totalMs": start.elapsed().as_millis() as u64, "witnesses": witnesses,
    }))
}

/// tear's BFS map, then the shortest path to every edge (every reachable transition).
fn edge_traces(depth: u64, max_states: u64, cfg: Config) -> R<(Value, Vec<Vec<String>>)> {
    let start = Instant::now();
    let mut space = Space {
        cfg,
        labels: alphabet(&cfg),
    };
    let graph = search::map_states(
        &json!(Model::initial(&cfg).canonical()),
        &json!({"maxDepth": depth, "maxStates": max_states}),
        &mut space,
    )?;
    let nodes = graph["nodes"].as_array().map_or(0, Vec::len);
    let edges = graph["edges"].as_array().cloned().unwrap_or_default();
    // Nodes are numbered in discovery order, so each node's first incoming edge is its BFS parent.
    let mut parent: Vec<Option<(usize, String)>> = vec![None; nodes];
    for e in &edges {
        let (from, to) = (
            e["from"].as_u64().unwrap_or(0) as usize,
            e["to"].as_u64().unwrap_or(0) as usize,
        );
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
    let info = json!({"graph": graph["status"], "states": nodes, "edges": edges.len(),
        "maxDepth": depth, "mapMs": start.elapsed().as_millis() as u64});
    Ok((info, traces))
}

pub struct Opts {
    pub args: Vec<String>,
    pub nums: Vec<u64>,
    pub seed: u64,
    pub deadline: Option<Instant>,
}
impl Opts {
    fn parse() -> Self {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let value = |k: &str| {
            args.iter()
                .position(|a| a == k)
                .and_then(|i| args.get(i + 1))
                .and_then(|v| v.parse::<u64>().ok())
        };
        let mut skip = std::collections::BTreeSet::new();
        for k in ["--seed", "--seconds", "--sessions"] {
            if let Some(i) = args.iter().position(|a| a == k) {
                skip.insert(i + 1);
            }
        }
        let nums = args
            .iter()
            .enumerate()
            .filter(|(i, _)| !skip.contains(i))
            .filter_map(|(_, a)| a.parse().ok())
            .collect();
        Self {
            seed: value("--seed").unwrap_or(0),
            deadline: value("--seconds").map(|s| Instant::now() + Duration::from_secs(s)),
            nums,
            args,
        }
    }
    pub fn has(&self, k: &str) -> bool {
        self.args.iter().any(|a| a == k)
    }
    fn config(&self) -> Config {
        let mut c = if self.has("--remote") {
            Config::remote()
        } else {
            Config::memory()
        };
        c.shared_kid = self.has("--shared-kid");
        c.split = self.has("--split");
        c.silent = !self.has("--no-silent");
        c.faults &= !self.has("--no-faults");
        c.folders = !self.has("--no-folders") && !self.has("--minimal");
        if self.has("--minimal") {
            c.uid = false;
            c.examine = false;
        }
        c.uploads = self.has("--uploads");
        if self.has("--bulk") {
            c.bulk = true;
            c.folders = false;
            c.cap = 2200;
        }
        if let Some(i) = self.args.iter().position(|a| a == "--sessions") {
            c.sessions = self
                .args
                .get(i + 1)
                .and_then(|v| v.parse().ok())
                .unwrap_or(2)
                .clamp(1, 4);
        }
        c
    }
}

fn describe(cfg: &Config) -> String {
    format!(
        "{:?}, {} sessions{}{}{}{}{}{}",
        cfg.backend,
        cfg.sessions,
        if cfg.shared_kid {
            ", shared credential"
        } else {
            ""
        },
        if cfg.split {
            ", two gateway processes"
        } else {
            ""
        },
        if cfg.silent { "" } else { ", no .SILENT" },
        if cfg.faults && cfg.backend == Backend::Remote {
            ", faults"
        } else {
            ""
        },
        if cfg.uploads { ", split APPEND" } else { "" },
        if cfg.bulk { ", 1000-UID bulk" } else { "" },
    )
}

fn random(cfg: Config, n: u64, len: usize, seed: u64, deadline: Option<Instant>) -> R<Value> {
    let labels = alphabet(&cfg);
    let traces = (0..n).map(move |i| {
        walk(
            seed.wrapping_mul(0x1000_0000).wrapping_add(i),
            len,
            &labels,
            &cfg,
        )
    });
    let mut host = Check::new(cfg);
    let mut r = campaign(
        &format!("random walks, {}", describe(&cfg)),
        traces,
        &mut host,
        deadline,
    )?;
    r["fixtures"] = json!(host.fixtures);
    r["coverage"] = json!(host.coverage);
    Ok(r)
}

fn edges(cfg: Config, depth: u64, max: u64, deadline: Option<Instant>) -> R<Value> {
    let (info, traces) = edge_traces(depth, max, cfg)?;
    let mut host = Check::new(cfg);
    let mut r = campaign(
        &format!("edge coverage, {}", describe(&cfg)),
        traces.into_iter(),
        &mut host,
        deadline,
    )?;
    r["model"] = info;
    r["fixtures"] = json!(host.fixtures);
    r["coverage"] = json!(host.coverage);
    Ok(r)
}

pub fn replay(cfg: Config, actions: &[String]) -> R<Value> {
    let mut host = Check::new(cfg);
    let run = conformance::dispatch("runTrace", &json!({"actions": actions}), &mut host)?;
    let path = run["mismatch"]["path"].as_str().unwrap_or_default();
    let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
    let mut out = json!({"status": run["status"], "mismatch": run["mismatch"], "error": run["error"],
        "failingStep": if path.is_empty() { Value::Null } else { focus(&run["steps"][at], path) }});
    if run["status"] == "mismatch" {
        let reduced = conformance::dispatch(
            "minimizeTrace",
            &json!({"actions": actions, "options": {"maxReplays": 2000}}),
            &mut host,
        )?;
        out["reduced"] = reduced["actions"].clone();
        out["reduction"] = reduced["status"].clone();
    }
    out["coverage"] = json!(host.coverage);
    Ok(out)
}

/// Shrunk witnesses of every bug this harness found, replayed on every `ci` run. Random walks
/// at the CI budget reach the rarer ones only occasionally.
const REGRESSIONS: &[(&str, &[&str])] = &[
    // 5ff8f00: a .SILENT STORE swallowed another session's flag change.
    (
        "memory",
        &[
            "deliver",
            "A noop",
            "B noop",
            "B store +flagged loud 1",
            "A store +seen silent 1",
            "A noop",
        ],
    ),
    // A committed COPY reported NO when the refresh after it failed.
    (
        "remote",
        &[
            "deliver",
            "hint",
            "A noop",
            "fail-snapshot",
            "A copy 1 Archive",
        ],
    ),
    // Two refused APPENDs kept both upload permits of the credential.
    (
        "remote-shared",
        &["B append Work", "A append Work", "A append INBOX"],
    ),
    // BYE inside COPY, then a tagged OK, and the connection stayed open.
    (
        "remote",
        &[
            "B create Work",
            "A select Work",
            "B delete Work",
            "A copy 1 Archive",
        ],
    ),
    // 1,001-UID STORE, COPY and MOVE run in batches inside one command (no NO [LIMIT]).
    (
        "remote-bulk",
        &[
            "bulk",
            "deliver",
            "hint",
            "A noop",
            "A store +seen loud 1:*",
            "A copy 1:* Archive",
            "A move 1:* Archive",
            "A select Archive",
            "A noop",
        ],
    ),
    // The second batch of a COPY fails: the first stays, NO; the retry replays batch one
    // (its receipt) and copies batch two, so Archive ends with exactly one copy of each.
    (
        "remote-bulk",
        &[
            "bulk",
            "deliver",
            "hint",
            "A noop",
            "fail-batch",
            "A copy 1:* Archive",
            "A copy 1:* Archive",
            "A select Archive",
        ],
    ),
    // A STORE stopped after its first batch reports what changed, answers NO; the retry
    // completes it.
    (
        "remote-bulk",
        &[
            "bulk",
            "deliver",
            "hint",
            "A noop",
            "fail-batch",
            "A store +seen loud 1:*",
            "A store +seen loud 1:*",
            "A noop",
        ],
    ),
    // Another writer expunges a message between two EXPUNGE batches ("empty Trash").
    (
        "remote-bulk",
        &[
            "bulk",
            "deliver",
            "hint",
            "A noop",
            "A store +deleted silent 1:*",
            "race-batch",
            "A expunge",
            "A noop",
        ],
    ),
    // The process dies after a COPY's last batch: no answer; a retry on a new connection has
    // a new ticket and copies again (at-least-once across a crash).
    (
        "remote-bulk",
        &[
            "bulk",
            "deliver",
            "hint",
            "A noop",
            "crash-batch",
            "A copy 1:* Archive",
            "A reconnect",
            "A copy 1:* Archive",
            "A select Archive",
        ],
    ),
    // A COPY whose response was lost is retried with the same ticket: no second copy.
    (
        "remote",
        &[
            "deliver",
            "hint",
            "A noop",
            "lose-response",
            "A copy 1 Archive",
            "A copy 1 Archive",
            "A noop",
        ],
    ),
    // Three spooled APPENDs fill the credential and inbox upload lanes; the fourth gets
    // NO [LIMIT] until one completes.
    (
        "remote-uploads",
        &[
            "A append-begin INBOX",
            "B append-begin INBOX",
            "C append-begin INBOX",
            "D append INBOX",
            "A append-end",
            "D append INBOX",
        ],
    ),
    // Two sessions of one credential in DATA fill its lane; the third gets 452.
    (
        "smtp-remote",
        &[
            "A ehlo",
            "A auth",
            "A pipeline",
            "B ehlo",
            "B auth",
            "B pipeline",
            "C ehlo",
            "C auth",
            "C pipeline",
            "A body own",
            "C pipeline",
        ],
    ),
    // A STORE on a folder another session deleted after this snapshot: the API refuses it.
    (
        "remote",
        &[
            "B create Work",
            "B append Work",
            "A select Work",
            "B delete Work",
            "A store +seen loud 1",
        ],
    ),
    // A reconnect whose SELECT failed kept LOGIN's folder list (from the 5 s login cache, older
    // than Work): APPEND to Work answered NO [TRYCREATE]. Now the next command refreshes first.
    (
        "remote",
        &[
            "B idle",
            "fail-snapshot",
            "hint",
            "B wake",
            "A create Work",
            "fail-snapshot",
            "B reconnect",
            "B append Work",
        ],
    ),
    // Model: a slot left unfetchable in INBOX is not blind in the next selection (EXAMINE
    // Archive, whose UID 1 is another message).
    (
        "remote-3",
        &[
            "deliver",
            "C store +todo silent 1:*",
            "A uid-expunge",
            "A fetch-body 1",
            "B uid-expunge",
            "B move 1 Archive",
            "fail-snapshot",
            "C move 1 INBOX",
            "deliver",
            "B append INBOX",
            "C examine Archive",
        ],
    ),
    // A clock stepping back across midnight reopened the SMTP caps (Memory sink).
    (
        "smtp",
        &[
            "A ehlo",
            "A auth",
            "tick",
            "tick",
            "A mail own",
            "A rcpt",
            "A rcpt",
            "A rcpt",
            "A data",
            "A body own",
            "skew",
            "A pipeline",
            "A body own",
        ],
    ),
];

/// The configurations regression witnesses name.
pub fn named(kind: &str) -> Config {
    let mut cfg = if kind == "memory" {
        Config::memory()
    } else {
        Config::remote()
    };
    cfg.shared_kid = matches!(kind, "remote-shared" | "remote-uploads");
    if kind == "remote-uploads" {
        cfg.uploads = true;
        cfg.sessions = 4;
    }
    if kind == "remote-3" {
        cfg.sessions = 3;
    }
    if kind == "remote-bulk" {
        cfg.bulk = true;
        cfg.folders = false;
        cfg.cap = 2200;
    }
    cfg
}

fn regressions() -> R<Value> {
    let start = Instant::now();
    let mut failed = vec![];
    let mut coverage: BTreeMap<String, u64> = BTreeMap::new();
    for (kind, actions) in REGRESSIONS {
        let actions: Vec<String> = actions.iter().map(|a| (*a).to_owned()).collect();
        let r = match *kind {
            "smtp" => smtp::replay(false, &actions)?,
            "smtp-remote" => smtp::replay(true, &actions)?,
            _ => replay(named(kind), &actions)?,
        };
        for (k, v) in r["coverage"].as_object().into_iter().flatten() {
            *coverage.entry(k.clone()).or_default() += v.as_u64().unwrap_or(0);
        }
        if r["status"] != "match" {
            failed.push(json!({"kind": kind, "actions": actions, "result": r}));
        }
    }
    Ok(
        json!({"campaign": "regression witnesses", "traces": REGRESSIONS.len(),
        "steps": REGRESSIONS.iter().map(|r| r.1.len()).sum::<usize>(),
        "mismatched": failed.len(), "errors": [], "totalMs": start.elapsed().as_millis() as u64,
        "witnesses": failed, "coverage": coverage}),
    )
}

/// The PR gate: every configuration at a budget that keeps the whole run under a minute on
/// a GitHub runner (about 30 s on an idle M-series Mac). `deep` documents the nightly budget.
fn ci(seed: u64) -> R<Value> {
    let start = Instant::now();
    let mut runs = vec![regressions()?];
    let mut minimal = Config::memory();
    minimal.folders = false;
    minimal.uid = false;
    minimal.examine = false;
    // Exhaustive: the shortest path to every transition of the two-session core, depth 4.
    runs.push(edges(minimal, 4, 200_000, None)?);
    runs.push(random(Config::memory(), 3000, 40, seed, None)?);
    let mut three = Config::memory();
    three.sessions = 3;
    runs.push(random(three, 1000, 40, seed + 1, None)?);
    let remote = Config::remote();
    runs.push(random(remote, 600, 30, seed + 2, None)?);
    let mut shared = remote;
    shared.shared_kid = true;
    runs.push(random(shared, 600, 30, seed + 3, None)?);
    let mut split = remote;
    split.split = true;
    split.sessions = 3;
    runs.push(random(split, 400, 30, seed + 4, None)?);
    runs.push(random(named("remote-uploads"), 400, 30, seed + 7, None)?);
    runs.push(random(named("remote-bulk"), 40, 25, seed + 8, None)?);
    runs.push(smtp::run(false, 2000, 30, seed + 5, None)?);
    runs.push(smtp::run(true, 400, 30, seed + 6, None)?);
    for t in [
        "transcripts/silent-store.txt",
        "transcripts/deleted-folder-copy.txt",
    ] {
        let cfg = if t.contains("folder") {
            Config::remote()
        } else {
            Config::memory()
        };
        let r = transcript::run(cfg, t)?;
        runs.push(json!({"campaign": format!("transcript {t}"), "traces": 1,
            "steps": r["actions"].as_array().map_or(0, Vec::len),
            "mismatched": u64::from(r["status"] != "match"), "errors": [], "totalMs": 0,
            "witnesses": if r["status"] == "match" { json!([]) } else { json!([r]) }}));
    }
    let mismatched: u64 = runs
        .iter()
        .map(|r| r["mismatched"].as_u64().unwrap_or(0))
        .sum();
    let errors: usize = runs
        .iter()
        .map(|r| r["errors"].as_array().map_or(0, Vec::len))
        .sum();
    let mut coverage: BTreeMap<String, u64> = BTreeMap::new();
    for r in &runs {
        if let Some(c) = r["coverage"].as_object() {
            for (k, v) in c {
                *coverage.entry(k.clone()).or_default() += v.as_u64().unwrap_or(0);
            }
        }
    }
    coverage.insert(
        "api:paged-snapshot".into(),
        fake_api::PAGES.load(std::sync::atomic::Ordering::Relaxed),
    );
    coverage.insert(
        "api:delta-snapshot".into(),
        fake_api::DELTAS.load(std::sync::atomic::Ordering::Relaxed),
    );
    Ok(json!({
        "checklist": checklist(&coverage),
        "verdict": if mismatched == 0 && errors == 0 { "match" } else { "mismatch" },
        "mismatched": mismatched, "errors": errors, "totalMs": start.elapsed().as_millis() as u64,
        "runs": runs.iter().map(|r| json!({"campaign": r["campaign"], "traces": r["traces"],
            "steps": r["steps"], "mismatched": r["mismatched"], "errors": r["errors"],
            "ms": r["totalMs"], "model": r["model"], "witnesses": r["witnesses"]})).collect::<Vec<_>>(),
        "coverage": coverage,
    }))
}

/// The edge-case checklist at the top of this file, against what a run reached.
fn checklist(c: &BTreeMap<String, u64>) -> Value {
    let n = |k: &str| c.get(k).copied().unwrap_or(0);
    let item = |id: &str, keys: &[&str]| {
        let counts: BTreeMap<&str, u64> = keys.iter().map(|k| (*k, n(k))).collect();
        let reached = counts.values().all(|v| *v > 0);
        json!({"id": id, "reached": reached, "counts": counts})
    };
    let not = |id: &str, why: &str| json!({"id": id, "reached": false, "why": why});
    json!([
        item(
            "C1 interleavings, 2-3 sessions",
            &["action:store", "action:noop", "action:idle"]
        ),
        item(
            "C2 .SILENT vs another session's change",
            &["store-silent", "store-loud"]
        ),
        item("C3 target vanished under a command", &["target-vanished"]),
        item(
            "C4 hints: idle, pending, coalesced",
            &["hint-consumed", "hint-coalesced", "wake-cache-fill"]
        ),
        item(
            "C5 shared wake cache, stale hit",
            &["wake-cache-hit", "wake-cache-hit-stale"]
        ),
        item("C6 copy into the selected folder", &["copy-into-selected"]),
        item(
            "C7 upload lanes: credential, inbox, workspace",
            &["upload-held", "upload-lane-busy"]
        ),
        item("C8 SMTP DATA lanes", &["smtp:data-lane-busy"]),
        item(
            "R1 refused command, reconnect",
            &["refused-before-command", "action:reconnect"]
        ),
        item(
            "R5 lost response, idempotent COPY replay",
            &["response-lost", "copy-replayed"]
        ),
        item(
            "R6 failure, crash and a concurrent writer between batches",
            &[
                "partial-applied",
                "crash-mid-command",
                "race-between-batches"
            ]
        ),
        item(
            "R2 refresh fails after a commit",
            &["refresh-failed-after-commit"]
        ),
        item(
            "R3 lost, duplicated, one-process hints",
            &["action:hint", "hint-coalesced", "hint-one-process"]
        ),
        item(
            "R4 SMTP retry after refusal",
            &["smtp:451", "smtp:553", "smtp:503"]
        ),
        item("L1 240 s snapshot age", &["aged-refresh"]),
        item("L2 tombstone floor passes since", &["floor-full-reload"]),
        item(
            "L3 SMTP day/month boundary and clock step back",
            &["smtp:clock-back", "smtp:451"]
        ),
        not(
            "L4 5 s store deadline, 1 s admission sleep",
            "wall-clock inside the adapter"
        ),
        item("B1 empty sequence and UID sets", &["empty-set"]),
        item(
            "B5 over 1,000 UIDs: batches in one command",
            &["batched", "batched-done"]
        ),
        item(
            "B2 snapshot paging and deltas",
            &["api:paged-snapshot", "api:delta-snapshot"]
        ),
        item(
            "B3 50 RCPT, caps at the boundary, 16 MiB",
            &["smtp:452", "smtp:451", "smtp:552"]
        ),
        not(
            "B4 2048-row pages, 50k-message folders, 8 MiB literals",
            "too slow per step; e2e large-folder and unit tests"
        ),
        item(
            "D1 selected folder deleted, recreated",
            &[
                "bye-deleted-folder",
                "bye-after-completion",
                "delete-selected-elsewhere"
            ]
        ),
        item(
            "D2 mutation on a folder deleted elsewhere",
            &["api-refused-deleted-folder"]
        ),
        item("D3 credentials revoked", &["revoked-bye"]),
        item("D4 read-only (EXAMINE) refusals", &["read-only-refused"]),
        item("D5 SMTP sender ownership", &["smtp:553", "smtp:555"]),
        item("O1 two gateway processes", &["hint-one-process"]),
        not("O2 two gateway versions at once", "one binary under test"),
        item("P1 snapshot read failures", &["snapshot-failed"]),
        item("P2 internal submit refusals", &["smtp:451"]),
        not(
            "X1 Dovecot conformance",
            "Docker: `mailgw-tear dovecot` (nightly)"
        ),
        item("X2 client transcript replay", &["action:copy"]),
    ])
}

fn main() {
    let _rt = fake_api::runtime().enter();
    let o = Opts::parse();
    let cfg = o.config();
    let report = match o.args.first().map(String::as_str) {
        Some("smtp-trace") => {
            let actions: Vec<String> = o.args[1..]
                .iter()
                .filter(|a| !a.starts_with("--"))
                .cloned()
                .collect();
            smtp::replay(o.has("--remote"), &actions)
        }
        Some("trace") => {
            let actions: Vec<String> = o.args[1..]
                .iter()
                .filter(|a| !a.starts_with("--") && parse(a).is_some())
                .cloned()
                .collect();
            replay(cfg, &actions)
        }
        Some("transcript") => {
            transcript::run(cfg, o.args.get(1).map(String::as_str).unwrap_or("-"))
        }
        Some("edges") => edges(
            cfg,
            o.nums.first().copied().unwrap_or(5),
            o.nums.get(1).copied().unwrap_or(200_000),
            o.deadline,
        ),
        Some("smtp") => smtp::run(
            o.has("--remote"),
            o.nums.first().copied().unwrap_or(2000),
            o.nums.get(1).copied().unwrap_or(30) as usize,
            o.seed,
            o.deadline,
        ),
        Some("dovecot") => dovecot::run(
            o.nums.first().copied().unwrap_or(200),
            o.nums.get(1).copied().unwrap_or(25) as usize,
            o.seed,
            o.deadline,
            &o,
        ),
        Some("ci") => ci(o.seed),
        _ => random(
            cfg,
            o.nums.first().copied().unwrap_or(2000),
            o.nums.get(1).copied().unwrap_or(40) as usize,
            o.seed,
            o.deadline,
        ),
    };
    match report {
        Ok(r) => {
            println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
            let bad = r["mismatched"].as_u64().unwrap_or(0) > 0
                || r["errors"].as_array().is_some_and(|e| !e.is_empty())
                || r["errors"].as_u64().unwrap_or(0) > 0
                || r["status"].as_str().is_some_and(|s| s != "match")
                || r["verdict"].as_str().is_some_and(|s| s != "match");
            std::process::exit(i32::from(bad));
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    }
}
