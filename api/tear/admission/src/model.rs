//! Reference model for admission and rate limits, written from the documented contract (the
//! comments in migrations 062-110 and sending.ts / mailbox-receipts.ts) rather than from the SQL.
//! The state is committed state plus one open transaction per connection (W, V). A statement runs
//! in lock phases; when it needs a lock the other connection holds, it is `blocked` and resumes,
//! against the then-latest committed state, at that connection's commit or abort.
//!
//! Receive side (`Recv`): one workspace, an hourly message window of `limit` messages, an ingest
//! backlog of `backlog` jobs. A notification of a new message serializes on the workspace's window
//! row, rechecks whether the receipt exists, and only then charges the window once; a notification
//! of a known message never charges. Budget holds are released into a later window.
//!
//! Send side (`Send`): two hosted workspaces sharing a quota sponsor, three API keys (1 and 3 on
//! workspace 1, 2 on workspace 2). Admission is one statement: key budget, idempotency claim,
//! workspace admission lock, policy rows (FOR SHARE), sponsor lock, then the decision against the
//! rolling 24-hour usage of the sponsor's workspaces, the marketing reserve and the pending cap.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const CONNS: [&str; 2] = ["W", "V"];

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(tag = "profile", rename_all = "lowercase")]
pub enum Model {
    Recv(Recv),
    Send(Send),
    Upload(Upload),
}

