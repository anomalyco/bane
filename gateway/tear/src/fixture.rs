//! Product fixture: real `mailgw_core::imap::Imap` sessions, driven in-process with protocol
//! bytes, over either the real `store::Memory` (the gateway's fixture mode) or the real
//! `remote::Store` (production) talking signed HTTP to the fake internal API. For the Remote
//! store the fixture uses the gateway shell's own seams (`Store::imap`, `Store::wake`,
//! `Api::notified`, `Hints`), so stale-snapshot refreshes, wake-cache reloads and BYE on a
//! credential change run the shipping code. Each client keeps the mirror a real IMAP client
//! would build. Store invariants (UIDNEXT, MODSEQ, UIDVALIDITY, no resurrection, strict UID
//! order in every Remote session snapshot) are checked after every step.
use crate::{
    client::{Client, Kind},
    fake_api::{self, Fake},
    hints::{Generation, Hints},
    model::{Act, Backend, Config, FLAG_NAMES, FOLDERS, Flags, SERVER, SESSIONS, Set, parse},
    remote::{Api, Login, Store},
};
use mailgw_core::{
    imap::Imap,
    session::{Account, Action, Reply},
    store::{Change, Date, MailStore, Memory, Origin},
};
use serde_json::{Value, json};
use statecheck::{Error, R};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, watch};

#[derive(Clone)]
struct Snap {
    validity: u32,
    next: u32,
    highest: u64,
    entries: BTreeMap<u32, (u64, Flags)>,
}

struct RemoteConn {
    store: Store,
    login: Login,
    stale: bool,
    rx: watch::Receiver<Generation>,
    _sender: Arc<watch::Sender<Generation>>,
    generation: u64,
}
struct Conn {
    imap: Imap,
    idle: bool,
    remote: Option<RemoteConn>,
    /// An APPEND literal being spooled: (folder, upload, message bytes).
    spooling: Option<(String, crate::upload::Upload, Vec<u8>)>,
}
enum Back {
    Memory {
        store: Memory,
        account: Account,
    },
    Remote {
        apis: Vec<Arc<Api>>,
        hints: Vec<Hints>,
        /// The process-wide upload pool of each gateway process.
        uploads: Vec<Arc<Semaphore>>,
    },
}

pub struct Fixture {
    cfg: Config,
    clients: Vec<Client>,
    conns: Vec<Option<Conn>>,
    back: Back,
    now: Date,
    serial: u32,
    safety: Vec<String>,
    prev: BTreeMap<String, Snap>,
    removed: BTreeSet<(String, u32, u32)>,
    retired: BTreeMap<String, BTreeSet<u32>>,
}

const PASSWORDS: [&str; 4] = [
    "fixture-secret-a",
    "fixture-secret-b",
    "fixture-secret-c",
    "fixture-secret-d",
];

fn message(n: u32) -> Vec<u8> {
    format!(
        "From: a@example.invalid\r\nTo: tear@example.invalid\r\nSubject: m{n}\r\nMessage-ID: <m{n}@example.invalid>\r\n\r\nbody {n}\r\n"
    )
    .into_bytes()
}

impl Fixture {
    pub fn open(cfg: Config) -> R<Self> {
        let back = match cfg.backend {
            Backend::Memory => Back::Memory {
                store: Memory::default(),
                account: Account::new(
                    "mbx_tear".into(),
                    vec!["tear@example.invalid".into()],
                    PASSWORDS[0].into(),
                    true,
                ),
            },
            Backend::Remote => {
                let kids: Vec<(String, &str)> =
                    (0..4).map(|i| (format!("kid_{i}"), PASSWORDS[i])).collect();
                let kids: Vec<(&str, &str)> = kids.iter().map(|(k, p)| (k.as_str(), *p)).collect();
                let mut fake = Fake::new(&kids);
                if cfg.bulk {
                    // 1,000-message folders: page by 256 rather than 2.
                    fake.page = 256;
                }
                fake_api::install(fake);
                let url = fake_api::url();
                let apis = (0..2)
                    .map(|_| {
                        let api = Api::new(url.clone(), fake_api::KEY.into())
                            .map_err(|e| Error::new(format!("api: {e}")))?;
                        api.online.store(true, std::sync::atomic::Ordering::Release);
                        Ok(Arc::new(api))
                    })
                    .collect::<R<Vec<_>>>()?;
                Back::Remote {
                    apis,
                    hints: vec![Hints::default(), Hints::default()],
                    uploads: (0..2).map(|_| Arc::new(Semaphore::new(8))).collect(),
                }
            }
        };
        let mut f = Self {
            cfg,
            clients: SESSIONS[..cfg.sessions]
                .iter()
                .map(|n| Client::new(n))
                .collect(),
            conns: (0..cfg.sessions).map(|_| None).collect(),
            back,
            now: "2026-11-11T12:00:00Z".parse().unwrap_or_default(),
            serial: 0,
            safety: vec![],
            prev: BTreeMap::new(),
            removed: BTreeSet::new(),
            retired: BTreeMap::new(),
        };
        for s in 0..cfg.sessions {
            if !f.connect(s) || !f.select(s, "INBOX", false) {
                let calls = fake_api::with(|x| x.calls.clone());
                return Err(Error::new(format!(
                    "fixture login/select failed for {}: last {:?}, safety {:?}, API calls {calls:?}",
                    SESSIONS[s], f.clients[s].last, f.safety
                )));
            }
        }
        f.checks();
        f.safety.clear();
        Ok(f)
    }

