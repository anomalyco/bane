//! tear state model for SES event processing on the API and PostgreSQL: the reference model
//! (`model.rs`) predicts every step, the Bun host (`host.ts`) runs it on the real SNS route,
//! feedback-queue consumer, recovery job handler and dispatcher result statement over an isolated
//! database, and tear's conformance runner diffs the two.
//!
//!   cargo run --release -- ci [-j N]                  PR-sized run (witnesses, edges, random walks)
//!   cargo run --release -- random [N] [LEN] [--seed S] [-j N]
//!   cargo run --release -- edges [DEPTH] [MAX_STATES] [-j N]
//!   cargo run --release -- trace ACTION...            replay one trace, e.g. "accept e1" "q b1"
//!   cargo run --release -- space [DEPTH]              core graph size per depth (no database)
//!
//! Run from `api/tear/ses`. Requires TEAR_DATABASE_URL: a plain loopback URL of a dedicated,
//! migrated PostgreSQL database marked disposable (`../disposable.ts`, shared by every tear host).
//!
//! # Actions
//!
//! Notifications (labels from `model::MSGS`): e1 goes to r1 alone, e2 to r1 with r2 on Cc; both start
//! `attempting` without a provider id, as the dispatcher leaves them while SendEmail is in flight.
//! `d` Delivery, `b` hard bounce, `t` transient bounce, `v` validation-suppressed bounce, `c`
//! complaint, `n` not-spam report, `y` delivery delay, `j` reject, `f` rendering failure, `o` open;
//! `x9` names a provider message id no email has.
//! - `q m`, `qq m n`: the feedback-queue consumer (`ingestFeedbackBatch`) with a one- or two-item batch.
//! - `h m`: a signed SNS POST to `/v1/events/ses` without a queue binding (self-hosted Node, or a
//!   Worker deployed without FEEDBACK_QUEUE): routine feedback inline, the rest deferred to a job.
//! - `forge b1`, `stray b1`, `alien b1`: a tampered signature, an unregistered topic, a foreign SES
//!   account; `qx b1`, `hx b1`: b1 on another registered pool account's topic (queue, HTTP).
//! - `accept e`, `lost e`: the dispatcher's SendEmail outcome (provider id, or the response lost).
//! - `J m`, `K m`: a job worker claims the recovery job of `m` and runs the handler to its first gate;
//!   `J go` runs to the next gate (event write, suppression transaction, receipt mark, settlement);
//!   `J crash` kills the worker at its gate; `expire` expires every running lease.
//! - `old q m`, `old h m`, `old J m`: the same on a Worker deployed before migration 153 (the old rank
//!   table); `repair` runs migration 154's repair (`repair_feedback_status`) on the workspace.
//! - `Q m`, `P m`: a consumer batch statement held open until `Q commit` / `Q abort`.
//! - `pause`, `resume`: the second webhook endpoint (bounces and complaints only).
//!
//! # Edge-case checklist
//!
//! Each item names its coverage key (reported per run under `checklist`) and the actions that reach
//! it. [x] items are reached by `ci`; [ ] items say why not.
//!
//! ## Concurrency and interleavings
//! - [x] `job-vs-queue`: the consumer processes a notification whose recovery job is mid-run
//!   (`J b1`, `J go`, `q b1`).
//! - [x] `job-vs-job`: a second worker claims a job whose first holder is still running after its
//!   lease expired (`J b1`, `expire`, `K b1`).
//! - [x] `blocked-record`: a job's event write waits on an open consumer transaction's row lock and
//!   runs serialized after it (`Q b1`, `J go`, `Q commit`).
//! - [x] `blocked-consumer`: a second consumer statement on the same email waits on the first
//!   (`Q b1`, `P c1`, `Q commit`). A waiter's non-locking reads keep its statement snapshot (READ
//!   COMMITTED): an open does not engage a contact the first statement created meanwhile, the
//!   outcome of the serial order open-then-creation, which the contract allows.
//! - [x] `woke`: a commit or abort unblocks the waiter.
//! - [x] `pair-same-email`, `pair-duplicate`: one batch with two notifications for one email, or
//!   one notification twice (`qq d1 b1`, `qq b1 b1`).
//! - [ ] Two statements blocked at once: disabled, because which waiter wins the row lock is a
//!   scheduling race PostgreSQL does not order. Statements that would only contend on shared hourly
//!   counter rows (hosted usage and health) are disabled while a batch is open, for the same reason.
//!
//! ## Crashes, aborts, retries and duplicates
//! - [x] `crash-record`, `crash-suppress`, `crash-mark`: a worker dies before the event write, the
//!   suppression transaction or the receipt mark; the job keeps its lease until `expire`.
//! - [x] `consumer-abort`: a consumer statement rolls back (crash before commit); SNS or the queue
//!   delivers it again later.
//! - [x] `duplicate-processed`, `duplicate-open`: SNS or the queue delivers a notification again
//!   after it was applied, or while its recovery job is pending.
//! - [x] `job-after-processed`: a recovery job finds its receipt already processed.
//! - [x] `retry-not-found`: the job runs before the email has a provider id and retries.
//! - [x] `retry-exhausted`: the sixth failed attempt fails the job (random walks, `--seed 0`).
//!
//! ## Lease or lock expiry, clock skew and time boundaries
//! - [x] `lease-reclaim`: a claim of an expired running lease.
//! - [x] `stale-settle`: a holder finishes after its lease expired; its settlement no longer applies.
//! - [ ] Clock skew and old SES timestamps: event times are fixed offsets from the fixture; the
//!   47-hour hosted-health window, the 30-day sender-score window and retention need a fake clock.
//!
//! ## Limits and caps
//! - [x] `attempts-boundary`: attempts 5 → 6 (the last retry) and 6 (failed).
//! - [x] `empty-recipients`: feedback for a multi-recipient email with no single recipient to
//!   engage (`d2`), and recipients reported in another case (`c2` reports R2).
//! - [x] `zero-denominator`: sender-score ratios with nothing accepted or delivered are null.
//! - [ ] 100-item batches, the batch split on conflicts and 50-recipient notifications: unreachable
//!   at model size; covered by acceptance tests.
//! - [ ] Hosted auto-pause thresholds (≥ 2 complaints or ≥ 10 hard bounces under 200 recipients):
//!   `checkHostedHealth` updates every workspace in the database, so it would race parallel hosts;
//!   its inputs (hosted health hourly totals) are checked on every step instead.
//!
//! ## Revocation or deletion racing in-flight work; permissions per actor type
//! - [x] `paused-endpoint`: fan-out while an endpoint is paused (`pause`, `q b1`) creates no delivery.
//! - [x] `forged`, `stray-topic`, `foreign-account`: rejected before any write.
//! - [x] `cross-tenant`: a verified notification on another registered account's topic, naming this
//!   workspace's provider message id and tag, matches nothing (`qx b1`, `hx b1`).
//! - [x] `unmatched`: an unknown provider message id (`x9`) is retried by SNS or the queue and stores
//!   nothing.
//! - [ ] Email retention deletion or workspace deletion racing feedback: retention runs on days-old
//!   rows and needs a fake clock; not modelled.
//!
//! ## Old and new Worker overlap (deploys)
//! - [x] `both-ingress`: one notification through the SNS route without a queue (an old Worker or a
//!   deploy without the FEEDBACK_QUEUE binding) and through the queue consumer.
//! - [x] `old-worker`, `old-validation-over-outcome`, `old-delivery-over-validation`: the consumer, the
//!   SNS route or a job worker on a Worker deployed before migration 153, which embeds the old rank
//!   table (suppressed tied with bounced and outranked delivered), interleaved with the current one
//!   (`q d2`, `old q v2`; `q v2`, `old q d2`). The database triggers of migration 153 must keep the
//!   current ranking and error code whichever version writes.
//! - [x] `repair`: migration 154's repair over the workspace changes nothing on a correct state.
//! - [ ] The old consumer without 85f1765 (effects only for events it inserted): not modelled; it can
//!   lose a suppression only if a recovery job crashes between its event write and its suppression
//!   inside the deploy window, which no database guard repairs.
//!
//! ## Partial failures of external calls
//! - [x] `late-acceptance`: feedback before the dispatcher stored the provider id (SendEmail answer
//!   still in flight): deferred to a recovery job.
//! - [x] `acceptance-lost`: the SendEmail answer was lost; feedback adopts the provider id.
//! - [ ] Webhook POST failures and retries: the delivery area (operation.webhook jobs); this checker
//!   stops at the fan-out rows. SNS certificate fetch failures: acceptance tests (no network here).
//!
//! ## Out-of-order arrival
//! - [x] `out-of-order`: feedback whose status ranks below the current one is stored and published
//!   but never downgrades the status (`q b1`, `q d1`).
//!
//! # Properties (checked on every step)
//! - The committed view equals the model's: email status, provider id, outcome bits, error code and
//!   suppression reason; contacts; stored and published events; deliveries per endpoint; receipts;
//!   recovery jobs; campaign stats; sender-score bounce, complaint and hygiene ratios; hosted health
//!   totals. Every request result equals the model's.
//! - Host safety, independent of the model: outcome bits equal a recount of published events; one
//!   stored event per notification; every published event has its stored event; one delivery per
//!   endpoint and event, with the event's payload; hosted health credits equal their projection and
//!   hourly totals equal the credits; nothing quarantined; a suppression is never lifted.
mod fixture;
mod model;

