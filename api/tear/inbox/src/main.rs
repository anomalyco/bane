//! tear state model for inbox phase 2 on the API and PostgreSQL: the reference model
//! (`model.rs`) predicts every step, the Bun host (`host.ts`) runs it on the real routes and SQL
//! routines over an isolated database, and tear's conformance runner diffs the two.
//!
//!   cargo run --release -- ci                      PR-sized run (random walks + exhaustive edges)
//!   cargo run --release -- random [N] [LEN] [--seed S] [--msgs M] [--quota Q|none]
//!   cargo run --release -- edges [DEPTH] [MAX_STATES] [--msgs M] [--quota Q|none]
//!   cargo run --release -- trace ACTION...         replay one trace, e.g. "accept m1 a" "store m1"
//!
//! Run from `api/tear/inbox`. Requires TEAR_DATABASE_URL: a plain loopback URL of a dedicated,
//! migrated PostgreSQL database marked disposable (`../disposable.ts`, shared by every tear host).
//!
//! # Edge-case checklist
//!
//! Each item names the actions that reach it (labels from `model::alphabet`). Connections I and J
//! are ingest workers; W and V are API request handlers whose statement runs and holds its locks
//! until a separate `commit`/`abort` step; unprefixed actions are autocommit requests. [x] items
//! were reached in the recorded runs (`coverage` in every report); [ ] items say why not.
//!
//!
//! ## Concurrency and interleavings
//!
//! - [x] Store holding the ingest lane while an expunge, folder purge, conversation patch or inbox
//!   delete waits for it, and the reverse (`I store` with `W expunge|purge|delete`).
//! - [x] Store waiting on an inbox row held by an uncommitted flag/move/copy (`W move`, `I store`).
//! - [x] Store waiting on its receipt row while an SNS reopen is uncommitted (`W accept`, `I store`);
//!   the waiter keeps the row lock even when its recheck finds the receipt reopened.
//! - [x] SNS notifications contending on the receipt row, the hourly admission window and the
//!   receiving-turn row (`W accept`, `V accept`).
//! - [x] Two writers on one inbox (`W move`, `V flag`) and on different inboxes (no wait).
//! - [x] Store to both inboxes in id order while one inbox row is held.
//! - [x] Reads during uncommitted work see committed state only (`folders`, `sync`, `get`).
//! - [x] A blocked statement completes at the holder's COMMIT or ROLLBACK, serialized after it.
//! - [ ] Two statements blocked at once: disabled, because which waiter wins the next lock is a
//!   scheduling race PostgreSQL does not order. A store whose only owners have the message
//!   tombstoned may or may not lock their inbox rows (plan-dependent); contending actions are
//!   disabled while that is open, since either outcome is correct.
//!
//! ## Crashes, aborts, retries and duplicates
//!
//! - [x] Ingest crash before commit (`I abort`), then retry (`I claim`, `I store`).
//! - [x] API request abort after its statement (`W abort`): no UID, MODSEQ or counter leaks.
//! - [x] Duplicate SNS notification (same recipients): no job, no second membership.
//! - [x] Duplicate SES receipt under another SES id (`d1`, same Message-ID and content as m1):
//!   one stored message, no second membership, no resurrection after expunge.
//! - [x] Second runner after lease expiry (`I` and `J` claim one receipt; the second store waits
//!   on the lane, then finds it processed).
//! - [x] Receipt reopen with extra recipients before and after processing; a stale claim from
//!   before the reopen stores nothing; reopen after an expunge delivers only to new inboxes.
//!
//! ## Lease or lock expiry, clock skew and time
//!
//! - [x] Lease expiry as the second runner (`J`) racing the first (`I`).
//! - [x] Expunge history past 30 days (`age`, `prune`): checkpoint equal to the floor is valid,
//!   one below is CHANGES_EXPIRED and the client resyncs from folders (ci boundary traces).
//! - [ ] Lock and statement timeouts, Worker clock skew, ephemeral lease expiry and grace (held
//!   `expired`): not modelled; both inboxes are persistent and the SQL has no fake clock.
//!
//! ## Limits and caps
//!
//! - [x] Message quota exactly reached (`--quota 1|2`): the next delivery is held, unfiled and
//!   counted; an expunge frees the slot for later mail (ci boundary trace).
//! - [x] Empty folder purge, sync with no changes, since=0, since=state, since=state+1
//!   (`sync-ahead`: CHANGES_EXPIRED).
//! - [ ] Byte quota, 500-entry purge and change pages (`hasMore`), 64 keywords, 200 recipients:
//!   unreachable at model sizes; bounded in SQL and covered by acceptance tests.
//!
//! ## Revocation and deletion racing in-flight work
//!
//! - [x] Inbox delete racing an open store, flag/move/copy and expunge (`W delete`, `V seen`),
//!   then the sweep erasing it (`sweep`). Requests to a deleted inbox return 404 and mail for
//!   it is not filed.
//! - [x] Read-only inbox credential cannot mutate (`ro`). Workspace keys and MCP grants: the
//!   grants area.
//!
//! ## Old and new Worker overlap (rollouts and rollbacks)
//!
//! - [x] Pre-folder Worker writes to an inbox (`legacy-read`, `legacy-thread`, `legacy-unread`)
//!   fail with 40001 or change nothing. Its reads are unfenced by design.
//!
//! ## Partial failures of external calls
//!
//! - [x] SES/SNS duplicate, late (reopen) and repeated notifications. S3/R2 reads happen before
//!   the store statement and webhook fan-out after commit, so their failures are `I abort`
//!   plus a retry; webhook delivery itself is the routing area.
//!
//! ## Other
//!
//! - [x] Overlapping inboxes share one stored message but not flags, UIDs, MODSEQ or counters.
//! - [x] Same-folder copy makes several entries: role-only locators are AMBIGUOUS_ENTRY.
//! - [x] Conditional update with a stale ifModseq is MODIFIED (`get`, a change, `cas`).
//! - [x] Sent copies get Sent-folder UIDs and counters (`send`); conversation archive, trash,
//!   restore and read patches move every entry (`thread`).
//! - [x] A reply joins the first message's conversation only when that message was stored first.
//!
//! # Properties (checked on every step)
//! - The committed view (folders, entries, memberships, tombstones, thread summaries, receipts)
//!   equals the model's; every request result, including UID and MODSEQ values, equals it.
//! - Host safety, independent of the model: counters equal a recount (total, unseen, messages,
//!   held, bytes, thread summaries); UIDNEXT above every UID; HIGHESTMODSEQ and inbox MODSEQ above
//!   every stamp and never decreasing; UIDVALIDITY stable; a newly visible UID exceeds every UID
//!   already visible (UIDs commit in UID order); a removed membership never reappears.
mod fixture;
mod model;

