//! tear model of received-mail delivery on the API and PostgreSQL: the reference model
//! (`model.rs`) predicts every step, the Bun host (`host.ts`) runs it on the real ingest, fan-out,
//! job runner, ritualDelivery fence and endpoint code over an isolated database, and tear's
//! conformance runner diffs the two. tear's temporal monitor then checks the delivery properties
//! on the observations alone.
//!
//!   cargo run --release -- ci                        PR-sized run (about 60 s, exits 1 on any mismatch)
//!   cargo run --release -- random [N] [LEN] [--seed S] [--alpha full|core|ritual] [--retries R]
//!   cargo run --release -- edges [DEPTH] [--alpha core|ritual] [--retries R]
//!   cargo run --release -- trace [--retries R] ACTION...   replay one trace
//!   cargo run --release -- space [DEPTH] [--alpha A]       graph size per depth, model only
//!
//! Run from `api/tear/delivery`. Requires TEAR_DATABASE_URL: a plain loopback URL of a dedicated,
//! migrated PostgreSQL database marked disposable (`../disposable.ts`, shared by every tear host).
//!
//! # Edge-case checklist
//!
//! Each item names the actions that reach it. Workers K and L run the real job runner; a webhook
//! POST stays in flight until `reply`. `claim` parks a worker between its claim and its handler.
//! The `coverage` section of every report counts each item reached in matching steps; items
//! marked [ ] say why they are not reached.
//!
//! ## Concurrency and interleavings
//! - C1 [x] Two workers with requests in flight at once, replies in either order (`run K`, `run L`, `reply`).
//! - C2 [x] Pause, unpause or delete while a worker holds a claim (`claim K d`, `pause E`, `go K`).
//! - C3 [x] Pause, unpause or delete while a request is in flight (`run K d`, `pause E`, `reply K`).
//! - C4 [x] Ritual or route edits between an email's first receipt and a reopen or duplicate receipt.
//! - C6 [x] Plain event subscriptions (U, box@'s message.received) take the same delivery path: the
//!   pause and stale-claim fence and breaker accounting, with at-least-once retries and no
//!   attempt row or rate slot.
//! - C5 [ ] Two fences on one delivery at the same statement: the fence is one short transaction
//!   whose attempt row serializes them (INSERT ... ON CONFLICT then FOR UPDATE); interleavings
//!   inside it need statement checkpoints, as in the inbox checker. Not modelled.
//!
//! ## Crashes, aborts, retries and duplicates
//! - R1 [x] Worker crash after the request left (`crash K`) and before it left (`drop K`), then the
//!   lease expires (`expire d`) and another worker claims (`run L d`).
//! - R2 [x] A stale worker replies after its lease expired or the job was replaced (its mark lands,
//!   its record does not).
//! - R3 [x] Retryable responses (503, 408, 429 with and without Retry-After), refusals (400, 410),
//!   unknown outcomes (timeout, connection reset) on replay-safe and non-replay-safe endpoints.
//! - R4 [x] Duplicate SNS notification (same receipt, same recipients), receipt reopen with more
//!   recipients, and the same email under a second SES receipt (`ingest d1 ...`).
//! - R5 [x] Retries exhaust at exactly 1 + retryAttempts (`--retries 0|1|2`), then dead-letter.
//! - R7 [x] A claim lost before the fence (nothing sent) does not use up a fenced delivery's last
//!   attempt (`claim K d`, `drop K`, `expire d`, `run L d` with `--retries 0`).
//! - R6 [ ] A second forward of one message to one endpoint (mail_forward_once): unreachable now that
//!   a message's recipients are routed once; a forward completes in one step (no in-flight state),
//!   and its retryable failure (FORWARD_LIMIT) needs the hourly cap (L7). Acceptance tests cover it.
//!
//! ## Lease or lock expiry, clock skew and time boundaries
//! - T1 [x] Lease expiry mid-send, before the handler and after the last attempt (JOB_LEASE_EXHAUSTED).
//! - T2 [x] Backoff per attempt (15 s x 4^n), Retry-After above and below it, capped at 7 days.
//! - T3 [x] Rate-limit minute rollover (`tick`).
//! - T4 [x] The 12 h backoff cap at the seventh attempt (`--retries 9` boundary trace).
//!   [ ] Worker/database clock skew: Date.now() and now() are one clock here, so not reached.
//! - T6 [x] Retention: settled deliveries past 30 days are pruned; a held one is dead-lettered
//!   with a reason and kept 7 more days (`age d`, `prune`).
//! - T5 [ ] Retry-After as an HTTP date: second-granular, so its delay is ±1 s; covered by the
//!   acceptance tests of retryAfterMs.
//!
//! ## Limits and caps at the boundary
//! - L1 [x] Per-endpoint rate limit at exactly perMinute (1) and one more (`rate E 1`, two runs).
//! - L2 [x] Three calls per endpoint per message: a fourth is skipped (`rituals four`).
//! - L3 [x] The 32-intent action budget: 32 runs (`rituals max`), 33 fails to junk (`rituals over`).
//! - L4 [x] Loop suppression: X-Bane-Loop blocks a forward; 24 Received headers forward, 25 do not.
//! - L5 [x] The transport breaker: a fourth call after three timeouts defers without sending
//!   (its 30 s window is real time, so walks that trip it skip the drain's liveness check).
//! - L6 [x] retryAttempts 0 (one attempt only), 1 and 2.
//! - L7 [ ] Fan-out caps (10 inboxes, 20 webhooks), 50 endpoints, 200 forwards per hour, 1,000 per
//!   day, the 250,000-step message budget: unreachable at model sizes (the step budget needs loops,
//!   which rituals do not have); bounded in code and covered by acceptance tests.
//! - L8 [x] Empty: a message with no destinations (route off, drop, endpoint deleted), and
//!   rituals none.
//!
//! ## Revocation, deletion and pausing racing in-flight work
//! - P1 [x] Endpoint paused before routing (new mail is held: queued, parked by its claim, sent on
//!   unpause), with queued work (parks, resumes as a new generation), after the claim, mid-request,
//!   and held past the 30-day retention (dead-lettered as ENDPOINT_PAUSED_EXPIRED).
//! - P2 [x] Endpoint deleted with queued, claimed and in-flight deliveries (routes detached).
//! - P3 [x] Forward declined (stop link) with queued work: CONNECTOR_UNAVAILABLE, nothing sent;
//!   rituals can no longer call it.
//! - P4 [ ] MCP grant revocation (payload.grants): needs OAuth grant fixtures; the access checker
//!   in tear/ covers grants, and ritualDelivery checks every grant before the fence.
//! - P5 [ ] Permissions per actor type for endpoint and routing admin: the access checker's REST
//!   table covers them; this host acts as a workspace manage key.
//!
//! ## Old and new Worker overlap
//! - O1 [x] Two runners with overlapping leases on one delivery (the overlap a deploy causes:
//!   the old isolate keeps its request in flight while the new one claims after lease expiry).
//! - O2 [ ] Mixed versions of the delivery code: not modelled. Routing, fan-out and envelope fixes
//!   live in shared database functions; the claim stamping, deferral accounting, fence and resume
//!   are Worker code, so an old Worker keeps the old behaviour for the jobs it touches until it drains.
//!
//! ## Partial failures of external calls
//! - E1 [x] Webhook, Slack: every response class above, timeouts, resets, a worker lost mid-call.
//! - E2 [x] SES (the forward's send) commits with mail_forward_once in one transaction.
//! - E4 [x] A message stored before ingest recorded forward verdicts (`strip m`) is still forwarded
//!   when safe and refused when looped.
//! - E3 [ ] S3/R2 reads for include=raw or the inbound format: the endpoints use the bane format
//!   without includes; reads happen before the send and fail as retryable errors.
//!
//! # Properties
//! Conformance: every step's result, sends and committed view (delivery status, attempt count,
//! error, fence, job status and attempts, scheduled delay, endpoint state, box labels, forwards)
//! equal the model's. Temporal (tear's monitor, on the observations alone):
//! - `delivery.once`: a non-replay-safe endpoint receives each action at most once; a replay-safe
//!   one only ever sees the delivery's own Idempotency-Key.
//! - `delivery.attempts`: an endpoint receives a delivery at most 1 + retryAttempts times.
//! - `endpoint.held`: no request starts to an endpoint that was paused or deleted before the step.
//! - `delivery.settles`: on drained traces, every queued delivery is delivered, dead-lettered,
//!   parked or deleted within the drain.
//! Model property `delivery.kept`, on every state: every (email, endpoint) that routing or a ritual
//! chose has a delivery, unless the endpoint was deleted or retention pruned a settled one; a
//! paused endpoint holds its mail.
mod fixture;
mod model;

