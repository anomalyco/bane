//! SMTP submission: an independent model of up to three concurrent sessions on one inbox,
//! checked against the real `mailgw_core::smtp::Smtp` over the gateway's two submitters:
//! the Memory `Sink` (fixture mode: caps in the gateway, copies filed to Sent without Bcc)
//! and the Remote `Store` (production: the signed internal `submit` RPC, caps and the
//! per-day send ledger in the API, here the fake).
//!
//! Spec, from RFC 5321/4954/2920 and the gateway README:
//! - EHLO before anything but NOOP/QUIT; AUTH once; MAIL/RCPT/DATA need AUTH; one MAIL per
//!   transaction; EHLO and RSET reset the transaction, a finished DATA does too.
//! - The envelope sender and the single header From (and a Sender, if any) must be addresses
//!   the inbox owns, case-insensitively; aliases share the inbox's caps.
//! - At most 50 RCPTs (the 51st gets 452); recipients must be ASCII with an '@'.
//! - A message to n recipients is accepted iff the inbox's UTC-day and UTC-month usage plus n
//!   stay within the caps; a refused message counts nothing and files nothing. A clock that
//!   steps back never reopens a cap window.
//! - Pipelined commands (one write) get one reply each, in order, exactly as sent one by one.
//! - DATA is dot-transparent; more than 16 MiB gets 552 at the final dot.
use crate::{
    fake_api::{self, Fake},
    remote::{Api, Login, Store},
    walk_weighted,
};
use chrono::{DateTime, Datelike, FixedOffset};
use mailgw_core::{
    session::{Account, Action, Identity, Reply},
    smtp::{Caps, Sink, Smtp},
    store::{MailStore, Memory},
    wire::{Event, Frame},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use statecheck::{Error, Host, R};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Instant,
};

const SESSIONS: [&str; 3] = ["A", "B", "C"];
const DAILY: u32 = 3;
const MONTHLY: u32 = 5;
const START: &str = "2026-11-30T23:59:58Z";
const OWN: &str = "tear@example.invalid";
const ALIAS: &str = "Alias@Example.Invalid";
const PASSWORD: &str = "fixture-secret-a";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Body {
    Own,
    Alias,
    Foreign,
    TwoFrom,
    ForeignSender,
    Dots,
    Big,
}
const BODIES: [(&str, Body); 7] = [
    ("own", Body::Own),
    ("alias", Body::Alias),
    ("foreign", Body::Foreign),
    ("two-from", Body::TwoFrom),
    ("foreign-sender", Body::ForeignSender),
    ("dots", Body::Dots),
    ("big", Body::Big),
];

#[derive(Clone, Copy, PartialEq, Debug)]
enum Act {
    Ehlo(usize),
    Auth(usize, bool),
    AuthLogin(usize),
    Mail(usize, u8),
    Rcpt(usize, bool),
    RcptMany(usize),
    Data(usize),
    Body(usize, Body),
    Rset(usize),
    Noop(usize),
    Quit(usize),
    Pipeline(usize),
    Reconnect(usize),
    Tick,
    Skew,
}
const MAILS: [&str; 4] = ["own", "alias", "foreign", "param"];

fn parse(label: &str) -> Option<Act> {
    let w: Vec<&str> = label.split(' ').collect();
    match w.as_slice() {
        ["tick"] => return Some(Act::Tick),
        ["skew"] => return Some(Act::Skew),
        _ => {}
    }
    let first = *w.first()?;
    let s = SESSIONS.iter().position(|x| *x == first)?;
    Some(match &w[1..] {
        ["ehlo"] => Act::Ehlo(s),
        ["auth"] => Act::Auth(s, true),
        ["auth-bad"] => Act::Auth(s, false),
        ["auth-login"] => Act::AuthLogin(s),
        ["mail", m] => Act::Mail(s, MAILS.iter().position(|x| x == m)? as u8),
        ["rcpt"] => Act::Rcpt(s, true),
        ["rcpt-bad"] => Act::Rcpt(s, false),
        ["rcpt-48"] => Act::RcptMany(s),
        ["data"] => Act::Data(s),
        ["body", b] => Act::Body(s, BODIES.iter().find(|x| x.0 == *b)?.1),
        ["rset"] => Act::Rset(s),
        ["noop"] => Act::Noop(s),
        ["quit"] => Act::Quit(s),
        ["pipeline"] => Act::Pipeline(s),
        ["reconnect"] => Act::Reconnect(s),
        _ => return None,
    })
}