use fixture::Host;
use model::{Act, Model, alphabet, parse};
use serde_json::{Value, json};
use statecheck::{Error, Host as TearHost, R, conformance, search};
use std::{collections::BTreeMap, time::Instant};

const PROPERTY: &str = "bane.inbox.phase2";

/// Shortest witnesses of bugs this model found, replayed on every `ci` run: (quota of A, actions).
const REGRESSIONS: &[(Option<i64>, &[&str])] = &[
    // A flag change waiting on the inbox row behind DELETE /v1/inboxes/{id} changed the deleted inbox.
    (
        Some(1),
        &[
            "accept m1 a",
            "store m1",
            "W delete A",
            "V seen A m1",
            "W commit",
        ],
    ),
    // A pre-folder Worker's conversation PATCH {read:false} recounted unread mail including held mail.
    (
        Some(1),
        &[
            "accept m1 a",
            "store m1",
            "accept m2 a",
            "store m2",
            "legacy-unread A m1",
        ],
    ),
    // Boundaries: quota exactly reached (m2 held) and freed by an expunge (m3 filed); a sync
    // checkpoint equal to the expunge-history floor is valid, one below it and one above the
    // current state are CHANGES_EXPIRED.
    (
        Some(1),
        &[
            "accept m1 a",
            "store m1",
            "accept m2 a",
            "store m2",
            "expunge A m1 inbox",
            "accept m3 a",
            "store m3",
            "folders A",
        ],
    ),
    (
        Some(1),
        &[
            "accept m1 ab",
            "store m1",
            "move A m1 inbox trash",
            "sync A",
            "age",
            "prune",
            "sync A",
            "sync-ahead A",
            "sync B",
        ],
    ),
    (
        Some(1),
        &[
            "accept m1 a",
            "store m1",
            "move A m1 inbox trash",
            "age",
            "prune",
            "sync A",
            "seen A m1",
            "sync A",
        ],
    ),
];