// ---------------------------------------------------------------- receive side

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Receipt {
    pub status: String,
    /// Single-letter recipients (a, b) plus `h` of the numbered ones (0, 100 or 101).
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
}
fn rcpt(r: &str) -> (String, u8) {
    match r {
        "0" => (String::new(), 0),
        "h" => (String::new(), 100),
        "x" => (String::new(), 101),
        _ => {
            let mut v: Vec<char> = r.chars().collect();
            v.sort();
            v.dedup();
            (v.into_iter().collect(), 0)
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug, Default)]
pub struct RTxn {
    pub words: Vec<String>,
    pub phase: u8,
    pub blocked: bool,
    pub done: bool,
    pub window_lock: bool,
    pub turns_lock: bool,
    pub receipt_locks: BTreeSet<String>,
    /// Uncommitted effects.
    pub receipts: BTreeMap<String, Receipt>,
    pub window: Option<(i64, i64)>,
    pub jobs: BTreeMap<String, i64>,
    /// release: receipts claimed (FOR UPDATE SKIP LOCKED) and the next one to process.
    pub claimed: Vec<String>,
    pub cursor: usize,
    pub result: Value,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub struct Recv {
    pub limit: i64,
    pub backlog: i64,
    /// Window clock (hours) and created_at clock (hours, also moved by `days`).
    pub h: i64,
    pub t: i64,
    pub window: Option<(i64, i64)>,
    pub receipts: BTreeMap<String, Receipt>,
    pub jobs: BTreeMap<String, i64>,
    /// Staging objects recorded as ignored (a notification with no recipients).
    pub ignored: BTreeSet<String>,
    pub txns: BTreeMap<String, RTxn>,
}

impl Recv {
    pub fn initial(limit: i64, backlog: i64) -> Self {
        Recv {
            limit,
            backlog,
            h: 0,
            t: 0,
            window: None,
            receipts: BTreeMap::new(),
            jobs: BTreeMap::new(),
            ignored: BTreeSet::new(),
            txns: BTreeMap::new(),
        }
    }
    fn other(&self, me: &str) -> impl Iterator<Item = (&String, &RTxn)> {
        let me = me.to_owned();
        self.txns.iter().filter(move |(k, _)| **k != me)
    }
    fn window_held(&self, me: &str) -> bool {
        self.other(me).any(|(_, t)| t.window_lock)
    }
    fn turns_held(&self, me: &str) -> bool {
        self.other(me).any(|(_, t)| t.turns_lock)
    }
    fn receipt_held(&self, me: &str, m: &str) -> bool {
        self.other(me).any(|(_, t)| t.receipt_locks.contains(m))
    }
    fn active(&self) -> i64 {
        self.jobs.values().sum()
    }
    /// mail_receive_slot, called with the window lock held: backlog and window read after every
    /// earlier admission committed. Returns the charged window, or None for a budget hold.
    fn slot(&self) -> Option<(i64, i64)> {
        if self.limit <= 0 || self.active() >= self.backlog {
            return None;
        }
        match self.window {
            Some((at, n)) if at == self.h => (n < self.limit).then_some((self.h, n + 1)),
            _ => Some((self.h, 1)),
        }
    }

    /// Run `me`'s statement from its current phase until it blocks or completes.
    fn advance(&mut self, me: &str) {
        let mut t = self.txns.remove(me).unwrap();
        t.blocked = false;
        // Locks and effects are judged against the other connection's locks.
        let blocked = loop {
            match t.words[0].as_str() {
                "accept" => {
                    let (m, r) = (t.words[1].clone(), t.words[2].clone());
                    let (letters, h) = rcpt(&r);
                    match t.phase {
                        // Fast path: a known message never touches the window.
                        0 => {
                            // No recipients: routes nothing and records the staging object as
                            // ignored (its key is locked until commit).
                            if letters.is_empty() && h == 0 {
                                let key = format!("ignored:{m}");
                                if !self.ignored.contains(&m) {
                                    if self.receipt_held(me, &key) {
                                        break true;
                                    }
                                    t.receipt_locks.insert(key);
                                }
                                t.result = json!({"queued": 0});
                                break false;
                            }
                            t.phase = if self.receipts.contains_key(&m) { 2 } else { 1 };
                        }
                        // A new message: serialize on the window row, then recheck.
                        1 => {
                            if self.window_held(me) {
                                break true;
                            }
                            t.window_lock = true;
                            if self.receipts.contains_key(&m) {
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
                            t.receipt_locks.insert(m.clone());
                            if rc.count() > 100 {
                                rc.status = "failed".into();
                                rc.error = Some("MAILBOX_RECEIVE_BUDGET".into());
                            } else if let Some(w) = self.slot() {
                                t.window = Some(w);
                            } else {
                                rc.status = "held".into();
                                rc.error = Some("MAILBOX_RECEIVE_BUDGET".into());
                                rc.retry = Some(self.h + 1);
                            }
                            let pending = rc.status == "pending";
                            t.receipts.insert(m.clone(), rc);
                            if !pending {
                                t.result = json!({"queued": 0});
                                break false;
                            }
                            t.phase = 3;
                        }
                        // A known message: reopen with new recipients, under the receipt row lock.
                        2 => {
                            if self.receipt_held(me, &m) {
                                break true;
                            }
                            t.receipt_locks.insert(m.clone());
                            let cur = self.receipts[&m].clone();
                            let mut union: Vec<char> =
                                cur.letters.chars().chain(letters.chars()).collect();
                            union.sort();
                            union.dedup();
                            let union: String = union.into_iter().collect();
                            let uh = cur.h.max(h);
                            let covers =
                                letters.chars().all(|c| cur.letters.contains(c)) && cur.h >= h;
                            if cur.status != "failed" && !covers && union.len() + uh as usize <= 200
                            {
                                let status = if cur.status == "held" {
                                    "held"
                                } else {
                                    "pending"
                                };
                                let rc = Receipt {
                                    status: status.into(),
                                    letters: union,
                                    h: uh,
                                    ..cur
                                };
                                t.receipts.insert(m.clone(), rc);
                                if status == "pending" {
                                    t.phase = 3;
                                    continue;
                                }
                            }
                            t.result = json!({"queued": 0});
                            break false;
                        }
                        // Queue the ingest job: the backlog counter row.
                        _ => {
                            if self.turns_held(me) {
                                break true;
                            }
                            t.turns_lock = true;
                            *t.jobs.entry(m.clone()).or_default() += 1;
                            t.result = json!({"queued": 1});
                            break false;
                        }
                    }
                }
                "release" => {
                    if t.phase == 0 {
                        // Due holds, oldest retry first; rows another connection holds are skipped.
                        let mut due: Vec<(i64, String)> = self
                            .receipts
                            .iter()
                            .filter(|(m, r)| {
                                r.status == "held"
                                    && r.retry.is_some_and(|x| x <= self.h)
                                    && !self.receipt_held(me, m)
                            })
                            .map(|(m, r)| (r.retry.unwrap(), m.clone()))
                            .collect();
                        due.sort();
                        t.claimed = due.into_iter().map(|(_, m)| m).collect();
                        for m in &t.claimed {
                            t.receipt_locks.insert(m.clone());
                        }
                        t.phase = 1;
                    }
                    if t.cursor >= t.claimed.len() {
                        t.result = json!(t.claimed.len());
                        break false;
                    }
                    let m = t.claimed[t.cursor].clone();
                    let mut rc = t
                        .receipts
                        .get(&m)
                        .cloned()
                        .unwrap_or_else(|| self.receipts[&m].clone());
                    if t.phase == 1 {
                        if self.t - rc.born >= 72 {
                            rc.status = "failed".into();
                            rc.error = Some("MAILBOX_BUDGET_HOLD_EXPIRED".into());
                            rc.retry = None;
                            t.receipts.insert(m, rc);
                            t.cursor += 1;
                            continue;
                        }
                        if self.window_held(me) {
                            break true;
                        }
                        t.window_lock = true;
                        // The slot sees this transaction's own earlier releases.
                        let mut view = self.clone();
                        view.window = t.window.or(self.window);
                        for (k, n) in &t.jobs {
                            *view.jobs.entry(k.clone()).or_default() += n;
                        }
                        match view.slot() {
                            Some(w) => {
                                t.window = Some(w);
                                rc.status = "pending".into();
                                rc.error = None;
                                rc.retry = None;
                                t.receipts.insert(m, rc);
                                t.phase = 2;
                            }
                            None => {
                                rc.retry = Some(self.h + 1);
                                t.receipts.insert(m, rc);
                                t.cursor += 1;
                            }
                        }
                        continue;
                    }
                    if self.turns_held(me) {
                        break true;
                    }
                    t.turns_lock = true;
                    *t.jobs.entry(m).or_default() += 1;
                    t.cursor += 1;
                    t.phase = 1;
                }
                _ => unreachable!(),
            }
        };
        t.blocked = blocked;
        t.done = !blocked;
        self.txns.insert(me.to_owned(), t);
    }

    fn finish(&mut self, me: &str, commit: bool) -> BTreeMap<String, Value> {
        let t = self.txns.remove(me).unwrap();
        if commit {
            self.receipts.extend(t.receipts);
            if let Some(w) = t.window {
                self.window = Some(w);
            }
            for (m, n) in t.jobs {
                *self.jobs.entry(m).or_default() += n;
            }
            for k in t.receipt_locks {
                if let Some(m) = k.strip_prefix("ignored:") {
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

    pub fn enabled(&self, conn: Option<&str>, words: &[&str]) -> bool {
        let any_blocked = self.txns.values().any(|t| t.blocked);
        if let Some(c) = conn {
            return match words[0] {
                "commit" | "abort" => self.txns.get(c).is_some_and(|t| t.done),
                _ => {
                    if self.txns.contains_key(c) {
                        return false;
                    }
                    if !any_blocked {
                        return true;
                    }
                    // Never two statements blocked at once: which waiter wins is PostgreSQL's choice.
                    let mut probe = self.clone();
                    probe.txns.insert(
                        c.to_owned(),
                        RTxn {
                            words: words.iter().map(|s| s.to_string()).collect(),
                            ..Default::default()
                        },
                    );
                    probe.advance(c);
                    !probe.txns[c].blocked
                }
            };
        }
        if any_blocked {
            return false;
        }
        let open = !self.txns.is_empty();
        match words[0] {
            // Autocommit statements never wait: run them only when no lock they need is held.
            "accept" | "release" => {
                let mut probe = self.clone();
                probe.txns.insert(
                    "A".into(),
                    RTxn {
                        words: words.iter().map(|s| s.to_string()).collect(),
                        ..Default::default()
                    },
                );
                probe.advance("A");
                !probe.txns["A"].blocked
            }
            "done" => {
                let m = words[1];
                let pending = self.receipts.get(m).is_some_and(|r| r.status == "pending");
                !(pending && self.receipt_held("A", m))
                    && !(self.jobs.get(m).copied().unwrap_or(0) > 0 && self.turns_held("A"))
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
                    self.txns.insert(
                        c.to_owned(),
                        RTxn {
                            words: words.iter().map(|s| s.to_string()).collect(),
                            ..Default::default()
                        },
                    );
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
            "accept" | "release" => {
                self.txns.insert(
                    "A".into(),
                    RTxn {
                        words: words.iter().map(|s| s.to_string()).collect(),
                        ..Default::default()
                    },
                );
                self.advance("A");
                let r = self.txns["A"].result.clone();
                self.finish("A", true);
                r
            }
            "done" => {
                let m = words[1];
                if let Some(r) = self.receipts.get_mut(m) {
                    if r.status == "pending" {
                        r.status = "processed".into();
                    }
                }
                json!(self.jobs.remove(m).unwrap_or(0))
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
        let receipts: BTreeMap<&String, Value> = self
            .receipts
            .iter()
            .map(|(m, r)| (m, json!([r.status, r.count(), r.retry, r.error])))
            .collect();
        let jobs: BTreeMap<&String, i64> = self
            .jobs
            .iter()
            .filter(|(_, n)| **n > 0)
            .map(|(m, n)| (m, *n))
            .collect();
        json!({
            "window": match self.window { Some((at, n)) if at == self.h => n, _ => 0 },
            "receipts": receipts, "active": self.active(), "jobs": jobs,
        })
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
/// expired reservations and queues their objects' deletion.
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
            next_obj: 1,
            next_label: 1,
        }
    }
    /// The finally block of an upload that did not publish its object: take the reservation if it
    /// is still there, and queue the object's deletion either way (the sweeper's deletion of an
    /// expired reservation may have run before this upload's put landed).
    fn refund(&mut self, obj: &str) {
        if self.reservations.remove(obj).is_some() {
            self.used -= 1;
        }
        self.deletes.insert(obj.to_owned());
    }
    pub fn enabled(&self, slot: Option<&str>, words: &[&str]) -> bool {
        match (slot, words[0]) {
            (Some(s), "upload" | "upload-other") => !self.slots.contains_key(s),
            (Some(s), "ok" | "fail") => self.slots.contains_key(s),
            (None, "expire" | "sweep" | "purge") => true,
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
                if self.reservations.remove(&u.obj).is_none() {
                    self.refund(&u.obj);
                    return json!("503:UPLOAD_EXPIRED");
                }
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
            (None, "expire") => {
                for e in self.reservations.values_mut() {
                    *e = true;
                }
                json!("ok")
            }
            (None, "sweep") => {
                let expired: Vec<String> = self
                    .reservations
                    .iter()
                    .filter(|(_, e)| **e)
                    .map(|(o, _)| o.clone())
                    .collect();
                for o in expired {
                    self.reservations.remove(&o);
                    self.used -= 1;
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
            "deletes": self.deletes.len(), "objects": self.objects.len()})
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
    let held = |out: &mut Vec<String>, stmts: &[String]| {
        for s in stmts {
            out.push(s.clone());
            for c in CONNS {
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
        }
        out.extend(["expire", "sweep", "purge"].map(String::from));
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
            &["a", "ab", "x"]
        } else {
            &["a", "ab", "b", "h", "x", "0"]
        };
        let mut stmts = vec![];
        for m in msgs {
            for r in sets {
                stmts.push(format!("accept {m} {r}"));
            }
        }
        stmts.push("release".into());
        held(&mut out, &stmts);
        for m in msgs {
            out.push(format!("done {m}"));
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
    for c in CONNS {
        out.push(format!("{c} commit"));
        out.push(format!("{c} abort"));
    }
    out
}