    fn password(&self, s: usize) -> &'static str {
        match self.cfg.backend {
            Backend::Memory => PASSWORDS[0],
            Backend::Remote => PASSWORDS[self.cfg.kid(s)],
        }
    }

    /// A new connection: LOGIN (and for Remote, the shell's login bookkeeping).
    fn connect(&mut self, s: usize) -> bool {
        let tag = self.clients[s].next_tag();
        let line = format!("{tag} LOGIN tear@example.invalid {}\r\n", self.password(s));
        let mut imap = Imap::new(true);
        self.clients[s].reset();
        self.clients[s].bye = false;
        let now = self.now;
        let instance = self.cfg.instance(s);
        let (reply, remote) = match &mut self.back {
            Back::Memory { account, store } => {
                (imap.step(line.as_bytes(), account, store, now), None)
            }
            Back::Remote { apis, hints, .. } => {
                let api = apis[instance].clone();
                let login = Login {
                    deadline: std::time::Instant::now() + std::time::Duration::from_secs(15),
                    api: api.clone(),
                    principal: Mutex::new(None),
                    unavailable: false.into(),
                    limits: Arc::default(),
                    ip: "127.0.0.1"
                        .parse()
                        .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)),
                };
                let reply = imap.step(line.as_bytes(), &login, &mut Memory::default(), now);
                if reply.action != Action::Login {
                    (reply, None)
                } else {
                    let Some(p) = login.principal.lock().ok().and_then(|p| p.clone()) else {
                        return false;
                    };
                    let (sender, rx) = hints[instance].subscribe(&p.inbox);
                    let generation = rx.borrow().auth;
                    if !api.current(&p) {
                        self.safety
                            .push("authentication changed during login".into());
                        return false;
                    }
                    let Ok(store) = Store::new(api, p) else {
                        return false;
                    };
                    (
                        reply,
                        Some(RemoteConn {
                            store,
                            login,
                            stale: false,
                            rx,
                            _sender: sender,
                            generation,
                        }),
                    )
                }
            }
        };
        let status = self.clients[s].absorb_all(&reply.bytes, Kind::Plain, &mut self.safety);
        if status != ["OK"] || (self.cfg.backend == Backend::Remote && remote.is_none()) {
            return false;
        }
        self.conns[s] = Some(Conn {
            imap,
            idle: false,
            remote,
            spooling: None,
        });
        true
    }

    fn up(&self, s: usize) -> bool {
        self.conns[s].is_some()
    }
    fn hang_up(&mut self, s: usize) {
        self.conns[s] = None;
        self.clients[s].reset();
    }

    /// Consume a pending change hint the way the shell's biased select does: an auth change
    /// ends the session; otherwise mark the snapshot stale, and reload and push if idling.
    fn wake(&mut self, s: usize) {
        enum W {
            Nothing,
            Bye,
            Push(Reply),
            Drop,
        }
        let w = {
            let Some(conn) = self.conns[s].as_mut() else {
                return;
            };
            let Some(rc) = conn.remote.as_mut() else {
                return;
            };
            if !rc.rx.has_changed().unwrap_or(false) {
                return;
            }
            let g = *rc.rx.borrow_and_update();
            if g.auth != rc.generation {
                W::Bye
            } else {
                rc.stale = true;
                if conn.idle {
                    match rc.store.wake(&mut conn.imap, &mut rc.stale) {
                        Ok(r) => W::Push(r),
                        Err(_) => W::Drop,
                    }
                } else {
                    W::Nothing
                }
            }
        };
        match w {
            W::Nothing => {}
            W::Bye | W::Drop => self.hang_up(s),
            W::Push(r) => {
                self.clients[s].absorb_all(&r.bytes, Kind::Plain, &mut self.safety);
                if r.action == Action::Close || self.clients[s].bye {
                    self.hang_up(s);
                }
            }
        }
    }

    /// Send one complete command (CRLF included) through the shell; None if the connection
    /// dropped before replying.
    fn send(&mut self, s: usize, bytes: &[u8]) -> Option<Reply> {
        self.wake(s);
        let now = self.now;
        let conn = self.conns[s].as_mut()?;
        let reply = match (&mut self.back, conn.remote.as_mut()) {
            (Back::Memory { store, account }, _) => Ok(conn.imap.step(bytes, account, store, now)),
            (Back::Remote { .. }, Some(rc)) => {
                rc.store.deadline = Instant::now() + Duration::from_secs(5);
                rc.store
                    .imap(&mut conn.imap, bytes, &rc.login, &mut rc.stale, now)
                    .map_err(drop)
            }
            (Back::Remote { .. }, None) => Err(()),
        };
        match reply {
            Ok(r) => Some(r),
            Err(()) => {
                // `?` in the shell: the connection ends without a reply.
                self.hang_up(s);
                None
            }
        }
    }

    /// Send, absorb, handle BYE/close; returns the tagged statuses.
    fn exchange(&mut self, s: usize, bytes: &[u8], kind: Kind) -> Vec<String> {
        let Some(reply) = self.send(s, bytes) else {
            return vec![];
        };
        // A crash mid-command: the process is gone before it could answer.
        if matches!(self.back, Back::Remote { .. })
            && fake_api::with(|f| std::mem::take(&mut f.crashed)).unwrap_or(false)
        {
            self.crash(self.cfg.instance(s));
            return vec![];
        }
        if kind == Kind::Select {
            self.clients[s].reset();
        }
        let status = self.clients[s].absorb_all(&reply.bytes, kind, &mut self.safety);
        if self.clients[s].bye && reply.action != Action::Close {
            self.safety.push(format!(
                "{}: BYE without closing the connection",
                SESSIONS[s]
            ));
        }
        if reply.action == Action::Close || self.clients[s].bye {
            self.hang_up(s);
        }
        status
    }

    fn command(&mut self, s: usize, body: &str, kind: Kind) -> bool {
        if !self.up(s) {
            return false;
        }
        let tag = self.clients[s].next_tag();
        let line = format!("{tag} {body}\r\n");
        self.exchange(s, line.as_bytes(), kind) == ["OK"]
    }

    /// FETCH UID/FLAGS for slots the client only knows from EXISTS.
    fn fill(&mut self, s: usize) -> bool {
        if !self.up(s) {
            // Nothing to fetch: the command completed and BYE closed the session.
            return true;
        }
        let Some((lo, hi)) = self.clients[s].unknown_range() else {
            return true;
        };
        self.command(s, &format!("FETCH {lo}:{hi} (UID FLAGS)"), Kind::NoExpunge)
    }

    fn select(&mut self, s: usize, folder: &str, ro: bool) -> bool {
        let verb = if ro { "EXAMINE" } else { "SELECT" };
        self.clients[s].reset();
        let ok = self.command(s, &format!("{verb} {folder}"), Kind::Select);
        ok && self.fill(s)
    }

    fn next_message(&mut self) -> Vec<u8> {
        self.serial += 1;
        message(self.serial)
    }

    fn append(&mut self, s: usize, folder: &str) -> bool {
        if matches!(self.back, Back::Remote { .. }) {
            return self.append_begin(s, folder) && self.append_end(s);
        }
        let raw = self.next_message();
        if !self.up(s) {
            return false;
        }
        let tag = self.clients[s].next_tag();
        let mut line = format!("{tag} APPEND {folder} {{{}+}}\r\n", raw.len()).into_bytes();
        line.extend(&raw);
        line.extend(b"\r\n");
        self.exchange(s, &line, Kind::Plain) == ["OK"] && self.fill(s)
    }

    /// The shell reads `APPEND folder {n+}` and reserves an upload in the credential, inbox
    /// and workspace lanes and the process pool, then spools the literal. A busy lane answers
    /// `NO [LIMIT] Upload capacity busy` after a 2 s wait (a paused clock here) and the session
    /// stays.
    fn append_begin(&mut self, s: usize, folder: &str) -> bool {
        let raw = self.next_message();
        self.wake(s);
        let instance = self.cfg.instance(s);
        let Back::Remote { uploads, .. } = &self.back else {
            return false;
        };
        let global = uploads[instance].clone();
        let Some(conn) = self.conns[s].as_mut() else {
            return false;
        };
        let Some(rc) = conn.remote.as_mut() else {
            return false;
        };
        let lanes = rc.store.lanes.pools(|s| &s.uploads);
        let Some(permit) = paused(crate::admission::Reservation::take(global, Some(lanes), 1))
        else {
            self.clients[s].next_tag();
            self.clients[s].last = "NO [LIMIT] Upload capacity busy".into();
            return false;
        };
        let Ok(up) = crate::upload::Upload::new(raw.len(), permit) else {
            self.hang_up(s);
            return false;
        };
        conn.spooling = Some((folder.to_owned(), up, raw));
        true
    }

    /// The literal ends: the core runs `APPEND folder {0+}` with the spool (Store::imap).
    fn append_end(&mut self, s: usize) -> bool {
        self.wake(s);
        let Some(conn) = self.conns[s].as_mut() else {
            return false;
        };
        let Some((folder, mut up, raw)) = conn.spooling.take() else {
            return false;
        };
        let Some(rc) = conn.remote.as_mut() else {
            return false;
        };
        if fake_api::runtime().block_on(up.write(&raw)).is_err() {
            self.hang_up(s);
            return false;
        }
        rc.store.upload = Some(up);
        let tag = self.clients[s].next_tag();
        let line = format!("{tag} APPEND {folder} {{0+}}\r\n\r\n");
        self.exchange(s, line.as_bytes(), Kind::Plain) == ["OK"] && self.fill(s)
    }

    fn deliver(&mut self) -> bool {
        let raw = self.next_message();
        let now = self.now;
        match &mut self.back {
            Back::Memory { store, .. } => store
                .change(
                    "INBOX",
                    Change::Append {
                        raw: &raw,
                        date: now,
                        flags: Flags::new(),
                        source: Origin::Client { now },
                    },
                )
                .is_ok(),
            Back::Remote { .. } => fake_api::with(|f| f.deliver(raw)).is_some(),
        }
    }

    fn revision(&self) -> u64 {
        match &self.back {
            Back::Memory { store, .. } => store.revision(),
            Back::Remote { .. } => 0,
        }
    }

    /// Memory fixture mode: an idling session gets an update after every store change.
    fn push(&mut self) {
        let Back::Memory { store, .. } = &self.back else {
            return;
        };
        let mut replies = vec![];
        for (s, conn) in self.conns.iter_mut().enumerate() {
            if let Some(conn) = conn.as_mut()
                && conn.idle
            {
                replies.push((s, conn.imap.update(store)));
            }
        }
        for (s, r) in replies {
            self.clients[s].absorb_all(&r.bytes, Kind::Plain, &mut self.safety);
            if r.action == Action::Close || self.clients[s].bye {
                self.hang_up(s);
            }
        }
    }

    /// The gateway process `instance` dies: every connection on it ends without a reply and
    /// a fresh process (new login, wake and admission state) takes new connections.
    fn crash(&mut self, instance: usize) {
        for s in 0..self.conns.len() {
            if self.cfg.instance(s) == instance {
                self.hang_up(s);
            }
        }
        if let Back::Remote {
            apis,
            hints,
            uploads,
        } = &mut self.back
            && let Ok(api) = Api::new(fake_api::url(), fake_api::KEY.into())
        {
            api.online.store(true, std::sync::atomic::Ordering::Release);
            apis[instance] = Arc::new(api);
            hints[instance] = Hints::default();
            uploads[instance] = Arc::new(Semaphore::new(8));
        }
    }
    fn notify(&mut self, instance: Option<usize>, channel: &str) {
        if let Back::Remote { apis, hints, .. } = &self.back {
            for i in 0..apis.len() {
                if instance.is_none_or(|x| x == i) {
                    apis[i].notified(&hints[i], channel, fake_api::INBOX_ID);
                }
            }
        }
    }

    pub fn act(&mut self, label: &str) -> R<Value> {
        let act = parse(label).ok_or_else(|| Error::new(format!("unknown action {label}")))?;
        self.safety.clear();
        let rev = self.revision();
        let mut sync = None;
        if self.cfg.eager
            && let Some(s) = act.session()
            && act.addresses()
            && self.up(s)
            && !(self.command(s, "NOOP", Kind::Plain) && self.fill(s))
        {
            return Ok(
                json!({"ok": false, "safety": self.safety, "server": self.server(), "gone": self.gone()}),
            );
        }
        use Act::*;
        let ok = match act {
            Deliver => self.deliver(),
            Select { s, f, ro } => {
                sync = Some(s);
                self.select(s, FOLDERS[f], ro)
            }
            Noop(s) => {
                let ok = self.command(s, "NOOP", Kind::Plain) && self.fill(s);
                sync = ok.then_some(s);
                ok
            }
            Idle(s) => {
                let tag = if self.up(s) {
                    self.clients[s].next_tag()
                } else {
                    String::new()
                };
                let started = self.up(s)
                    && self.exchange(s, format!("{tag} IDLE\r\n").as_bytes(), Kind::Plain) == ["+"];
                if let Some(c) = self.conns[s].as_mut() {
                    c.idle = started;
                }
                started
            }
            Done(s) => {
                let done = self.up(s) && self.exchange(s, b"DONE\r\n", Kind::Plain) == ["OK"];
                if let Some(c) = self.conns[s].as_mut() {
                    c.idle = false;
                }
                let ok = done && self.fill(s);
                sync = ok.then_some(s);
                ok
            }
            Store {
                s,
                add,
                flag,
                silent,
                set,
                uid,
            } => {
                let name = FLAG_NAMES[flag].1;
                let target = match (uid, set) {
                    (true, Set::First) => self.clients[s].first_uid().unwrap_or(1).to_string(),
                    _ => set.text().to_owned(),
                };
                let body = format!(
                    "{}STORE {target} {}FLAGS{} ({name})",
                    if uid { "UID " } else { "" },
                    if add { "+" } else { "-" },
                    if silent { ".SILENT" } else { "" }
                );
                let kind = if uid { Kind::Plain } else { Kind::NoExpunge };
                let ok = self.command(s, &body, kind);
                if ok && silent {
                    let len = self.clients[s].mirror.len();
                    let slots = match set {
                        Set::First => 0..len.min(1),
                        Set::All => 0..len,
                    };
                    self.clients[s].apply_silent(slots, name, add);
                }
                ok
            }
            Fetch { s, uid } => {
                let body = if uid {
                    format!(
                        "UID FETCH {} (BODY[])",
                        self.clients[s].first_uid().unwrap_or(1)
                    )
                } else {
                    "FETCH 1 (BODY[])".into()
                };
                let kind = if uid { Kind::Plain } else { Kind::NoExpunge };
                self.command(s, &body, kind)
            }
            Expunge(s) | UidExpunge(s) => {
                let cmd = if matches!(act, Expunge(_)) {
                    "EXPUNGE"
                } else {
                    "UID EXPUNGE 1:*"
                };
                // A partial NO still reports the committed batches; the client fetches
                // what it was told about either way.
                let ok = self.command(s, cmd, Kind::Plain);
                let ok = self.fill(s) && ok;
                sync = ok.then_some(s);
                ok
            }
            Close(s) | Unselect(s) => {
                let cmd = if matches!(act, Close(_)) {
                    "CLOSE"
                } else {
                    "UNSELECT"
                };
                let ok = self.command(s, cmd, Kind::Plain);
                if ok {
                    self.clients[s].reset();
                }
                sync = ok.then_some(s);
                ok
            }
            Transfer {
                s,
                to,
                moving,
                uid,
                all,
            } => {
                let set = if all {
                    "1:*".to_owned()
                } else if uid {
                    self.clients[s].first_uid().unwrap_or(1).to_string()
                } else {
                    "1".into()
                };
                let body = format!(
                    "{}{} {set} {}",
                    if uid { "UID " } else { "" },
                    if moving { "MOVE" } else { "COPY" },
                    FOLDERS[to]
                );
                let ok = self.command(s, &body, Kind::Plain);
                let ok = self.fill(s) && ok;
                sync = ok.then_some(s);
                ok
            }
            Append(s, f) => {
                let ok = self.append(s, FOLDERS[f]);
                sync = ok.then_some(s);
                ok
            }
            AppendBegin(s, f) => self.append_begin(s, FOLDERS[f]),
            AppendEnd(s) => {
                let ok = self.append_end(s);
                sync = ok.then_some(s);
                ok
            }
            Bulk => {
                let raws: Vec<Vec<u8>> = (0..crate::model::Config::BATCH)
                    .map(|_| self.next_message())
                    .collect();
                fake_api::with(|f| {
                    for r in raws {
                        f.deliver(r);
                    }
                })
                .is_some()
            }
            Arm(f) => fake_api::with(|x| x.fault = Some((f.countdown(), f))).is_some(),
            Create(s) => self.command(s, "CREATE Work", Kind::Plain),
            Delete(s) => self.command(s, "DELETE Work", Kind::Plain),
            Reconnect(s) => {
                sync = Some(s);
                self.connect(s) && self.select(s, "INBOX", false)
            }
            Hint(instance) => {
                self.notify(instance, "bane_inbox_changed");
                true
            }
            Wake(s) => {
                self.wake(s);
                self.up(s)
            }
            ExtSeen => fake_api::with(Fake::external_seen).is_some(),
            ExtExpunge => fake_api::with(Fake::external_expunge).is_some(),
            Prune => fake_api::with(Fake::prune).is_some(),
            FailSnapshot => fake_api::with(|f| f.fail_snapshot = true).is_some(),
            Age(s) => {
                if let Some(rc) = self.conns[s].as_mut().and_then(|c| c.remote.as_mut()) {
                    rc.store.stamp = Instant::now()
                        .checked_sub(Duration::from_secs(241))
                        .unwrap_or_else(Instant::now);
                }
                true
            }
            Revoke => {
                fake_api::with(|f| f.credentials.iter_mut().for_each(|c| c.revoked = true));
                self.notify(None, "bane_protocol_auth");
                true
            }
        };
        if self.revision() != rev {
            self.push();
        }

        self.checks();
        let mut v =
            json!({"ok": ok, "safety": self.safety, "server": self.server(), "gone": self.gone()});
        if let Some(s) = sync
            && self.up(s)
        {
            v["mirror"] = json!({SESSIONS[s]: self.clients[s].view()});
        }
        Ok(v)
    }

    fn gone(&self) -> Vec<&'static str> {
        (0..self.conns.len())
            .filter(|&s| !self.up(s))
            .map(|s| SESSIONS[s])
            .collect()
    }

    /// The folder contents the store holds, for every compared folder.
    fn server(&self) -> Value {
        let mut out = serde_json::Map::new();
        match &self.back {
            Back::Memory { store, .. } => {
                for name in SERVER {
                    let v = store.folder(name).map_or(Value::Null, |f| {
                        json!({"next": f.next, "entries": f.entries.iter().map(|e| (e.uid, &e.flags)).collect::<Vec<_>>()})
                    });
                    out.insert(name.into(), v);
                }
            }
            Back::Remote { .. } => {
                fake_api::with(|fake| {
                    for name in SERVER {
                        let v = fake.folder(name).map_or(Value::Null, |f| {
                            json!({"next": f.next, "entries": f.entries.iter()
                                .map(|e| (e.uid, fake.flags(e).into_iter().collect::<Flags>()))
                                .collect::<Vec<_>>()})
                        });
                        out.insert(name.into(), v);
                    }
                });
            }
        }
        Value::Object(out)
    }

    fn snaps(&self) -> BTreeMap<String, Snap> {
        let mut now = BTreeMap::new();
        match &self.back {
            Back::Memory { store, .. } => {
                for name in store.folders() {
                    let Ok(f) = store.folder(&name) else { continue };
                    now.insert(
                        name,
                        Snap {
                            validity: f.validity,
                            next: f.next,
                            highest: f.highest,
                            entries: f
                                .entries
                                .iter()
                                .map(|e| (e.uid, (e.modseq, e.flags.clone())))
                                .collect(),
                        },
                    );
                }
            }
            Back::Remote { .. } => {
                fake_api::with(|fake| {
                    for f in &fake.folders {
                        now.insert(
                            f.path(),
                            Snap {
                                validity: f.validity,
                                next: f.next,
                                highest: f.highest,
                                entries: f
                                    .entries
                                    .iter()
                                    .map(|e| {
                                        (e.uid, (e.modseq, fake.flags(e).into_iter().collect()))
                                    })
                                    .collect(),
                            },
                        );
                    }
                });
            }
        }
        now
    }

    /// Store invariants against the previous step, plus client and session-snapshot order.
    fn checks(&mut self) {
        for c in &self.clients {
            c.check_order(&mut self.safety);
        }
        for (s, conn) in self.conns.iter().enumerate() {
            let Some(rc) = conn.as_ref().and_then(|c| c.remote.as_ref()) else {
                continue;
            };
            for name in rc.store.folders() {
                if let Ok(f) = rc.store.folder(&name) {
                    let uids: Vec<u32> = f.entries.iter().map(|e| e.uid).collect();
                    if uids.windows(2).any(|w| w[0] >= w[1]) {
                        self.safety.push(format!(
                            "{}: session snapshot of {name} not in UID order {uids:?}",
                            SESSIONS[s]
                        ));
                    }
                }
            }
        }
        if let Back::Remote { .. } = self.back {
            let v = fake_api::with(|f| std::mem::take(&mut f.violations)).unwrap_or_default();
            self.safety
                .extend(v.into_iter().map(|v| format!("internal API: {v}")));
        }
        let now = self.snaps();
        for (name, snap) in &now {
            let uids: Vec<_> = snap.entries.keys().collect();
            if uids.windows(2).any(|w| w[0] >= w[1]) {
                self.safety
                    .push(format!("{name}: entries not in strict UID order"));
            }
            for (uid, (modseq, _)) in &snap.entries {
                if *uid >= snap.next {
                    self.safety
                        .push(format!("{name}: UID {uid} >= UIDNEXT {}", snap.next));
                }
                if *modseq > snap.highest {
                    self.safety.push(format!(
                        "{name}: MODSEQ {modseq} > HIGHESTMODSEQ {}",
                        snap.highest
                    ));
                }
                if self.removed.contains(&(name.clone(), snap.validity, *uid)) {
                    self.safety
                        .push(format!("{name}: expunged UID {uid} resurrected"));
                }
            }
            match self.prev.get(name) {
                Some(p) if p.validity == snap.validity => {
                    if snap.next < p.next {
                        self.safety
                            .push(format!("{name}: UIDNEXT {} -> {}", p.next, snap.next));
                    }
                    if snap.highest < p.highest {
                        self.safety.push(format!(
                            "{name}: HIGHESTMODSEQ {} -> {}",
                            p.highest, snap.highest
                        ));
                    }
                    for (uid, (modseq, flags)) in &snap.entries {
                        match p.entries.get(uid) {
                            Some((old, _)) if modseq < old => self
                                .safety
                                .push(format!("{name}: UID {uid} MODSEQ {old} -> {modseq}")),
                            Some((old, before)) if before != flags && modseq <= old => {
                                self.safety.push(format!(
                                    "{name}: UID {uid} flags changed without MODSEQ bump"
                                ))
                            }
                            None if *uid < p.next => self.safety.push(format!(
                                "{name}: new UID {uid} below old UIDNEXT {}",
                                p.next
                            )),
                            _ => {}
                        }
                    }
                    for uid in p.entries.keys().filter(|u| !snap.entries.contains_key(u)) {
                        self.removed.insert((name.clone(), snap.validity, *uid));
                    }
                }
                Some(p) => {
                    // Recreated: the new UIDVALIDITY must never repeat an earlier one.
                    self.retired
                        .entry(name.clone())
                        .or_default()
                        .insert(p.validity);
                    if self.retired[name].contains(&snap.validity) {
                        self.safety
                            .push(format!("{name}: UIDVALIDITY {} reused", snap.validity));
                    }
                }
                None => {
                    if self
                        .retired
                        .get(name)
                        .is_some_and(|r| r.contains(&snap.validity))
                    {
                        self.safety.push(format!(
                            "{name}: recreated with old UIDVALIDITY {}",
                            snap.validity
                        ));
                    }
                }
            }
        }
        for (name, p) in &self.prev {
            if !now.contains_key(name) {
                self.retired
                    .entry(name.clone())
                    .or_default()
                    .insert(p.validity);
            }
        }
        self.prev = now;
    }
}

/// Run an admission future on a paused clock: a reservation that would wait for its 2 s
/// timeout (nothing can release a permit while this fixture is single-threaded) times out at
/// once instead of in real time. The semaphores are the gateway's own.
pub fn paused<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .unwrap_or_else(|e| panic!("paused runtime: {e}"))
        .block_on(f)
}
