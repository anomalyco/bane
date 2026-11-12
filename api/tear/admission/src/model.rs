//! Reference model for admission and rate limits, written from the documented contract (the
//! comments in migrations 062-110 and sending.ts / mailbox-receipts.ts) rather than from the SQL.
//! The state is committed state plus one open transaction per connection (W, V). A statement runs
//! in lock phases; when it needs a lock the other connection holds, it is `blocked` and resumes,
//! against the then-latest committed state, at that connection's commit or abort.
//!
//! Receive side (`Recv`): two hosted workspaces A < B, each with an hourly message window of `limit`
//! messages and an ingest backlog of `backlog` active jobs; one notification can address both and
//! handles them in workspace order. A notification of a new message serializes on the workspace's
//! window row, rechecks whether the receipt exists, and only then charges the window once; a
//! notification of a known message never charges. A reopen (new recipients) is coalesced into the
//! receipt's pending ingest job, or needs backlog room (read under the window row), or is held and
//! released later without a second charge. Every job producer respects the backlog. The global
//! release never waits: holds whose workspace rows are locked are left for its next pass.
//!
//! Send side (`Send`): two hosted workspaces sharing a quota sponsor, three API keys (1 and 3 on
//! workspace 1, 2 on workspace 2). Admission is one statement: key budget, idempotency claim,
//! workspace admission lock, policy rows (FOR SHARE), sponsor lock, then the decision against the
//! rolling 24-hour usage of the sponsor's workspaces, the marketing reserve and the pending cap.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Held connections; the receive profile also uses X (the send profile two).
pub const CONNS: [&str; 3] = ["W", "V", "X"];

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(tag = "profile", rename_all = "lowercase")]
pub enum Model {
    Recv(Recv),
    Send(Send),
    Upload(Upload),
}

// ---------------------------------------------------------------- receive side

/// Workspace of a recipient letter: a, c and the numbered h001...h101 are A's, b is B's.
fn ws_of(c: char) -> usize {
    if c == 'b' { 1 } else { 0 }
}
pub const WS: [&str; 2] = ["A", "B"];

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Receipt {
    pub status: String,
    /// Single-letter recipients plus `h` of the numbered ones (0, 100 or 101).
    pub letters: String,
    pub h: u8,
    pub retry: Option<i64>,
    pub error: Option<String>,
    /// Value of the created_at clock (`t`) when inserted.
    pub born: i64,
}
impl Receipt {
    fn count(&self) -> usize {
        self.letters.len() + self.h as usize
    }
    fn set(&self) -> (String, u8) {
        (self.letters.clone(), self.h)
    }
}
/// Per-workspace recipients of a recipient set, in workspace order.
fn split_rcpt(r: &str) -> [(String, u8); 2] {
    let mut out: [(String, u8); 2] = Default::default();
    match r {
        "0" => {}
        "h" => out[0].1 = 100,
        "x" => out[0].1 = 101,
        _ => {
            let mut v: Vec<char> = r.chars().collect();
            v.sort();
            v.dedup();
            for c in v {
                out[ws_of(c)].0.push(c);
            }
        }
    }
    out
}

/// Ingest jobs of one receipt: pending, and the recipients each running job claimed (oldest first).
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug, Default)]
pub struct Jobs {
    pub pending: i64,
    pub running: Vec<(String, u8)>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug, Default)]
pub struct RWs {
    pub limit: i64,
    pub backlog: i64,
    pub window: Option<(i64, i64)>,
    pub receipts: BTreeMap<String, Receipt>,
    pub jobs: BTreeMap<String, Jobs>,
}
impl RWs {
    fn active(&self) -> i64 {
        self.jobs
            .values()
            .map(|j| j.pending + j.running.len() as i64)
            .sum()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug, Default)]