use fixture::Host;
use model::{Act, HELD, MSGS, Model, WORKERS, alphabet, parse};
use serde_json::{Value, json};
use statecheck::{Error, Host as TearHost, R, conformance, search};
use std::{collections::BTreeMap, time::Instant};

const PROPERTY: &str = "bane.ses.feedback";

/// Shortest witnesses of bugs this model found, replayed on every `ci` run, then boundary traces.
const REGRESSIONS: &[&[&str]] = &[
    // A recovery job stored the bounce and died before suppressing; the queue's redelivery marked
    // the receipt processed without suppressing, and the job's retry returned (fixed in 85f1765).
    &[
        "h b1",
        "accept e1",
        "J b1",
        "J go",
        "J crash",
        "q b1",
        "expire",
        "K b1",
    ],
    // A validation-suppressed Cc recipient turned a delivered multi-recipient email suppressed
    // (fixed in 82fcc96); and the reverse order, and a hard bounce in both orders.
    &["accept e2", "q v2", "h d2"],
    &[
        "accept e2",
        "q d2",
        "q v2",
        "h b2",
        "J b2",
        "J go",
        "J go",
        "J go",
    ],
    // Mixed versions (review of #56): a Worker with the pre-153 rank table restored 'suppressed' over
    // a delivery or hard bounce the new version committed, or skipped a delivery after a validation
    // suppression; migration 153 holds the current ranking for every version.
    &["accept e2", "q d2", "old q v2"],
    &["accept e2", "q v2", "old q d2"],
    &[
        "accept e2",
        "h b2",
        "J b2",
        "J go",
        "J go",
        "J go",
        "old q v2",
    ],
    &[
        "accept e2",
        "q d2",
        "h v2",
        "old J v2",
        "J go",
        "J go",
        "J go",
        "repair",
    ],
    // Boundary: an acceptance_unknown email keeps its error code under a validation suppression.
    &["lost e1", "q v1"],
    // Boundary: an open that waited behind another consumer's uncommitted complaint, which created
    // the contact, does not engage it (its snapshot predates the contact).
    &["accept e1", "P c1", "Q o1", "P commit", "Q commit"],
    // Boundary: a job retries five times while the email has no provider id, then fails.
    &[
        "h b1",
        "J b1",
        "J b1",
        "J b1",
        "J b1",
        "J b1",
        "J b1",
        "accept e1",
        "q b1",
    ],
];

