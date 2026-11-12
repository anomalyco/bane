//! Independent reference model of SES event processing on Hosted (shared pool) Bane: SNS feedback
//! through the feedback-queue consumer, the SNS route without a queue, and the recovery job; email
//! status, event outcomes, suppression, webhook fan-out, campaign stats, sender-score inputs and
//! hosted health. See `main.rs` for the edge-case checklist this model reaches.
//!
//! The contract it encodes, written from the API documentation and comments rather than the SQL:
//! - Every SNS notification (topic + MessageId) is applied at most once: one email event, one public
//!   event, one delivery per subscribed endpoint, one suppression merge per reported recipient. Once
//!   an ingress accepts it (queue ack or HTTP 202), it is applied exactly once after recovery jobs run.
//! - Email status only moves up a rank order, so out-of-order arrival converges. The order is the
//!   documented one with ties broken by lifecycle: accepted < delayed < validation-suppressed <
//!   delivered < bounced/rejected/rendering-failed < complained (validation suppression drops one
//!   recipient before sending; it never outranks an outcome SES reported for mail it did send).
//! - Suppression merges never lose or downgrade a reason: complaint > hard bounce > validation.
//! - Campaign stats, sender-score inputs and hosted health equal a recount of the applied feedback.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const WORKERS: [&str; 2] = ["J", "K"];
pub const HELD: [&str; 2] = ["Q", "P"];
pub const MAX_ATTEMPTS: u8 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum St {
    Attempting,
    Unknown,
    Accepted,
    Delayed,
    Suppressed,
    Delivered,
    Bounced,
    Rejected,
    Rendering,
    Complained,
}
impl St {
    fn name(self) -> &'static str {
        match self {
            St::Attempting => "attempting",
            St::Unknown => "acceptance_unknown",
            St::Accepted => "accepted",
            St::Delayed => "delayed",
            St::Suppressed => "suppressed",
            St::Delivered => "delivered",
            St::Bounced => "bounced",
            St::Rejected => "rejected",
            St::Rendering => "rendering_failed",
            St::Complained => "complained",
        }
    }
    fn rank(self) -> u8 {
        match self {
            St::Attempting => 1,
            St::Unknown => 2,
            St::Accepted => 3,
            St::Delayed => 4,
            St::Suppressed => 5,
            St::Delivered => 6,
            St::Bounced | St::Rejected | St::Rendering => 7,
            St::Complained => 8,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    Delivery,
    Bounce,
    Transient,
    Validation,
    Complaint,
    NotSpam,
    Delay,
    Reject,
    Render,
    Open,
}
impl Kind {
    /// sending_email_events.type
    fn event(self) -> &'static str {
        match self {
            Kind::Delivery => "delivery",
            Kind::Bounce => "bounce",
            Kind::Transient => "non_permanent_bounce",
            Kind::Validation => "validation_suppressed",
            Kind::Complaint => "complaint",
            Kind::NotSpam => "complaint_feedback",
            Kind::Delay => "delivery_delay",
            Kind::Reject => "reject",
            Kind::Render => "rendering_failure",
            Kind::Open => "open",
        }
    }
    fn status(self) -> Option<St> {
        match self {
            Kind::Delivery => Some(St::Delivered),
            Kind::Bounce => Some(St::Bounced),
            Kind::Transient | Kind::Delay => Some(St::Delayed),
            Kind::Validation => Some(St::Suppressed),
            Kind::Complaint => Some(St::Complained),
            Kind::NotSpam => Some(St::Accepted),
            Kind::Reject => Some(St::Rejected),
            Kind::Render => Some(St::Rendering),
            Kind::Open => None,
        }
    }
    fn public(self) -> Option<&'static str> {
        match self {
            Kind::Delivery => Some("email.delivered"),
            Kind::Bounce | Kind::Transient | Kind::Validation => Some("email.bounced"),
            Kind::Complaint => Some("email.complained"),
            Kind::NotSpam => None,
            Kind::Delay => Some("email.delivery_delayed"),
            Kind::Reject => Some("email.rejected"),
            Kind::Render => Some("email.rendering_failed"),
            Kind::Open => Some("email.opened"),
        }
    }
    /// Outcome bits of the public event (migration 088).
    fn bits(self) -> u16 {
        match self {
            Kind::Delivery => 3,
            Kind::Bounce => 5,
            Kind::Transient | Kind::Delay => 129,
            Kind::Validation | Kind::NotSpam => 0,
            Kind::Complaint => 9,
            Kind::Reject | Kind::Render => 64,
            Kind::Open => 16,
        }
    }
    fn suppress(self) -> Option<Reason> {
        match self {
            Kind::Bounce => Some(Reason::HardBounce),
            Kind::Validation => Some(Reason::Validation),
            Kind::Complaint => Some(Reason::Complaint),
            _ => None,
        }
    }
    fn reports(self) -> bool {
        matches!(
            self,
            Kind::Bounce | Kind::Transient | Kind::Validation | Kind::Complaint | Kind::NotSpam
        )
    }
    /// Send and Delivery are routine: no consent or engagement writes, applied inline on every path.
    fn routine(self) -> bool {
        self == Kind::Delivery
    }
}