pub struct RTxn {
    pub words: Vec<String>,
    pub phase: u8,
    pub cursor: usize,
    pub blocked: bool,
    pub done: bool,
    /// window:X, turns:X, receipt:X:m, job:X:m, ignored:m; all exclusive.
    pub locks: BTreeSet<String>,
    /// Uncommitted effects: receipts by X:m, windows, ingest jobs added by X:m.
    pub receipts: BTreeMap<String, Receipt>,
    pub windows: [Option<(i64, i64)>; 2],
    pub jobs: BTreeMap<String, i64>,
    pub need_job: Vec<String>,
    pub claimed: Vec<String>,
    pub queued: i64,
    pub result: Value,
}
impl RTxn {
    fn new(words: &[&str]) -> Self {
        RTxn {
            words: words.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Recv {
    /// Window clock (hours) and created_at clock (hours, also moved by `days`).
    pub h: i64,
    pub t: i64,
    pub ws: [RWs; 2],
    /// Staging objects recorded as ignored (a notification with no recipients).
    pub ignored: BTreeSet<String>,
    pub txns: BTreeMap<String, RTxn>,
}

const BACKLOG_HOLD: &str = "MAILBOX_RECEIVE_BACKLOG";
const BUDGET_HOLD: &str = "MAILBOX_RECEIVE_BUDGET";

fn key(x: usize, m: &str) -> String {
    format!("{}:{m}", WS[x])
}
fn unkey(k: &str) -> (usize, &str) {
    let (x, m) = k.split_once(':').unwrap();
    (if x == "A" { 0 } else { 1 }, m)
}

impl Recv {
    pub fn initial(limits: [(i64, i64); 2]) -> Self {
        let w = |(limit, backlog): (i64, i64)| RWs {
            limit,
            backlog,
            ..Default::default()
        };
        Recv {
            h: 0,
            t: 0,
            ws: [w(limits[0]), w(limits[1])],
            ignored: BTreeSet::new(),
            txns: BTreeMap::new(),
        }
    }
    fn held(&self, me: &str, lock: &str) -> bool {
        self.txns
            .iter()
            .any(|(k, t)| k != me && t.locks.contains(lock))
    }
    fn receipt(&self, k: &str) -> Option<&Receipt> {
        let (x, m) = unkey(k);
        self.ws[x].receipts.get(m)
    }
    fn jobs(&self, k: &str) -> Jobs {
        let (x, m) = unkey(k);
        self.ws[x].jobs.get(m).cloned().unwrap_or_default()
    }
    /// mail_receive_slot with the window row held: the policy and backlog read after every earlier
    /// admission committed, plus this transaction's own window charge and jobs.
    fn slot(&self, x: usize, t: &RTxn) -> Option<(i64, i64)> {
        let w = &self.ws[x];
        let own: i64 = t
            .jobs
            .iter()
            .filter(|(k, _)| unkey(k).0 == x)
            .map(|(_, n)| n)
            .sum();
        if w.limit <= 0 || w.active() + own >= w.backlog {
            return None;
        }
        match t.windows[x].or(w.window) {
            Some((at, n)) if at == self.h => (n < w.limit).then_some((self.h, n + 1)),
            _ => Some((self.h, 1)),
        }
    }

    /// Run `me`'s statement from its current phase until it blocks or completes.
    fn advance(&mut self, me: &str) {
        let mut t = self.txns.remove(me).unwrap();
        t.blocked = false;
        let blocked = match t.words[0].as_str() {
            "accept" | "legacy-accept" => self.advance_accept(me, &mut t),
            "release" => self.advance_release(me, &mut t),
            _ => unreachable!(),
        };
        t.blocked = blocked;
        t.done = !blocked;
        self.txns.insert(me.to_owned(), t);
    }

    /// One SNS notification: receipts per workspace in workspace order, then their ingest jobs.
    fn advance_accept(&mut self, me: &str, t: &mut RTxn) -> bool {
        let m = t.words[1].clone();
        let plan: Vec<(usize, (String, u8))> = split_rcpt(&t.words[2])
            .into_iter()
            .enumerate()
            .filter(|(_, (l, h))| !l.is_empty() || *h > 0)
            .collect();
        if plan.is_empty() {
            // No recipients: routes nothing and records the staging object as ignored.
            let lock = format!("ignored:{m}");
            if !self.ignored.contains(&m) {
                if self.held(me, &lock) {
                    return true;
                }
                t.locks.insert(lock);
            }
            t.result = json!({"queued": 0});
            return false;
        }
        while t.cursor < plan.len() {
            let (x, (letters, h)) = plan[t.cursor].clone();
            let k = key(x, &m);
            match t.phase {
                // Fast path: a known receipt is reopened, never charged.
                0 => t.phase = if self.receipt(&k).is_some() { 2 } else { 1 },
                // A new receipt: serialize on the workspace's window row, then recheck.
                1 => {
                    let lock = format!("window:{}", WS[x]);
                    if self.held(me, &lock) {
                        return true;
                    }
                    t.locks.insert(lock);
                    if self.receipt(&k).is_some() {
                        t.phase = 2;
                        continue;
                    }
                    let mut rc = Receipt {
                        status: "pending".into(),
                        letters,
                        h,
                        retry: None,
                        error: None,
                        born: self.t,
                    };
                    if rc.count() > 100 {
                        rc.status = "failed".into();
                        rc.error = Some(BUDGET_HOLD.into());
                    } else if let Some(w) = self.slot(x, t) {
                        t.windows[x] = Some(w);
                        t.need_job.push(k.clone());
                    } else {
                        rc.status = "held".into();
                        rc.error = Some(BUDGET_HOLD.into());
                        rc.retry = Some(self.h + 1);
                    }
                    t.locks.insert(format!("receipt:{k}"));
                    t.receipts.insert(k, rc);
                    t.cursor += 1;
                    t.phase = 0;
                }
                // A known receipt: merge the new recipients under its row lock.
                2 => {
                    let lock = format!("receipt:{k}");
                    if self.held(me, &lock) {
                        return true;
                    }
                    t.locks.insert(lock);
                    let cur = self.receipt(&k).unwrap().clone();
                    let mut union: Vec<char> = cur.letters.chars().chain(letters.chars()).collect();
                    union.sort();
                    union.dedup();
                    let union: String = union.into_iter().collect();
                    let uh = cur.h.max(h);
                    let covers = letters.chars().all(|c| cur.letters.contains(c)) && cur.h >= h;
                    if cur.status == "failed" || covers || union.len() + uh as usize > 200 {
                        t.cursor += 1;
                        t.phase = 0;
                        continue;
                    }
                    let mut rc = Receipt {
                        letters: union,
                        h: uh,
                        ..cur.clone()
                    };
                    if cur.status == "held" {
                        t.receipts.insert(k, rc);
                        t.cursor += 1;
                        t.phase = 0;
                        continue;
                    }
                    rc.status = "pending".into();
                    if self.jobs(&k).pending > 0 {
                        // Coalesced into the receipt's pending job, which reads the merged recipients
                        // when it is claimed (the job row is locked until commit).
                        let lock = format!("job:{k}");
                        if self.held(me, &lock) {
                            return true;
                        }
                        t.locks.insert(lock);
                        t.receipts.insert(k, rc);
                        t.cursor += 1;
                        t.phase = 0;
                        continue;
                    }
                    t.receipts.insert(k, rc);
                    t.phase = 3;
                }
                // A reopen that needs a new ingest job: the backlog, read under the window row.
                _ => {
                    let lock = format!("window:{}", WS[x]);
                    if self.held(me, &lock) {
                        return true;
                    }
                    t.locks.insert(lock);
                    let w = &self.ws[x];
                    let own: i64 = t
                        .jobs
                        .iter()
                        .filter(|(k, _)| unkey(k).0 == x)
                        .map(|(_, n)| n)
                        .sum();
                    let rc = t.receipts.get_mut(&k).unwrap();
                    if w.active() + own >= w.backlog {
                        rc.status = "held".into();
                        rc.error = Some(BACKLOG_HOLD.into());
                        rc.retry = Some(self.h + 1);
                    } else {
                        t.need_job.push(k.clone());
                    }
                    t.cursor += 1;
                    t.phase = 0;
                }
            }
        }
        // Ingest jobs, in workspace order, under each workspace's backlog counter row.
        while let Some(k) = t.need_job.first().cloned() {
            let (x, _) = unkey(&k);
            let lock = format!("turns:{}", WS[x]);
            if self.held(me, &lock) {
                return true;
            }
            t.locks.insert(lock);
            *t.jobs.entry(k).or_default() += 1;
            t.queued += 1;
            t.need_job.remove(0);
        }
        t.result = json!({"queued": t.queued});
        false
    }

    /// release_receive_budget_holds(NULL): never waits. Due holds another transaction holds are
    /// skipped (SKIP LOCKED), and so are holds whose workspace window or backlog row is locked.
    fn advance_release(&mut self, me: &str, t: &mut RTxn) -> bool {
        if t.phase == 0 {
            let mut due: Vec<(i64, usize, String)> = vec![];
            for (x, w) in self.ws.iter().enumerate() {
                for (m, r) in &w.receipts {
                    if r.status == "held"
                        && r.retry.is_some_and(|v| v <= self.h)
                        && !self.held(me, &format!("receipt:{}", key(x, m)))
                    {
                        due.push((r.retry.unwrap(), x, m.clone()));
                    }
                }
            }
            due.sort();
            t.claimed = due.into_iter().map(|(_, x, m)| key(x, &m)).collect();
            for k in t.claimed.clone() {
                t.locks.insert(format!("receipt:{k}"));
            }
            t.phase = 1;
        }
        let mut processed = 0;
        for k in t.claimed.clone() {
            let (x, _) = unkey(&k);
            let mut rc = self.receipt(&k).unwrap().clone();
            if self.t - rc.born >= 72 {
                rc.status = "failed".into();
                rc.error = Some("MAILBOX_BUDGET_HOLD_EXPIRED".into());
                rc.retry = None;
                t.receipts.insert(k, rc);
                processed += 1;
                continue;
            }
            let (window, turns) = (format!("window:{}", WS[x]), format!("turns:{}", WS[x]));
            if self.held(me, &window) || self.held(me, &turns) {
                continue;
            }
            t.locks.insert(window);
            t.locks.insert(turns);
            processed += 1;
            let w = &self.ws[x];
            let own: i64 = t
                .jobs
                .iter()
                .filter(|(j, _)| unkey(j).0 == x)
                .map(|(_, n)| n)
                .sum();
            let admit = if rc.error.as_deref() == Some(BACKLOG_HOLD) {
                // Already charged when first admitted: only the backlog decides.
                w.active() + own < w.backlog
            } else {
                match self.slot(x, t) {
                    Some(win) => {
                        t.windows[x] = Some(win);
                        true
                    }
                    None => false,
                }
            };
            if admit {
                rc.status = "pending".into();
                rc.error = None;
                rc.retry = None;
                *t.jobs.entry(k.clone()).or_default() += 1;
            } else {
                rc.retry = Some(self.h + 1);
            }
            t.receipts.insert(k, rc);
        }
        t.result = json!(processed);
        false
    }

    fn finish(&mut self, me: &str, commit: bool) -> BTreeMap<String, Value> {
        let t = self.txns.remove(me).unwrap();
        if commit {
            for (k, rc) in t.receipts {
                let (x, m) = unkey(&k);
                self.ws[x].receipts.insert(m.to_owned(), rc);
            }
            for (x, w) in t.windows.iter().enumerate() {
                if let Some(w) = w {
                    self.ws[x].window = Some(*w);
                }
            }
            for (k, n) in t.jobs {
                let (x, m) = unkey(&k);
                self.ws[x].jobs.entry(m.to_owned()).or_default().pending += n;
            }
            for l in t.locks {
                if let Some(m) = l.strip_prefix("ignored:") {
                    self.ignored.insert(m.to_owned());
                }
            }
        }
        let mut woke = BTreeMap::new();
        let waiting: Vec<String> = self
            .txns
            .iter()
            .filter(|(_, t)| t.blocked)
            .map(|(k, _)| k.clone())
            .collect();
        for w in waiting {
            self.advance(&w);
            if !self.txns[&w].blocked {
                woke.insert(w.clone(), self.txns[&w].result.clone());
            }
        }
        woke
    }

    fn probe(&self, words: &[&str]) -> bool {
        let mut p = self.clone();
        p.txns.insert("A".into(), RTxn::new(words));
        p.advance("A");
        !p.txns["A"].blocked
    }

    pub fn enabled(&self, conn: Option<&str>, words: &[&str]) -> bool {
        let any_blocked = self.txns.values().any(|t| t.blocked);
        if let Some(c) = conn {
            return match words[0] {
                "commit" | "abort" => self.txns.get(c).is_some_and(|t| t.done),
                // Never two statements blocked at once: which waiter wins is PostgreSQL's choice.
                _ => !self.txns.contains_key(c) && (!any_blocked || self.probe(words)),
            };
        }
        if any_blocked {
            return false;
        }
        let open = !self.txns.is_empty();
        match words[0] {
            // Autocommit statements never wait: run them only when no lock they need is held.
            "accept" | "legacy-accept" | "release" => self.probe(words),
            "claim" => {
                let k = key(if words[1] == "A" { 0 } else { 1 }, words[2]);
                self.jobs(&k).pending > 0
            }
            "done" => {
                let x = if words[1] == "A" { 0 } else { 1 };
                let k = key(x, words[2]);
                let pending = self.receipt(&k).is_some_and(|r| r.status == "pending");
                !self.jobs(&k).running.is_empty()
                    && !self.held("A", &format!("turns:{}", WS[x]))
                    && !(pending && self.held("A", &format!("receipt:{k}")))
            }
            "hour" | "days" => !open,
            _ => false,
        }
    }

    pub fn step(&mut self, conn: Option<&str>, words: &[&str]) -> (Value, BTreeMap<String, Value>) {
        if let Some(c) = conn {
            return match words[0] {
                "commit" | "abort" => (json!("ok"), self.finish(c, words[0] == "commit")),
                _ => {
                    self.txns.insert(c.to_owned(), RTxn::new(words));
                    self.advance(c);
                    let t = &self.txns[c];
                    (
                        if t.blocked {
                            json!("blocked")
                        } else {
                            t.result.clone()
                        },
                        BTreeMap::new(),
                    )
                }
            };
        }
        let r = match words[0] {
            "accept" | "legacy-accept" | "release" => {
                self.txns.insert("A".into(), RTxn::new(words));
                self.advance("A");
                let r = self.txns["A"].result.clone();
                self.finish("A", true);
                r
            }
            "claim" => {
                // A runner claims the pending job, skipping one a transaction holds locked.
                let x = if words[1] == "A" { 0 } else { 1 };
                let k = key(x, words[2]);
                if self.held("A", &format!("job:{k}")) {
                    json!(0)
                } else {
                    let set = self.receipt(&k).map(Receipt::set).unwrap_or_default();
                    let j = self.ws[x].jobs.get_mut(words[2]).unwrap();
                    j.pending -= 1;
                    j.running.push(set);
                    json!(1)
                }
            }
            "done" => {
                // The oldest running job settles the receipt only if it is still pending with the
                // recipients that job claimed (the store's fence), then completes.
                let x = if words[1] == "A" { 0 } else { 1 };
                let m = words[2];
                let claimed = self.ws[x].jobs.get_mut(m).unwrap().running.remove(0);
                if self.ws[x].jobs[m].pending == 0 && self.ws[x].jobs[m].running.is_empty() {
                    self.ws[x].jobs.remove(m);
                }
                match self.ws[x].receipts.get_mut(m) {
                    Some(r) if r.status == "pending" && r.set() == claimed => {
                        r.status = "processed".into();
                        json!(1)
                    }
                    _ => json!(0),
                }
            }
            "hour" => {
                self.h += 1;
                self.t += 1;
                json!("ok")
            }
            "days" => {
                self.t += 70;
                json!("ok")
            }
            _ => unreachable!(),
        };
        (r, BTreeMap::new())
    }

    pub fn view(&self) -> Value {
        let mut out = serde_json::Map::new();
        for (x, w) in self.ws.iter().enumerate() {
            let receipts: BTreeMap<&String, Value> = w
                .receipts
                .iter()
                .map(|(m, r)| (m, json!([r.status, r.count(), r.retry, r.error])))
                .collect();
            let jobs: BTreeMap<&String, Value> = w
                .jobs
                .iter()
                .filter(|(_, j)| j.pending + j.running.len() as i64 > 0)
                .map(|(m, j)| (m, json!([j.pending, j.running.len()])))
                .collect();
            out.insert(
                WS[x].into(),
                json!({
                    "window": match w.window { Some((at, n)) if at == self.h => n, _ => 0 },
                    "receipts": receipts, "active": w.active(), "jobs": jobs,
                }),
            );
        }
        Value::Object(out)
    }
}

// ---------------------------------------------------------------- send side

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug, Default)]
pub struct Ws {
    pub send_cap: Option<i64>,
    pub pend_cap: Option<i64>,
    pub exempt: bool,
    pub paused: bool,
    /// Weeks since the shared connection was created; clean accepted recipients a day ago in the
    /// current health epoch (a resume starts a new epoch).
    pub weeks: i64,
    pub history: i64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Email {
    pub ws: usize,
    pub n: i64,
    pub status: String,
    pub marketing: bool,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Idem {
    pub body: String,
    pub result: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug, Default)]
pub struct STxn {
    pub words: Vec<String>,
    pub phase: u8,
    pub blocked: bool,
    pub done: bool,
    pub locks: BTreeSet<String>,
    /// Uncommitted effects.
    pub budget: Option<(usize, i64)>,
    pub idem: Option<(String, Option<Idem>)>,
    pub emails: BTreeMap<String, Email>,
    pub ws: Option<(usize, Ws)>,
    pub result: Value,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Send {
    pub caps: [i64; 3],
    pub headroom: i64,
    pub rate: i64,
    pub h: i64,
    pub ws: [Ws; 2],
    pub emails: BTreeMap<String, Email>,
    /// Usage buckets as stored: per workspace, (admission hour, recipients).
    pub usage: [Vec<(i64, i64)>; 2],
    pub email_hour: BTreeMap<String, i64>,
    pub next: usize,
    /// Requests charged to keys 1, 2, 3 in the current minute.
    pub budgets: [i64; 3],
    pub idem: BTreeMap<String, Idem>,
    pub txns: BTreeMap<String, STxn>,
}

pub const KEY_WS: [usize; 3] = [0, 1, 0];

impl Send {
    pub fn initial(caps: [i64; 3], headroom: i64, rate: i64) -> Self {
        Send {
            caps,
            headroom,
            rate,
            h: 0,
            ws: Default::default(),
            emails: BTreeMap::new(),
            usage: Default::default(),
            email_hour: BTreeMap::new(),
            next: 1,
            budgets: [0; 3],
            idem: BTreeMap::new(),
            txns: BTreeMap::new(),
        }
    }
    fn held_by_other(&self, me: &str, lock: &str) -> bool {
        let conflict = |held: &str| match lock.split_once(':') {
            // Share locks on the policy rows conflict only with exclusive ones on the same row.
            Some(("pcS", x)) => held == format!("pcX:{x}"),
            Some(("wS", x)) => held == format!("wX:{x}"),
            Some(("pcX", x)) => held == format!("pcS:{x}") || held == format!("pcX:{x}"),
            Some(("wX", x)) => held == format!("wS:{x}") || held == format!("wX:{x}"),
            _ => held == lock,
        };
        self.txns
            .iter()
            .any(|(k, t)| k != me && t.locks.iter().any(|l| conflict(l)))
    }
    /// The workspace the hosted policy sees, with `me`'s own uncommitted operator change.
    fn tier_cap(&self, w: &Ws) -> i64 {
        let tier = if w.history >= 100 {
            if w.history >= 1000 && w.weeks >= 2 {
                3
            } else if w.weeks >= 1 {
                2
            } else {
                1
            }
        } else {
            1
        };
        self.caps[tier - 1]
    }
    fn cap(&self, w: &Ws) -> Option<i64> {
        w.send_cap.or(if w.exempt {
            None
        } else {
            Some(self.tier_cap(w))
        })
    }
    fn sponsored(w: &Ws) -> bool {
        w.send_cap.is_none() && !w.exempt
    }
    fn live(&self, x: usize) -> i64 {
        self.usage[x]
            .iter()
            .filter(|(h, _)| *h > self.h - 24 && *h <= self.h)
            .map(|(_, n)| n)
            .sum()
    }
    fn used(&self, x: usize) -> i64 {
        let mut used = self.live(x);
        if Self::sponsored(&self.ws[x]) {
            let y = 1 - x;
            if Self::sponsored(&self.ws[y]) {
                used += self.live(y);
            }
        }
        used
    }
    fn queued(&self, x: usize, marketing: Option<bool>) -> i64 {
        self.emails
            .values()
            .filter(|e| {
                e.ws == x && e.status == "queued" && marketing.is_none_or(|m| e.marketing == m)
            })
            .count() as i64
    }
    fn charge(&mut self, x: usize, hour: i64, n: i64) {
        match self.usage[x].iter_mut().find(|(h, _)| *h == hour) {
            Some(row) => row.1 += n,
            None => {
                self.usage[x].push((hour, n));
                self.usage[x].sort();
            }
        }
    }
    fn label(&mut self) -> String {
        let l = format!("e{}", self.next);
        self.next += 1;
        l
    }