fn model(v: &Value) -> R<Model> {
    serde_json::from_value(v.clone()).map_err(|e| Error::new(e.to_string()))
}
fn act(v: &Value) -> R<Act> {
    v.as_str()
        .and_then(parse)
        .ok_or_else(|| Error::new(format!("unknown action {v}")))
}

/// Conformance host: the model predicts each step, the Bun host runs it on the real API.
struct Check {
    host: Host,
    fixtures: u64,
}
impl TearHost for Check {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        Ok(match name {
            "id" => json!(PROPERTY),
            "initial" => json!(Model::initial()),
            "enabled" => json!(model(&args[0])?.enabled(&act(&args[1])?)),
            "step" => {
                let mut m = model(&args[0])?;
                let (r, woke) = m.step(act(&args[1])?);
                json!({"expected": {"r": r, "woke": woke, "view": m.view(), "safety": []}, "state": m})
            }
            "open" => {
                self.host.reset()?;
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
                    .filter(|l| parse(l).is_some_and(|a| m.enabled(&a)))
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

/// Relative weight of an action in random walks: keep feedback, job steps and commits frequent,
/// signature failures and endpoint pauses rare.
fn weight(label: &str) -> u64 {
    if let Some(rest) = label.strip_prefix("old ") {
        return weight(rest).div_ceil(2);
    }
    let words: Vec<&str> = label.split(' ').collect();
    let conn = WORKERS.contains(&words[0]) || HELD.contains(&words[0]);
    match (conn, words[0], words.get(1).copied().unwrap_or_default()) {
        (true, _, "go") => 30,
        (true, _, "commit") => 30,
        (true, _, "crash") => 6,
        (true, _, "abort") => 6,
        (true, w, _) if HELD.contains(&w) => 3,
        (true, _, _) => 12,
        (_, "q", _) => 6,
        (_, "qq", _) => 2,
        (_, "h", _) => 5,
        (_, "accept", _) => 20,
        (_, "lost", _) => 4,
        (_, "expire", _) => 4,
        (_, "repair", _) => 2,
        _ => 1,
    }
}

fn walk(seed: u64, len: usize, labels: &[String]) -> Vec<String> {
    let mut x = seed;
    let mut m = Model::initial();
    let mut out = vec![];
    for _ in 0..len {
        let enabled: Vec<&String> = labels
            .iter()
            .filter(|l| parse(l).is_some_and(|a| m.enabled(&a)))
            .collect();
        if enabled.is_empty() {
            break;
        }
        let total: u64 = enabled.iter().map(|l| weight(l)).sum();
        let mut pick = splitmix(&mut x) % total;
        let label = enabled
            .iter()
            .find(|l| {
                let w = weight(l);
                if pick < w {
                    true
                } else {
                    pick -= w;
                    false
                }
            })
            .unwrap();
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
    let verb = if WORKERS.contains(&words[0]) || HELD.contains(&words[0]) {
        format!(
            "{} {}",
            words[0],
            if matches!(words.get(1), Some(&"go" | &"crash" | &"commit" | &"abort")) {
                words[1]
            } else {
                "m"
            }
        )
    } else {
        words[0].to_owned()
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

/// Checklist keys one step reaches, from the model state before and after it (the model's state is
/// the product's wherever the trace matched).
fn reached(before: &Model, a: &Act, r: &Value, woke: &Value, after: &Model) -> Vec<&'static str> {
    if let Act::Old(inner) = a {
        let mut out = reached(before, inner, r, woke, after);
        out.push("old-worker");
        if let Act::Queue(i) | Act::Http(i) | Act::Claim(_, i) = **inner {
            let m = &MSGS[i as usize];
            let st = before.db.emails.get(m.email as usize).map(|e| e.status);
            // The two places the old rank table disagrees with the current one.
            if m.kind == model::Kind::Validation
                && st.is_some_and(|s| {
                    matches!(
                        s,
                        model::St::Delivered
                            | model::St::Bounced
                            | model::St::Rejected
                            | model::St::Rendering
                    )
                })
            {
                out.push("old-validation-over-outcome");
            }
            if m.kind == model::Kind::Delivery && st == Some(model::St::Suppressed) {
                out.push("old-delivery-over-validation");
            }
        }
        return out;
    }
    let mut out = vec![];
    let db = &before.db;
    let running = |i: u8| before.workers.iter().flatten().any(|w| w.msg == i);
    let strs = |v: &Value| -> Vec<String> {
        match v {
            Value::Array(a) => a
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect(),
            Value::String(s) => vec![s.clone()],
            _ => vec![],
        }
    };
    let rs = strs(r);
    if woke.as_object().is_some_and(|w| !w.is_empty()) {
        out.push("woke");
    }
    let feedback = |i: u8, out: &mut Vec<&'static str>| {
        if running(i) {
            out.push("job-vs-queue");
        }
        match db.receipts.get(&i) {
            Some(true) => out.push("duplicate-processed"),
            Some(false) => out.push("duplicate-open"),
            None => {}
        }
        let m = &MSGS[i as usize];
        if m.email == 2 {
            out.push("unmatched");
            return;
        }
        let e = &before.db.emails[m.email as usize];
        if !e.provider && e.status != model::St::Unknown {
            out.push("late-acceptance");
        }
        if e.lost && !e.provider && after.db.emails[m.email as usize].provider {
            out.push("acceptance-lost");
        }
        if m.email == 1 && m.kind == model::Kind::Delivery {
            out.push("empty-recipients");
        }
        if after.db.events.len() > db.events.len()
            && after.db.emails[m.email as usize].status == e.status
            && e.status != model::St::Attempting
        {
            out.push("out-of-order");
        }
        if db.paused && after.db.deliveries[0].len() > db.deliveries[0].len() {
            out.push("paused-endpoint");
        }
    };
    match *a {
        Act::Queue(i) => {
            feedback(i, &mut out);
            if db.receipts.contains_key(&i)
                && before.used & (1 << i) != 0
                && after.db.receipts.get(&i) == Some(&true)
                && db.jobs.contains_key(&i)
            {
                out.push("both-ingress");
            }
        }
        Act::Pair(i, j) => {
            feedback(i, &mut out);
            out.push(if i == j {
                "pair-duplicate"
            } else {
                "pair-same-email"
            });
        }
        Act::Http(i) => feedback(i, &mut out),
        Act::Forge => out.push("forged"),
        Act::Stray => out.push("stray-topic"),
        Act::Alien => out.push("foreign-account"),
        Act::Cross(_) => out.push("cross-tenant"),
        Act::Claim(_, i) => {
            let j = &db.jobs[&i];
            if j.st == model::JobSt::Running {
                out.push("lease-reclaim");
                if before.workers.iter().flatten().any(|w| w.msg == i) {
                    out.push("job-vs-job");
                }
            }
            if j.attempts + 1 >= model::MAX_ATTEMPTS - 1 {
                out.push("attempts-boundary");
            }
            match rs.first().map(String::as_str) {
                Some("done") => out.push("job-after-processed"),
                Some(s) if s.starts_with("retry:") => out.push("retry-not-found"),
                Some(s) if s.starts_with("failed:") => out.push("retry-exhausted"),
                _ => {}
            }
        }
        Act::Go(k) => {
            if rs.first().map(String::as_str) == Some("blocked") {
                out.push("blocked-record");
            }
            if let Some(w) = &before.workers[k as usize]
                && let Some(j) = db.jobs.get(&w.msg)
                && (j.expired || j.holder != Some(k))
                && rs.first().map(String::as_str) == Some("done")
            {
                out.push("stale-settle");
            }
        }
        Act::Crash(k) => {
            out.push(match before.workers[k as usize].as_ref().map(|w| w.gate) {
                Some(model::Gate::Record) => "crash-record",
                Some(model::Gate::Suppress) => "crash-suppress",
                _ => "crash-mark",
            });
        }
        Act::Hold(_, _) => {
            if rs.first().map(String::as_str) == Some("blocked") {
                out.push("blocked-consumer");
            }
        }
        Act::Commit(_, false) => out.push("consumer-abort"),
        Act::Repair => out.push("repair"),
        _ => {}
    }
    if after.view()["score"]
        .as_array()
        .is_some_and(|s| s.iter().any(Value::is_null))
    {
        out.push("zero-denominator");
    }
    out
}

/// Replays a trace through the model up to `upto` steps and counts the checklist keys it reaches.
fn coverage(trace: &[String], upto: usize, into: &mut BTreeMap<String, u64>) {
    let mut m = Model::initial();
    for label in trace.iter().take(upto) {
        let Some(a) = parse(label) else { return };
        if !m.enabled(&a) {
            return;
        }
        let before = m.clone();
        let (r, woke) = m.step(a.clone());
        for key in reached(&before, &a, &r, &woke, &m) {
            *into.entry(key.into()).or_default() += 1;
        }
    }
}

/// Runs traces over `jobs` host processes (one synthetic workspace each) and reduces every distinct
/// mismatch to a short witness.
fn campaign(name: &str, traces: Vec<Vec<String>>, replays: u64, jobs: usize) -> R<Value> {
    let start = Instant::now();
    let total = traces.len();
    let jobs = jobs.clamp(1, 16).min(total.max(1));
    let mut slices: Vec<Vec<(usize, Vec<String>)>> = vec![vec![]; jobs];
    for (i, t) in traces.into_iter().enumerate() {
        slices[i % jobs].push((i, t));
    }
    type Out = (Vec<(usize, Vec<String>, Value)>, u64);
    let results: Vec<R<Out>> = std::thread::scope(|s| {
        let handles: Vec<_> = slices
            .into_iter()
            .enumerate()
            .map(|(n, slice)| {
                s.spawn(move || -> R<Out> {
                    let mut check = Check {
                        host: Host::spawn(n)?,
                        fixtures: 0,
                    };
                    let mut out = vec![];
                    for (i, trace) in slice {
                        let run = conformance::dispatch(
                            "runTrace",
                            &json!({"actions": trace}),
                            &mut check,
                        )?;
                        out.push((i, trace, run));
                    }
                    Ok((out, check.fixtures))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err(Error::new("worker panicked")))
            })
            .collect()
    });
    let (mut matched, mut steps, mut fixtures, mut errors) = (0u64, 0u64, 0u64, vec![]);
    let mut groups: BTreeMap<String, (u64, Vec<String>)> = BTreeMap::new();
    let mut checklist: BTreeMap<String, u64> = BTreeMap::new();
    for res in results {
        let (runs, f) = res?;
        fixtures += f;
        for (_, trace, run) in runs {
            let n = run["steps"].as_array().map_or(0, |s| s.len());
            steps += n as u64;
            coverage(&trace, n, &mut checklist);
            match run["status"].as_str() {
                Some("match") => matched += 1,
                Some("mismatch") => {
                    let g = groups.entry(signature(&run)).or_insert((0, trace.clone()));
                    g.0 += 1;
                    if trace.len() < g.1.len() {
                        g.1 = trace;
                    }
                }
                _ => errors.push(json!({"actions": trace, "status": run["status"], "error": run["error"], "disabled": run["disabled"]})),
            }
        }
    }
    let checked = start.elapsed();
    let mut witnesses = vec![];
    if !groups.is_empty() {
        let mut check = Check {
            host: Host::spawn(99)?,
            fixtures: 0,
        };
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
    }
    Ok(json!({
        "campaign": name, "traces": total, "matched": matched,
        "mismatched": groups.values().map(|g| g.0).sum::<u64>(), "errors": errors,
        "steps": steps, "fixtures": fixtures, "hosts": jobs,
        "checkMs": checked.as_millis() as u64, "totalMs": start.elapsed().as_millis() as u64,
        "checklist": checklist, "witnesses": witnesses,
    }))
}

fn edges(depth: u64, max_states: u64) -> R<(Value, Vec<Vec<String>>)> {
    let start = Instant::now();
    let mut space = Space {
        labels: alphabet(true),
    };
    let graph = search::map_states(
        &json!(Model::initial()),
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
    // A trace per edge replays its BFS path, then takes the edge.
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

fn failed(r: &Value) -> bool {
    r["mismatched"].as_u64().is_some_and(|n| n > 0)
        || r["errors"].as_array().is_some_and(|e| !e.is_empty())
}

fn main() -> R<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let seed: u64 = flag(&args, "--seed")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let replays: u64 = flag(&args, "--replays")
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let jobs: usize = flag(&args, "-j").and_then(|s| s.parse().ok()).unwrap_or(4);
    let flags = ["--seed", "--replays", "-j"];
    let positional: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|(i, a)| {
            *i > 0 && !a.starts_with("--") && *a != "-j" && !flags.contains(&args[i - 1].as_str())
        })
        .map(|(_, a)| a)
        .collect();
    let nums: Vec<u64> = positional.iter().filter_map(|a| a.parse().ok()).collect();
    let report = match args.first().map(String::as_str) {
        Some("trace") => {
            let mut check = Check {
                host: Host::spawn(0)?,
                fixtures: 0,
            };
            let actions: Vec<&String> = positional;
            let run = conformance::dispatch("runTrace", &json!({"actions": actions}), &mut check)?;
            let path = run["mismatch"]["path"].as_str().unwrap_or_default();
            let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
            let report = json!({"status": run["status"], "mismatch": run["mismatch"], "error": run["error"], "disabled": run["disabled"],
                "failingStep": if path.is_empty() { Value::Null } else { focus(&run["steps"][at], path) }});
            println!(
                "{}",
                serde_json::to_string_pretty(&report).unwrap_or_default()
            );
            if report["status"] != json!("match") {
                std::process::exit(1);
            }
            return Ok(());
        }
        Some("space") => {
            let mut out = vec![];
            for d in 1..=nums.first().copied().unwrap_or(5) {
                let (info, traces) = edges(d, 2_000_000)?;
                let steps: usize = traces.iter().map(Vec::len).sum();
                out.push(json!({"depth": d, "model": info, "traceSteps": steps}));
            }
            json!(out)
        }
        Some("edges") => {
            let (depth, max) = (
                nums.first().copied().unwrap_or(4),
                nums.get(1).copied().unwrap_or(200_000),
            );
            let (info, traces) = edges(depth, max)?;
            let mut r = campaign(
                &format!("edge coverage depth {depth}"),
                traces,
                replays,
                jobs,
            )?;
            r["model"] = info;
            r
        }
        Some("ci") => {
            // PR budget: under 60 s on a laptop with -j 4. Bug witnesses and boundary traces, every
            // transition of the core alphabet to depth 3, then seeded random walks over the full one.
            let mut regressions = vec![];
            let mut check = Check {
                host: Host::spawn(0)?,
                fixtures: 0,
            };
            for actions in REGRESSIONS {
                let run =
                    conformance::dispatch("runTrace", &json!({"actions": actions}), &mut check)?;
                regressions.push(json!({"actions": actions, "status": run["status"], "mismatch": run["mismatch"]}));
            }
            drop(check);
            let (info, traces) = edges(3, 200_000)?;
            let mut edge = campaign("edge coverage depth 3", traces, replays, jobs)?;
            edge["model"] = info;
            let labels = alphabet(false);
            let traces = (0..240).map(|s| walk(seed + s, 30, &labels)).collect();
            let random = campaign("random walks", traces, replays, jobs)?;
            let bad = failed(&random)
                || failed(&edge)
                || regressions.iter().any(|r| r["status"] != json!("match"));
            let report = json!({"regressions": regressions, "edges": edge, "random": random});
            println!(
                "{}",
                serde_json::to_string_pretty(&report).unwrap_or_default()
            );
            if bad {
                std::process::exit(1);
            }
            return Ok(());
        }
        _ => {
            let (n, len) = (
                nums.first().copied().unwrap_or(200),
                nums.get(1).copied().unwrap_or(30),
            );
            let labels = alphabet(false);
            let traces = (0..n)
                .map(|s| walk(seed + s, len as usize, &labels))
                .collect();
            campaign(
                &format!("random walks (seed {seed})"),
                traces,
                replays,
                jobs,
            )?
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );
    if failed(&report) {
        std::process::exit(1);
    }
    Ok(())
}
