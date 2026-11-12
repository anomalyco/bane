//! # Edge cases (checklist)
//!
//! [x] reached and checked (by random walks, the breadth-first edge map or a SCENARIOS trace in
//! main.rs; `coverage` in every report counts each tag); [~] partly; [ ] not reached, and why.
//!
//! Concurrency and interleavings
//! - [x] Two dispatcher processes lease, claim, send and record the same queue (D1, D2 step).
//! - [x] A claim after another process claimed or requeued the row (lost claim, version fence).
//! - [x] A record after the sweep marked the attempt interrupted (accepted / refused / unknown).
//! - [x] Cancel before a leased row's claim (cancel's own page cancels it, the claim loses), and a
//!       row in flight at cancel that is throttled, requeued and then canceled by the next claim.
//! - [x] Cancel between a claim and its send (in flight: sent, reported as inFlight).
//! - [x] Pause with rows queued (they still dispatch) and with rows unreleased (held).
//! - [x] Two concurrent sends with one Idempotency-Key (dupk: one row, both get its receipt).
//! - [x] The runner's drain is a whole run: it leases pages until one comes back short (25 sends
//!       need two pages), and with two owners and two-row leases the owner cursor lands on the
//!       last owner and the run must wrap (the original owner-cursor bug, caught by the drain
//!       alone: `send ok`, `send2 ok`, `send ok`, `drain`). Interleaved with stepped processes.
//! - [~] Statement-level races inside one transaction (e.g. cancelPage's SKIP LOCKED against a
//!       claim holding the row): actions are whole statements; the interleaving points are
//!       lease, claim, provider call and record.
//!
//! Crashes and aborts mid-operation
//! - [x] Crash before the lease, after the lease (lease held until expiry), after the claim
//!       (attempting, never sent), after the provider accepted (sent, never recorded).
//! - [x] Restart after a crash with a fresh gate (pacing and quota state lost).
//! - [x] Interrupted-attempt sweep: attempting older than 3 min -> acceptance_unknown, never resent.
//!
//! Retries and duplicates
//! - [x] Throttled (429): requeued at version+1 with 2 s backoff, retried once, then accepted.
//! - [x] Throttle brake: the process's next provider call waits 1 s (temporal, per process).
//! - [x] 5xx / unknown: acceptance_unknown, never retried; a possibly accepted row is never
//!       called again (temporal, per message, and the host's double-send check).
//! - [x] Permanent refusal: rejected, never retried.
//! - [x] A late definitive refusal after the sweep requeues the row and reopens a done campaign.
//! - [x] Same key and body replays; same key, different body is 409; a refused admission (429)
//!       releases its key.
//!
//! Lease or lock expiry
//! - [x] Lease expiry (2 min, ±1 s) while the leasing process stalls; another process takes the row.
//! - [x] A claimed send that cannot start within 5 s of its claim is deferred, not sent (±1 s).
//! - [x] The campaign run job's deferral to its schedule and its pacing window.
//!
//! Clock skew and time boundaries
//! - [x] Every deadline one second either side: lease, sweep, backoff, schedule, run job, pre-send;
//!       the pacing window +1 s. Virtual time is shared by JS and PostgreSQL.
//! - [~] The pacing window -1 s: not reachable with the wait alphabet (1 s, 4 s, 59 s, 1 min, 1 d);
//!       its run job's due check is reached at -1 s through the schedule.
//! - [ ] The exact instant of a deadline: the host's events land 50-990 ms into their second, so
//!       equality is a genuine race in the real system too; the model disables reads then.
//! - [ ] Skew between two processes' clocks: one virtual clock serves all of them.
//!
//! Limits and caps at the boundary, ±1
//! - [x] Pending cap: 10,000 queued direct rows admitted, the 10,001st refused (seeded to 9,998).
//! - [x] Campaign daily cap 1 of 2 recipients: one release per window, the next at +24 h +1 s;
//!       temporal: a full window holds the next release until it ends, never over the cap.
//! - [x] SES 24-hour quota 2, 3 and 4 with two shards (1-3 campaign credits, fewer than the shard
//!       count at 2: the tail claim): campaign mail never spends the transactional reserve, and
//!       every row settles within a simulated week (quota profile, invariants).
//! - [~] Provider rate pacing: the brake is checked; the 1,000/s rate itself is not lowered,
//!       because lower rates make every action wait in real time.
//! - [ ] Hosted per-minute and daily send caps: multi-tenant hosted only (not this host).
//!
//! Empty, zero and huge inputs
//! - [x] An empty queue: leases, drains and sweeps with nothing due.
//! - [x] A campaign whose recipients all settle while paused, then resume and finish.
//! - [ ] Huge audiences (>1,000 rows, cancel continuation jobs, 2,000-row release pages):
//!       sizes are fixed to keep runs fast; acceptance tests cover the paging.
//!
//! Revocation or deletion racing in-flight work; permissions per actor type
//! - [ ] Key revocation and origin checks at claim: the access-control tear area.
//!
//! Old and new Worker overlap during deploys
//! - [x] Two processes with independent gates on one queue (D1 and D2: the old and new process
//!       of a deploy, or a restarted runner), and two shards splitting one SES quota.
//!
//! Partial failures of external calls
//! - [x] SES: accept, throttle, permanent refusal, 5xx, a call that never returns (crash at the
//!       provider call), a response that is lost (crash before the record), a daily-quota refusal.
//! - [x] An account-wide sending pause (`ses pause`/`ses resume`, quota profile): the quota refresh
//!       fails and the run retries; pause refusals brake for 5 min; a row is given up as
//!       pause-expired only 24 h after its first refusal; everything settles after resume.
//! - [ ] R2 attachments and webhooks: no attachments or webhooks in these traces.
//!
//! Reference model of Bane's send path: admission (with Idempotency-Key and the pending cap),
//! the campaign state machine and its run job (preparing, scheduled, paced release), the
//! dispatcher (a runner process that drains a whole lease, plus two stepped processes D1 and D2
//! that lease one row at a time and can crash at any parked point), provider outcomes, retries
//! and backoff, and the interrupted-attempt sweep. Written from the documented contract, not the
//! implementation: a row is claimed at most once per dispatch version, a provider call that may
//! have been accepted is never repeated, pause stops releases but not queued mail, cancel stops
//! every unclaimed row, and every admitted row settles.
//!
//! Time is in whole seconds. A host event happens 50-990 ms into its second, so a deadline set
//! D >= 1 s after an event is racy exactly at its second; the model never reads time-dependent
//! state at such an instant (`racy`), and only `wait` is enabled then.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const LEASE: u32 = 120; // sending_emails.lease_until after a lease
pub const RECOVER: u32 = 180; // attempting rows older than this become acceptance_unknown
pub const PRE_SEND: u32 = 5; // a claimed send that cannot start within 5 s is deferred, not sent
pub const DAY: u32 = 86_400;
pub const SCHEDULE: u32 = 60; // `schedule` launches for now + 60 s
pub const PENDING_CAP: u32 = 10_000; // direct mail queued or attempting per workspace (floor)

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum P {
    Ok,
    Thr,
    Rej,
    Unk,
}
impl P {
    pub fn parse(s: &str) -> Option<P> {
        Some(match s {
            "ok" => P::Ok,
            "thr" => P::Thr,
            "rej" => P::Rej,
            "unk" => P::Unk,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            P::Ok => "ok",
            P::Thr => "thr",
            P::Rej => "rej",
            P::Unk => "unk",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum St {
    Queued,
    Attempting,
    Accepted,
    Rejected,
    Unknown,
    Canceled,
}
impl St {
    fn name(self) -> &'static str {
        match self {
            St::Queued => "queued",
            St::Attempting => "attempting",
            St::Accepted => "accepted",
            St::Rejected => "rejected",
            St::Unknown => "acceptance_unknown",
            St::Canceled => "canceled",
        }
    }
    /// Monotonic status rank: an outcome never moves a row backwards.
    fn rank(self) -> u8 {
        match self {
            St::Queued => 0,
            St::Attempting => 1,
            St::Unknown => 2,
            St::Accepted => 3,
            St::Rejected | St::Canceled => 6,
        }
    }
}

/// A provider outcome, or a send deferred before the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Out {
    Accepted,
    Rejected,
    Unknown,
    Throttled,
    Deferred,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mail {
    pub name: String,
    pub p: P,
    pub campaign: bool,
    pub st: St,
    pub calls: u8,
    pub ver: u8,
    /// scheduled_at in model seconds; `due_racy` when it was set with a positive delay.
    pub due: u32,
    pub due_racy: bool,
    pub lease: Option<u32>,
    pub attempt: Option<u32>,
    pub throttles: u8,
    pub interrupted: bool,
    /// Sent by the second owner.
    #[serde(default)]
    pub second: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Cs {
    Draft,
    Preparing,
    Scheduled,
    Sending,
    Paused,
    Done,
    Canceled,
}
impl Cs {
    fn name(self) -> &'static str {
        match self {
            Cs::Draft => "draft",
            Cs::Preparing => "preparing",
            Cs::Scheduled => "scheduled",
            Cs::Sending => "sending",
            Cs::Paused => "paused",
            Cs::Done => "done",
            Cs::Canceled => "canceled",
        }
    }
    fn running(self) -> bool {
        matches!(self, Cs::Preparing | Cs::Scheduled | Cs::Sending)
    }
    fn active(self) -> bool {
        self.running() || self == Cs::Paused
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Camp {
    pub st: Cs,
    pub total: u8,
    pub prepared: u8,
    pub expanded: u8,
    pub window: Option<u32>,
    pub window_n: u8,
    pub sched: Option<u32>,
    /// The pending campaign.run job's available_at; None when no run is pending.
    pub job: Option<u32>,
    pub job_racy: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ph {
    Off,
    Lease,
    Claim { m: usize, prep: u32, ver: u8 },
    Ses { m: usize, ver: u8 },
    Record { m: usize, out: Out, ver: u8 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inst {
    pub exists: bool,
    pub ph: Ph,
    /// Pacing gate: no send starts before this second (a throttled response brakes for 1 s).
    pub next_send: u32,
    /// This run moved a campaign row out of the queue; its end checks the campaign for completion.
    pub finishing: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cfg {
    /// Queued direct mail already counted against the pending cap (sending_stream_depth seed).
    pub seed: u32,
    /// Campaign daily cap (pace_per_day), set below the API's 100 minimum to reach it.
    pub pace: Option<u8>,
    /// Behaviour of every campaign recipient, and how many there are.
    pub campaign: P,
    pub recipients: u8,
    /// SES 24-hour quota with two dispatcher shards. These traces are checked as invariants over
    /// the real state (the reserve, no stuck mail, the temporal properties), not predicted.
    pub quota: Option<u8>,
    /// Workspaces sending into the region, and rows per runner lease. With two owners and
    /// two-row leases a lease sees exactly a lease's worth of owners, so the owner cursor lands
    /// on the last owner. Their mail all accepts, so the order across owners (the fair lease)
    /// is not modeled: only that one run sends every due row.
    pub owners: u8,
    pub drain_batch: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Model {
    pub t: u32,
    pub cfg: Cfg,
    pub mails: Vec<Mail>,
    pub camp: Camp,
    /// Idempotency keys: (key, persona of the first body, mail index).
    pub keys: Vec<(String, P, usize)>,
    pub runner_next_send: u32,
    /// A throttled response also turns off the runner's early transactional slot for 10 s.
    pub runner_brake_until: u32,
    pub d: [Inst; 2],
    pub directs: u8,
    /// Coverage tags of the last action (not part of the state).
    #[serde(skip)]
    pub cov: Vec<&'static str>,
}

fn off() -> Inst {
    Inst {
        exists: false,
        ph: Ph::Off,
        next_send: 0,
        finishing: false,
    }
}

impl Model {
    pub fn initial(cfg: Cfg) -> Model {
        let total = cfg.recipients;
        Model {
            t: 0,
            cfg,
            mails: vec![],
            camp: Camp {
                st: Cs::Draft,
                total,
                prepared: 0,
                expanded: 0,
                window: None,
                window_n: 0,
                sched: None,
                job: None,
                job_racy: false,
            },
            keys: vec![],
            runner_next_send: 0,
            runner_brake_until: 0,
            d: [off(), off()],
            directs: 0,
            cov: vec![],
        }
    }

    // ---- time ----------------------------------------------------------------------------
    /// Deadlines set with a positive delay; reading time-dependent state exactly at one is racy.
    fn racy(&self) -> bool {
        let t = self.t;
        self.mails.iter().any(|m| {
            (m.st == St::Queued && m.due_racy && m.due == t)
                || m.lease == Some(t)
                || (m.st == St::Attempting && m.attempt.map(|a| a + RECOVER) == Some(t))
        }) || (self.camp.job_racy && self.camp.job == Some(t))
            || (self.runner_brake_until > 0 && self.runner_brake_until == t)
            || self.camp.sched == Some(t)
            || self.camp.window.map(|w| w + DAY) == Some(t)
            || self
                .d
                .iter()
                .any(|i| matches!(i.ph, Ph::Claim { prep, .. } if prep + PRE_SEND == t))
    }

    fn is_due(&self, m: &Mail) -> bool {
        m.st == St::Queued && m.due <= self.t && m.lease.is_none_or(|l| l < self.t)
    }
    /// Lease order: transactional before campaign mail, then creation order.
    fn due_order(&self) -> Vec<usize> {
        let mut due: Vec<usize> = (0..self.mails.len()).filter(|&i| self.is_due(&self.mails[i])).collect();
        due.sort_by_key(|&i| (self.mails[i].campaign, i));
        due
    }

    /// Coverage of a lease's time boundaries: an expired lease taken one second late, a
    /// throttled row taken one second after its backoff, a row still held one second early.
    fn lease_boundaries(&mut self, rows: &[usize]) {
        let t = self.t;
        for &i in rows {
            let m = &self.mails[i];
            if t > 0 && m.lease == Some(t - 1) {
                self.cov.push("expired lease (+1 s) taken by another lease");
            } else if m.lease.is_some() {
                self.cov.push("expired lease taken by another lease");
            }
            if m.due_racy && m.due + 1 == t {
                self.cov.push("backoff +1 s retried");
            }
        }
        for m in &self.mails {
            if m.st == St::Queued && m.lease == Some(t + 1) {
                self.cov.push("lease -1 s still held");
            }
            if m.st == St::Queued && m.due_racy && m.due == t + 1 {
                self.cov.push("backoff -1 s still waiting");
            }
        }
    }

    // ---- provider and outcomes ----------------------------------------------------------
    fn provider(&mut self, i: usize) -> Out {
        let canceled = self.camp.st == Cs::Canceled;
        let m = &mut self.mails[i];
        m.calls += 1;
        let out = match m.p {
            P::Ok => Out::Accepted,
            P::Rej => Out::Rejected,
            P::Unk => Out::Unknown,
            P::Thr if m.calls == 1 => Out::Throttled,
            P::Thr => Out::Accepted,
        };
        if m.campaign && canceled {
            self.cov.push("in-flight send after cancel");
        }
        self.cov.push(match out {
            Out::Accepted if m.throttles > 0 => "retry after a throttle accepted",
            Out::Accepted => "provider accepted",
            Out::Rejected => "provider refused permanently",
            Out::Unknown => "provider 5xx: acceptance unknown",
            _ => "provider throttled",
        });
        out
    }

    /// One fenced result write for the claimed version. Returns whether the row left the queue.
    fn record(&mut self, i: usize, out: Out, ver: u8, at: u32) -> bool {
        let m = &mut self.mails[i];
        if m.ver != ver {
            return false;
        }
        if m.st == St::Unknown && m.interrupted {
            self.cov.push("record after the sweep");
        }
        let m = &mut self.mails[i];
        match out {
            Out::Throttled | Out::Deferred => {
                // A definitive refusal or an unsent deferral goes back to the queue, even after
                // the sweep called the attempt interrupted (that guess was wrong).
                let requeue = matches!(m.st, St::Queued | St::Attempting) || (m.st == St::Unknown && m.interrupted);
                if !requeue {
                    return false;
                }
                let reopened = m.st == St::Unknown && m.campaign;
                let late = m.st == St::Unknown;
                m.st = St::Queued;
                m.ver += 1;
                m.attempt = None;
                m.lease = None;
                m.interrupted = false;
                if out == Out::Throttled {
                    let backoff = (2u32 << m.throttles).min(60);
                    m.throttles += 1;
                    m.due = at + backoff;
                    m.due_racy = true;
                } else {
                    m.due = at;
                    m.due_racy = false;
                }
                if reopened && self.camp.st == Cs::Done {
                    self.camp.st = Cs::Sending;
                    self.cov.push("late refusal reopens a done campaign");
                }
                if late {
                    self.cov.push("late refusal requeues an interrupted attempt");
                }
                self.cov.push(if out == Out::Throttled { "throttled, requeued with backoff" } else { "deferred before the provider call" });
                false
            }
            _ => {
                let next = match out {
                    Out::Accepted => St::Accepted,
                    Out::Rejected => St::Rejected,
                    _ => St::Unknown,
                };
                if next.rank() >= m.st.rank() {
                    m.st = next;
                    m.lease = None;
                    if next != St::Unknown {
                        m.interrupted = false;
                    }
                }
                m.campaign
            }
        }
    }

    /// sending -> done once every recipient is released and none is queued or attempting.
    fn finish_campaign(&mut self) {
        if self.camp.st == Cs::Sending
            && self.camp.expanded == self.camp.total
            && !self
                .mails
                .iter()
                .any(|m| m.campaign && matches!(m.st, St::Queued | St::Attempting))
        {
            self.camp.st = Cs::Done;
        }
    }

    /// The claim: queued at the leased version, and its campaign not canceled.
    fn claim(&mut self, i: usize, ver: u8) -> Option<bool> {
        let canceled = self.camp.st == Cs::Canceled;
        let t = self.t;
        let m = &mut self.mails[i];
        if m.st != St::Queued || m.ver != ver {
            self.cov.push("claim lost to another process");
            return None; // lost: another process changed the row first
        }
        m.lease = None;
        if m.campaign && canceled {
            m.st = St::Canceled;
            self.cov.push("cancel between lease and claim");
            return Some(false);
        }
        if m.campaign && self.camp.st == Cs::Paused {
            self.cov.push("queued campaign mail dispatches while paused");
        }
        m.st = St::Attempting;
        m.attempt = Some(t);
        Some(true)
    }

    // ---- the runner process: one whole lease per drain -----------------------------------
    /// The runner's whole run (`runDispatcher` with its default 24-row lease and 6-send claims,
    /// no time budget): lease a page, claim and send it six at a time, record each group, and
    /// lease again while pages come back full. A short page ends the run.
    fn drain(&mut self) {
        if self.d.iter().any(|i| i.ph != Ph::Off) {
            self.cov.push("runner drain interleaved with a stepped process");
        }
        let (mut pages, mut finishing) = (0, false);
        loop {
            // A brake that pushes the next slot 5 s out ends the run before it leases.
            if self.runner_next_send >= self.t + PRE_SEND {
                break;
            }
            let batch = self.cfg.drain_batch as usize;
            let rows: Vec<usize> = self.due_order().into_iter().take(batch).collect();
            self.lease_boundaries(&rows);
            if rows.is_empty() {
                if pages == 0 {
                    self.cov.push("empty drain");
                }
                break;
            }
            pages += 1;
            if pages == 2 {
                self.cov.push(if self.cfg.owners > 1 { "a run with a lease's worth of owners leases past the last owner" } else { "drain leases a second page" });
            }
            for &i in &rows {
                self.mails[i].lease = Some(self.t + LEASE);
            }
            for group in rows.chunks(6) {
                // A group whose first slot is already 5 s away is released unclaimed.
                if self.runner_next_send >= self.t + PRE_SEND {
                    for &i in group {
                        self.mails[i].lease = None;
                    }
                    continue;
                }
                let prep = self.t;
                let mut claimed = vec![];
                for &i in group {
                    let ver = self.mails[i].ver;
                    if self.claim(i, ver) == Some(true) {
                        claimed.push((i, ver));
                    }
                }
                // Sends start in lease order; a throttled response holds the next send for 1 s,
                // and a send that cannot start within 5 s of its claim is deferred, not sent.
                let mut outcomes = vec![];
                let mut first_start = None;
                for (idx, (i, ver)) in claimed.into_iter().enumerate() {
                    // The first send of a turn starts at its slot; a transactional second one may
                    // take the next slot at once (unless braked), in flight before the first's response.
                    let early = idx == 1 && !self.mails[i].campaign && first_start.is_some_and(|s| self.runner_brake_until <= s);
                    let start = if early { first_start.unwrap() } else { self.t.max(self.runner_next_send) };
                    if idx == 0 {
                        first_start = Some(start);
                    }
                    if start > self.t {
                        self.cov.push("throttle brake delays the next send");
                    }
                    if start >= prep + PRE_SEND {
                        outcomes.push((i, Out::Deferred, ver, start));
                        continue;
                    }
                    self.t = self.t.max(start);
                    let out = self.provider(i);
                    if out == Out::Throttled {
                        self.runner_next_send = self.runner_next_send.max(start + 1);
                        self.runner_brake_until = start + 10;
                    }
                    outcomes.push((i, out, ver, start));
                }
                for (i, out, ver, at) in outcomes {
                    finishing |= self.record(i, out, ver, at);
                }
            }
            if rows.len() < batch {
                break;
            }
        }
        if finishing {
            self.finish_campaign();
        }
    }

    // ---- stepped processes ----------------------------------------------------------------
    fn step(&mut self, k: usize) {
        let ph = self.d[k].ph.clone();
        self.d[k].exists = true;
        if self.d[1 - k].ph != Ph::Off && ph != Ph::Off {
            self.cov.push("two processes interleave");
        }
        match ph {
            Ph::Off => {
                self.d[k].ph = Ph::Lease;
                self.d[k].finishing = false;
            }
            Ph::Lease => match self.due_order().first().copied() {
                None => {
                    self.lease_boundaries(&[]);
                    self.cov.push("lease finds nothing due");
                    // The run ends; it settles campaigns it moved rows for.
                    if self.d[k].finishing {
                        self.finish_campaign();
                    }
                    self.d[k].ph = Ph::Off;
                }
                Some(i) => {
                    self.lease_boundaries(&[i]);
                    self.mails[i].lease = Some(self.t + LEASE);
                    self.d[k].ph = Ph::Claim { m: i, prep: self.t, ver: self.mails[i].ver };
                }
            },
            Ph::Claim { m: i, prep, ver } => {
                // The claim is fenced on the version the lease read: a requeue in between wins.
                match self.claim(i, ver) {
                    Some(true) => {
                        let start = self.t.max(self.d[k].next_send);
                        if start > self.t {
                            self.cov.push("throttle brake delays the next send");
                        }
                        if self.t == prep + PRE_SEND + 1 {
                            self.cov.push("pre-send deadline +1 s");
                        }
                        if self.t + 1 == prep + PRE_SEND {
                            self.cov.push("pre-send deadline -1 s");
                        }
                        if start >= prep + PRE_SEND {
                            self.d[k].ph = Ph::Record { m: i, out: Out::Deferred, ver };
                        } else {
                            self.t = start;
                            self.d[k].ph = Ph::Ses { m: i, ver };
                        }
                    }
                    Some(false) => self.d[k].ph = Ph::Lease, // canceled by its campaign
                    None => self.d[k].ph = Ph::Lease,
                }
            }
            Ph::Ses { m: i, ver } => {
                let out = self.provider(i);
                if out == Out::Throttled {
                    self.d[k].next_send = self.t + 1;
                }
                self.d[k].ph = Ph::Record { m: i, out, ver };
            }
            Ph::Record { m: i, out, ver } => {
                let t = self.t;
                if self.record(i, out, ver, t) {
                    self.d[k].finishing = true;
                }
                self.d[k].ph = Ph::Lease;
            }
        }
    }

    // ---- the interrupted-attempt sweep ----------------------------------------------------
    fn recover(&mut self) {
        let t = self.t;
        let mut tags = vec![];
        for m in &mut self.mails {
            if m.st == St::Attempting && m.attempt.is_some_and(|a| a + RECOVER < t) {
                m.st = St::Unknown;
                m.interrupted = true;
                m.lease = None;
                tags.push(if m.attempt.map(|a| a + RECOVER + 1) == Some(t) { "sweep at attempt +3 min +1 s" } else { "sweep marks an attempt interrupted" });
            } else if m.st == St::Attempting && m.attempt.map(|a| a + RECOVER) == Some(t + 1) {
                tags.push("sweep at attempt +3 min -1 s leaves it");
            }
        }
        if tags.is_empty() {
            tags.push("sweep with nothing interrupted");
        }
        self.cov.extend(tags);
        let before = self.camp.st;
        self.finish_campaign();
        if before != self.camp.st {
            self.cov.push("sweep finishes a campaign");
        }
    }

    // ---- admission ------------------------------------------------------------------------
    /// The first owner's queued direct mail (the pending cap is per workspace).
    fn pending(&self) -> u32 {
        self.cfg.seed + self.mails.iter().filter(|m| !m.campaign && !m.second && matches!(m.st, St::Queued | St::Attempting)).count() as u32
    }
    fn admit(&mut self, p: P) -> Value {
        self.admit_as(p, false)
    }
    fn admit_as(&mut self, p: P, second: bool) -> Value {
        if !second && self.pending() + 1 > PENDING_CAP {
            self.cov.push("pending cap +1 refused");
            return json!([429, "PENDING_EMAIL_LIMIT_EXCEEDED"]);
        }
        if self.pending() + 1 == PENDING_CAP {
            self.cov.push("pending cap exactly reached");
        }
        self.directs += 1;
        let name = format!("e{}", self.directs);
        self.mails.push(Mail {
            name: name.clone(),
            p,
            campaign: false,
            st: St::Queued,
            calls: 0,
            ver: 0,
            due: self.t,
            due_racy: false,
            lease: None,
            attempt: None,
            throttles: 0,
            interrupted: false,
            second,
        });
        json!([202, name])
    }
    fn admit_key(&mut self, key: &str, p: P) -> Value {
        if let Some((_, first, i)) = self.keys.iter().find(|(k, _, _)| k == key) {
            let (same, name) = (*first == p, self.mails[*i].name.clone());
            self.cov.push(if same { "same key and body replays" } else { "same key, other body conflicts" });
            return if same { json!([202, name]) } else { json!([409, "IDEMPOTENCY_CONFLICT"]) };
        }
        let reply = self.admit(p);
        if reply[0] == 202 {
            self.keys.push((key.to_owned(), p, self.mails.len() - 1));
        } else {
            self.cov.push("refused admission releases its key");
        }
        reply
    }

    // ---- campaign controls ----------------------------------------------------------------
    fn running_state(&self) -> Cs {
        let c = &self.camp;
        if c.prepared < c.total {
            Cs::Preparing
        } else if c.sched.is_some_and(|s| s > self.t) {
            Cs::Scheduled
        } else {
            Cs::Sending
        }
    }
    fn launch(&mut self, scheduled: bool) -> Value {
        if self.camp.st != Cs::Draft {
            return json!([409, "CAMPAIGN_LOCKED"]);
        }
        let c = &mut self.camp;
        c.st = Cs::Preparing;
        c.prepared = 0;
        c.expanded = 0;
        c.window = None;
        c.window_n = 0;
        c.sched = scheduled.then_some(self.t + SCHEDULE);
        c.job = Some(self.t);
        c.job_racy = false;
        json!([202, null])
    }
    fn pause(&mut self) -> Value {
        let c = &mut self.camp;
        if !c.st.active() {
            return json!([409, "CAMPAIGN_NOT_SENDING"]);
        }
        if c.st == Cs::Paused || c.expanded >= c.total {
            return json!([409, "CAMPAIGN_NOT_PAUSABLE"]);
        }
        c.st = Cs::Paused;
        c.job = None;
        let queued = self.mails.iter().any(|m| m.campaign && m.st == St::Queued);
        self.cov.push(if queued { "pause with campaign mail queued" } else { "pause with recipients unreleased" });
        json!([200, null])
    }
    fn resume(&mut self) -> Value {
        if !self.camp.st.active() {
            return json!([409, "CAMPAIGN_NOT_SENDING"]);
        }
        if self.camp.st != Cs::Paused {
            return json!([409, "CAMPAIGN_NOT_PAUSED"]);
        }
        let next = self.running_state();
        self.cov.push(match next {
            Cs::Preparing => "resume to preparing",
            Cs::Scheduled => "resume to scheduled",
            _ => "resume to sending",
        });
        self.camp.st = next;
        if next == Cs::Scheduled {
            self.camp.job = self.camp.sched;
            self.camp.job_racy = true;
        } else {
            self.camp.job = Some(self.t);
            self.camp.job_racy = false;
        }
        json!([200, null])
    }
    fn cancel(&mut self) -> Value {
        match self.camp.st {
            Cs::Done => return json!([409, "CAMPAIGN_ALREADY_DISPATCHED"]),
            Cs::Draft => return json!([409, "CAMPAIGN_NOT_SENDING"]),
            _ => {}
        }
        let moved = self.camp.st != Cs::Canceled;
        let mut canceled = 0;
        if moved {
            canceled += (self.camp.total - self.camp.expanded) as u32;
            self.camp.st = Cs::Canceled;
            self.camp.job = None;
            for m in &mut self.mails {
                if m.campaign && m.st == St::Queued {
                    m.st = St::Canceled;
                    m.lease = None;
                    canceled += 1;
                }
            }
        }
        let in_flight = self
            .mails
            .iter()
            .filter(|m| m.campaign && matches!(m.st, St::Attempting | St::Accepted | St::Unknown))
            .count();
        if moved {
            self.cov.push(if self.mails.iter().any(|m| m.campaign && m.st == St::Attempting) { "cancel with a send in flight" } else { "cancel" });
        }
        json!([200, canceled, in_flight])
    }

    /// The campaign's run job, when it is due.
    fn jobs(&mut self) {
        if !self.camp.job.is_some_and(|at| at <= self.t) {
            if self.camp.job == Some(self.t + 1) {
                self.cov.push("run job -1 s not yet due");
            }
            return;
        }
        self.camp.job = None;
        loop {
            let t = self.t;
            match self.camp.st {
                Cs::Preparing => {
                    self.camp.prepared = self.camp.total;
                    self.camp.st = self.running_state();
                }
                Cs::Scheduled => {
                    let at = self.camp.sched.unwrap_or(t);
                    if at > t {
                        self.cov.push("run job waits for the schedule");
                        self.camp.job = Some(at);
                        self.camp.job_racy = true;
                        return;
                    }
                    self.cov.push(if t == at + 1 { "schedule +1 s releases" } else { "scheduled campaign starts" });
                    self.camp.st = Cs::Sending;
                }
                Cs::Sending => {
                    let c = &self.camp;
                    if c.expanded >= c.total {
                        return;
                    }
                    let pace = self.cfg.pace;
                    let new_window = pace.is_some() && c.window.is_none_or(|w| t >= w + DAY);
                    let window = if new_window { Some(t) } else { c.window };
                    let used = if new_window { 0 } else { c.window_n };
                    let left = pace.map_or(u8::MAX, |p| p.saturating_sub(used));
                    if left == 0 {
                        self.cov.push("daily cap holds the next release");
                        // Held until the window that started at its first release ends.
                        self.camp.job = window.map(|w| w + DAY);
                        self.camp.job_racy = true;
                        return;
                    }
                    if new_window && c.window.is_some() {
                        self.cov.push(if c.window.is_some_and(|w| t == w + DAY + 1) { "next window +1 s releases" } else { "next pacing window releases" });
                    }
                    let n = left.min(c.total - c.expanded);
                    for _ in 0..n {
                        self.camp.expanded += 1;
                        let name = format!("c{}", self.mails.iter().filter(|m| m.campaign).count() + 1);
                        self.mails.push(Mail {
                            name,
                            p: self.cfg.campaign,
                            campaign: true,
                            st: St::Queued,
                            calls: 0,
                            ver: 0,
                            due: t,
                            due_racy: false,
                            lease: None,
                            attempt: None,
                            throttles: 0,
                            interrupted: false,
                            second: false,
                        });
                    }
                    self.camp.window = window;
                    self.camp.window_n = used + n;
                    if self.camp.expanded == self.camp.total {
                        return;
                    }
                }
                _ => return,
            }
        }
    }

    // ---- actions ------------------------------------------------------------------------------
    pub fn enabled(&self, a: &str) -> bool {
        if self.cfg.quota.is_some() {
            return true; // Invariants hold in every interleaving, racy instants included.
        }
        let words: Vec<&str> = a.split(' ').collect();
        let reads_time = match words[0] {
            "wait" | "send" | "sendk" | "dupk" | "pause" | "cancel" => false,
            // A stepped process reads the clock when it leases and when its claimed send starts.
            "D1" | "D2" => words[1] == "step" && matches!(self.d[(words[0] == "D2") as usize].ph, Ph::Lease | Ph::Claim { .. }),
            _ => true,
        };
        if reads_time && self.racy() {
            return false;
        }
        match words[0] {
            "D1" | "D2" => {
                let k = (words[0] == "D2") as usize;
                // A stepped process steps from any point; a crash needs a live process.
                words[1] == "step" || self.d[k].ph != Ph::Off
            }
            _ => true,
        }
    }

    /// Apply `a`; return the action's own result (`r` in the observation).
    pub fn step_action(&mut self, a: &str) -> Value {
        self.cov.clear();
        let words: Vec<&str> = a.split(' ').collect();
        if self.cfg.quota.is_some() {
            // Only the clock is modeled; the host checks the properties on the real state.
            match words[0] {
                "wait" => self.t += parse_wait(words[1]),
                "settle" => self.t += 7 * (DAY + 60),
                _ => {}
            }
            return Value::Null;
        }
        let mut r = Value::Null;
        match words[0] {
            "wait" => self.t += parse_wait(words[1]),
            "send" => r = json!([self.admit(P::parse(words[1]).unwrap())]),
            "send2" => r = json!([self.admit_as(P::parse(words[1]).unwrap(), true)]),
            "sendk" => r = json!([self.admit_key(words[1], P::parse(words[2]).unwrap())]),
            "dupk" => {
                // Two concurrent requests with one key: one admits, the other replays it.
                let p = P::parse(words[2]).unwrap();
                let first = self.admit_key(words[1], p);
                let second = self.admit_key(words[1], p);
                self.cov.push("two concurrent sends with one key");
                r = json!([first, second]);
            }
            "launch" => r = self.launch(false),
            "schedule" => r = self.launch(true),
            "pause" => r = self.pause(),
            "resume" => r = self.resume(),
            "cancel" => r = self.cancel(),
            "jobs" => self.jobs(),
            "drain" => self.drain(),
            "recover" => self.recover(),
            "D1" | "D2" => {
                let k = (words[0] == "D2") as usize;
                if words[1] == "step" {
                    self.step(k);
                } else {
                    self.cov.push(match self.d[k].ph {
                        Ph::Lease => "crash before a lease",
                        Ph::Claim { .. } => "crash after a lease, before the claim",
                        Ph::Ses { .. } => "crash after the claim, before the provider call",
                        Ph::Record { out: Out::Accepted, .. } => "crash after the provider accepted",
                        Ph::Record { .. } => "crash before recording an outcome",
                        Ph::Off => "crash",
                    });
                    self.d[k] = Inst {
                        exists: true,
                        ..off()
                    };
                }
            }
            _ => panic!("unknown action {a}"),
        }
        r
    }

    pub fn expected(&self, r: Value) -> Value {
        if self.cfg.quota.is_some() {
            return json!({"safety": [], "temporal": []});
        }
        let mut mail = serde_json::Map::new();
        for m in &self.mails {
            mail.insert(m.name.clone(), json!([m.st.name(), m.calls]));
        }
        let mut d = serde_json::Map::new();
        for (k, inst) in self.d.iter().enumerate() {
            if !inst.exists {
                continue;
            }
            let name = |i: &usize| self.mails[*i].name.clone();
            let ph = match &inst.ph {
                Ph::Off => "off".to_owned(),
                Ph::Lease => "lease".to_owned(),
                Ph::Claim { m, .. } => format!("claim {}", name(m)),
                Ph::Ses { m, .. } => format!("ses {}", name(m)),
                Ph::Record { m, .. } => format!("record {}", name(m)),
            };
            d.insert(format!("D{}", k + 1), json!(ph));
        }
        let c = &self.camp;
        json!({
            "r": r, "mail": mail, "d": d, "safety": [], "temporal": [],
            "campaign": [c.st.name(), c.expanded, c.window_n],
        })
    }
}

fn parse_wait(w: &str) -> u32 {
    match w {
        "1m" => 60,
        "1d" => DAY,
        other => other.trim_end_matches('s').parse().unwrap_or(1),
    }
}

/// Action alphabets. Profiles keep breadth-first maps small; random walks use `all`.
pub fn alphabet(profile: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["wait 1s".into(), "wait 1m".into()];
    let dispatch = ["send ok", "send thr", "send rej", "send unk", "D1 step", "D1 crash", "D2 step", "D2 crash", "recover", "drain", "wait 4s", "wait 59s"];
    let campaign = ["launch", "schedule", "pause", "resume", "cancel", "jobs", "drain", "D1 step", "D1 crash", "recover", "wait 59s", "wait 1d"];
    let admission = ["send ok", "sendk k1 ok", "sendk k1 rej", "dupk k2 ok", "drain"];
    let owners = ["send ok", "send2 ok", "drain", "recover"];
    let quota = ["send ok", "send unk", "launch", "jobs", "D1 step", "D2 step", "D1 crash", "D2 crash", "recover", "wait 1m", "wait 1d", "settle", "ses pause", "ses resume"];
    let pick: Vec<&str> = match profile {
        "quota" => quota.to_vec(),
        "owners" => owners.to_vec(),
        "dispatch" => dispatch.to_vec(),
        "campaign" => campaign.to_vec(),
        "admission" => admission.to_vec(),
        _ => dispatch.iter().chain(&campaign).chain(&admission).copied().collect(),
    };
    for x in pick {
        if !a.iter().any(|y| y == x) {
            a.push(x.into());
        }
    }
    a
}