fn model(v: &Value) -> R<Model> {
    serde_json::from_value(v.clone()).map_err(|e| Error::new(e.to_string()))
}
fn act(v: &Value) -> R<Act> {
    v.as_str()
        .and_then(parse)
        .ok_or_else(|| Error::new(format!("unknown action {v}")))
}

#[derive(Clone, Copy)]
struct Cfg {
    msgs: u8,
    quota: Option<i64>,
}

/// Conformance host: the model predicts each step, the Bun host runs it on the real API.
struct Check {
    cfg: Cfg,
    host: Host,
    fixtures: u64,
}
impl TearHost for Check {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        Ok(match name {
            "id" => json!(PROPERTY),
            "initial" => json!(Model::initial(self.cfg.msgs, self.cfg.quota)),
            "enabled" => json!(model(&args[0])?.enabled(act(&args[1])?)),
            "step" => {
                let mut m = model(&args[0])?;
                let (r, woke) = m.step(act(&args[1])?);
                json!({"expected": {"r": r, "woke": woke, "view": m.view(), "safety": []}, "state": m})
            }
            "open" => {
                self.host.reset(self.cfg.quota)?;
                self.fixtures += 1;
                Value::Null
            }
            "act" => self.host.act(args[1].as_str().unwrap_or_default())?,
            "close" => Value::Null,
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

/// Model-only host for tear's breadth-first state mapping.
struct Space {
    labels: Vec<String>,
}
impl TearHost for Space {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        let mut m = model(&args[0])?;
        Ok(match name {
            "actions" => json!(
                self.labels
                    .iter()
                    .filter(|l| parse(l).is_some_and(|a| m.enabled(a)))
                    .collect::<Vec<_>>()
            ),
            "step" => {
                m.step(act(&args[1])?);
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

/// Relative weight of an action in random walks: keep deliveries and commits frequent and
/// inbox deletion and maintenance rare, so walks build state before tearing it down.
fn weight(label: &str) -> u64 {
    let words: Vec<&str> = label.split(' ').collect();
    let verb = if model::CONNS.contains(&words[0]) {
        words[1]
    } else {
        words[0]
    };
    match verb {
        "delete" | "sweep" => 1,
        "age" => 2,
        "prune" => 6,
        "commit" => 40,
        "abort" => 8,
        "accept" => 3,
        "store" | "claim" => 14,
        "legacy-read" | "legacy-thread" | "legacy-unread" | "ro" | "thread" => 2,
        "sync" | "folders" => 6,
        _ => 4,
    }
}

fn walk(seed: u64, len: usize, labels: &[String], cfg: Cfg) -> Vec<String> {
    let mut x = seed;
    let mut m = Model::initial(cfg.msgs, cfg.quota);
    let mut out = vec![];
    for _ in 0..len {
        let enabled: Vec<&String> = labels
            .iter()
            .filter(|l| parse(l).is_some_and(|a| m.enabled(a)))
            .collect();
        if enabled.is_empty() {
            break;
        }
        let total: u64 = enabled.iter().map(|l| weight(l)).sum();
        let mut pick = splitmix(&mut x) % total;
        let label = enabled.iter().find(|l| {
            let w = weight(l);
            if pick < w {
                true
            } else {
                pick -= w;
                false
            }
        });
        let label = label.unwrap();
        m.step(parse(label).unwrap());
        out.push((*label).clone());
    }
    out
}

/// Group key: the action verb plus the mismatch path (digits elided), or the safety message.
fn signature(run: &Value) -> String {
    let index = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
    let step = &run["steps"][index];
    let label = step["action"].as_str().unwrap_or_default();
    let words: Vec<&str> = label.split(' ').collect();
    let verb = if model::CONNS.contains(&words[0]) {
        words.get(1).copied().unwrap_or(label)
    } else {
        words[0]
    };
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

fn focus(step: &Value, path: &str) -> Value {
    let mut parts = path.split('/').skip(1);
    let key = parts.next().unwrap_or_default();
    let sub = parts.next();
    let pick = |v: &Value| match sub {
        Some(s) if key == "view" => v[key][s].clone(),
        _ => v[key].clone(),
    };
    json!({"action": step["action"], "expected": pick(&step["expected"]), "observed": pick(&step["observed"])})
}

fn campaign(name: &str, traces: Vec<Vec<String>>, cfg: Cfg, replays: u64, host: Host) -> R<Value> {
    let start = Instant::now();
    let mut check = Check {
        cfg,
        host,
        fixtures: 0,
    };
    let (mut matched, mut steps, mut errors) = (0u64, 0u64, vec![]);
    let mut groups: BTreeMap<String, (u64, Vec<String>)> = BTreeMap::new();
    let mut coverage: BTreeMap<String, u64> = BTreeMap::new();
    let total = traces.len();
    for trace in traces {
        let run = conformance::dispatch("runTrace", &json!({"actions": trace}), &mut check)?;
        steps += run["steps"].as_array().map_or(0, |s| s.len() as u64);
        for step in run["steps"].as_array().into_iter().flatten() {
            *coverage.entry(outcome(step)).or_default() += 1;
        }
        match run["status"].as_str() {
            Some("match") => matched += 1,
            Some("mismatch") => {
                let g = groups.entry(signature(&run)).or_insert((0, trace.clone()));
                g.0 += 1;
                if trace.len() < g.1.len() {
                    g.1 = trace;
                }
            }
            _ => errors.push(run),
        }
    }
    let checked = start.elapsed();
    let mut witnesses = vec![];
    for (sig, (count, trace)) in &groups {
        let reduced = conformance::dispatch(
            "minimizeTrace",
            &json!({"actions": trace, "options": {"maxReplays": replays}}),
            &mut check,
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
        "steps": steps, "fixtures": check.fixtures,
        "checkMs": checked.as_millis() as u64, "totalMs": start.elapsed().as_millis() as u64,
        "coverage": coverage, "witnesses": witnesses,
    }))
}

/// Coverage class of one observed step: held-open or autocommit verb, plus its outcome kind.
fn outcome(step: &Value) -> String {
    let label = step["action"].as_str().unwrap_or_default();
    let words: Vec<&str> = label.split(' ').collect();
    let held = model::CONNS.contains(&words[0]);
    let verb = if held { words[1] } else { words[0] };
    let r = &step["observed"]["r"];
    let kind = match r.as_str() {
        Some(s) if s.starts_with("e:") => s.to_owned(),
        Some("blocked") => "blocked".into(),
        _ if r.get("removed") == Some(&json!(true)) => "removed".into(),
        _ if r.get("queued") == Some(&json!(0)) => "duplicate".into(),
        _ if verb == "store" && r.is_null() => "nothing".into(),
        _ => "ok".into(),
    };
    let woke = step["observed"]["woke"].as_object().map_or(0, |w| w.len());
    let held_mail = step["observed"]["view"]["A"]["h"].as_i64().unwrap_or(0) > 0;
    format!(
        "{}{verb}:{kind}{}{}",
        if held { "txn " } else { "" },
        if woke > 0 { "+woke" } else { "" },
        if held_mail && verb == "store" {
            "+held"
        } else {
            ""
        }
    )
}

fn edges(depth: u64, max_states: u64, cfg: Cfg) -> R<(Value, Vec<Vec<String>>)> {
    let start = Instant::now();
    let mut space = Space {
        labels: alphabet(cfg.msgs, true),
    };
    let graph = search::map_states(
        &json!(Model::initial(cfg.msgs, cfg.quota)),
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
    // Only edges out of a node are new transitions; a trace per edge replays its BFS path.
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

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn main() -> R<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let quota = |default: Option<i64>| match flag(&args, "--quota").as_deref() {
        Some("none") => None,
        Some(q) => q.parse().ok(),
        None => default,
    };
    let msgs = |default: u8| {
        flag(&args, "--msgs")
            .and_then(|m| m.parse().ok())
            .unwrap_or(default)
            .clamp(1, 3)
    };
    let seed: u64 = flag(&args, "--seed")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let replays: u64 = flag(&args, "--replays")
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let flags = ["--quota", "--msgs", "--seed", "--replays"];
    let nums: Vec<u64> = args
        .iter()
        .enumerate()
        .filter(|(i, _)| *i == 0 || !flags.contains(&args[i - 1].as_str()))
        .filter_map(|(_, a)| a.parse().ok())
        .collect();
    let report = match args.first().map(String::as_str) {
        Some("trace") => {
            let actions: Vec<&String> = args[1..]
                .iter()
                .filter(|a| {
                    !a.starts_with("--")
                        && !flags.iter().any(|f| {
                            args.iter()
                                .position(|x| x == f)
                                .is_some_and(|i| args.get(i + 1) == Some(a))
                        })
                })
                .collect();
            let cfg = Cfg {
                msgs: msgs(3),
                quota: quota(Some(2)),
            };
            let mut check = Check {
                cfg,
                host: Host::spawn()?,
                fixtures: 0,
            };
            let run = conformance::dispatch("runTrace", &json!({"actions": actions}), &mut check)?;
            let path = run["mismatch"]["path"].as_str().unwrap_or_default();
            let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
            json!({"status": run["status"], "mismatch": run["mismatch"], "error": run["error"], "disabled": run["disabled"],
                "failingStep": if path.is_empty() { Value::Null } else { focus(&run["steps"][at], path) }})
        }
        Some("space") => {
            // Model only: size of the core-alphabet graph per depth.
            let cfg = Cfg {
                msgs: msgs(1),
                quota: quota(Some(1)),
            };
            let mut out = vec![];
            for d in 1..=nums.first().copied().unwrap_or(5) {
                let (info, traces) = edges(d, 2_000_000, cfg)?;
                let steps: usize = traces.iter().map(Vec::len).sum();
                out.push(json!({"depth": d, "model": info, "traceSteps": steps}));
            }
            json!(out)
        }
        Some("edges") => {
            let cfg = Cfg {
                msgs: msgs(1),
                quota: quota(Some(1)),
            };
            let (depth, max) = (
                nums.first().copied().unwrap_or(4),
                nums.get(1).copied().unwrap_or(200_000),
            );
            let (info, traces) = edges(depth, max, cfg)?;
            let mut r = campaign(
                "edge coverage (core alphabet)",
                traces,
                cfg,
                replays,
                Host::spawn()?,
            )?;
            r["model"] = info;
            r
        }
        Some("ci") => {
            // PR budget: about 30 s on an idle laptop (under 60 s loaded). The bug witnesses and
            // boundary traces, random walks over the full alphabet, and every transition of the
            // core alphabet to depth 3.
            let host = Host::spawn()?;
            let cfg = Cfg {
                msgs: 3,
                quota: Some(2),
            };
            let labels = alphabet(cfg.msgs, false);
            let traces = (0..300).map(|s| walk(seed + s, 30, &labels, cfg)).collect();
            let random = campaign("random walks", traces, cfg, replays, host)?;
            let cfg = Cfg {
                msgs: 1,
                quota: Some(1),
            };
            let (info, traces) = edges(3, 200_000, cfg)?;
            let mut edge = campaign(
                "edge coverage depth 3",
                traces,
                cfg,
                replays,
                Host::spawn()?,
            )?;
            edge["model"] = info;
            // Bug witnesses and boundary traces.
            let mut regressions = vec![];
            for (quota, actions) in REGRESSIONS {
                let cfg = Cfg {
                    msgs: 3,
                    quota: *quota,
                };
                let mut check = Check {
                    cfg,
                    host: Host::spawn()?,
                    fixtures: 0,
                };
                let run =
                    conformance::dispatch("runTrace", &json!({"actions": actions}), &mut check)?;
                regressions.push(json!({"actions": actions, "status": run["status"], "mismatch": run["mismatch"]}));
            }
            let failed = random["mismatched"].as_u64() != Some(0)
                || edge["mismatched"].as_u64() != Some(0)
                || random["errors"].as_array().is_some_and(|e| !e.is_empty())
                || edge["errors"].as_array().is_some_and(|e| !e.is_empty())
                || regressions.iter().any(|r| r["status"] != json!("match"));
            let report = json!({"regressions": regressions, "random": random, "edges": edge});
            println!(
                "{}",
                serde_json::to_string_pretty(&report).unwrap_or_default()
            );
            if failed {
                std::process::exit(1);
            }
            return Ok(());
        }
        _ => {
            let cfg = Cfg {
                msgs: msgs(3),
                quota: quota(Some(2)),
            };
            let (n, len) = (
                nums.first().copied().unwrap_or(200),
                nums.get(1).copied().unwrap_or(30),
            );
            let labels = alphabet(cfg.msgs, false);
            let traces = (0..n)
                .map(|s| walk(seed + s, len as usize, &labels, cfg))
                .collect();
            campaign(
                &format!("random walks (seed {seed})"),
                traces,
                cfg,
                replays,
                Host::spawn()?,
            )?
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );
    let bad = report["mismatched"].as_u64().is_some_and(|n| n > 0)
        || report["errors"].as_array().is_some_and(|e| !e.is_empty())
        || report["status"].as_str().is_some_and(|s| s != "match");
    if bad {
        std::process::exit(1);
    }
    Ok(())
}