use fixture::Host;
use model::{Act, Model, Wk, alphabet, parse};
use serde_json::{Value, json};
use statecheck::temporal::{Monitor, Property};
use statecheck::{Error, Host as TearHost, R, conformance, search};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

const PROPERTY: &str = "bane.delivery";

/// Shortest witnesses of bugs this model found, replayed by every `ci` run: (retries, actions).
const REGRESSIONS: &[(u32, &[&str])] = &[
    // A pause committed between the claim and the fence: the paused endpoint still received the POST.
    (1, &["ingest m1 a", "claim K m1:W", "pause W", "go K"]),
    (1, &["ingest m1 a", "claim K m1:W", "pause W", "go K", "unpause W", "run K m1:W", "reply K 200"]),
    // retryAttempts 0: after a lost first attempt the lease expiry re-claimed it and sent it again.
    (0, &["ingest m1 z", "run K m1:V", "expire m1:V", "run L m1:V"]),
    (0, &["ingest m1 z", "run K m1:V", "crash K", "expire m1:V", "run L m1:V"]),
    // A rate-limit or breaker deferral reset the attempt count: a failing endpoint retried forever.
    (1, &["rate W 1", "ingest m1 a", "run K m1:W", "reply K 503", "run K m1:W"]),
    (1, &["rate W 1", "ingest m1 a", "run K m1:W", "reply K 503", "run K m1:W", "tick", "run K m1:W", "reply K 503"]),
    (1, &["ingest m1 z", "run K m1:V", "reply K timeout", "ingest m2 z", "run K m2:V", "reply K timeout", "ingest m3 z", "run K m3:V", "reply K timeout", "run K m1:V"]),
    // A ritual that failed to junk for box@ made z@'s routed webhook delivery junk: V refused it.
    (1, &["rituals over", "ingest m1 b+z", "run K m1:V"]),
    // Another SES receipt of the same email, or a reopen after a routing or ritual edit, queued the
    // earlier recipients' ritual actions and routes again: a second Slack post, a new route's endpoint.
    (1, &["rituals slack", "ingest m1 b", "ingest d1 b"]),
    (1, &["ingest m1 a", "route r1 off", "ingest d1 a"]),
    (1, &["rituals slack", "ingest m1 b", "rituals both", "ingest m1 b+z"]),
    (1, &["ingest m1 b", "pause W", "ingest d1 a", "unpause W", "ingest d1 a+z"]),
    (1, &["route r1 drop", "ingest m1 a", "ingest d1 a+z"]),
    // Reopening the first receipt replaced the envelope the second receipt had extended.
    (1, &["rituals slack", "ingest m1 a", "ingest d1 b", "ingest m1 a+z", "ingest d1 b+z"]),
    // Mail first stored before any ritual ran had no forward verdict: a later forward was refused.
    (1, &["ingest m1 z", "rituals forward", "ingest m1 b+z", "run K m1:F"]),
    (1, &["ingest m1 z loop", "rituals forward", "ingest m1 b+z loop", "run K m1:F"]),
    // A delivery resumed after a pause got a fresh attempt budget (found by delivery.attempts).
    (1, &["ingest m1 a", "run K m1:W", "reply K 503", "pause W", "run K m1:W", "unpause W", "run K m1:W", "reply K 503"]),
    (1, &["ingest m1 z", "run K m1:V", "crash K", "expire m1:V", "pause V", "run L m1:V", "unpause V", "run L m1:V", "reply L 503"]),
    // A runner whose claim went stale still sent a delivery that had settled or been resumed.
    (1, &["ingest m1 a", "claim K m1:W", "expire m1:W", "run L m1:W", "reply L 400", "go K"]),
    (1, &["ingest m1 z", "claim K m1:V", "pause V", "expire m1:V", "run L m1:V", "unpause V", "go K"]),
    // Boundary: backoff 15 s x 4^n reaches its 12 h cap at the seventh attempt (retryAttempts 9).
    (9, &["ingest m1 a", "run K m1:W", "reply K 503", "run K m1:W", "reply K 503", "run K m1:W", "reply K 503", "run K m1:W", "reply K 503",
        "run K m1:W", "reply K 503", "run K m1:W", "reply K 503", "run K m1:W", "reply K 503"]),
];

