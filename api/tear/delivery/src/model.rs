//! Reference model of received-mail delivery, written from the documented contract (endpoint and
//! route docs, ritual-retry.ts, the JobDeferred and webhook-attempt comments), not from the code
//! paths it checks. Every step returns the exact observation the host must report.
//!
//! The workspace has one receiving host with
//! - box@ (an address with rituals attached), a@, x-1@ and z@ as recipients;
//! - routes r1 a@ -> [W], r2 x-*@ -> [W, V], r3 *@ ("Everything else") -> [V];
//! - endpoints W (webhook), V (webhook that deduplicates by Idempotency-Key, so replay-safe),
//!   S (Slack) and F (forward, pre-verified), all called through the one delivery path.
//!
//! Contract points the model encodes:
//! - An action is identified by (email, recipient, ritual, call index, endpoint); a routed webhook
//!   delivery by (email, endpoint). Each is queued once, however often or under however many
//!   receipts the email arrives, and a reopened receipt only routes its new recipients.
//! - A delivery is attempted at most 1 + retryAttempts times. A claim that sends, or crashes, is an
//!   attempt; a deferral before anything is sent (rate limit, timeout breaker) is not, and does not
//!   erase earlier attempts. A lease that expires after the last attempt dead-letters it.
//! - Each attempt is fenced: a non-replay-safe endpoint receives an action at most once; after an
//!   unknown outcome only a replay-safe endpoint (idempotent webhook, retryOnTimeout, forward) is
//!   sent it again, always with the same Idempotency-Key.
//! - A paused endpoint receives nothing that is decided after the pause commits: queued work parks
//!   and resumes on unpause; new mail skips it (routing reports it unavailable). A deleted endpoint
//!   loses its queue.
//! - Backoff is 15 s x 4^(attempt-1), capped at 12 h, never sooner than Retry-After (capped at 7
//!   days); jitter is pinned to 1 by the host.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const WORKERS: [&str; 2] = ["K", "L"];
pub const EPS: [&str; 4] = ["W", "V", "S", "F"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Ep {
    pub paused: bool,
    pub declined: bool,
    pub per_minute: u32,
    pub used: u32,
    /// Consecutive transport timeouts (the per-URL breaker in postWebhook).
    pub timeouts: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Route {
    pub enabled: bool,
    pub drop: bool,
    pub to: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Job {
    pub status: String,
    pub attempts: u32,
    pub expired: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct D {
    pub label: String,
    pub ep: String,
    pub msg: String,
    pub status: String,
    pub count: u32,
    pub err: Option<String>,
    pub fence: Option<String>,
    pub job: Option<Job>,
    pub delay: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum Wk {
    Idle,
    /// Claimed and parked before the handler. `hook` is what the claim statement joined.
    Parked { d: String, attempts: u32, stale: bool, hook: bool },
    /// A request is in flight to `ep`.
    Flight { d: String, attempts: u32, stale: bool, ep: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Msg {
    /// Recipients the stored message was routed for (its envelope).
    pub rcpts: Vec<String>,
    pub variant: String,
    /// The receipt that stored the email first; deliveries carry its message ID.
    pub stored: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Model {
    pub retries: u32,
    pub routes: BTreeMap<String, Route>,
    pub ritual: String,
    pub eps: BTreeMap<String, Ep>,
    /// Receipts by SES label (m1, d1, ...).
    pub receipts: BTreeMap<String, Vec<String>>,
    /// Emails by message label (dN is the same email as mN): recipients processed and the variant.
    pub emails: BTreeMap<String, Msg>,
    pub ds: Vec<D>,
    pub workers: BTreeMap<String, Wk>,
    pub boxed: BTreeMap<String, Vec<String>>,
    pub forwards: Vec<String>,
    pub forward_sends: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    Ingest { m: String, rcpts: Vec<String>, variant: String },
    Run { w: String, d: String, gate: bool },
    Go { w: String },
    Reply { w: String, resp: String },
    Crash { w: String, sent: bool },
    Expire { d: String },
    Tick,
    Pause { e: String, on: bool },
    Delete { e: String },
    Rituals { mode: String },
    RouteSet { r: String, state: String },
    Rate { e: String, n: u32 },
    Decline,
}

pub const RESPONSES: [&str; 10] = ["200", "503", "429 120", "400", "timeout", "408", "410", "429", "429 9999999", "reset"];
pub const CORE_RESPONSES: [&str; 5] = ["200", "503", "429 120", "400", "timeout"];
pub const RITUALS: [&str; 7] = ["none", "slack", "forward", "both", "four", "max", "over"];

pub fn parse(label: &str) -> Option<Act> {
    let w: Vec<&str> = label.split(' ').collect();
    let s = |i: usize| w.get(i).map(|x| x.to_string());
    Some(match *w.first()? {
        "ingest" => Act::Ingest { m: s(1)?, rcpts: s(2)?.split('+').map(String::from).collect(), variant: s(3).unwrap_or_else(|| "plain".into()) },
        "run" | "claim" => Act::Run { w: s(1)?, d: s(2)?, gate: w[0] == "claim" },
        "go" => Act::Go { w: s(1)? },
        "reply" => Act::Reply { w: s(1)?, resp: w[2..].join(" ") },
        "crash" | "drop" => Act::Crash { w: s(1)?, sent: w[0] == "crash" },
        "expire" => Act::Expire { d: s(1)? },
        "tick" => Act::Tick,
        "pause" | "unpause" => Act::Pause { e: s(1)?, on: w[0] == "pause" },
        "delete" => Act::Delete { e: s(1)? },
        "rituals" => Act::Rituals { mode: s(1)? },
        "route" => Act::RouteSet { r: s(1)?, state: s(2)? },
        "rate" => Act::Rate { e: s(1)?, n: s(2)?.parse().ok()? },
        "decline" => Act::Decline,
        _ => return None,
    })
}

/// Which endpoints a ritual mode calls from box@, in call order (the call index is the position).
fn calls(mode: &str) -> Vec<(&'static str, u32)> {
    match mode {
        "slack" | "max" => vec![("S", 0)],
        "forward" => vec![("F", 0)],
        "both" => vec![("S", 0), ("F", 1)],
        // At most three calls per endpoint per message: the fourth is skipped with a warning.
        "four" => vec![("S", 0), ("S", 1), ("S", 2)],
        _ => vec![],
    }
}
fn replay_safe(ep: &str) -> bool {
    ep == "V" || ep == "F"
}
fn retry_after_ms(arg: Option<&str>) -> u64 {
    match arg {
        Some(v) if v.chars().all(|c| c.is_ascii_digit()) => (v.parse::<u64>().unwrap_or(0) * 1000).min(7 * 86_400_000),
        _ => 0,
    }
}
fn backoff_s(attempt: u32, after_ms: u64) -> u64 {
    let base = (15_000u64 * 4u64.pow(attempt.saturating_sub(1).min(10))).min(12 * 3_600_000);
    base.max(after_ms) / 1000
}

impl Model {
    pub fn initial(retries: u32) -> Self {
        let ep = |pm| Ep { paused: false, declined: false, per_minute: pm, used: 0, timeouts: 0 };
        let route = |to: &[&str]| Route { enabled: true, drop: false, to: to.iter().map(|s| s.to_string()).collect() };
        Model {
            retries,
            routes: BTreeMap::from([("r1".into(), route(&["W"])), ("r2".into(), route(&["W", "V"])), ("r3".into(), route(&["V"]))]),
            ritual: "none".into(),
            eps: EPS.iter().map(|e| (e.to_string(), ep(60))).collect(),
            receipts: BTreeMap::new(),
            emails: BTreeMap::new(),
            ds: vec![],
            workers: WORKERS.iter().map(|w| (w.to_string(), Wk::Idle)).collect(),
            boxed: BTreeMap::new(),
            forwards: vec![],
            forward_sends: 0,
        }
    }

    /// Attempts allowed for a delivery: 1 + the endpoint's retryAttempts (9 unless set).
    fn max_attempts(&self, ep: &str) -> u32 {
        1 + if ep == "W" || ep == "V" { self.retries } else { 9 }
    }
    fn d(&self, label: &str) -> Option<&D> {
        self.ds.iter().find(|d| d.label == label)
    }
    fn dm(&mut self, label: &str) -> Option<&mut D> {
        self.ds.iter_mut().find(|d| d.label == label)
    }
    fn worker(&self, w: &str) -> &Wk {
        &self.workers[w]
    }

    pub fn enabled(&self, a: &Act) -> bool {
        match a {
            Act::Ingest { m, rcpts, variant } => {
                let email = email_of(m);
                if rcpts.iter().any(|r| !["a", "x", "z", "b"].contains(&r.as_str())) {
                    return false;
                }
                // A duplicate dN carries mN's content, so only after mN.
                if m.starts_with('d') && !self.emails.contains_key(&email) {
                    return false;
                }
                if let Some(e) = self.emails.get(&email) {
                    if variant != &e.variant {
                        return false;
                    }
                }
                match self.receipts.get(m) {
                    // An SES receipt only ever grows its envelope.
                    Some(old) => old.iter().all(|r| rcpts.contains(r)),
                    None => true,
                }
            }
            Act::Run { w, d, .. } => {
                matches!(self.worker(w), Wk::Idle)
                    && self.d(d).and_then(|d| d.job.as_ref()).is_some_and(|j| j.status == "pending" || (j.status == "running" && j.expired))
            }
            Act::Go { w } => matches!(self.worker(w), Wk::Parked { .. }),
            Act::Reply { w, .. } => matches!(self.worker(w), Wk::Flight { .. }),
            Act::Crash { w, sent } => match self.worker(w) {
                Wk::Flight { .. } => true,
                Wk::Parked { .. } => !sent,
                Wk::Idle => false,
            },
            Act::Expire { d } => self.d(d).and_then(|d| d.job.as_ref()).is_some_and(|j| j.status == "running" && !j.expired),
            Act::Tick => self.eps.values().any(|e| e.used > 0),
            Act::Pause { e, on } => self.eps.get(e).is_some_and(|x| x.paused != *on),
            Act::Delete { e } => self.eps.contains_key(e),
            Act::Rituals { mode } => {
                mode != &self.ritual && calls(mode).iter().chain(if mode == "over" { &[("S", 0)][..] } else { &[] }).all(|(e, _)| self.eps.contains_key(*e))
            }
            Act::RouteSet { r, state } => {
                let x = &self.routes[r];
                match state.as_str() {
                    "on" => !x.enabled,
                    "off" => x.enabled,
                    "drop" => !x.drop,
                    _ => false,
                }
            }
            Act::Rate { e, n } => self.eps.get(e).is_some_and(|x| x.per_minute != *n),
            Act::Decline => self.eps.get("F").is_some_and(|f| !f.declined),
        }
    }

    /// Applies one action; returns the step result (`r`) and the sends observed in it.
    pub fn step(&mut self, a: Act) -> (Value, Vec<Value>) {
        let mut sends = vec![];
        let r = match a {
            Act::Ingest { m, rcpts, variant } => self.ingest(&m, &rcpts, &variant),
            Act::Run { w, d, gate } => self.run(&w, &d, gate),
            Act::Go { w } => {
                let Wk::Parked { d, attempts, stale, hook } = self.worker(&w).clone() else { unreachable!() };
                self.workers.insert(w.clone(), Wk::Idle);
                self.handle(&w, &d, attempts, stale, hook)
            }
            Act::Reply { w, resp } => self.reply(&w, &resp, &mut sends),
            Act::Crash { w, sent } => {
                if let (Wk::Flight { d, ep, .. }, true) = (self.worker(&w).clone(), sent) {
                    sends.push(json!([ep, d, ep != "S"]));
                }
                self.workers.insert(w, Wk::Idle);
                json!("ok")
            }
            Act::Expire { d } => {
                if let Some(j) = self.dm(&d).and_then(|d| d.job.as_mut()) {
                    j.expired = true;
                }
                self.stale(&d);
                json!("ok")
            }
            Act::Tick => {
                for e in self.eps.values_mut() {
                    e.used = 0;
                }
                json!("ok")
            }
            Act::Pause { e, on } => {
                self.eps.get_mut(&e).unwrap().paused = on;
                if !on {
                    // Resume: every parked delivery of the endpoint gets a new generation and job.
                    let parked: Vec<String> = self.ds.iter().filter(|d| d.ep == e && d.status == "paused").map(|d| d.label.clone()).collect();
                    for label in parked {
                        self.stale(&label);
                        let d = self.dm(&label).unwrap();
                        d.status = "pending".into();
                        d.err = None;
                        d.job = Some(Job { status: "pending".into(), attempts: 0, expired: false });
                        d.delay = json!(0);
                    }
                }
                json!("ok")
            }
            Act::Delete { e } => {
                self.eps.remove(&e);
                self.ds.retain(|d| d.ep != e);
                for r in self.routes.values_mut() {
                    r.to.retain(|x| x != &e);
                }
                if e == "S" || e == "F" {
                    self.ritual = "none".into();
                }
                json!("ok")
            }
            Act::Rituals { mode } => {
                // A ritual may call a forward only once its recipient allowed it.
                if calls(&mode).iter().any(|(e, _)| *e == "F") && self.eps["F"].declined {
                    json!("e:UNKNOWN_ENDPOINT")
                } else {
                    self.ritual = mode;
                    json!("ok")
                }
            }
            Act::RouteSet { r, state } => {
                let x = self.routes.get_mut(&r).unwrap();
                match state.as_str() {
                    "on" => x.enabled = true,
                    "off" => x.enabled = false,
                    _ => x.drop = true,
                }
                json!("ok")
            }
            Act::Rate { e, n } => {
                self.eps.get_mut(&e).unwrap().per_minute = n;
                json!("ok")
            }
            Act::Decline => {
                self.eps.get_mut("F").unwrap().declined = true;
                json!("ok")
            }
        };
        (r, sends)
    }

    /// Workers still holding `d` lose their claim (lease expired, or the job was replaced).
    fn stale(&mut self, d: &str) {
        for w in self.workers.values_mut() {
            match w {
                Wk::Parked { d: x, stale, .. } | Wk::Flight { d: x, stale, .. } if x == d => *stale = true,
                _ => {}
            }
        }
    }

    fn route_targets(&self, rcpt: &str) -> Option<Vec<String>> {
        // None: dropped. The most specific enabled route wins; a disabled route falls through.
        let chain: &[&str] = match rcpt {
            "a" => &["r1", "r3"],
            "x" => &["r2", "r3"],
            _ => &["r3"],
        };
        for r in chain {
            let route = &self.routes[*r];
            if !route.enabled {
                continue;
            }
            return if route.drop { None } else { Some(route.to.clone()) };
        }
        Some(vec![])
    }

    fn ingest(&mut self, m: &str, rcpts: &[String], variant: &str) -> Value {
        let email = email_of(m);
        let mut all: Vec<String> = self.receipts.get(m).cloned().unwrap_or_default();
        for r in rcpts {
            if !all.contains(r) {
                all.push(r.clone());
            }
        }
        self.receipts.insert(m.into(), all.clone());
        self.emails.entry(email.clone()).or_insert(Msg { rcpts: vec![], variant: variant.into(), stored: None });
        // A receipt whose every recipient a route drops is settled without storing anything.
        if all.iter().all(|r| r != "b" && self.route_targets(r).is_none()) {
            return json!("ok");
        }
        let e = self.emails.get_mut(&email).unwrap();
        let stored = e.stored.get_or_insert_with(|| m.to_string()).clone();
        // Recipients the stored email was already routed for are not routed again, whichever
        // receipt (a duplicate notification, a reopen, another SES ID) brings them.
        let fresh: Vec<String> = all.iter().filter(|r| !e.rcpts.contains(r)).cloned().collect();
        e.rcpts.extend(fresh.iter().cloned());
        let email = stored;
        for r in fresh {
            if r == "b" {
                let labels: Vec<String> = match self.ritual.as_str() {
                    "max" => vec!["l".into()],
                    "over" => vec!["ritual-error".into(), "spam".into()],
                    _ => vec![],
                };
                self.boxed.entry(email.clone()).or_insert(labels);
                for (e, idx) in calls(&self.ritual) {
                    if self.eps.get(e).is_some_and(|x| !x.paused) {
                        let label = format!("{email}:{e}{}", if e == "S" && idx > 0 { idx.to_string() } else { String::new() });
                        self.queue(&label, e, &email);
                    }
                }
            } else if let Some(targets) = self.route_targets(&r) {
                for e in targets {
                    if self.eps.get(&e).is_some_and(|x| !x.paused) {
                        let label = format!("{email}:{e}");
                        self.queue(&label, &e, &email);
                    }
                }
            }
        }
        json!("ok")
    }
    fn queue(&mut self, label: &str, ep: &str, msg: &str) {
        if self.d(label).is_none() {
            self.ds.push(D {
                label: label.into(),
                ep: ep.into(),
                msg: msg.into(),
                status: "pending".into(),
                count: 0,
                err: None,
                fence: None,
                job: Some(Job { status: "pending".into(), attempts: 0, expired: false }),
                delay: json!(0),
            });
        }
    }

    fn run(&mut self, w: &str, label: &str, gate: bool) -> Value {
        let max = self.max_attempts(&self.d(label).unwrap().ep);
        let d = self.dm(label).unwrap();
        let job = d.job.as_mut().unwrap();
        if job.status == "running" && job.attempts >= max {
            // The last attempt's lease expired: dead-letter it.
            job.status = "failed".into();
            if d.status == "pending" {
                d.status = "failed".into();
                d.err = Some("JOB_LEASE_EXHAUSTED".into());
            }
            return json!("done");
        }
        job.status = "running".into();
        job.attempts += 1;
        job.expired = false;
        let attempts = job.attempts;
        // The claim joins the endpoint: a paused one parks the delivery, a settled one is skipped.
        let ep = d.ep.clone();
        let hook = if d.status != "pending" {
            false
        } else if self.eps[&ep].paused {
            let d = self.dm(label).unwrap();
            d.status = "paused".into();
            d.err = Some("ENDPOINT_PAUSED".into());
            false
        } else {
            true
        };
        if gate {
            self.workers.insert(w.into(), Wk::Parked { d: label.into(), attempts, stale: false, hook });
            return json!("claimed");
        }
        self.handle(w, label, attempts, false, hook)
    }

    /// Settles the worker's job and (in the same statement) its delivery record.
    fn settle(&mut self, label: &str, attempts: u32, stale: bool, job: Option<(&str, Value)>, record: Option<(&str, Option<&str>)>) {
        let Some(d) = self.dm(label) else { return };
        let current = !stale && d.job.as_ref().is_some_and(|j| j.status == "running" && j.attempts == attempts);
        if !current {
            return;
        }
        if let Some((status, delay)) = job {
            let j = d.job.as_mut().unwrap();
            j.status = status.into();
            if status == "pending" {
                // A deferral returns the claim's attempt; a retry keeps it.
                if delay == json!("d") {
                    j.attempts -= 1;
                }
                d.delay = delay;
            }
        }
        if let Some((status, err)) = record {
            if d.status == "pending" {
                d.count += 1;
                d.status = status.into();
                d.err = err.map(String::from);
            }
        }
    }

    fn handle(&mut self, w: &str, label: &str, attempts: u32, stale: bool, hook: bool) -> Value {
        let Some(d) = self.d(label).cloned() else { return json!("done") };
        let done = json!("done");
        if !hook {
            self.settle(label, attempts, stale, Some(("completed", json!(null))), None);
            return done;
        }
        let ep = d.ep.clone();
        let Some(e) = self.eps.get(&ep).cloned() else { return done };
        if e.paused {
            // Decided after the pause committed: park like the claim does.
            if !stale && self.d(label).is_some_and(|d| d.status == "pending") {
                let d = self.dm(label).unwrap();
                d.status = "paused".into();
                d.err = Some("ENDPOINT_PAUSED".into());
            }
            self.settle(label, attempts, stale, Some(("completed", json!(null))), None);
            return done;
        }
        match d.fence.as_deref() {
            Some("delivered") => {
                self.settle(label, attempts, stale, Some(("completed", json!(null))), Some(("delivered", None)));
                return done;
            }
            Some("unknown") | Some("sending") if !replay_safe(&ep) => {
                self.settle(label, attempts, stale, Some(("failed", json!(null))), Some(("failed", Some("ACTION_UNKNOWN"))));
                return done;
            }
            _ => {}
        }
        if e.used >= e.per_minute {
            self.settle(label, attempts, stale, Some(("pending", json!("d"))), None);
            return done;
        }
        self.eps.get_mut(&ep).unwrap().used += 1;
        self.dm(label).unwrap().fence = Some("sending".into());
        if ep == "F" {
            let blocked = ["loop", "recv25"].contains(&self.emails[&email_of(&d.msg)].variant.as_str());
            let (status, err) = if e.declined {
                ("failed", Some("CONNECTOR_UNAVAILABLE"))
            } else if blocked {
                ("failed", Some("FORWARD_BLOCKED"))
            } else {
                if !self.forwards.contains(&d.msg) {
                    self.forwards.push(d.msg.clone());
                    self.forwards.sort();
                    self.forward_sends += 1;
                }
                ("delivered", None)
            };
            self.dm(label).unwrap().fence = Some(if status == "delivered" { "delivered" } else { "retry" }.into());
            self.settle(label, attempts, stale, Some((if status == "delivered" { "completed" } else { "failed" }, json!(null))), Some((status, err)));
            return done;
        }
        if e.timeouts >= 3 {
            // The transport breaker defers the call; nothing was sent.
            self.dm(label).unwrap().fence = Some("retry".into());
            self.settle(label, attempts, stale, Some(("pending", json!("d"))), None);
            return done;
        }
        self.workers.insert(w.into(), Wk::Flight { d: label.into(), attempts, stale, ep: ep.clone() });
        json!({"sending": ep, "d": label})
    }

    fn reply(&mut self, w: &str, resp: &str, sends: &mut Vec<Value>) -> Value {
        let Wk::Flight { d: label, attempts, stale, ep } = self.worker(w).clone() else { unreachable!() };
        self.workers.insert(w.into(), Wk::Idle);
        sends.push(json!([ep, label, ep != "S"]));
        let mut words = resp.split(' ');
        let kind = words.next().unwrap_or_default();
        let arg = words.next();
        if let Some(e) = self.eps.get_mut(&ep) {
            match kind {
                "timeout" => e.timeouts += 1,
                "reset" => {}
                _ => e.timeouts = 0,
            }
        }
        let max = self.max_attempts(&ep);
        let fence = |m: &mut Self, f: &str| {
            if let Some(d) = m.dm(&label) {
                d.fence = Some(f.into());
            }
        };
        let retry = |m: &mut Self, code: &str, after: u64| {
            if attempts < max {
                m.settle(&label, attempts, stale, Some(("pending", json!(backoff_s(attempts, after)))), Some(("pending", Some(code))));
            } else {
                m.settle(&label, attempts, stale, Some(("failed", json!(null))), Some(("failed", Some(code))));
            }
        };
        match kind {
            "timeout" | "reset" => {
                fence(self, "unknown");
                if replay_safe(&ep) {
                    retry(self, "ACTION_UNKNOWN", 0);
                } else {
                    self.settle(&label, attempts, stale, Some(("failed", json!(null))), Some(("failed", Some("ACTION_UNKNOWN"))));
                }
            }
            _ => {
                let status: u32 = kind.parse().unwrap_or(0);
                if (200..300).contains(&status) {
                    fence(self, "delivered");
                    self.settle(&label, attempts, stale, Some(("completed", json!(null))), Some(("delivered", None)));
                } else if status == 429 || status == 408 || status >= 500 {
                    fence(self, "retry");
                    retry(self, if status == 429 { "DESTINATION_THROTTLED" } else { "DESTINATION_UNAVAILABLE" }, retry_after_ms(arg));
                } else {
                    fence(self, "retry");
                    self.settle(&label, attempts, stale, Some(("failed", json!(null))), Some(("failed", Some("DESTINATION_REFUSED"))));
                }
            }
        }
        json!("done")
    }

    /// The committed state, in the host's shape.
    pub fn view(&self) -> Value {
        let d: serde_json::Map<String, Value> = self
            .ds
            .iter()
            .map(|d| {
                (
                    d.label.clone(),
                    json!([d.status, d.count, d.err, d.fence, d.job.as_ref().map(|j| json!([j.status, j.attempts])), d.delay]),
                )
            })
            .collect();
        let e: serde_json::Map<String, Value> = self.eps.iter().map(|(k, e)| (k.clone(), json!([e.paused, e.declined]))).collect();
        json!({"b": self.boxed, "d": d, "e": e, "f": self.forwards, "fs": self.forward_sends})
    }
}

pub fn email_of(m: &str) -> String {
    if let Some(n) = m.strip_prefix('d') { format!("m{n}") } else { m.to_string() }
}

/// Every action label of an alphabet. `core` keeps BFS small: one message, two recipients, the
/// responses that change state differently, and every fault and admin action.
pub fn alphabet(alpha: &str) -> Vec<String> {
    let mut out = vec![];
    let (msgs, rcpts, variants, responses, rituals): (&[&str], &[&str], &[&str], &[&str], &[&str]) = match alpha {
        "core" => (&["m1", "d1"], &["a", "z", "a+z"], &["plain"], &CORE_RESPONSES, &[]),
        "ritual" => (&["m1", "d1", "m2"], &["b", "b+z"], &["plain", "loop", "recv24", "recv25"], &["200", "503", "timeout"], &RITUALS),
        _ => (&["m1", "d1", "m2", "m3"], &["a", "x", "z", "b", "a+z", "b+z"], &["plain", "loop", "recv24", "recv25"], &RESPONSES, &RITUALS),
    };
    for m in msgs {
        for r in rcpts {
            for v in variants {
                out.push(if *v == "plain" { format!("ingest {m} {r}") } else { format!("ingest {m} {r} {v}") });
            }
        }
    }
    let labels = delivery_labels(msgs);
    for w in WORKERS {
        for d in &labels {
            out.push(format!("run {w} {d}"));
            out.push(format!("claim {w} {d}"));
        }
        out.push(format!("go {w}"));
        for r in responses {
            out.push(format!("reply {w} {r}"));
        }
        out.push(format!("crash {w}"));
        out.push(format!("drop {w}"));
    }
    for d in &labels {
        out.push(format!("expire {d}"));
    }
    out.push("tick".into());
    for e in EPS {
        out.push(format!("pause {e}"));
        out.push(format!("unpause {e}"));
        out.push(format!("delete {e}"));
        if alpha != "core" || e == "W" {
            out.push(format!("rate {e} 1"));
            out.push(format!("rate {e} 60"));
        }
    }
    for r in rituals {
        out.push(format!("rituals {r}"));
    }
    if alpha != "ritual" {
        for r in ["r1", "r3"] {
            for s in ["on", "off", "drop"] {
                out.push(format!("route {r} {s}"));
            }
        }
    }
    if alpha != "core" {
        out.push("decline".into());
    }
    out
}
fn delivery_labels(msgs: &[&str]) -> Vec<String> {
    let mut out = vec![];
    for m in msgs.iter().filter(|m| m.starts_with('m')) {
        for e in ["W", "V", "S", "S1", "S2", "F"] {
            out.push(format!("{m}:{e}"));
        }
    }
    out
}