    /// (recipient cost, marketing cost, emails, marketing emails) of an admission request.
    fn request(words: &[String]) -> Vec<(i64, bool)> {
        match words[0].as_str() {
            "send" => vec![(words[2].parse().unwrap(), words[3] == "m")],
            "batch" => vec![(1, false), (1, false)],
            _ => vec![(1, false)],
        }
    }

    fn advance(&mut self, me: &str) {
        let mut t = self.txns.remove(me).unwrap();
        t.blocked = false;
        let need = |s: &Self, t: &mut STxn, lock: String| -> bool {
            if s.held_by_other(me, &lock) {
                return false;
            }
            t.locks.insert(lock);
            true
        };
        let verb = t.words[0].clone();
        let blocked = 'run: {
            match verb.as_str() {
                "send" | "batch" | "idem" | "idem-other" => {
                    let k: usize = t.words[1].parse::<usize>().unwrap() - 1;
                    let x = KEY_WS[k];
                    let xs = (x + 1).to_string();
                    if t.phase == 0 {
                        if !need(self, &mut t, format!("budget:{}", k + 1)) {
                            break 'run true;
                        }
                        let used = (self.budgets[k] + 1).min(self.rate + 1);
                        t.budget = Some((k, used));
                        if used > self.rate {
                            t.result =
                                json!({"error": "429:REQUEST_RATE_LIMITED", "statements": 1});
                            break 'run false;
                        }
                        t.phase = 1;
                    }
                    if t.phase == 1 {
                        if verb.starts_with("idem") {
                            let key = format!("{}:{}", k + 1, t.words[2]);
                            let body = if verb == "idem" { "same" } else { "other" };
                            if let Some(prev) = self.idem.get(&key) {
                                t.result = if prev.body == body {
                                    json!({"ok": prev.result, "statements": 1})
                                } else {
                                    json!({"error": "409:IDEMPOTENCY_CONFLICT", "statements": 1})
                                };
                                break 'run false;
                            }
                            if !need(self, &mut t, format!("idem:{key}")) {
                                break 'run true;
                            }
                            t.idem = Some((
                                key,
                                Some(Idem {
                                    body: body.into(),
                                    result: vec![],
                                }),
                            ));
                        }
                        t.phase = 2;
                    }
                    if t.phase == 2 {
                        if !need(self, &mut t, format!("sched:{xs}")) {
                            break 'run true;
                        }
                        t.phase = 3;
                    }
                    if t.phase == 3 {
                        if self.held_by_other(me, &format!("pcS:{xs}"))
                            || self.held_by_other(me, &format!("wS:{xs}"))
                        {
                            break 'run true;
                        }
                        t.locks.insert(format!("pcS:{xs}"));
                        t.locks.insert(format!("wS:{xs}"));
                        t.phase = 4;
                    }
                    if t.phase == 4 {
                        if Self::sponsored(&self.ws[x]) && !need(self, &mut t, "sponsor".into()) {
                            break 'run true;
                        }
                        t.phase = 5;
                    }
                    // The decision, against the latest committed state.
                    let mails = Self::request(&t.words);
                    let cost: i64 = mails.iter().map(|m| m.0).sum();
                    let marketing: i64 = mails.iter().filter(|m| m.1).map(|m| m.0).sum();
                    let rows = mails.len() as i64;
                    let mrows = mails.iter().filter(|m| m.1).count() as i64;
                    let w = &self.ws[x];
                    let used = self.used(x);
                    let error = if w.paused {
                        Some("409:HOSTED_SENDING_PAUSED")
                    } else if self.cap(w).is_some_and(|cap| {
                        let mcap = cap - (cap * self.headroom + 99) / 100;
                        used + cost > cap || (marketing > 0 && used + marketing > mcap)
                    }) {
                        Some("429:SEND_LIMIT_REACHED")
                    } else {
                        let pcap = w
                            .pend_cap
                            .unwrap_or(if w.exempt { 200_000 } else { 10_000 });
                        let (n, m) = (self.queued(x, None), self.queued(x, Some(true)));
                        let projected = (if rows > mrows {
                            n - m + rows - mrows
                        } else {
                            i64::MIN
                        })
                        .max(if mrows > 0 { m + mrows } else { i64::MIN });
                        (projected > pcap).then_some("429:PENDING_EMAIL_LIMIT_EXCEEDED")
                    };
                    if let Some(e) = error {
                        // A denial releases its idempotency claim, not the request charge.
                        if let Some((_, row)) = &mut t.idem {
                            *row = None;
                        }
                        t.result = json!({"error": e, "statements": 1});
                        break 'run false;
                    }
                    let mut labels = vec![];
                    for (n, mk) in mails {
                        let l = self.label();
                        t.emails.insert(
                            l.clone(),
                            Email {
                                ws: x,
                                n,
                                status: "queued".into(),
                                marketing: mk,
                            },
                        );
                        labels.push(l);
                    }
                    t.locks.insert(format!("mail:{xs}"));
                    if let Some((_, Some(row))) = &mut t.idem {
                        row.result = labels.clone();
                    }
                    t.result = json!({"ok": labels, "statements": 1});
                    false
                }
                // Operators: set-hosted-limits and set-workspace-exemption lock the connection
                // FOR SHARE and the workspace FOR UPDATE; pause and resume update the connection.
                op => {
                    let xs = t.words[1].clone();
                    let x: usize = xs.parse::<usize>().unwrap() - 1;
                    let mut w = self.ws[x].clone();
                    match op {
                        "limits" | "exempt" => {
                            if self.held_by_other(me, &format!("pcS:{xs}"))
                                || self.held_by_other(me, &format!("wX:{xs}"))
                            {
                                break 'run true;
                            }
                            t.locks.insert(format!("pcS:{xs}"));
                            t.locks.insert(format!("wX:{xs}"));
                            if op == "limits" {
                                let v = |s: &str| s.parse().ok();
                                w.send_cap = v(&t.words[2]);
                                w.pend_cap = v(&t.words[3]);
                            } else {
                                w.exempt = t.words[2] == "on";
                            }
                            t.ws = Some((x, w));
                            t.result = json!("ok");
                        }
                        _ => {
                            // An UPDATE that waited locks the row's newest version before its
                            // recheck, and keeps that lock even when the recheck finds it done.
                            if t.phase == 1 {
                                t.locks.insert(format!("pcX:{xs}"));
                            }
                            let applies = (op == "pause") != w.paused;
                            if !applies {
                                t.result = json!("noop");
                                break 'run false;
                            }
                            if !need(self, &mut t, format!("pcX:{xs}")) {
                                t.phase = 1;
                                break 'run true;
                            }
                            w.paused = op == "pause";
                            if op == "resume" {
                                w.history = 0;
                            }
                            t.ws = Some((x, w));
                            t.result = json!("ok");
                        }
                    }
                    false
                }
            }
        };
        t.blocked = blocked;
        t.done = !blocked;
        self.txns.insert(me.to_owned(), t);
    }