fn model(v: &Value) -> R<Model> {
    serde_json::from_value(v.clone()).map_err(|e| Error::new(e.to_string()))
}
fn act(v: &Value) -> R<Act> {
    v.as_str().and_then(parse).ok_or_else(|| Error::new(format!("unknown action {v}")))
}

/// Conformance host: the model predicts each step, the Bun host runs it on the real API.
struct Check {
    retries: u32,
    host: Host,
    fixtures: u64,
}
impl TearHost for Check {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        Ok(match name {
            "id" => json!(PROPERTY),
            "initial" => json!(Model::initial(self.retries)),
            "enabled" => json!(model(&args[0])?.enabled(&act(&args[1])?)),
            "step" => {
                let mut m = model(&args[0])?;
                let (r, sends) = m.step(act(&args[1])?);
                json!({"expected": {"r": r, "sends": sends, "view": m.view(), "safety": []}, "state": m})
            }
            "open" => {
                self.host.reset(self.retries)?;
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
            "actions" => json!(self.labels.iter().filter(|l| parse(l).is_some_and(|a| m.enabled(&a))).collect::<Vec<_>>()),
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

/// Relative weight in random walks: keep mail, runs and replies frequent, faults and admin rare.
fn weight(label: &str) -> u64 {
    match label.split(' ').next().unwrap_or_default() {
        "ingest" => 8,
        "run" => 10,
        "claim" => 3,
        "go" => 12,
        "reply" => 4,
        "crash" | "drop" => 2,
        "expire" => 3,
        "tick" => 3,
        "pause" | "unpause" => 2,
        "delete" | "decline" => 1,
        "rituals" => 3,
        "route" | "rate" => 1,
        _ => 2,
    }
}

fn walk(seed: u64, len: usize, labels: &[String], retries: u32) -> Vec<String> {
    let mut x = seed;
    let mut m = Model::initial(retries);
    let mut out = vec![];
    for _ in 0..len {
        let enabled: Vec<&String> = labels.iter().filter(|l| parse(l).is_some_and(|a| m.enabled(&a))).collect();
        if enabled.is_empty() {
            break;
        }
        let total: u64 = enabled.iter().map(|l| weight(l)).sum();
        let mut pick = splitmix(&mut x) % total;
        let label = *enabled
            .iter()
            .find(|l| {
                let w = weight(l);
                if pick < w { true } else { pick -= w; false }
            })
            .unwrap();
        m.step(parse(label).unwrap());
        out.push(label.clone());
    }
    out
}

/// The model's own drain: answer every request with 503, resume paused endpoints, start a new
/// minute when rate-limited, run every due delivery and expire leases a crashed worker left.
/// Appended to random walks so `delivery.settles` can close.
/// Returns None when the model says the drain cannot settle everything: the transport breaker
/// waits 30 s of real time, which no step advances.
fn drain(trace: &[String], retries: u32, bound: usize) -> Option<Vec<String>> {
    let mut m = Model::initial(retries);
    for l in trace {
        m.step(parse(l).unwrap());
    }
    let mut out = vec![];
    while out.len() < bound {
        let next = (|| {
            for (w, k) in &m.workers {
                match k {
                    Wk::Flight { .. } => return Some(format!("reply {w} 503")),
                    Wk::Parked { .. } => return Some(format!("go {w}")),
                    Wk::Idle => {}
                }
            }
            if let Some((e, _)) = m.eps.iter().find(|(_, e)| e.paused) {
                return Some(format!("unpause {e}"));
            }
            if m.eps.values().any(|e| e.used >= e.per_minute) {
                return Some("tick".into());
            }
            for d in &m.ds {
                if let Some(j) = &d.job {
                    if j.status == "pending" || (j.status == "running" && j.expired) {
                        return Some(format!("run L {}", d.label));
                    }
                }
            }
            for d in &m.ds {
                if d.job.as_ref().is_some_and(|j| j.status == "running" && !j.expired) {
                    return Some(format!("expire {}", d.label));
                }
            }
            None
        })();
        let Some(label) = next else { break };
        let a = parse(&label).unwrap();
        if !m.enabled(&a) {
            break;
        }
        m.step(a);
        out.push(label);
    }
    let settled = m.ds.iter().all(|d| ["delivered", "failed", "paused"].contains(&d.status.as_str()) || d.job.as_ref().is_some_and(|j| j.status != "pending" && j.status != "running"));
    settled.then_some(out)
}

/// Group key: the action verb plus the mismatch path (digits elided).
fn signature(run: &Value) -> String {
    let index = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
    let step = &run["steps"][index];
    let label = step["action"].as_str().unwrap_or_default();
    let verb = label.split(' ').next().unwrap_or_default();
    let path = run["mismatch"]["path"].as_str().unwrap_or_default();
    let path: String = path.split('/').take(4).collect::<Vec<_>>().join("/");
    let detail: String = path.chars().map(|c| if c.is_ascii_digit() { '#' } else { c }).collect();
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

fn n_of(ep: &str, retries: u32) -> u64 {
    1 + if ep == "W" || ep == "V" || ep == "U" { retries as u64 } else { 9 }
}

/// tear's temporal monitor over the observed steps of one trace (product observations only).
fn temporal(steps: &[Value], retries: u32, drained: Option<usize>) -> R<Value> {
    let props = vec![
        // A request may start again after a known failure (an HTTP error); after a success, an
        // unknown outcome or while another request for it is in flight, only to a replay-safe
        // endpoint, and then with the delivery's own Idempotency-Key.
        Property::always("delivery.once", "/observed/r", |f| f["dupStart"] == json!(false) && f["badKey"] == json!(false)),
        Property::always("delivery.attempts", "/observed/sends", move |f| {
            f["cum"].as_object().is_some_and(|c| {
                c.iter().all(|(d, n)| {
                    let ep = d.split(':').nth(1).unwrap_or("S").chars().next().unwrap_or('S').to_string();
                    n.as_u64().unwrap_or(0) <= n_of(&ep, retries)
                })
            })
        }),
        Property::always("endpoint.held", "/observed/r", |f| f["heldSend"] == json!(false)),
        Property::eventually(
            "delivery.settles",
            "/observed/view/d",
            steps.len() as u64 + 1,
            |f| f["fresh"].as_array().is_some_and(|a| !a.is_empty()) && f["drained"] == json!(true),
            |t, f| {
                t["fresh"].as_array().unwrap().iter().all(|d| {
                    let s = &f["observed"]["view"]["d"][d.as_str().unwrap_or_default()];
                    s.is_null() || ["delivered", "failed", "paused"].contains(&s[0].as_str().unwrap_or_default())
                })
            },
        ),
    ];
    let mut mon = Monitor::new(props)?;
    let mut cum: BTreeMap<String, u64> = BTreeMap::new();
    let mut unsafe_: BTreeMap<String, u64> = BTreeMap::new();
    let mut inflight: BTreeMap<String, String> = BTreeMap::new();
    let mut prev = Value::Null;
    for (i, s) in steps.iter().enumerate() {
        let o = &s["observed"];
        let words: Vec<&str> = s["action"].as_str().unwrap_or_default().split(' ').collect();
        let worker = words.get(1).copied().unwrap_or_default().to_string();
        match words[0] {
            "reply" | "crash" | "drop" => {
                if let Some(d) = inflight.remove(&worker) {
                    let kind = words.get(2).copied().unwrap_or_default();
                    let unknown_or_ok = words[0] == "crash" || kind == "timeout" || kind == "reset" || kind.starts_with('2');
                    if unknown_or_ok {
                        *unsafe_.entry(d).or_default() += 1;
                    }
                }
            }
            _ => {}
        }
        let mut dup = false;
        if let (Some(ep), Some(d)) = (o["r"]["sending"].as_str(), o["r"]["d"].as_str()) {
            if (ep == "W" || ep == "S") && (unsafe_.get(d).copied().unwrap_or(0) > 0 || inflight.values().any(|x| x == d)) {
                dup = true;
            }
            inflight.insert(worker.clone(), d.to_string());
        }
        let mut bad_key = false;
        for send in o["sends"].as_array().into_iter().flatten() {
            let d = send[1].as_str().unwrap_or("?").to_string();
            *cum.entry(d.clone()).or_default() += 1;
            if d.contains(":V") && send[2] != json!(true) {
                bad_key = true;
            }
        }
        let held = o["r"]["sending"].as_str().is_some_and(|ep| {
            let e = &prev["view"]["e"][ep];
            !prev.is_null() && (e.is_null() || e[0] == json!(true))
        });
        let fresh: Vec<String> = o["view"]["d"]
            .as_object()
            .map(|m| m.keys().filter(|k| prev["view"]["d"][k.as_str()].is_null()).cloned().collect())
            .unwrap_or_default();
        mon.push(i as u64, json!({"observed": o, "cum": cum, "badKey": bad_key, "dupStart": dup, "heldSend": held, "fresh": fresh, "drained": drained.is_some()}))?;
        prev = o.clone();
    }
    if drained.is_some() {
        mon.close_through(steps.len() as u64 + drained.unwrap_or(0) as u64 + 2)?;
    }
    Ok(mon.receipt())
}

/// Checklist items each step reaches, from the model's pre-state (counted only before a mismatch).
fn reached(m: &Model, label: &str, obs: &Value) -> Vec<&'static str> {
    let mut out = vec![];
    let a = parse(label).unwrap();
    let flights = m.workers.values().filter(|w| matches!(w, Wk::Flight { .. })).count();
    let holder = |e: &str| m.workers.values().any(|w| matches!(w, Wk::Parked { d, .. } | Wk::Flight { d, .. } if d.split(':').nth(1).is_some_and(|x| x.starts_with(e))));
    match &a {
        Act::Ingest { m: msg, rcpts, variant } => {
            if msg.starts_with('d') || m.receipts.contains_key(msg) {
                out.push("R4");
            }
            if m.emails.contains_key(&model::email_of(msg)) && m.emails.len() >= 1 {
                out.push("C4");
            }
            if variant != "plain" {
                out.push("L4");
            }
            if rcpts.iter().any(|r| r == "b") && m.ritual == "four" {
                out.push("L2");
            }
            if rcpts.iter().any(|r| r == "b") && (m.ritual == "max" || m.ritual == "over") {
                out.push("L3");
            }
            if m.eps.values().any(|e| e.paused) {
                out.push("P1");
            }
            if obs["view"]["d"].as_object().map(|d| d.len()) == Some(m.ds.len()) {
                out.push("L8");
            }
        }
        Act::Run { d, .. } => {
            if let Some(dd) = m.ds.iter().find(|x| &x.label == d) {
                let j = dd.job.as_ref().unwrap();
                if j.status == "running" {
                    out.extend(["R1", "T1", "O1"]);
                }
                if dd.ep == "F" && dd.fence.is_some() {
                    out.push("R6");
                }
                if dd.ep == "F" {
                    out.push("E2");
                }
                if m.eps.get(&dd.ep).is_some_and(|e| e.used >= e.per_minute) {
                    out.push("L1");
                }
                if m.eps.get(&dd.ep).is_some_and(|e| e.timeouts >= 3) {
                    out.push("L5");
                }
                if dd.ep == "F" && m.eps.get("F").is_some_and(|f| f.declined) {
                    out.push("P3");
                }
                if j.attempts + 1 >= m.retries + 1 && (dd.ep == "W" || dd.ep == "V") {
                    out.push("R5");
                }
                if m.retries == 0 {
                    out.push("L6");
                }
            }
            if flights > 0 {
                out.push("C1");
            }
        }
        Act::Reply { w, resp } => {
            out.extend(["R3", "E1"]);
            if let Wk::Flight { attempts, .. } = &m.workers[w] {
                if *attempts >= 7 && resp != "200" {
                    out.push("T4");
                }
            }
            if resp.starts_with("429") || resp.starts_with("503") || resp == "timeout" {
                out.push("T2");
            }
            if let Wk::Flight { stale, .. } = &m.workers[w] {
                if *stale {
                    out.push("R2");
                }
            }
            if flights > 1 {
                out.push("C1");
            }
        }
        Act::Crash { .. } => out.extend(["R1", "E1"]),
        Act::Expire { .. } => out.push("T1"),
        Act::Tick => out.push("T3"),
        Act::Pause { e, .. } | Act::Delete { e } => {
            out.push(if matches!(a, Act::Delete { .. }) { "P2" } else { "P1" });
            if m.workers.values().any(|w| matches!(w, Wk::Parked { .. })) && holder(e) {
                out.push("C2");
            }
            if m.workers.values().any(|w| matches!(w, Wk::Flight { .. })) && holder(e) {
                out.push("C3");
            }
        }
        Act::Rituals { .. } | Act::RouteSet { .. } => {
            if !m.emails.is_empty() {
                out.push("C4");
            }
            if label == "rituals none" || label.ends_with(" off") || label.ends_with(" drop") {
                out.push("L8");
            }
        }
        Act::Rate { n: 1, .. } => out.push("L1"),
        Act::Decline => out.push("P3"),
        Act::Prune => {
            out.push("T6");
            if m.ds.iter().any(|d| d.aged && d.status == "paused") {
                out.push("P1");
            }
        }
        Act::Strip { .. } => out.push("E4"),
        _ => {}
    }
    if let Act::Run { d, .. } | Act::Go { w: d } = &a {
        let label = match &a {
            Act::Go { w } => match &m.workers[w] {
                Wk::Parked { d, .. } => d.clone(),
                _ => String::new(),
            },
            _ => d.clone(),
        };
        if label.ends_with(":U") {
            out.push("C6");
        }
        if let Some(dd) = m.ds.iter().find(|x| x.label == label) {
            if dd.job.as_ref().is_some_and(|j| j.status == "running" && j.expired && dd.tries < j.attempts) && dd.ep != "U" {
                out.push("R7");
            }
        }
    }
    out
}

struct Campaign {
    retries: u32,
    replays: u64,
}

fn campaign(name: &str, traces: Vec<(Vec<String>, Option<usize>)>, c: &Campaign, host: Host, deadline: Option<Instant>) -> R<Value> {
    let start = Instant::now();
    let mut check = Check { retries: c.retries, host, fixtures: 0 };
    let (mut matched, mut steps, mut errors, mut run_traces) = (0u64, 0u64, vec![], 0u64);
    let mut groups: BTreeMap<String, (u64, Vec<String>)> = BTreeMap::new();
    let mut coverage: BTreeMap<String, u64> = BTreeMap::new();
    let mut temporal_violations: Vec<Value> = vec![];
    let mut temporal_checked: BTreeMap<String, u64> = BTreeMap::new();
    // The model's own no-loss property, on every state the trace reaches.
    let (mut model_checked, mut model_lost) = (0u64, vec![]);
    for (trace, drained) in traces {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            break;
        }
        run_traces += 1;
        let run = conformance::dispatch("runTrace", &json!({"actions": trace}), &mut check)?;
        let observed = run["steps"].as_array().cloned().unwrap_or_default();
        steps += observed.len() as u64;
        // Checklist coverage up to the first mismatch.
        let upto = if run["status"] == json!("match") { observed.len() } else { run["mismatch"]["index"].as_u64().unwrap_or(0) as usize };
        let mut m = Model::initial(c.retries);
        for s in observed.iter().take(upto) {
            let label = s["action"].as_str().unwrap_or_default();
            for item in reached(&m, label, &s["observed"]) {
                *coverage.entry(item.to_string()).or_default() += 1;
            }
            m.step(parse(label).unwrap());
        }
        let mut whole = Model::initial(c.retries);
        for label in &trace {
            whole.step(parse(label).unwrap());
            model_checked += 1;
            if let Some(why) = whole.lost() {
                if model_lost.len() < 10 {
                    model_lost.push(json!({"lost": why, "trace": trace}));
                }
                break;
            }
        }
        let receipt = temporal(&observed, c.retries, if run["status"] == json!("match") { drained } else { None })?;
        for p in receipt["properties"].as_array().into_iter().flatten() {
            *temporal_checked.entry(p["id"].as_str().unwrap_or("?").to_string()).or_default() += p["checked"].as_u64().unwrap_or(0);
            if p["status"] == json!("violation") && temporal_violations.len() < 20 {
                temporal_violations.push(json!({"property": p["id"], "violations": p["violations"], "trace": trace}));
            }
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
            _ => errors.push(json!({"trace": trace, "run": run})),
        }
    }
    let checked = start.elapsed();
    let mut witnesses = vec![];
    for (sig, (count, trace)) in &groups {
        let reduced = conformance::dispatch("minimizeTrace", &json!({"actions": trace, "options": {"maxReplays": c.replays}}), &mut check)?;
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
        "campaign": name, "traces": run_traces, "matched": matched,
        "mismatched": groups.values().map(|g| g.0).sum::<u64>(), "errors": errors,
        "steps": steps, "fixtures": check.fixtures,
        "checkMs": checked.as_millis() as u64, "totalMs": start.elapsed().as_millis() as u64,
        "coverage": coverage, "temporal": {"checked": temporal_checked, "violations": temporal_violations},
        "model": {"delivery.kept": {"checked": model_checked, "violations": model_lost}},
        "witnesses": witnesses,
    }))
}

fn edges(depth: u64, max_states: u64, alpha: &str, retries: u32) -> R<(Value, Vec<Vec<String>>)> {
    let start = Instant::now();
    let mut space = Space { labels: alphabet(alpha) };
    let graph = search::map_states(&json!(Model::initial(retries)), &json!({"maxDepth": depth, "maxStates": max_states}), &mut space)?;
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
    let info = json!({"graph": graph["status"], "states": nodes, "edges": edges.len(), "maxDepth": depth, "alphabet": alpha, "mapMs": start.elapsed().as_millis() as u64});
    Ok((info, traces))
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn failed(r: &Value) -> bool {
    r["mismatched"].as_u64().is_some_and(|n| n > 0)
        || r["errors"].as_array().is_some_and(|e| !e.is_empty())
        || r["temporal"]["violations"].as_array().is_some_and(|v| !v.is_empty())
        || r["model"]["delivery.kept"]["violations"].as_array().is_some_and(|v| !v.is_empty())
}

fn main() -> R<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let retries: u32 = flag(&args, "--retries").and_then(|s| s.parse().ok()).unwrap_or(1);
    let seed: u64 = flag(&args, "--seed").and_then(|s| s.parse().ok()).unwrap_or(0);
    let replays: u64 = flag(&args, "--replays").and_then(|s| s.parse().ok()).unwrap_or(200);
    let alpha = flag(&args, "--alpha");
    let budget: u64 = flag(&args, "--budget").and_then(|s| s.parse().ok()).unwrap_or(55);
    let flags = ["--retries", "--seed", "--replays", "--alpha", "--budget"];
    let positional: Vec<&String> = args
        .iter()
        .enumerate()
        .skip(1)
        .filter(|(i, a)| !a.starts_with("--") && !flags.contains(&args[i - 1].as_str()))
        .map(|(_, a)| a)
        .collect();
    let nums: Vec<u64> = positional.iter().filter_map(|a| a.parse().ok()).collect();
    let c = Campaign { retries, replays };
    let report = match args.first().map(String::as_str) {
        Some("trace") => {
            let mut check = Check { retries, host: Host::spawn()?, fixtures: 0 };
            let run = conformance::dispatch("runTrace", &json!({"actions": positional}), &mut check)?;
            let path = run["mismatch"]["path"].as_str().unwrap_or_default();
            let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
            json!({"status": run["status"], "mismatch": run["mismatch"], "error": run["error"], "disabled": run["disabled"],
                "failingStep": if path.is_empty() { Value::Null } else { focus(&run["steps"][at], path) },
                "steps": if std::env::var("TEAR_STEPS").is_ok() { run["steps"].clone() } else { Value::Null }})
        }
        Some("space") => {
            let a = alpha.as_deref().unwrap_or("core");
            let mut out = vec![];
            for d in 1..=nums.first().copied().unwrap_or(4) {
                let (info, traces) = edges(d, 2_000_000, a, retries)?;
                let steps: usize = traces.iter().map(Vec::len).sum();
                out.push(json!({"depth": d, "model": info, "traceSteps": steps}));
            }
            json!(out)
        }
        Some("edges") => {
            let a = alpha.as_deref().unwrap_or("core");
            let (info, traces) = edges(nums.first().copied().unwrap_or(3), nums.get(1).copied().unwrap_or(500_000), a, retries)?;
            let mut r = campaign(&format!("edge coverage ({a})"), traces.into_iter().map(|t| (t, None)).collect(), &c, Host::spawn()?, None)?;
            r["graph"] = info;
            r
        }
        Some("ci") => {
            // PR budget (--budget, default 55 s in all): the bug witnesses, every transition of
            // the core and ritual alphabets to depth 2, then drained random walks over the full
            // alphabet (retries 1, 0, 2) in the time left.
            let start = Instant::now();
            let mut regressions = vec![];
            let mut coverage: BTreeMap<String, u64> = BTreeMap::new();
            let mut check = Check { retries: 1, host: Host::spawn()?, fixtures: 0 };
            for (r, actions) in REGRESSIONS {
                check.retries = *r;
                let run = conformance::dispatch("runTrace", &json!({"actions": actions}), &mut check)?;
                if run["status"] == json!("match") {
                    let mut m = Model::initial(*r);
                    for s in run["steps"].as_array().into_iter().flatten() {
                        let label = s["action"].as_str().unwrap_or_default();
                        for item in reached(&m, label, &s["observed"]) {
                            *coverage.entry(item.to_string()).or_default() += 1;
                        }
                        m.step(parse(label).unwrap());
                    }
                }
                regressions.push(json!({"retries": r, "actions": actions, "status": run["status"], "mismatch": run["mismatch"]}));
            }
            let mut parts = vec![];
            for (a, depth) in [("core", 2), ("ritual", 2)] {
                let (info, traces) = edges(depth, 500_000, a, 1)?;
                let mut r = campaign(&format!("edge coverage ({a}, depth {depth})"), traces.into_iter().map(|t| (t, None)).collect(), &Campaign { retries: 1, replays }, Host::spawn()?, None)?;
                r["graph"] = info;
                parts.push(r);
            }
            let deadline = start + Duration::from_secs(budget);
            for (i, r) in [1u32, 0, 2].iter().enumerate() {
                let labels = alphabet("full");
                let traces: Vec<(Vec<String>, Option<usize>)> = (0..2000)
                    .map(|s| {
                        let t = walk(seed + s * 3 + i as u64, 24, &labels, *r);
                        match drain(&t, *r, 200) {
                            Some(d) => { let n = d.len(); ([t, d].concat(), Some(n)) }
                            None => (t, None),
                        }
                    })
                    .collect();
                let slice = deadline.saturating_duration_since(Instant::now()) / (3 - i as u32);
                parts.push(campaign(&format!("random walks, drained (retries {r}, seed {seed})"), traces, &Campaign { retries: *r, replays }, Host::spawn()?, Some(Instant::now() + slice))?);
            }
            let bad = parts.iter().any(failed) || regressions.iter().any(|r| r["status"] != json!("match"));
            for p in &parts {
                for (k, v) in p["coverage"].as_object().into_iter().flatten() {
                    *coverage.entry(k.clone()).or_default() += v.as_u64().unwrap_or(0);
                }
            }
            let report = json!({"regressions": regressions, "runs": parts, "coverage": coverage, "totalMs": start.elapsed().as_millis() as u64});
            println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
            if bad {
                std::process::exit(1);
            }
            return Ok(());
        }
        _ => {
            let a = alpha.as_deref().unwrap_or("full");
            let (n, len) = (nums.first().copied().unwrap_or(200), nums.get(1).copied().unwrap_or(30));
            let labels = alphabet(a);
            let traces = (0..n)
                .map(|s| {
                    let t = walk(seed + s, len as usize, &labels, retries);
                    match drain(&t, retries, 200) {
                        Some(d) => { let k = d.len(); ([t, d].concat(), Some(k)) }
                        None => (t, None),
                    }
                })
                .collect();
            campaign(&format!("random walks, drained (seed {seed}, {a}, retries {retries})"), traces, &c, Host::spawn()?, None)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    let bad = failed(&report) || report["status"].as_str().is_some_and(|s| s != "match");
    if bad {
        std::process::exit(1);
    }
    Ok(())
}