fn alphabet(sessions: usize) -> Vec<String> {
    let mut out = vec!["tick".to_owned(), "skew".to_owned()];
    for s in &SESSIONS[..sessions] {
        for v in [
            "ehlo",
            "auth",
            "auth-bad",
            "auth-login",
            "rcpt",
            "rcpt-bad",
            "rcpt-48",
            "data",
            "rset",
            "noop",
            "quit",
            "pipeline",
            "reconnect",
        ] {
            out.push(format!("{s} {v}"));
        }
        for m in MAILS {
            out.push(format!("{s} mail {m}"));
        }
        for (b, _) in BODIES {
            out.push(format!("{s} body {b}"));
        }
    }
    out
}

/// Weights favor the step that advances a session's transaction, so walks reach DATA, the
/// caps and the 50-recipient bound instead of mostly sequence errors.
fn weight(m: &Model, a: Act) -> u64 {
    if let Some(s) = session(a) {
        let x = &m.sessions[s];
        let next = match a {
            Act::Ehlo(_) => !x.ehlo,
            Act::Auth(_, true) => x.ehlo && !x.authed,
            Act::Mail(_, 0 | 1) | Act::Pipeline(_) => x.authed && !x.from,
            Act::Rcpt(_, true) => x.from && x.rcpt < 3,
            Act::Data(_) => x.rcpt > 0,
            Act::Body(_, b) => b != Body::Big,
            _ => false,
        };
        if next {
            return 60;
        }
    }
    match a {
        Act::Body(_, Body::Big) | Act::Quit(_) | Act::AuthLogin(_) => 1,
        Act::Skew | Act::RcptMany(_) | Act::Auth(_, false) | Act::Reconnect(_) => 2,
        Act::Tick => 3,
        _ => 10,
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug, Default)]
struct Session {
    up: bool,
    ehlo: bool,
    authed: bool,
    from: bool,
    rcpt: u32,
    data: bool,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
struct Model {
    remote: bool,
    sessions: Vec<Session>,
    clock: i64,
    /// Accepted recipients per UTC day (days since the epoch).
    ledger: BTreeMap<i64, u32>,
    /// Memory sink: its current day and month windows never move backwards.
    window: (i64, i32),
    filed: Vec<(bool, bool)>,
}

fn time(offset: i64) -> DateTime<FixedOffset> {
    let start: DateTime<FixedOffset> = START.parse().unwrap_or_default();
    start + chrono::Duration::seconds(offset)
}
fn day_month(offset: i64) -> (i64, i32) {
    let t = time(offset).to_utc();
    (
        t.timestamp().div_euclid(86400),
        t.year() * 12 + t.month0() as i32,
    )
}
fn month_of_day(day: i64) -> i32 {
    let t = DateTime::from_timestamp(day * 86400, 0).unwrap_or_default();
    t.year() * 12 + t.month0() as i32
}

impl Model {
    fn initial(remote: bool, sessions: usize) -> Self {
        let mut m = Self {
            remote,
            sessions: vec![Session::default(); sessions],
            clock: 0,
            ledger: BTreeMap::new(),
            window: day_month(0),
            filed: vec![],
        };
        for s in &mut m.sessions {
            s.up = true;
        }
        m
    }
    fn enabled(&self, a: Act) -> bool {
        let Some(s) = session(a) else { return true };
        let x = &self.sessions[s];
        match a {
            Act::Reconnect(_) => !x.up,
            Act::Body(..) => x.up && x.data,
            _ => x.up && !x.data,
        }
    }
    /// Usage the cap check sees: (day, month).
    fn usage(&self) -> (u32, u32) {
        let (day, month) = day_month(self.clock);
        if self.remote {
            // The API's per-day ledger: today, and every day from this month's start on.
            let d = self.ledger.get(&day).copied().unwrap_or(0);
            let m = self
                .ledger
                .iter()
                .filter(|(k, _)| **k >= first_day(month))
                .map(|e| e.1)
                .sum();
            (d, m)
        } else {
            // The sink's windows: the latest day and month it has seen.
            let (wd, wm) = (self.window.0.max(day), self.window.1.max(month));
            let d = self.ledger.get(&wd).copied().unwrap_or(0);
            let m = self
                .ledger
                .iter()
                .filter(|(k, _)| month_of_day(**k) == wm)
                .map(|e| e.1)
                .sum();
            (d, m)
        }
    }
    fn submit(&mut self, s: usize, body: Body) -> u16 {
        let n = self.sessions[s].rcpt;
        let x = &mut self.sessions[s];
        x.from = false;
        x.rcpt = 0;
        x.data = false;
        if body == Body::Big {
            return 552;
        }
        if matches!(body, Body::Foreign | Body::TwoFrom | Body::ForeignSender) {
            return 553;
        }
        let (d, m) = self.usage();
        if d + n > DAILY || m + n > MONTHLY {
            return 451;
        }
        let (day, month) = day_month(self.clock);
        let key = if self.remote {
            day
        } else {
            self.window = (self.window.0.max(day), self.window.1.max(month));
            self.window.0
        };
        *self.ledger.entry(key).or_default() += n;
        // Memory files a copy without Bcc; Remote passes the submission through unchanged.
        self.filed.push((self.remote, body == Body::Dots));
        250
    }
    fn mail(&mut self, s: usize, which: u8) -> u16 {
        let x = &mut self.sessions[s];
        if !x.ehlo {
            return 503;
        }
        if !x.authed {
            return 530;
        }
        if x.from {
            return 503;
        }
        match which {
            3 => 555,
            2 => 553,
            _ => {
                x.from = true;
                250
            }
        }
    }
    fn rcpt(&mut self, s: usize, ok: bool) -> u16 {
        let x = &mut self.sessions[s];
        if !x.ehlo {
            return 503;
        }
        if !x.authed {
            return 530;
        }
        if !x.from {
            return 503;
        }
        if x.rcpt >= 50 {
            return 452;
        }
        if !ok {
            return 553;
        }
        x.rcpt += 1;
        250
    }
    fn data(&mut self, s: usize) -> u16 {
        let x = &mut self.sessions[s];
        if !x.ehlo {
            return 503;
        }
        if !x.authed {
            return 530;
        }
        if x.rcpt == 0 {
            return 503;
        }
        x.data = true;
        354
    }
    fn step(&mut self, a: Act) -> Vec<u16> {
        match a {
            Act::Tick => {
                self.clock += 1;
                vec![]
            }
            Act::Skew => {
                self.clock -= 1;
                vec![]
            }
            Act::Reconnect(s) => {
                self.sessions[s] = Session {
                    up: true,
                    ..Session::default()
                };
                vec![220]
            }
            Act::Ehlo(s) => {
                let x = &mut self.sessions[s];
                x.ehlo = true;
                x.from = false;
                x.rcpt = 0;
                vec![250]
            }
            Act::Auth(s, good) => {
                let x = &mut self.sessions[s];
                if !x.ehlo || x.authed {
                    return vec![503];
                }
                x.authed = good;
                vec![if good { 235 } else { 535 }]
            }
            Act::AuthLogin(s) => {
                let x = &mut self.sessions[s];
                if !x.ehlo || x.authed {
                    // "AUTH LOGIN" refused; the two base64 lines are then bad commands.
                    return vec![503, 500, 500];
                }
                x.authed = true;
                vec![334, 334, 235]
            }
            Act::Mail(s, m) => vec![self.mail(s, m)],
            Act::Rcpt(s, ok) => vec![self.rcpt(s, ok)],
            Act::RcptMany(s) => (0..48).map(|_| self.rcpt(s, true)).collect(),
            Act::Data(s) => vec![self.data(s)],
            Act::Body(s, b) => vec![self.submit(s, b)],
            Act::Rset(s) => {
                let x = &mut self.sessions[s];
                if !x.ehlo {
                    return vec![503];
                }
                x.from = false;
                x.rcpt = 0;
                vec![250]
            }
            Act::Noop(_) => vec![250],
            Act::Quit(s) => {
                self.sessions[s] = Session::default();
                vec![221]
            }
            Act::Pipeline(s) => vec![self.mail(s, 0), self.rcpt(s, true), self.data(s)],
        }
    }
    fn expected(&self, codes: &[u16]) -> Value {
        json!({"codes": codes, "up": self.sessions.iter().map(|s| s.up).collect::<Vec<_>>(), "filed": self.filed})
    }
}
fn first_day(month: i32) -> i64 {
    let (y, m) = (month.div_euclid(12), month.rem_euclid(12) as u32 + 1);
    chrono::NaiveDate::from_ymd_opt(y, m, 1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map_or(0, |d| d.and_utc().timestamp().div_euclid(86400))
}
fn session(a: Act) -> Option<usize> {
    use Act::*;
    match a {
        Ehlo(s)
        | Auth(s, _)
        | AuthLogin(s)
        | Mail(s, _)
        | Rcpt(s, _)
        | RcptMany(s)
        | Data(s)
        | Body(s, _)
        | Rset(s)
        | Noop(s)
        | Quit(s)
        | Pipeline(s)
        | Reconnect(s) => Some(s),
        Tick | Skew => None,
    }
}

// ---------------- fixture ----------------

struct Conn {
    smtp: Smtp,
    login: Option<Login>,
    store: Option<Store>,
}
enum Back {
    Memory {
        store: Memory,
        caps: Caps,
        account: Account,
    },
    Remote {
        api: Arc<Api>,
    },
}
struct Fixture {
    back: Back,
    conns: Vec<Option<Conn>>,
    clock: i64,
}

fn body(b: Body, serial: usize) -> Vec<u8> {
    let from = match b {
        Body::Alias => ALIAS.to_owned(),
        Body::Foreign => "mallory@example.invalid".into(),
        _ => OWN.into(),
    };
    let mut h = format!(
        "From: Tear <{from}>\r\nTo: r@example.invalid\r\nBcc: hidden@example.invalid,\r\n other@example.invalid\r\nSubject: s{serial}\r\nMessage-ID: <s{serial}@example.invalid>\r\n"
    );
    match b {
        Body::TwoFrom => h.push_str(&format!("From: {OWN}\r\n")),
        Body::ForeignSender => h.push_str("Sender: mallory@example.invalid\r\n"),
        _ => {}
    }
    h.push_str("\r\n");
    if b == Body::Dots {
        // Dot-stuffed on the wire: the stored message has single leading dots.
        h.push_str("..leading dot\r\n...\r\n");
    } else {
        h.push_str("body\r\n");
    }
    if b == Body::Big {
        let line = "x".repeat(998) + "\r\n";
        while h.len() <= mailgw_core::smtp::MAX_SIZE {
            h.push_str(&line);
        }
    }
    h.into_bytes()
}

impl Fixture {
    fn open(remote: bool, sessions: usize) -> R<Self> {
        let back = if remote {
            let mut fake = Fake::new(&[("kid_0", PASSWORD)]);
            fake.daily = DAILY;
            fake.monthly = MONTHLY;
            fake.now = time(0);
            fake_api::install(fake);
            let api = Api::new(fake_api::url(), fake_api::KEY.into())
                .map_err(|e| Error::new(e.to_string()))?;
            api.online.store(true, std::sync::atomic::Ordering::Release);
            Back::Remote { api: Arc::new(api) }
        } else {
            Back::Memory {
                store: Memory::default(),
                caps: Caps::new(DAILY, MONTHLY),
                account: Account::new(
                    "mbx_tear".into(),
                    vec![OWN.into(), ALIAS.to_lowercase()],
                    PASSWORD.into(),
                    true,
                ),
            }
        };
        let mut f = Self {
            back,
            conns: (0..sessions).map(|_| None).collect(),
            clock: 0,
        };
        for s in 0..sessions {
            f.connect(s);
        }
        Ok(f)
    }
    fn connect(&mut self, s: usize) {
        let login = match &self.back {
            Back::Remote { api } => Some(Login {
                api: api.clone(),
                principal: Mutex::new(None),
                unavailable: false.into(),
                limits: Arc::default(),
                ip: std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            }),
            Back::Memory { .. } => None,
        };
        self.conns[s] = Some(Conn {
            smtp: Smtp::new(true),
            login,
            store: None,
        });
    }
    /// One line through the core, as the shell steps it (DATA lines included).
    fn line(&mut self, s: usize, bytes: &[u8]) -> Reply {
        let now = time(self.clock);
        let Some(conn) = self.conns[s].as_mut() else {
            return Reply::default();
        };
        let r = match &mut self.back {
            Back::Memory {
                store,
                caps,
                account,
            } => conn
                .smtp
                .step(bytes, account, &mut Sink { store, caps }, now),
            Back::Remote { api } => {
                fake_api::with(|f| f.now = now);
                let identity: &dyn Identity = conn
                    .login
                    .as_ref()
                    .map_or(&NoIdentity as &dyn Identity, |l| l as &dyn Identity);
                match conn.store.as_mut() {
                    Some(store) => conn.smtp.step(bytes, identity, store, now),
                    None => conn
                        .smtp
                        .step(bytes, identity, &mut crate::remote::Offline, now),
                }
                .tap(|r| {
                    if r.action == Action::Login
                        && let Some(l) = conn.login.as_ref()
                        && let Some(p) = l.principal.lock().ok().and_then(|p| p.clone())
                    {
                        conn.store = Store::new(api.clone(), p).ok();
                    }
                })
            }
        };
        if r.action == Action::Close {
            self.conns[s] = None;
        }
        r
    }
    /// Frame a write exactly like the shell (SMTP mode), stepping each complete line.
    fn write(&mut self, s: usize, bytes: &[u8]) -> Vec<u16> {
        let mut frame = Frame::default();
        let mut src = bytes;
        let mut codes = vec![];
        while !src.is_empty() {
            let Ok(event) = frame.consume(&mut src, false, false) else {
                codes.push(0);
                break;
            };
            let Event::Complete(line) = event else { break };
            let r = self.line(s, &line);
            if let Some(code) = std::str::from_utf8(&r.bytes)
                .ok()
                .and_then(|t| t.trim_end().rsplit("\r\n").next()?.get(..3)?.parse().ok())
            {
                codes.push(code);
            }
        }
        codes
    }
    fn act(&mut self, label: &str, serial: usize) -> R<Value> {
        let a = parse(label).ok_or_else(|| Error::new(format!("unknown action {label}")))?;
        let b64 = |x: &str| {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(x)
        };
        let codes = match a {
            Act::Tick => {
                self.clock += 1;
                vec![]
            }
            Act::Skew => {
                self.clock -= 1;
                vec![]
            }
            Act::Reconnect(s) => {
                self.connect(s);
                vec![220]
            }
            Act::Ehlo(s) => self.write(s, b"EHLO client.example.invalid\r\n"),
            Act::Auth(s, good) => {
                let pw = if good { PASSWORD } else { "wrong" };
                let line = format!("AUTH PLAIN {}\r\n", b64(&format!("\0{OWN}\0{pw}")));
                self.write(s, line.as_bytes())
            }
            Act::AuthLogin(s) => {
                let mut c = self.write(s, b"AUTH LOGIN\r\n");
                c.extend(self.write(s, format!("{}\r\n", b64(ALIAS)).as_bytes()));
                c.extend(self.write(s, format!("{}\r\n", b64(PASSWORD)).as_bytes()));
                c
            }
            Act::Mail(s, m) => {
                let line = match m {
                    0 => format!("MAIL FROM:<{OWN}>\r\n"),
                    1 => format!("MAIL FROM:<{ALIAS}> BODY=8BITMIME\r\n"),
                    2 => "MAIL FROM:<mallory@example.invalid>\r\n".into(),
                    _ => format!("MAIL FROM:<{OWN}> RET=HDRS\r\n"),
                };
                self.write(s, line.as_bytes())
            }
            Act::Rcpt(s, ok) => {
                // RFC 5321 accepts a bare <postmaster>; the gateway wants a full address.
                let line = if ok {
                    "RCPT TO:<r@example.invalid>\r\n"
                } else {
                    "RCPT TO:<postmaster>\r\n"
                };
                self.write(s, line.as_bytes())
            }
            Act::RcptMany(s) => {
                let all: String = (0..48)
                    .map(|i| format!("RCPT TO:<r{i}@example.invalid>\r\n"))
                    .collect();
                self.write(s, all.as_bytes())
            }
            Act::Data(s) => self.write(s, b"DATA\r\n"),
            Act::Body(s, b) => {
                let mut raw = body(b, serial);
                raw.extend(b".\r\n");
                self.write(s, &raw)
            }
            Act::Rset(s) => self.write(s, b"RSET\r\n"),
            Act::Noop(s) => self.write(s, b"NOOP\r\n"),
            Act::Quit(s) => self.write(s, b"QUIT\r\n"),
            Act::Pipeline(s) => {
                let line = format!("MAIL FROM:<{OWN}>\r\nRCPT TO:<p@example.invalid>\r\nDATA\r\n");
                self.write(s, line.as_bytes())
            }
        };
        Ok(
            json!({"codes": codes, "up": self.conns.iter().map(Option::is_some).collect::<Vec<_>>(), "filed": self.filed()}),
        )
    }
    /// What the inbox kept: (raw passed through unchanged, dot-transparent body), per message.
    fn filed(&self) -> Vec<(bool, bool)> {
        let raws: Vec<Vec<u8>> = match &self.back {
            Back::Memory { store, .. } => store
                .folder("Sent")
                .map(|f| f.entries.iter().map(|e| e.raw.to_vec()).collect())
                .unwrap_or_default(),
            Back::Remote { .. } => {
                fake_api::with(|f| f.submitted.iter().map(|x| x.2.clone()).collect())
                    .unwrap_or_default()
            }
        };
        raws.iter()
            .map(|r| {
                let text = String::from_utf8_lossy(r);
                let head = text
                    .split("\r\n\r\n")
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let bcc = head.contains("\r\nbcc:") || head.starts_with("bcc:");
                (bcc, text.contains("\r\n.leading dot\r\n..\r\n"))
            })
            .collect()
    }
}

struct NoIdentity;
impl Identity for NoIdentity {
    fn owns(&self, _: &str) -> bool {
        false
    }
    fn login(&self, _: mailgw_core::session::Protocol, _: &[u8], _: &[u8]) -> bool {
        false
    }
}
trait Tap: Sized {
    fn tap(self, f: impl FnOnce(&Self)) -> Self {
        f(&self);
        self
    }
}
impl Tap for Reply {}

struct Check {
    remote: bool,
    sessions: usize,
    fixture: Option<Fixture>,
    serial: usize,
    coverage: BTreeMap<String, u64>,
}
impl Host for Check {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        let model = |v: &Value| {
            serde_json::from_value::<Model>(v.clone()).map_err(|e| Error::new(e.to_string()))
        };
        let act = |v: &Value| {
            v.as_str()
                .and_then(parse)
                .ok_or_else(|| Error::new(format!("unknown action {v}")))
        };
        Ok(match name {
            "id" => json!(if self.remote {
                "bane.smtp.remote-submission"
            } else {
                "bane.smtp.memory-submission"
            }),
            "initial" => json!(Model::initial(self.remote, self.sessions)),
            "enabled" => json!(model(&args[0])?.enabled(act(&args[1])?)),
            "step" => {
                let mut m = model(&args[0])?;
                let a = act(&args[1])?;
                let codes = m.step(a);
                for c in &codes {
                    *self.coverage.entry(format!("smtp:{c}")).or_default() += 1;
                }
                if matches!(a, Act::Skew) {
                    *self.coverage.entry("smtp:clock-back".into()).or_default() += 1;
                }
                json!({"expected": m.expected(&codes), "state": m})
            }
            "open" => {
                self.fixture = Some(Fixture::open(self.remote, self.sessions)?);
                self.serial = 0;
                Value::Null
            }
            "act" => {
                self.serial += 1;
                let serial = self.serial;
                self.fixture
                    .as_mut()
                    .ok_or_else(|| Error::new("no open fixture"))?
                    .act(args[1].as_str().unwrap_or_default(), serial)?
            }
            "close" => {
                if self.remote {
                    fake_api::abort_connections();
                }
                self.fixture = None;
                Value::Null
            }
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

pub fn run(remote: bool, n: u64, len: usize, seed: u64, deadline: Option<Instant>) -> R<Value> {
    let sessions = 3;
    let labels = alphabet(sessions);
    let traces = (0..n).map(move |i| {
        let mut m = Model::initial(remote, sessions);
        walk_weighted(
            seed.wrapping_mul(0x1000_0000).wrapping_add(i),
            len,
            &labels,
            &mut m,
            |m, l| parse(l).filter(|a| m.enabled(*a)).map(|a| weight(m, a)),
            |m, l| {
                if let Some(a) = parse(l) {
                    m.step(a);
                }
            },
        )
    });
    let mut host = Check {
        remote,
        sessions,
        fixture: None,
        serial: 0,
        coverage: BTreeMap::new(),
    };
    let name = format!(
        "smtp submission, {}, 3 sessions",
        if remote { "Remote" } else { "Memory" }
    );
    let mut r = crate::campaign(&name, traces, &mut host, deadline)?;
    r["coverage"] = json!(host.coverage);
    Ok(r)
}

/// Replay (and, on a mismatch, reduce) one SMTP trace.
pub fn replay(remote: bool, actions: &[String]) -> R<Value> {
    let mut host = Check {
        remote,
        sessions: 3,
        fixture: None,
        serial: 0,
        coverage: BTreeMap::new(),
    };
    let run =
        statecheck::conformance::dispatch("runTrace", &json!({"actions": actions}), &mut host)?;
    let path = run["mismatch"]["path"].as_str().unwrap_or_default();
    let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
    let mut out = json!({"status": run["status"], "mismatch": run["mismatch"], "error": run["error"],
        "failingStep": if path.is_empty() { Value::Null } else { crate::focus(&run["steps"][at], path) }});
    if run["status"] == "mismatch" {
        let reduced = statecheck::conformance::dispatch(
            "minimizeTrace",
            &json!({"actions": actions, "options": {"maxReplays": 4000}}),
            &mut host,
        )?;
        out["reduced"] = reduced["actions"].clone();
        out["length"] = json!(reduced["actions"].as_array().map_or(0, Vec::len));
    }
    out["coverage"] = json!(host.coverage);
    Ok(out)
}