    fn finish(&mut self, me: &str, commit: bool) -> BTreeMap<String, Value> {
        let t = self.txns.remove(me).unwrap();
        if commit {
            if let Some((k, v)) = t.budget {
                self.budgets[k] = v;
            }
            match t.idem {
                Some((key, Some(row))) => {
                    self.idem.insert(key, row);
                }
                Some((key, None)) => {
                    self.idem.remove(&key);
                }
                None => {}
            }
            for (l, e) in t.emails {
                self.charge(e.ws, self.h, e.n);
                self.email_hour.insert(l.clone(), self.h);
                self.emails.insert(l, e);
            }
            if let Some((x, w)) = t.ws {
                self.ws[x] = w;
            }
        }
        let mut woke = BTreeMap::new();
        let waiting: Vec<String> = self
            .txns
            .iter()
            .filter(|(_, t)| t.blocked)
            .map(|(k, _)| k.clone())
            .collect();
        for w in waiting {
            self.advance(&w);
            if !self.txns[&w].blocked {
                woke.insert(w.clone(), self.txns[&w].result.clone());
            }
        }
        woke
    }

    fn probe(&self, words: &[&str]) -> bool {
        let mut p = self.clone();
        p.txns.insert(
            "A".into(),
            STxn {
                words: words.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            },
        );
        p.advance("A");
        !p.txns["A"].blocked
    }

