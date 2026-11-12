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

/// When a hold is due again: the top of an hour (`kind` 0), the moment it was held (1, due at once),
/// or ten seconds after a pass skipped it (2, due only once time has passed). `stamp` orders
/// moments within an hour; holds stamped by one statement share it.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Retry {
    pub hour: i64,
    pub kind: u8,
    pub stamp: i64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Receipt {
    pub status: String,
    /// Single-letter recipients plus `h` of the numbered ones (0, 100 or 101).
    pub letters: String,
    pub h: u8,
    pub retry: Option<Retry>,
    pub error: Option<String>,
    /// Value of the created_at clock (`t`) when inserted.
    pub born: i64,
    /// Lost-receipt recovery passes so far.
    pub attempts: i64,
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
    /// window:X, turns:X, receipt:X:m, job:X:m, ignored:m, stash:m; all exclusive.
    pub locks: BTreeSet<String>,
    /// The (workspace, message, recipient set) rows of the statement, in order.
    pub plan: Vec<(usize, String, String)>,
    /// Uncommitted effects: receipts by X:m, windows, ingest jobs added by X:m, envelopes released.
    pub receipts: BTreeMap<String, Receipt>,
    pub windows: [Option<(i64, i64)>; 2],
    pub jobs: BTreeMap<String, i64>,
    pub need_job: Vec<String>,
    pub released: Vec<String>,
    pub claimed: Vec<String>,
    pub queued: i64,
    /// now() of the statement: when it started, also if it waited.
    pub stamp: i64,
    pub result: Value,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Recv {
    /// Window clock (hours) and created_at clock (hours, also moved by `days`).
    pub h: i64,
    pub t: i64,
    /// Orders moments within an hour (statement timestamps).
    pub stamp: i64,
    pub ws: [RWs; 2],
    /// Staging objects recorded as ignored (a notification with no recipients).
    pub ignored: BTreeSet<String>,
    /// Held envelopes for an unrouted host, awaiting replay: message -> recipient set.
    pub stash: BTreeMap<String, String>,
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
            stamp: 1,
            ws: [w(limits[0]), w(limits[1])],
            ignored: BTreeSet::new(),
            stash: BTreeMap::new(),
            txns: BTreeMap::new(),
        }
    }
    fn txn(&self, words: &[&str]) -> RTxn {
        RTxn {
            words: words.iter().map(|s| s.to_string()).collect(),
            stamp: self.stamp,
            ..Default::default()
        }
    }
    fn held(&self, me: &str, lock: &str) -> bool {
        self.txns
            .iter()
            .any(|(k, t)| k != me && t.locks.contains(lock))
    }
    /// The receipt as this transaction sees it: its own change, else the committed row.
    fn receipt(&self, t: &RTxn, k: &str) -> Option<Receipt> {
        let (x, m) = unkey(k);
        t.receipts
            .get(k)
            .cloned()
            .or_else(|| self.ws[x].receipts.get(m).cloned())
    }
    fn jobs(&self, k: &str) -> Jobs {
        let (x, m) = unkey(k);
        self.ws[x].jobs.get(m).cloned().unwrap_or_default()
    }
    fn active(&self, x: usize, t: &RTxn) -> i64 {
        self.ws[x].active()
            + t.jobs
                .iter()
                .filter(|(k, _)| unkey(k).0 == x)
                .map(|(_, n)| n)
                .sum::<i64>()
    }
    fn due(&self, r: &Retry) -> bool {
        r.hour < self.h || (r.hour == self.h && r.kind <= 1)
    }
    /// mail_receive_slot: the hourly message window only (the backlog decides at the job insert).
    fn slot(&self, x: usize, t: &RTxn) -> Option<(i64, i64)> {
        let w = &self.ws[x];
        if w.limit <= 0 {
            return None;
        }
        match t.windows[x].or(w.window) {
            Some((at, n)) if at == self.h => (n < w.limit).then_some((self.h, n + 1)),
            _ => Some((self.h, 1)),
        }
    }
    fn hold(&self, t: &mut RTxn, k: &str, stamp: i64) {
        let mut rc = self.receipt(t, k).unwrap();
        rc.status = "held".into();
        rc.error = Some(BACKLOG_HOLD.into());
        rc.retry = Some(Retry {
            hour: self.h,
            kind: 1,
            stamp,
        });
        t.receipts.insert(k.to_owned(), rc);
    }

    /// The ingest-job insert for a receipt this statement admitted (mail_ingest_admit): under the
    /// backlog row, taken first for every insert, one active job per receipt, then backlog room.
    /// Returns true when it must wait.
    fn queue_job(&self, me: &str, t: &mut RTxn, k: &str, stamp: i64) -> bool {
        let (x, _) = unkey(k);
        let turns = format!("turns:{}", WS[x]);
        if self.held(me, &turns) {
            return true;
        }
        t.locks.insert(turns);
        let j = self.jobs(k);
        if j.pending > 0 {
            // A pending job reads the merged recipients when claimed. A claim in progress (its row
            // locked) makes it a running job: the receipt waits for that job instead.
            let lock = format!("job:{k}");
            if self.held(me, &lock) {
                self.hold(t, k, stamp);
            } else {
                t.locks.insert(lock);
            }
            return false;
        }
        if !j.running.is_empty() {
            self.hold(t, k, stamp);
            return false;
        }
        if self.active(x, t) >= self.ws[x].backlog {
            self.hold(t, k, stamp);
        } else {
            *t.jobs.entry(k.to_owned()).or_default() += 1;
            t.queued += 1;
        }
        false
    }

    fn advance(&mut self, me: &str) {
        let mut t = self.txns.remove(me).unwrap();
        t.blocked = false;
        let blocked = match t.words[0].as_str() {
            "accept" | "legacy-accept" | "replay" => self.advance_route(me, &mut t),
            "release" => self.advance_release(me, &mut t),
            _ => unreachable!(),
        };
        t.blocked = blocked;
        t.done = !blocked;
        self.txns.insert(me.to_owned(), t);
    }

    /// One route statement: an SNS notification, or a replay of the held envelopes. Rows in
    /// workspace then message order; each takes its workspace's window row first, then the
    /// receipt; then the ingest jobs in the same order.
    fn advance_route(&mut self, me: &str, t: &mut RTxn) -> bool {
        if t.phase == 0 {
            t.phase = 1;
            let mut rows: Vec<(usize, String, String)> = vec![];
            if t.words[0] == "replay" {
                // Due envelopes another replay holds are skipped (FOR UPDATE SKIP LOCKED).
                let stash: Vec<(String, String)> = self
                    .stash
                    .iter()
                    .filter(|(m, _)| !self.held(me, &format!("stash:{m}")))
                    .map(|(m, r)| (m.clone(), r.clone()))
                    .collect();
                for (m, r) in &stash {
                    t.locks.insert(format!("stash:{m}"));
                    t.released.push(m.clone());
                    for (x, (l, h)) in split_rcpt(r).into_iter().enumerate() {
                        if !l.is_empty() || h > 0 {
                            rows.push((x, m.clone(), r.clone()));
                        }
                    }
                }
                t.result = json!(stash.len());
            } else {
                let (m, r) = (t.words[1].clone(), t.words[2].clone());
                for (x, (l, h)) in split_rcpt(&r).into_iter().enumerate() {
                    if !l.is_empty() || h > 0 {
                        rows.push((x, m.clone(), r.clone()));
                    }
                }
                if rows.is_empty() {
                    // No recipients: routes nothing and records the staging object as ignored.
                    let lock = format!("ignored:{m}");
                    if !self.ignored.contains(&m) {
                        if self.held(me, &lock) {
                            t.phase = 0;
                            return true;
                        }
                        t.locks.insert(lock);
                    }
                    t.result = json!({"queued": 0});
                    return false;
                }
            }
            rows.sort();
            t.plan = rows;
        }
        while t.cursor < t.plan.len() {
            let (x, m, r) = t.plan[t.cursor].clone();
            let (letters, h) = split_rcpt(&r)[x].clone();
            let k = key(x, &m);
            if t.phase == 1 {
                let lock = format!("window:{}", WS[x]);
                if self.held(me, &lock) {
                    return true;
                }
                t.locks.insert(lock);
                t.phase = 2;
            }
            match self.receipt(t, &k) {
                None => {
                    let mut rc = Receipt {
                        status: "pending".into(),
                        letters,
                        h,
                        retry: None,
                        error: None,
                        born: self.t,
                        attempts: 0,
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
                        rc.retry = Some(Retry {
                            hour: self.h + 1,
                            kind: 0,
                            stamp: 0,
                        });
                    }
                    t.locks.insert(format!("receipt:{k}"));
                    t.receipts.insert(k, rc);
                }
                Some(cur) => {
                    // A known receipt: merge the new recipients under its row lock.
                    let lock = format!("receipt:{k}");
                    if self.held(me, &lock) {
                        return true;
                    }
                    t.locks.insert(lock);
                    let mut union: Vec<char> = cur.letters.chars().chain(letters.chars()).collect();
                    union.sort();
                    union.dedup();
                    let union: String = union.into_iter().collect();
                    let uh = cur.h.max(h);
                    let covers = letters.chars().all(|c| cur.letters.contains(c)) && cur.h >= h;
                    if cur.status != "failed" && !covers && union.len() + uh as usize <= 200 {
                        let pending = cur.status != "held";
                        let rc = Receipt {
                            letters: union,
                            h: uh,
                            status: if pending {
                                "pending".into()
                            } else {
                                "held".into()
                            },
                            ..cur
                        };
                        t.receipts.insert(k.clone(), rc);
                        if pending {
                            t.need_job.push(k);
                        }
                    }
                }
            }
            t.cursor += 1;
            t.phase = 1;
        }
        let stamp = t.stamp;
        while let Some(k) = t.need_job.first().cloned() {
            if self.queue_job(me, t, &k, stamp) {
                return true;
            }
            t.need_job.remove(0);
        }
        if t.words[0] != "replay" {
            t.result = json!({"queued": t.queued});
        }
        false
    }

    /// release_receive_budget_holds(NULL): never waits, and moves a hold it cannot reach behind
    /// the others instead of retrying it first forever.
    fn advance_release(&mut self, me: &str, t: &mut RTxn) -> bool {
        let stamp = t.stamp;
        let mut due: Vec<(Retry, usize, String)> = vec![];
        for (x, w) in self.ws.iter().enumerate() {
            for (m, r) in &w.receipts {
                if r.status == "held"
                    && r.retry.is_some_and(|v| self.due(&v))
                    && !self.held(me, &format!("receipt:{}", key(x, m)))
                {
                    due.push((r.retry.unwrap(), x, m.clone()));
                }
            }
        }
        due.sort();
        let mut scanned = 0;
        for (_, x, m) in due {
            let k = key(x, &m);
            t.locks.insert(format!("receipt:{k}"));
            scanned += 1;
            let mut rc = self.receipt(t, &k).unwrap();
            if self.t - rc.born >= 72 {
                rc.status = "failed".into();
                rc.error = Some("MAILBOX_BUDGET_HOLD_EXPIRED".into());
                rc.retry = None;
                t.receipts.insert(k, rc);
                continue;
            }
            let (window, turns) = (format!("window:{}", WS[x]), format!("turns:{}", WS[x]));
            if self.held(me, &window) || self.held(me, &turns) {
                rc.retry = Some(Retry {
                    hour: self.h,
                    kind: 2,
                    stamp,
                });
                t.receipts.insert(k, rc);
                continue;
            }
            t.locks.insert(window);
            t.locks.insert(turns);
            let next_hour = Some(Retry {
                hour: self.h + 1,
                kind: 0,
                stamp: 0,
            });
            if rc.error.as_deref() == Some(BACKLOG_HOLD) {
                // Already charged: it needs only an ingest job.
                let j = self.jobs(&k);
                if !j.running.is_empty() || (j.pending > 0 && self.held(me, &format!("job:{k}"))) {
                    rc.retry = Some(Retry {
                        hour: self.h,
                        kind: 2,
                        stamp,
                    });
                } else if j.pending > 0 || self.active(x, t) < self.ws[x].backlog {
                    rc.status = "pending".into();
                    rc.error = None;
                    rc.retry = None;
                    if j.pending > 0 {
                        t.locks.insert(format!("job:{k}"));
                    } else {
                        *t.jobs.entry(k.clone()).or_default() += 1;
                    }
                } else {
                    rc.retry = next_hour;
                }
                t.receipts.insert(k, rc);
                continue;
            }
            match self.slot(x, t) {
                None => {
                    rc.retry = next_hour;
                    t.receipts.insert(k, rc);
                }
                Some(win) => {
                    t.windows[x] = Some(win);
                    rc.status = "pending".into();
                    rc.error = None;
                    rc.retry = None;
                    t.receipts.insert(k.clone(), rc);
                    self.queue_job(me, t, &k, stamp);
                    // Held again for the backlog: not before the next hour from this pass.
                    if let Some(r) = t.receipts.get_mut(&k).filter(|r| r.status == "held") {
                        r.retry = next_hour;
                    }
                }
            }
        }
        t.result = json!(scanned);
        false
    }

    /// When an ingest job stops being active, admit the workspace's backlog holds in queue
    /// order (mail_receive_drain). It never waits; the job end already holds the backlog row.
    fn drain(&mut self, x: usize) {
        let mut t = self.txn(&["drain"]);
        t.locks.insert(format!("turns:{}", WS[x]));
        let mut queue: Vec<(Retry, String)> = self.ws[x]
            .receipts
            .iter()
            .filter(|(m, r)| {
                r.status == "held"
                    && r.error.as_deref() == Some(BACKLOG_HOLD)
                    && !self.held("D", &format!("receipt:{}", key(x, m)))
            })
            .map(|(m, r)| (r.retry.unwrap(), m.clone()))
            .collect();
        queue.sort();
        for (_, m) in queue {
            let k = key(x, &m);
            let j = self.jobs(&k);
            if !j.running.is_empty() || (j.pending > 0 && self.held("D", &format!("job:{k}"))) {
                continue;
            }
            if j.pending == 0 && self.active(x, &t) >= self.ws[x].backlog {
                break;
            }
            let mut rc = self.receipt(&t, &k).unwrap();
            rc.status = "pending".into();
            rc.error = None;
            rc.retry = None;
            t.receipts.insert(k.clone(), rc);
            if j.pending == 0 {
                *t.jobs.entry(k).or_default() += 1;
            }
        }
        self.apply(t);
    }

    fn apply(&mut self, t: RTxn) {
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
        for m in t.released {
            self.stash.remove(&m);
        }
        for l in t.locks {
            if let Some(m) = l.strip_prefix("ignored:") {
                self.ignored.insert(m.to_owned());
            }
        }
    }

    fn finish(&mut self, me: &str, commit: bool) -> BTreeMap<String, Value> {
        let t = self.txns.remove(me).unwrap();
        if commit {
            self.apply(t);
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
        p.txns.insert("A".into(), p.txn(words));
        p.advance("A");
        !p.txns["A"].blocked
    }

    /// The oldest running job of X:m stops (done, fail or lose). A done job settles the receipt, a
    /// failed one fails it, both only as claimed: still pending with the recipients it read.
    fn end_job(&mut self, x: usize, m: &str, how: &str) -> Value {
        let claimed = self.ws[x].jobs.get_mut(m).unwrap().running.remove(0);
        if self.ws[x].jobs[m].pending == 0 && self.ws[x].jobs[m].running.is_empty() {
            self.ws[x].jobs.remove(m);
        }
        let r = match (how, self.ws[x].receipts.get_mut(m)) {
            ("done", Some(r)) if r.status == "pending" && r.set() == claimed => {
                r.status = "processed".into();
                json!(1)
            }
            ("fail", Some(r)) if r.status == "pending" && r.set() == claimed => {
                r.status = "failed".into();
                r.error = Some("MAILBOX_INGEST_FAILED".into());
                json!(1)
            }
            _ => json!(0),
        };
        self.drain(x);
        r
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
        let ws = |w: &str| if w == "A" { 0 } else { 1 };
        match words[0] {
            // Autocommit statements never wait: run them only when no lock they need is held.
            "accept" | "legacy-accept" | "release" | "replay" => self.probe(words),
            "stash" => !self.stash.contains_key(words[1]),
            "claim" => self.jobs(&key(ws(words[1]), words[2])).pending > 0,
            "done" | "fail" | "lose" => {
                let x = ws(words[1]);
                let k = key(x, words[2]);
                let pending = self.ws[x]
                    .receipts
                    .get(words[2])
                    .is_some_and(|r| r.status == "pending");
                // The job end takes the backlog row; its drain never waits.
                !self.jobs(&k).running.is_empty()
                    && !self.held("A", &format!("turns:{}", WS[x]))
                    && !(pending && self.held("A", &format!("receipt:{k}")))
            }
            // The previous Worker's terminal failure write: it waits on a receipt another statement
            // holds, so run it only when none does.
            "legacy-fail" => {
                let x = ws(words[1]);
                self.ws[x].receipts.contains_key(words[2])
                    && !self.held("A", &format!("receipt:{}", key(x, words[2])))
            }
            "recover" | "hour" | "days" => !open,
            _ => false,
        }
    }

    pub fn step(&mut self, conn: Option<&str>, words: &[&str]) -> (Value, BTreeMap<String, Value>) {
        self.stamp += 1;
        if let Some(c) = conn {
            return match words[0] {
                "commit" | "abort" => (json!("ok"), self.finish(c, words[0] == "commit")),
                _ => {
                    let t = self.txn(words);
                    self.txns.insert(c.to_owned(), t);
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
        let ws = |w: &str| if w == "A" { 0 } else { 1 };
        let r = match words[0] {
            "accept" | "legacy-accept" | "release" | "replay" => {
                let t = self.txn(words);
                self.txns.insert("A".into(), t);
                self.advance("A");
                let r = self.txns["A"].result.clone();
                self.finish("A", true);
                r
            }
            "stash" => {
                self.stash.insert(words[1].into(), words[2].into());
                json!("ok")
            }
            "claim" => {
                // A runner claims the pending job, skipping one a transaction holds locked.
                let x = ws(words[1]);
                let k = key(x, words[2]);
                if self.held("A", &format!("job:{k}")) {
                    json!(0)
                } else {
                    let set = self.ws[x]
                        .receipts
                        .get(words[2])
                        .map(Receipt::set)
                        .unwrap_or_default();
                    let j = self.ws[x].jobs.get_mut(words[2]).unwrap();
                    j.pending -= 1;
                    j.running.push(set);
                    json!(1)
                }
            }
            "done" | "fail" | "lose" => self.end_job(ws(words[1]), words[2], words[0]),
            // A previous Worker's attempt, current or long retired, fails the receipt with its old
            // unfenced statement (status='pending' only). It names no claim, so the settle fence
            // drops it: such a receipt stays pending until a current Worker settles it.
            "legacy-fail" => json!(0),
            "recover" => {
                // recoverMailReceipts: pending receipts that lost their ingest job, in order; each
                // queues one again through the same job insert, or fails after three passes.
                let mut t = self.txn(words);
                let mut n = 0;
                let stamp = t.stamp;
                for x in 0..2 {
                    let lost: Vec<String> = self.ws[x]
                        .receipts
                        .iter()
                        .filter(|(m, r)| {
                            r.status == "pending" && self.jobs(&key(x, m)) == Jobs::default()
                        })
                        .map(|(m, _)| m.clone())
                        .collect();
                    for m in lost {
                        let k = key(x, &m);
                        let mut rc = self.receipt(&t, &k).unwrap();
                        n += 1;
                        rc.attempts += 1;
                        if rc.attempts > 3 {
                            rc.status = "failed".into();
                            rc.error = Some("MAILBOX_RECOVERY_EXHAUSTED".into());
                            t.receipts.insert(k, rc);
                        } else {
                            t.receipts.insert(k.clone(), rc);
                            self.queue_job("A", &mut t, &k, stamp);
                        }
                    }
                }
                self.apply(t);
                json!(n)
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
                .map(|(m, r)| {
                    (
                        m,
                        json!([
                            r.status,
                            r.count(),
                            r.retry.map(|v| v.hour),
                            r.retry.map(|v| self.due(&v)),
                            r.error
                        ]),
                    )
                })
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
        out.insert("stash".into(), json!(self.stash.keys().collect::<Vec<_>>()));
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
    /// Weeks since the shared connection was created; clean accepted recipients a day ago. A resume
    /// keeps this history (it forgives only the reviewed bounces and complaints).
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
            // Only the columns the operator wrote: clean history and connection age move meanwhile.
            if let Some((x, w)) = t.ws {
                let cur = &mut self.ws[x];
                match t.words[0].as_str() {
                    "limits" => (cur.send_cap, cur.pend_cap) = (w.send_cap, w.pend_cap),
                    "exempt" => cur.exempt = w.exempt,
                    _ => cur.paused = w.paused,
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
/// again unless an attachment holds it. Storage itself is reconciled too: any upload object that
/// has had no attachment and no reservation for a day is deleted, however late its put landed (a
/// Worker that died before its refund, an older Worker, a put that outlived every record). Objects
/// of other key families in the same bucket are never deleted.
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
    /// Stored objects and their age in days.
    pub objects: BTreeMap<String, i64>,
    /// Objects of other key families in the same bucket (a workspace named `attachments`'s kept
    /// mail under workspace `k`, a mail attachment, a template asset): nothing here ever deletes them.
    pub foreign: i64,
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
            objects: BTreeMap::new(),
            foreign: 0,
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
            (None, "foreign") => self.foreign == 0,
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
                self.objects.insert(u.obj.clone(), 0);
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
                self.objects.insert(u.obj, 0);
                json!("crashed")
            }
            (None, "expire") => {
                for e in self.reservations.values_mut() {
                    *e = true;
                }
                json!("ok")
            }
            (None, "day") => {
                // A day passes and the hourly cleanup runs.
                for e in self.reservations.values_mut() {
                    *e = true;
                }
                for d in self.tombstones.values_mut() {
                    *d = true;
                }
                for a in self.objects.values_mut() {
                    *a += 1;
                }
                self.step(None, &["sweep"])
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
                // Reconcile storage: an object a day old that no attachment or reservation holds.
                let orphans: Vec<String> = self
                    .objects
                    .iter()
                    .filter(|(o, age)| {
                        **age >= 1
                            && !self.reservations.contains_key(*o)
                            && !self.attachments.values().any(|a| a == *o)
                    })
                    .map(|(o, _)| o.clone())
                    .collect();
                self.deletes.extend(orphans);
                json!("ok")
            }
            (None, "purge") => {
                for o in std::mem::take(&mut self.deletes) {
                    self.objects.remove(&o);
                }
                json!("ok")
            }
            (None, "foreign") => {
                self.foreign = 3;
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
            "deletes": self.deletes.len(), "tombstones": self.tombstones.len(), "objects": self.objects.len(), "foreign": self.foreign})
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
        out.extend(["expire", "sweep", "purge", "day", "foreign"].map(String::from));
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
        stmts.push("replay".into());
        held(&mut out, &stmts);
        for m in msgs {
            for r in if core {
                &["a", "ac"][..]
            } else {
                &["a", "ac", "ab", "b"][..]
            } {
                out.push(format!("stash {m} {r}"));
            }
            for x in WS {
                for v in ["claim", "done", "fail", "lose", "legacy-fail"] {
                    if !core
                        || v == "claim"
                        || v == "done"
                        || v == "fail"
                        || (v == "legacy-fail" && x == "A")
                    {
                        out.push(format!("{v} {x} {m}"));
                    }
                }
            }
        }
        out.extend(["recover", "hour", "days"].map(String::from));
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