/// One synthetic SNS notification. Emails: 0 = e1 (To r1), 1 = e2 (To r1, Cc r2), 2 = a provider
/// message id no local email has. `story` groups notifications SES can emit for one message
/// together: a validation-suppressed, rejected or unrenderable single-recipient email gets nothing
/// else. SES Send is not subscribed by any Bane configuration set, so it is not modelled.
pub struct Msg {
    pub label: &'static str,
    pub email: u8,
    pub kind: Kind,
    pub recips: &'static [u8],
    pub story: u8,
}
pub const MSGS: [Msg; 15] = [
    Msg {
        label: "d1",
        email: 0,
        kind: Kind::Delivery,
        recips: &[],
        story: 1,
    },
    Msg {
        label: "b1",
        email: 0,
        kind: Kind::Bounce,
        recips: &[0],
        story: 1,
    },
    Msg {
        label: "t1",
        email: 0,
        kind: Kind::Transient,
        recips: &[0],
        story: 1,
    },
    Msg {
        label: "c1",
        email: 0,
        kind: Kind::Complaint,
        recips: &[0],
        story: 1,
    },
    Msg {
        label: "n1",
        email: 0,
        kind: Kind::NotSpam,
        recips: &[0],
        story: 1,
    },
    Msg {
        label: "y1",
        email: 0,
        kind: Kind::Delay,
        recips: &[],
        story: 1,
    },
    Msg {
        label: "o1",
        email: 0,
        kind: Kind::Open,
        recips: &[],
        story: 1,
    },
    Msg {
        label: "v1",
        email: 0,
        kind: Kind::Validation,
        recips: &[0],
        story: 2,
    },
    Msg {
        label: "j1",
        email: 0,
        kind: Kind::Reject,
        recips: &[],
        story: 3,
    },
    Msg {
        label: "f1",
        email: 0,
        kind: Kind::Render,
        recips: &[],
        story: 4,
    },
    Msg {
        label: "d2",
        email: 1,
        kind: Kind::Delivery,
        recips: &[],
        story: 0,
    },
    Msg {
        label: "b2",
        email: 1,
        kind: Kind::Bounce,
        recips: &[1],
        story: 0,
    },
    Msg {
        label: "c2",
        email: 1,
        kind: Kind::Complaint,
        recips: &[1],
        story: 0,
    },
    Msg {
        label: "v2",
        email: 1,
        kind: Kind::Validation,
        recips: &[0],
        story: 0,
    },
    Msg {
        label: "x9",
        email: 2,
        kind: Kind::Bounce,
        recips: &[0],
        story: 0,
    },
];
pub fn msg(label: &str) -> Option<u8> {
    MSGS.iter().position(|m| m.label == label).map(|i| i as u8)
}
const ENVELOPE: [&[u8]; 2] = [&[0], &[0, 1]];
const COST: [i64; 2] = [1, 2];
const EMAILS: [&str; 2] = ["e1", "e2"];
const RECIPS: [&str; 2] = ["r1", "r2"];
/// Two-message batches the queue consumer can receive together.
pub const PAIRS: [(&str, &str); 10] = [
    ("c1", "o1"),
    ("b1", "b1"),
    ("d1", "b1"),
    ("b1", "c1"),
    ("t1", "d1"),
    ("y1", "d1"),
    ("d2", "b2"),
    ("b2", "c2"),
    ("o1", "c1"),
    ("c1", "n1"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Reason {
    HardBounce,
    Validation,
    Complaint,
}
impl Reason {
    fn name(self) -> &'static str {
        match self {
            Reason::HardBounce => "hard_bounce",
            Reason::Validation => "email_validation",
            Reason::Complaint => "complaint",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub suppressed: bool,
    pub reason: Option<Reason>,
    pub opened: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Email {
    pub status: St,
    pub provider: bool,
    pub bits: u16,
    pub lost: bool,
    /// The dispatcher recorded a provider acceptance (email.sent, hosted accepted volume).
    pub accepted: bool,
    pub dispatched: bool,
    /// Kinds of the feedback events stored for this email.
    pub kinds: Vec<Kind>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobSt {
    Pending,
    Running,
    Completed,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Job {
    pub st: JobSt,
    pub attempts: u8,
    /// The worker whose claim fences the row (None after a crash or before any claim).
    pub holder: Option<u8>,
    /// The lease expired: another worker may claim it and the holder's settlement no longer applies.
    pub expired: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Gate {
    Record,
    Suppress,
    Mark,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Worker {
    pub msg: u8,
    pub gate: Gate,
    pub blocked: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    pub msg: u8,
    pub blocked: bool,
    /// Contacts that existed when the statement started (its snapshot).
    pub seen: Vec<bool>,
    /// Result of the statement once it ran (None while blocked).
    pub result: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Db {
    pub emails: Vec<Email>,
    pub contacts: Vec<Option<Contact>>,
    /// Receipt per notification: false while open (deferred to its job), true once processed.
    pub receipts: BTreeMap<u8, bool>,
    pub jobs: BTreeMap<u8, Job>,
    /// Stored feedback events (by notification).
    pub events: BTreeSet<u8>,
    pub deliveries: [BTreeSet<String>; 2],
    pub paused: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Model {
    pub db: Db,
    pub workers: [Option<Worker>; 2],
    pub held: [Option<Held>; 2],
    /// Notifications used so far (SES emits one story per email).
    pub used: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    Queue(u8),
    Pair(u8, u8),
    Http(u8),
    Forge,
    Stray,
    Alien,
    /// The notification on another registered account's topic (queue or HTTP).
    Cross(bool),
    Accept(u8),
    Lost(u8),
    Expire,
    Pause(bool),
    Claim(u8, u8),
    Go(u8),
    Crash(u8),
    Hold(u8, u8),
    Commit(u8, bool),
}

pub fn parse(s: &str) -> Option<Act> {
    let w: Vec<&str> = s.split(' ').collect();
    let email = |x: &str| EMAILS.iter().position(|e| *e == x).map(|i| i as u8);
    let worker = WORKERS.iter().position(|x| *x == w[0]).map(|i| i as u8);
    let held = HELD.iter().position(|x| *x == w[0]).map(|i| i as u8);
    if let Some(k) = worker {
        return match *w.get(1)? {
            "go" => Some(Act::Go(k)),
            "crash" => Some(Act::Crash(k)),
            m => Some(Act::Claim(k, msg(m)?)),
        };
    }
    if let Some(k) = held {
        return match *w.get(1)? {
            "commit" => Some(Act::Commit(k, true)),
            "abort" => Some(Act::Commit(k, false)),
            m => Some(Act::Hold(k, msg(m)?)),
        };
    }
    Some(match (w[0], w.len()) {
        ("q", 2) => Act::Queue(msg(w[1])?),
        ("qq", 3) => Act::Pair(msg(w[1])?, msg(w[2])?),
        ("h", 2) => Act::Http(msg(w[1])?),
        ("forge", 2) if w[1] == "b1" => Act::Forge,
        ("stray", 2) if w[1] == "b1" => Act::Stray,
        ("alien", 2) if w[1] == "b1" => Act::Alien,
        ("qx", 2) if w[1] == "b1" => Act::Cross(false),
        ("hx", 2) if w[1] == "b1" => Act::Cross(true),
        ("accept", 2) => Act::Accept(email(w[1])?),
        ("lost", 2) => Act::Lost(email(w[1])?),
        ("expire", 1) => Act::Expire,
        ("pause", 1) => Act::Pause(true),
        ("resume", 1) => Act::Pause(false),
        _ => return None,
    })
}

/// Every action label. `core` is the smaller alphabet for exhaustive edge coverage.
pub fn alphabet(core: bool) -> Vec<String> {
    let mut out = vec![];
    let msgs: Vec<&str> = MSGS
        .iter()
        .map(|m| m.label)
        .filter(|l| !core || ["d1", "b1", "c1", "y1", "v1", "x9", "b2", "d2", "v2"].contains(l))
        .collect();
    for m in &msgs {
        out.push(format!("q {m}"));
        out.push(format!("h {m}"));
        for w in WORKERS.iter().take(if core { 1 } else { 2 }) {
            out.push(format!("{w} {m}"));
        }
        for h in HELD.iter().take(if core { 1 } else { 2 }) {
            out.push(format!("{h} {m}"));
        }
    }
    if !core {
        for (a, b) in PAIRS {
            out.push(format!("qq {a} {b}"));
        }
        out.extend(
            [
                "forge b1", "stray b1", "alien b1", "qx b1", "hx b1", "pause", "resume",
            ]
            .map(String::from),
        );
    }
    for e in EMAILS {
        out.push(format!("accept {e}"));
        out.push(format!("lost {e}"));
    }
    out.push("expire".into());
    for w in WORKERS.iter().take(if core { 1 } else { 2 }) {
        out.push(format!("{w} go"));
        out.push(format!("{w} crash"));
    }
    for h in HELD.iter().take(if core { 1 } else { 2 }) {
        out.push(format!("{h} commit"));
        out.push(format!("{h} abort"));
    }
    out
}

/// What the claim's read of the job found, and therefore where the handler goes next.
enum Read {
    Processed,
    Missing,
    Found,
}

impl Db {
    fn ready(&self, e: u8) -> bool {
        let m = &self.emails[e as usize];
        m.provider || m.status == St::Unknown
    }
    /// Recipients the handler acts on: reported ones that are on the envelope, or the single
    /// envelope recipient for engagement.
    fn recipients(m: &Msg) -> Vec<u8> {
        let env = ENVELOPE[m.email as usize];
        if m.kind.reports() {
            m.recips
                .iter()
                .copied()
                .filter(|r| env.contains(r))
                .collect()
        } else if env.len() == 1 {
            env.to_vec()
        } else {
            vec![]
        }
    }
    fn effects(m: &Msg) -> bool {
        !Self::recipients(m).is_empty() && (m.kind.suppress().is_some() || m.kind == Kind::Open)
    }
    /// Store the event if it is new; apply status, outcome bits, publication and fan-out once.
    fn record(&mut self, i: u8) -> bool {
        let m = &MSGS[i as usize];
        if !self.events.insert(i) {
            return false;
        }
        let paused = self.paused;
        let e = &mut self.emails[m.email as usize];
        e.kinds.push(m.kind);
        if let Some(st) = m.kind.status()
            && st.rank() >= e.status.rank()
        {
            e.status = st;
            e.provider = true;
        }
        if let Some(t) = m.kind.public() {
            e.bits |= m.kind.bits();
            self.deliveries[0].insert(m.label.into());
            if !paused && (t == "email.bounced" || t == "email.complained") {
                self.deliveries[1].insert(m.label.into());
            }
        }
        true
    }
    /// `seen` is which contacts the statement's snapshot holds (None: the current ones).
    fn apply_effects(&mut self, i: u8, seen: Option<&[bool]>) {
        let m = &MSGS[i as usize];
        for r in Self::recipients(m) {
            let visible = seen.is_none_or(|s| s[r as usize]);
            let c = &mut self.contacts[r as usize];
            if let Some(reason) = m.kind.suppress() {
                match c {
                    None => {
                        *c = Some(Contact {
                            suppressed: true,
                            reason: Some(reason),
                            opened: false,
                        })
                    }
                    Some(c) if !c.suppressed => {
                        c.suppressed = true;
                        c.reason = Some(reason);
                    }
                    Some(c) => {
                        let reversible =
                            matches!(c.reason, Some(Reason::HardBounce | Reason::Validation));
                        if reversible && reason != Reason::Validation {
                            c.reason = Some(reason);
                        }
                    }
                }
            } else if m.kind == Kind::Open
                && visible
                && let Some(c) = c
            {
                c.opened = true;
            }
        }
    }
    fn new_job(&mut self, i: u8) {
        self.jobs.insert(
            i,
            Job {
                st: JobSt::Pending,
                attempts: 0,
                holder: None,
                expired: false,
            },
        );
    }
    /// Feedback-queue consumer, one statement per batch.
    fn batch(&mut self, items: &[u8]) -> Vec<String> {
        self.batch_seen(items, None)
    }
    /// The statement locks the email row, then decides whether engagement may touch a contact from
    /// its snapshot (READ COMMITTED): a contact another transaction created while this statement
    /// waited on the row lock is not engaged, the outcome of the serial order open-then-creation.
    fn batch_seen(&mut self, items: &[u8], seen: Option<&[bool]>) -> Vec<String> {
        let mut out = vec![];
        let mut done: Vec<u8> = vec![];
        for &i in items {
            let m = &MSGS[i as usize];
            if m.email == 2 {
                out.push("e:SES_FEEDBACK_UNMATCHED".into());
                continue;
            }
            let dup = done.contains(&i);
            done.push(i);
            let ready = self.ready(m.email);
            if !dup {
                match self.receipts.get(&i) {
                    None if ready => {
                        self.receipts.insert(i, true);
                        self.record(i);
                        self.apply_effects(i, seen);
                    }
                    None => {
                        self.receipts.insert(i, false);
                        self.new_job(i);
                    }
                    Some(false) if ready => {
                        self.receipts.insert(i, true);
                        self.record(i);
                        self.apply_effects(i, seen);
                    }
                    _ => {}
                }
            }
            out.push(
                if ready || m.kind.routine() {
                    "ok"
                } else {
                    "e:SES_EMAIL_NOT_FOUND"
                }
                .into(),
            );
        }
        out
    }
    /// SNS route without a queue: routine feedback inline, everything else deferred to its job.
    fn http(&mut self, i: u8) -> String {
        let m = &MSGS[i as usize];
        if m.email == 2 {
            return "e:SES_EMAIL_NOT_FOUND".into();
        }
        let inline = m.kind.routine() && self.ready(m.email);
        match self.receipts.get(&i) {
            None if inline => {
                self.receipts.insert(i, true);
                self.record(i);
            }
            None => {
                self.receipts.insert(i, false);
                self.new_job(i);
            }
            Some(false) if inline => {
                self.receipts.insert(i, true);
                self.record(i);
            }
            _ => {}
        }
        "ok".into()
    }
    fn dispatch(&mut self, e: u8, lost: bool) {
        let m = &mut self.emails[e as usize];
        m.dispatched = true;
        let st = if lost { St::Unknown } else { St::Accepted };
        if st.rank() >= m.status.rank() {
            m.status = st;
            if !lost {
                m.provider = true;
            }
        }
        if lost {
            m.lost = true;
        } else {
            m.accepted = true;
            m.bits |= 1;
        }
        self.deliveries[0].insert(format!("A:{}", EMAILS[e as usize]));
    }
    fn read(&self, i: u8) -> Read {
        if self.receipts.get(&i) == Some(&true) {
            Read::Processed
        } else if self.ready(MSGS[i as usize].email) {
            Read::Found
        } else {
            Read::Missing
        }
    }
    fn settle(&mut self, i: u8, k: u8, st: JobSt) {
        if let Some(j) = self.jobs.get_mut(&i)
            && j.st == JobSt::Running
            && j.holder == Some(k)
            && !j.expired
        {
            j.st = st;
            j.holder = None;
        }
    }
    fn claimable(&self, i: u8) -> bool {
        self.jobs.get(&i).is_some_and(|j| {
            j.st == JobSt::Pending
                || (j.st == JobSt::Running && j.expired && j.attempts < MAX_ATTEMPTS)
        })
    }
}

impl Model {
    pub fn initial() -> Self {
        let email = Email {
            status: St::Attempting,
            provider: false,
            bits: 0,
            lost: false,
            accepted: false,
            dispatched: false,
            kinds: vec![],
        };
        Model {
            db: Db {
                emails: vec![email.clone(), email],
                contacts: vec![
                    None,
                    Some(Contact {
                        suppressed: false,
                        reason: None,
                        opened: false,
                    }),
                ],
                receipts: BTreeMap::new(),
                jobs: BTreeMap::new(),
                events: BTreeSet::new(),
                deliveries: [BTreeSet::new(), BTreeSet::new()],
                paused: false,
            },
            workers: [None, None],
            held: [None, None],
            used: 0,
        }
    }

    fn story_ok(&self, i: u8) -> bool {
        let m = &MSGS[i as usize];
        if m.story == 0 {
            return true;
        }
        MSGS.iter()
            .enumerate()
            .all(|(j, o)| self.used & (1 << j) == 0 || o.email != m.email || o.story == m.story)
    }
    fn open_held(&self) -> Option<usize> {
        self.held.iter().position(|h| h.is_some())
    }
    /// The email row an open batch transaction holds locked.
    fn locked(&self) -> Option<u8> {
        self.held
            .iter()
            .flatten()
            .find(|h| !h.blocked)
            .map(|h| MSGS[h.msg as usize].email)
            .filter(|e| *e < 2)
    }
    fn blocked_any(&self) -> bool {
        self.workers.iter().flatten().any(|w| w.blocked)
            || self.held.iter().flatten().any(|h| h.blocked)
    }

    pub fn enabled(&self, a: &Act) -> bool {
        let busy = self.open_held().is_some();
        match *a {
            Act::Queue(i) | Act::Http(i) => !busy && self.story_ok(i),
            // PAIRS only combines notifications of one story.
            Act::Pair(i, j) => !busy && self.story_ok(i) && self.story_ok(j),
            Act::Forge | Act::Stray | Act::Alien | Act::Cross(_) | Act::Pause(_) => !busy,
            Act::Accept(e) | Act::Lost(e) => !busy && !self.db.emails[e as usize].dispatched,
            // Leases and claims touch only committed job rows, which no batch statement locks.
            Act::Expire => self
                .db
                .jobs
                .values()
                .any(|j| j.st == JobSt::Running && !j.expired),
            Act::Claim(k, i) => self.workers[k as usize].is_none() && self.db.claimable(i),
            Act::Go(k) => match &self.workers[k as usize] {
                None => false,
                Some(w) if w.blocked => false,
                // With a batch transaction open, only the event write on its locked email may run
                // (it waits on the row); other statements would contend on shared counters.
                Some(w) if busy => {
                    w.gate == Gate::Record
                        && self.locked() == Some(MSGS[w.msg as usize].email)
                        && !self.blocked_any()
                }
                Some(_) => true,
            },
            Act::Crash(k) => self.workers[k as usize]
                .as_ref()
                .is_some_and(|w| !w.blocked),
            Act::Hold(k, i) => {
                if self.held[k as usize].is_some() || !self.story_ok(i) {
                    return false;
                }
                match self.open_held() {
                    None => !self.blocked_any(),
                    // A second consumer on the same email waits on the first one's row lock.
                    Some(_) => self.locked() == Some(MSGS[i as usize].email) && !self.blocked_any(),
                }
            }
            Act::Commit(k, _) => self.held[k as usize].as_ref().is_some_and(|h| !h.blocked),
        }
    }

    fn note(&mut self, i: u8) {
        self.used |= 1 << i;
    }

    /// Run a worker's handler from its current gate to the next one (or completion).
    fn advance(&mut self, k: u8) -> String {
        let w = self.workers[k as usize].clone().unwrap();
        let m = &MSGS[w.msg as usize];
        match w.gate {
            Gate::Record => {
                self.db.record(w.msg);
                if m.kind.routine() {
                    self.db.receipts.insert(w.msg, true);
                    self.db.settle(w.msg, k, JobSt::Completed);
                    self.workers[k as usize] = None;
                    return "done".into();
                }
                let gate = if Db::effects(m) {
                    Gate::Suppress
                } else {
                    Gate::Mark
                };
                self.workers[k as usize] = Some(Worker { gate, ..w });
                format!("at:{}", gate_name(gate))
            }
            Gate::Suppress => {
                self.db.apply_effects(w.msg, None);
                self.workers[k as usize] = Some(Worker {
                    gate: Gate::Mark,
                    ..w
                });
                "at:mark".into()
            }
            Gate::Mark => {
                self.db.receipts.insert(w.msg, true);
                self.db.settle(w.msg, k, JobSt::Completed);
                self.workers[k as usize] = None;
                "done".into()
            }
        }
    }

    /// Apply one action; returns the request result and the statements a commit unblocked.
    pub fn step(&mut self, a: Act) -> (Value, Value) {
        let mut woke = serde_json::Map::new();
        let r = match a {
            Act::Queue(i) => {
                self.note(i);
                json!(self.db.batch(&[i]))
            }
            Act::Pair(i, j) => {
                self.note(i);
                self.note(j);
                json!(self.db.batch(&[i, j]))
            }
            Act::Http(i) => {
                self.note(i);
                json!(self.db.http(i))
            }
            Act::Forge => json!("e:SNS_INVALID_SIGNATURE"),
            Act::Stray => json!("e:SNS_TOPIC_NOT_ALLOWED"),
            Act::Alien => json!("e:SES_ACCOUNT_MISMATCH"),
            // Mail is bound to the topic it was sent with: another tenant's verified topic matches nothing.
            Act::Cross(false) => json!(["e:SES_FEEDBACK_UNMATCHED"]),
            Act::Cross(true) => json!("e:SES_EMAIL_NOT_FOUND"),
            Act::Accept(e) | Act::Lost(e) => {
                self.db.dispatch(e, matches!(a, Act::Lost(_)));
                json!("ok")
            }
            Act::Expire => {
                for j in self.db.jobs.values_mut() {
                    if j.st == JobSt::Running {
                        j.expired = true;
                    }
                }
                json!("ok")
            }
            Act::Pause(p) => {
                self.db.paused = p;
                json!("ok")
            }
            Act::Claim(k, i) => {
                let j = self.db.jobs.get_mut(&i).unwrap();
                j.st = JobSt::Running;
                j.attempts += 1;
                j.holder = Some(k);
                j.expired = false;
                let attempts = j.attempts;
                match self.db.read(i) {
                    Read::Processed => {
                        self.db.settle(i, k, JobSt::Completed);
                        json!("done")
                    }
                    Read::Missing => {
                        let retry = attempts < MAX_ATTEMPTS;
                        self.db
                            .settle(i, k, if retry { JobSt::Pending } else { JobSt::Failed });
                        json!(format!(
                            "{}:SES_EMAIL_NOT_FOUND",
                            if retry { "retry" } else { "failed" }
                        ))
                    }
                    Read::Found => {
                        self.workers[k as usize] = Some(Worker {
                            msg: i,
                            gate: Gate::Record,
                            blocked: false,
                        });
                        json!("at:record")
                    }
                }
            }
            Act::Go(k) => {
                if self.open_held().is_some() {
                    self.workers[k as usize].as_mut().unwrap().blocked = true;
                    json!("blocked")
                } else {
                    json!(self.advance(k))
                }
            }
            Act::Crash(k) => {
                let w = self.workers[k as usize].take().unwrap();
                if let Some(j) = self.db.jobs.get_mut(&w.msg)
                    && j.holder == Some(k)
                {
                    j.holder = None;
                }
                json!("ok")
            }
            Act::Hold(k, i) => {
                self.note(i);
                let seen: Vec<bool> = self.db.contacts.iter().map(Option::is_some).collect();
                if self.open_held().is_some() {
                    self.held[k as usize] = Some(Held {
                        msg: i,
                        blocked: true,
                        seen,
                        result: None,
                    });
                    json!("blocked")
                } else {
                    let r = self.db.clone().batch(&[i]);
                    self.held[k as usize] = Some(Held {
                        msg: i,
                        blocked: false,
                        seen,
                        result: Some(r[0].clone()),
                    });
                    json!(r)
                }
            }
            Act::Commit(k, commit) => {
                let h = self.held[k as usize].take().unwrap();
                if commit {
                    let r = self.db.batch_seen(&[h.msg], Some(&h.seen));
                    debug_assert_eq!(Some(&r[0]), h.result.as_ref());
                }
                // Whatever waited on this transaction's row lock runs now, serialized after it
                // (except for its snapshot reads, see `batch_seen`).
                for (slot, name) in self.held.iter_mut().zip(HELD) {
                    if let Some(x) = slot
                        && x.blocked
                    {
                        let r = self.db.clone().batch_seen(&[x.msg], Some(&x.seen));
                        x.blocked = false;
                        x.result = Some(r[0].clone());
                        woke.insert(name.into(), json!(r));
                    }
                }
                for (w, name) in WORKERS.iter().enumerate() {
                    if self.workers[w].as_ref().is_some_and(|x| x.blocked)
                        && self.open_held().is_none()
                    {
                        self.workers[w].as_mut().unwrap().blocked = false;
                        let r = self.advance(w as u8);
                        woke.insert((*name).into(), json!(r));
                    }
                }
                json!("ok")
            }
        };
        (r, Value::Object(woke))
    }

    /// The committed state the host reads back, plus the stats routes' numbers.
    pub fn view(&self) -> Value {
        let db = &self.db;
        let mut emails = serde_json::Map::new();
        for (i, e) in db.emails.iter().enumerate() {
            // The dispatch's ambiguity stays recorded; a validation suppression explains itself
            // only while it is the email's status.
            let error = if e.lost {
                json!("SES_ACCEPTANCE_UNKNOWN")
            } else if e.status == St::Suppressed {
                json!("EMAIL_VALIDATION_SUPPRESSED")
            } else {
                Value::Null
            };
            let reason = if e.status == St::Suppressed {
                json!("email_validation")
            } else {
                Value::Null
            };
            emails.insert(
                EMAILS[i].into(),
                json!([e.status.name(), e.provider, e.bits, error, reason]),
            );
        }
        let mut contacts = serde_json::Map::new();
        for (r, c) in db.contacts.iter().enumerate() {
            if let Some(c) = c {
                contacts.insert(
                    RECIPS[r].into(),
                    json!([c.suppressed, c.reason.map(Reason::name), c.opened]),
                );
            }
        }
        let mut events: BTreeMap<String, Value> = BTreeMap::new();
        let mut published: BTreeMap<String, Value> = BTreeMap::new();
        for (i, e) in db.emails.iter().enumerate() {
            if e.dispatched {
                let l = format!("A:{}", EMAILS[i]);
                let (t, p) = if e.lost {
                    ("acceptance_unknown", "email.rejected")
                } else {
                    ("accepted", "email.sent")
                };
                events.insert(l.clone(), json!([l, t, EMAILS[i], 0]));
                published.insert(l.clone(), json!([l, p]));
            }
        }
        for &i in &db.events {
            let m = &MSGS[i as usize];
            let hashes = if matches!(m.kind, Kind::Bounce | Kind::Complaint) {
                Db::recipients(m).len()
            } else {
                0
            };
            events.insert(
                m.label.into(),
                json!([m.label, m.kind.event(), EMAILS[m.email as usize], hashes]),
            );
            if let Some(p) = m.kind.public() {
                published.insert(m.label.into(), json!([m.label, p]));
            }
        }
        let receipts: BTreeMap<&str, bool> = db
            .receipts
            .iter()
            .map(|(i, p)| (MSGS[*i as usize].label, *p))
            .collect();
        let jobs: Vec<Value> = db
            .jobs
            .iter()
            .map(|(i, j)| (MSGS[*i as usize].label, j))
            .collect::<BTreeMap<_, _>>()
            .into_iter()
            .map(|(l, j)| {
                let st = match j.st {
                    JobSt::Pending => "pending",
                    JobSt::Running => "running",
                    JobSt::Completed => "completed",
                    JobSt::Failed => "failed",
                };
                json!(["ses", l, st, j.attempts])
            })
            .collect();
        // Campaign stats (GET /v1/campaigns/{id}/stats): distinct emails per outcome.
        let has = |e: &Email, k: &[Kind]| e.kinds.iter().any(|x| k.contains(x));
        let count = |f: &dyn Fn(&Email) -> bool| db.emails.iter().filter(|e| f(e)).count() as i64;
        let stats = json!([
            count(&|e| e.status != St::Suppressed
                && (e.provider
                    || matches!(
                        e.status,
                        St::Accepted | St::Delivered | St::Bounced | St::Complained | St::Delayed
                    )
                    || has(
                        e,
                        &[
                            Kind::Delivery,
                            Kind::Bounce,
                            Kind::Complaint,
                            Kind::Delay,
                            Kind::Transient
                        ]
                    ))),
            count(&|e| e.status == St::Delivered || has(e, &[Kind::Delivery])),
            count(&|e| e.status == St::Bounced || has(e, &[Kind::Bounce])),
            count(&|e| e.status == St::Complained || has(e, &[Kind::Complaint])),
            count(&|e| matches!(e.status, St::Rejected | St::Rendering)
                || has(e, &[Kind::Reject, Kind::Render])),
            count(&|e| e.status == St::Delayed || has(e, &[Kind::Delay, Kind::Transient])),
        ]);
        // Sender-score inputs (GET /v1/sender-score): bounced ÷ accepted, complained ÷ delivered,
        // suppressed ÷ emails, from status and outcome bits.
        let accepted = count(&|e| {
            e.status != St::Suppressed
                && (e.provider
                    || matches!(
                        e.status,
                        St::Accepted | St::Delivered | St::Bounced | St::Complained | St::Delayed
                    )
                    || e.bits & 1 != 0)
        });
        let delivered = count(&|e| e.status == St::Delivered || e.bits & 2 != 0);
        let bounced = count(&|e| e.status == St::Bounced || e.bits & 4 != 0);
        let complained = count(&|e| e.status == St::Complained || e.bits & 8 != 0);
        let suppressed = count(&|e| e.status == St::Suppressed);
        let ratio = |n: i64, d: i64| {
            if d == 0 {
                Value::Null
            } else {
                json!(n as f64 / d as f64)
            }
        };
        let score = json!([
            ratio(bounced, accepted),
            ratio(complained, delivered),
            ratio(suppressed, 2)
        ]);
        // Hosted health: accepted recipient volume and distinct hard-bounced / complained real
        // recipients, for envelopes that were not suppressed.
        let mut hosted = [0i64; 3];
        for (i, e) in db.emails.iter().enumerate() {
            if e.status == St::Suppressed {
                continue;
            }
            if e.accepted {
                hosted[0] += COST[i];
            }
            for (slot, kind) in [(1, Kind::Bounce), (2, Kind::Complaint)] {
                let mut dest = BTreeSet::new();
                for &m in &db.events {
                    let m = &MSGS[m as usize];
                    if m.email as usize == i && m.kind == kind {
                        dest.extend(Db::recipients(m));
                    }
                }
                hosted[slot] += dest.len() as i64;
            }
        }
        json!({
            "emails": emails, "contacts": contacts,
            "events": events.into_values().collect::<Vec<_>>(),
            "published": published.into_values().collect::<Vec<_>>(),
            "deliveries": [db.deliveries[0].iter().collect::<Vec<_>>(), db.deliveries[1].iter().collect::<Vec<_>>()],
            "receipts": receipts, "jobs": jobs, "hosted": hosted, "stats": stats, "score": score,
        })
    }
}

pub fn gate_name(g: Gate) -> &'static str {
    match g {
        Gate::Record => "record",
        Gate::Suppress => "suppress",
        Gate::Mark => "mark",
    }
}