    pub fn enabled(&self, conn: Option<&str>, words: &[&str]) -> bool {
        let any_blocked = self.txns.values().any(|t| t.blocked);
        if let Some(c) = conn {
            return match words[0] {
                "commit" | "abort" => self.txns.get(c).is_some_and(|t| t.done),
                _ => !self.txns.contains_key(c) && (!any_blocked || self.probe(words)),
            };
        }
        if any_blocked {
            return false;
        }
        let open = !self.txns.is_empty();
        match words[0] {
            "send" | "batch" | "idem" | "idem-other" | "limits" | "exempt" | "pause" | "resume" => {
                self.probe(words)
            }
            "me" => !self.held_by_other("A", &format!("budget:{}", words[1])),
            "outcome" => self
                .emails
                .get(words[1])
                .is_some_and(|e| !self.held_by_other("A", &format!("mail:{}", e.ws + 1))),
            "history" => true,
            "hour" | "h23" | "minute" | "week" => !open,
            _ => false,
        }
    }

    pub fn step(&mut self, conn: Option<&str>, words: &[&str]) -> (Value, BTreeMap<String, Value>) {
        let start = |s: &mut Self, c: &str| {
            s.txns.insert(
                c.to_owned(),
                STxn {
                    words: words.iter().map(|s| s.to_string()).collect(),
                    ..Default::default()
                },
            );
            s.advance(c);
        };
        if let Some(c) = conn {
            return match words[0] {
                "commit" | "abort" => (json!("ok"), self.finish(c, words[0] == "commit")),
                _ => {
                    start(self, c);
                    let t = &self.txns[c];
                    (
                        if t.blocked {
                            json!("blocked")
                        } else {
                            t.result.clone()
                        },
                        BTreeMap::new(),
                    )
                }
            };
        }
        let r = match words[0] {
            "send" | "batch" | "idem" | "idem-other" | "limits" | "exempt" | "pause" | "resume" => {
                start(self, "A");
                let r = self.txns["A"].result.clone();
                self.finish("A", true);
                r
            }
            "me" => {
                let k: usize = words[1].parse::<usize>().unwrap() - 1;
                let used = (self.budgets[k] + 1).min(self.rate + 1);
                self.budgets[k] = used;
                if used > self.rate {
                    json!("e:429:REQUEST_RATE_LIMITED")
                } else {
                    let x = KEY_WS[k];
                    json!({"cap": self.cap(&self.ws[x]), "used": self.used(x)})
                }
            }
            "outcome" => {
                let l = words[1];
                let e = self.emails.get_mut(l).unwrap();
                if e.status != "queued" {
                    json!(0)
                } else {
                    e.status = words[2].into();
                    // Sent mail stays charged; suppressed, canceled and pre-SES rejections refund
                    // the admission hour, while it is still inside the 24-hour window.
                    let (x, n) = (e.ws, e.n);
                    let hour = self.email_hour[l];
                    if words[2] != "sent" && hour > self.h - 24 {
                        self.charge(x, hour, -n);
                    }
                    json!(1)
                }
            }
            "history" => {
                let x: usize = words[1].parse::<usize>().unwrap() - 1;
                self.ws[x].history += words[2].parse::<i64>().unwrap();
                json!("ok")
            }
            "hour" | "h23" => {
                self.h += if words[0] == "hour" { 1 } else { 23 };
                self.budgets = [0; 3];
                json!("ok")
            }
            "minute" => {
                self.budgets = [0; 3];
                json!("ok")
            }
            "week" => {
                for w in &mut self.ws {
                    w.weeks += 1;
                }
                json!("ok")
            }
            _ => unreachable!(),
        };
        (r, BTreeMap::new())
    }

    pub fn view(&self) -> Value {
        let mut usage = serde_json::Map::new();
        for (x, u) in self.usage.iter().enumerate() {
            let rows: serde_json::Map<String, Value> = u
                .iter()
                .filter(|(_, n)| *n != 0)
                .map(|(h, n)| (h.to_string(), json!(n)))
                .collect();
            if !rows.is_empty() {
                usage.insert((x + 1).to_string(), Value::Object(rows));
            }
        }
        let mails: BTreeMap<&String, Value> = self
            .emails
            .iter()
            .map(|(l, e)| (l, json!([e.status, e.n, (e.ws + 1).to_string()])))
            .collect();
        let mut budgets = serde_json::Map::new();
        for (k, n) in self.budgets.iter().enumerate() {
            if *n > 0 {
                budgets.insert((k + 1).to_string(), json!(n));
            }
        }
        let mut depth = serde_json::Map::new();
        for x in 0..2 {
            let n = self.queued(x, None);
            if n > 0 {
                depth.insert((x + 1).to_string(), json!(n));
            }
        }
        json!({"usage": usage, "mails": mails, "budgets": budgets, "depth": depth, "idem": self.idem.len()})
    }
}

// ---------------------------------------------------------------- upload reservations

/// One upload suspended at its storage put: the object it will write and its request.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct USlot {
    pub obj: String,
    pub key: Option<String>,
    pub other: bool,
}

/// Stored-attachment quota: `room` more uploads fit. Usage counts live reservations and stored
/// attachments; a reservation is taken before the put, exchanged for the attachment after it, and
/// refunded (with a deletion of its object) when the upload does not finish. The sweeper deletes
/// expired reservations and queues their objects' deletion. Every reservation that ends without
/// its attachment leaves a durable tombstone; a day later the sweeper queues the object's deletion
/// again unless an attachment holds it. That covers a late put left behind by a Worker that died
/// before its refund, or by an older Worker whose refund queued nothing.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Upload {
    pub room: i64,
    pub used: i64,
    pub slots: BTreeMap<String, USlot>,
    /// Live reservations: object -> expired.
    pub reservations: BTreeMap<String, bool>,
    pub attachments: BTreeMap<String, String>,
    /// Idempotency-Key -> (attachment label, other body).
    pub idem: BTreeMap<String, (String, bool)>,
    pub objects: BTreeSet<String>,
    pub deletes: BTreeSet<String>,
    /// Cleanup obligations: object -> due (a day after its reservation ended).
    pub tombstones: BTreeMap<String, bool>,
    pub next_obj: usize,
    pub next_label: usize,
}

impl Upload {
    pub fn initial(room: i64) -> Self {
        Upload {
            room,
            used: 0,
            slots: BTreeMap::new(),
            reservations: BTreeMap::new(),
            attachments: BTreeMap::new(),
            idem: BTreeMap::new(),
            objects: BTreeSet::new(),
            deletes: BTreeSet::new(),
            tombstones: BTreeMap::new(),
            next_obj: 1,
            next_label: 1,
        }
    }
    /// Delete the reservation, if any: usage drops and a tombstone records the cleanup obligation.
    fn take(&mut self, obj: &str) {
        if self.reservations.remove(obj).is_some() {
            self.used -= 1;
            self.tombstones.insert(obj.to_owned(), false);
        }
    }
    /// The finally block of an upload that did not publish its object: take the reservation if it
    /// is still there, and queue the object's deletion either way (the sweeper's deletion of an
    /// expired reservation may have run before this upload's put landed).
    fn refund(&mut self, obj: &str) {
        self.take(obj);
        self.deletes.insert(obj.to_owned());
    }
    pub fn enabled(&self, slot: Option<&str>, words: &[&str]) -> bool {
        match (slot, words[0]) {
            (Some(s), "upload" | "upload-other") => !self.slots.contains_key(s),
            (Some(s), "ok" | "fail" | "crash") => self.slots.contains_key(s),
            (None, "expire" | "sweep" | "purge" | "day") => true,
            (None, "delete") => self.attachments.contains_key(words[1]),
            _ => false,
        }
    }
    pub fn step(&mut self, slot: Option<&str>, words: &[&str]) -> Value {
        match (slot, words[0]) {
            (Some(s), "upload" | "upload-other") => {
                let key = words.get(1).map(|k| k.to_string());
                let other = words[0] == "upload-other";
                if let Some(k) = &key {
                    if let Some((label, o)) = self.idem.get(k) {
                        return if *o == other {
                            json!(label)
                        } else {
                            json!("409:IDEMPOTENCY_CONFLICT")
                        };
                    }
                }
                if self.used + 1 > self.room {
                    return json!("413:STORED_ATTACHMENT_LIMIT_EXCEEDED");
                }
                let obj = format!("o{}", self.next_obj);
                self.next_obj += 1;
                self.used += 1;
                self.reservations.insert(obj.clone(), false);
                self.slots.insert(s.to_owned(), USlot { obj, key, other });
                json!("at-put")
            }
            (Some(s), "ok") => {
                let u = self.slots.remove(s).unwrap();
                self.objects.insert(u.obj.clone());
                if let Some((label, o)) = u.key.as_ref().and_then(|k| self.idem.get(k)).cloned() {
                    // Another attempt with this key finished first: replay it (or conflict).
                    self.refund(&u.obj);
                    return if o == u.other {
                        json!(label)
                    } else {
                        json!("409:IDEMPOTENCY_CONFLICT")
                    };
                }
                if !self.reservations.contains_key(&u.obj) {
                    self.refund(&u.obj);
                    return json!("503:UPLOAD_EXPIRED");
                }
                // Publishing takes the reservation and stores the attachment in one transaction,
                // so its tombstone never commits.
                self.reservations.remove(&u.obj);
                let label = format!("a{}", self.next_label);
                self.next_label += 1;
                self.attachments.insert(label.clone(), u.obj.clone());
                if let Some(k) = u.key {
                    self.idem.insert(k, (label.clone(), u.other));
                }
                json!(label)
            }
            (Some(s), "fail") => {
                let u = self.slots.remove(s).unwrap();
                self.refund(&u.obj);
                json!("500:INTERNAL_ERROR")
            }
            (Some(s), "crash") => {
                // The put lands and the Worker dies before finish or its refund.
                let u = self.slots.remove(s).unwrap();
                self.objects.insert(u.obj);
                json!("crashed")
            }
            (None, "expire") => {
                for e in self.reservations.values_mut() {
                    *e = true;
                }
                json!("ok")
            }
            (None, "day") => {
                for e in self.reservations.values_mut() {
                    *e = true;
                }
                for d in self.tombstones.values_mut() {
                    *d = true;
                }
                json!("ok")
            }
            (None, "sweep") => {
                // Due tombstones first, then expired reservations (which leave new tombstones).
                let due: Vec<String> = self
                    .tombstones
                    .iter()
                    .filter(|(_, d)| **d)
                    .map(|(o, _)| o.clone())
                    .collect();
                for o in due {
                    self.tombstones.remove(&o);
                    if !self.attachments.values().any(|a| *a == o) {
                        self.deletes.insert(o);
                    }
                }
                let expired: Vec<String> = self
                    .reservations
                    .iter()
                    .filter(|(_, e)| **e)
                    .map(|(o, _)| o.clone())
                    .collect();
                for o in expired {
                    self.take(&o);
                    self.deletes.insert(o);
                }
                json!("ok")
            }
            (None, "purge") => {
                for o in std::mem::take(&mut self.deletes) {
                    self.objects.remove(&o);
                }
                json!("ok")
            }
            (None, "delete") => {
                let obj = self.attachments.remove(words[1]).unwrap();
                self.used -= 1;
                self.deletes.insert(obj);
                json!("ok")
            }
            _ => unreachable!(),
        }
    }
    pub fn view(&self) -> Value {
        json!({"used": self.used, "reservations": self.reservations.len(), "attachments": self.attachments.keys().collect::<Vec<_>>(),
            "deletes": self.deletes.len(), "tombstones": self.tombstones.len(), "objects": self.objects.len()})
    }
}

// ---------------------------------------------------------------- shared

pub const SLOTS: [&str; 3] = ["U1", "U2", "U3"];

pub fn split(label: &str) -> (Option<&str>, Vec<&str>) {
    let words: Vec<&str> = label.split(' ').collect();
    if CONNS.contains(&words[0]) || SLOTS.contains(&words[0]) {
        (Some(words[0]), words[1..].to_vec())
    } else {
        (None, words)
    }
}

impl Model {
    pub fn enabled(&self, label: &str) -> bool {
        let (c, w) = split(label);
        if w.is_empty() {
            return false;
        }
        match self {
            Model::Recv(r) => r.enabled(c, &w),
            Model::Send(s) => s.enabled(c, &w),
            Model::Upload(u) => u.enabled(c, &w),
        }
    }
    pub fn step(&mut self, label: &str) -> (Value, BTreeMap<String, Value>) {
        let (c, w) = split(label);
        match self {
            Model::Recv(r) => r.step(c, &w),
            Model::Send(s) => s.step(c, &w),
            Model::Upload(u) => (u.step(c, &w), BTreeMap::new()),
        }
    }
    pub fn view(&self) -> Value {
        match self {
            Model::Recv(r) => r.view(),
            Model::Send(s) => s.view(),
            Model::Upload(u) => u.view(),
        }
    }
}

/// Action labels. `core` is the smaller alphabet for exhaustive edge coverage.
pub fn alphabet(profile: &str, core: bool) -> Vec<String> {
    let mut out = vec![];
    let conns: &[&str] = if profile == "recv" {
        &CONNS
    } else {
        &CONNS[..2]
    };
    let held = |out: &mut Vec<String>, stmts: &[String]| {
        for s in stmts {
            out.push(s.clone());
            for c in conns {
                out.push(format!("{c} {s}"));
            }
        }
    };
    if profile == "upload" {
        let slots: &[&str] = if core { &["U1", "U2"] } else { &SLOTS };
        for s in slots {
            out.push(format!("{s} upload"));
            out.push(format!("{s} upload k1"));
            if !core {
                out.push(format!("{s} upload-other k1"));
            }
            out.push(format!("{s} ok"));
            out.push(format!("{s} fail"));
            out.push(format!("{s} crash"));
        }
        out.extend(["expire", "sweep", "purge", "day"].map(String::from));
        for a in 1..=if core { 2 } else { 4 } {
            out.push(format!("delete a{a}"));
        }
        return out;
    }
    if profile == "recv" {
        let msgs: &[&str] = if core {
            &["m1", "m2"]
        } else {
            &["m1", "m2", "m3"]
        };
        let sets: &[&str] = if core {
            &["a", "ab", "b"]
        } else {
            &["a", "ab", "b", "ac", "h", "x", "0"]
        };
        let mut stmts = vec![];
        for m in msgs {
            for r in sets {
                stmts.push(format!("accept {m} {r}"));
            }
            // The previous Worker's route SQL: one workspace per message (its row order is unspecified).
            for r in if core {
                &["ac"][..]
            } else {
                &["a", "ac", "h", "x"][..]
            } {
                stmts.push(format!("legacy-accept {m} {r}"));
            }
        }
        stmts.push("release".into());
        held(&mut out, &stmts);
        for m in msgs {
            for x in WS {
                out.push(format!("claim {x} {m}"));
                out.push(format!("done {x} {m}"));
            }
        }
        out.push("hour".into());
        out.push("days".into());
    } else {
        let mut stmts = vec![];
        let keys: &[&str] = if core {
            &["1", "3", "2"]
        } else {
            &["1", "2", "3"]
        };
        for k in keys {
            for n in if core {
                &["1", "2"][..]
            } else {
                &["1", "2", "3"][..]
            } {
                stmts.push(format!("send {k} {n} t"));
            }
            stmts.push(format!("send {k} 1 m"));
            if !core {
                stmts.push(format!("batch {k}"));
                stmts.push(format!("idem {k} k1"));
                stmts.push(format!("idem-other {k} k1"));
            }
        }
        if core {
            stmts.push("idem 1 k1".into());
            stmts.push("idem-other 1 k1".into());
        }
        for x in ["1", "2"] {
            stmts.push(format!("limits {x} 2 default"));
            stmts.push(format!("limits {x} default 1"));
            stmts.push(format!("limits {x} default default"));
            stmts.push(format!("exempt {x} on"));
            stmts.push(format!("exempt {x} off"));
            stmts.push(format!("pause {x}"));
            stmts.push(format!("resume {x}"));
        }
        if core {
            stmts.retain(|s| {
                !s.starts_with("limits 2")
                    && !s.starts_with("exempt 2")
                    && !s.starts_with("pause 2")
                    && !s.starts_with("resume 2")
                    && s != "limits 1 default default"
            });
        }
        held(&mut out, &stmts);
        for e in 1..=if core { 3 } else { 6 } {
            for s in ["sent", "suppressed", "rejected", "canceled"] {
                if !core || s != "rejected" {
                    out.push(format!("outcome e{e} {s}"));
                }
            }
        }
        out.extend(
            [
                "me 1",
                "me 2",
                "hour",
                "h23",
                "minute",
                "week",
                "history 1 100",
                "history 1 900",
                "history 2 100",
            ]
            .map(String::from),
        );
    }
    for c in conns {
        out.push(format!("{c} commit"));
        out.push(format!("{c} abort"));
    }
    out
}
