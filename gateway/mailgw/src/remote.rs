//! Request-scoped gateway adapters. Core methods are synchronous; the shell invokes
//! them on a Tokio blocking region, never with a shared store mutex held.
use anyhow::{Result, anyhow, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use mailgw_core::{
    imap::Imap,
    session::{Identity, Protocol, Reply},
    smtp::{Submission, SubmitError, Submitter},
    store::{self, Applied, Change, Entry, Flags, Folder, FolderOp, MailStore, Mode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
#[derive(Clone, Deserialize)]
pub struct FolderMeta {
    key: String,
    path: String,
    validity: u32,
    next: u32,
    highest: u64,
    subscribed: bool,
    total: usize,
    unseen: usize,
}
#[derive(Clone, Deserialize)]
pub struct Principal {
    #[serde(skip)]
    started: Option<Instant>,
    /// Served from the 5 s login cache: its folder list can predate a folder another
    /// connection created since.
    #[serde(skip)]
    cached: bool,
    pub kid: String,
    pub inbox: String,
    workspace: String,
    account: String,
    addresses: Vec<String>,
    folders: Vec<FolderMeta>,
}
#[derive(Clone, Deserialize)]
struct Message {
    uid: u32,
    date: store::Date,
    modseq: u64,
    size: usize,
    flags: Flags,
    handle: Option<String>,
}
#[derive(Clone, Deserialize)]
struct Snapshot {
    folders: Vec<FolderMeta>,
    entries: Vec<Message>,
    gone: Vec<u32>,
    floor: u64,
    more: Option<u32>,
}
type WakeCache = HashMap<(String, Option<String>, u64), Arc<std::sync::OnceLock<Option<Snapshot>>>>;
/// Credentials tracked at once: every open session's, and those seen in the last minute.
const GATES: usize = 8192;
struct Gate {
    lanes: crate::admission::Lanes,
    bytes: Arc<Mutex<crate::admission::Bucket>>,
    calls: crate::admission::Bucket,
    inbox: String,
    workspace: String,
    account: String,
    last: Instant,
}
#[derive(Default)]
struct Revocations {
    reset: Option<Instant>,
    by_inbox: HashMap<String, Instant>,
}
impl Revocations {
    const MAX_LOGIN: Duration = Duration::from_secs(30);
    fn record(&mut self, inbox: Option<&str>, now: Instant) {
        self.by_inbox
            .retain(|_, t| now.duration_since(*t) <= Self::MAX_LOGIN);
        if let Some(i) = inbox {
            self.by_inbox.insert(i.to_owned(), now);
        } else {
            self.by_inbox.clear();
            self.reset = Some(now);
        }
    }
    fn current(&self, inbox: &str, started: Instant, now: Instant) -> bool {
        now.duration_since(started) < Self::MAX_LOGIN
            && self.reset.is_none_or(|t| t < started)
            && self.by_inbox.get(inbox).is_none_or(|&t| t < started)
    }
}
pub struct Api {
    revoked: Mutex<Revocations>,
    gates: Mutex<HashMap<String, Gate>>,
    views: Arc<tokio::sync::Semaphore>,
    heavy: Arc<tokio::sync::Semaphore>,
    pub online: std::sync::atomic::AtomicBool,
    wakes: Mutex<WakeCache>,
    client: reqwest::Client,
    url: String,
    key: Zeroizing<String>,
    cache: Mutex<HashMap<[u8; 32], (Instant, Principal)>>,
}
impl Api {
    pub fn new(url: String, key: String) -> Result<Self> {
        let u = reqwest::Url::parse(&url)?;
        ensure!(
            key.len() >= 32
                && (u.scheme() == "https"
                    || u.scheme() == "http"
                        && matches!(u.host_str(), Some("127.0.0.1" | "localhost"))),
            "invalid gateway API configuration"
        );
        Ok(Self {
            revoked: Default::default(),
            online: false.into(),
            gates: Mutex::default(),
            views: Arc::new(tokio::sync::Semaphore::new(192 * 1024)),
            heavy: Arc::new(tokio::sync::Semaphore::new(4)),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            url: u.join("/internal/v1/mail")?.to_string(),
            key: Zeroizing::new(key),
            cache: Mutex::default(),
            wakes: Mutex::default(),
        })
    }
    fn call(&self, p: Value) -> Result<Vec<u8>, u16> {
        self.call_before(p, None)
    }
    fn call_before(&self, p: Value, deadline: Option<Instant>) -> Result<Vec<u8>, u16> {
        let mut inbox_work = None;
        if let Some(kid) = p.get("kid").and_then(Value::as_str) {
            let start = Instant::now();
            loop {
                let mut gates = self.gates.lock().map_err(|_| 503u16)?;
                let g = gates.get_mut(kid).ok_or(403u16)?;
                g.last = Instant::now();
                if !g.calls.take(tokio::time::Instant::now(), 1) {
                    drop(gates);
                    if start.elapsed() > Duration::from_secs(1) {
                        return Err(429);
                    }
                    std::thread::sleep(Duration::from_millis(20));
                } else {
                    inbox_work = Some(g.lanes.pools(|s| &s.reads));
                    break;
                }
            }
        }
        let _work = if matches!(
            p["op"].as_str(),
            Some("snapshot" | "body" | "projections" | "subject" | "submit")
        ) {
            Some(
                tokio::runtime::Handle::current()
                    .block_on(crate::admission::Reservation::take(
                        self.heavy.clone(),
                        Some(inbox_work.ok_or(403u16)?),
                        1,
                    ))
                    .ok_or(429u16)?,
            )
        } else {
            None
        };
        let scope = hex::encode(Sha256::digest(
            p.get("kid")
                .or_else(|| p.get("user"))
                .and_then(Value::as_str)
                .unwrap_or("login")
                .to_ascii_lowercase()
                .as_bytes(),
        ));
        let b = serde_json::to_vec(&p).map_err(|_| 500u16)?;
        let hash = hex::encode(Sha256::digest(&b));
        let ts = chrono::Utc::now().timestamp().to_string();
        let mut mac = Hmac::<Sha256>::new_from_slice(self.key.as_bytes()).map_err(|_| 500u16)?;
        mac.update(format!("POST\n/internal/v1/mail\n{ts}\n{hash}\n{scope}").as_bytes());
        let req = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("x-bane-scope", scope)
            .header("x-bane-content", hash)
            .header("x-bane-timestamp", ts)
            .header("x-bane-signature", hex::encode(mac.finalize().into_bytes()))
            .body(b);
        let req = if let Some(deadline) = deadline {
            req.timeout(
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or(503u16)?,
            )
        } else {
            req
        };
        tokio::runtime::Handle::current().block_on(async {
            let mut r = req.send().await.map_err(|_| 503u16)?;
            if !r.status().is_success() {
                return Err(r.status().as_u16());
            }
            let mut out = vec![];
            while let Some(chunk) = r.chunk().await.map_err(|_| 503u16)? {
                let cap = if p["headers"].as_bool() == Some(true) {
                    40 << 20
                } else {
                    48 << 20
                };
                if out.len() + chunk.len() > cap {
                    return Err(413);
                }
                out.extend_from_slice(&chunk)
            }
            Ok(out)
        })
    }
    fn json<T: serde::de::DeserializeOwned>(&self, p: Value) -> Result<T, store::Error> {
        serde_json::from_slice(&self.call(p).map_err(|s| match s {
            403 | 409 | 422 => store::Error::Denied,
            404 => store::Error::Missing,
            413 => store::Error::Limit,
            _ => store::Error::Unavailable,
        })?)
        .map_err(|_| store::Error::Unavailable)
    }
    pub fn current(&self, p: &Principal) -> bool {
        p.started.is_some_and(|s| {
            self.revoked
                .lock()
                .is_ok_and(|v| v.current(&p.inbox, s, Instant::now()))
        })
    }
    /// One database notification: every change drops the wake cache; an auth change also
    /// drops cached logins for that inbox. Then the inbox's sessions are woken.
    pub fn notified(&self, events: &crate::hints::Hints, channel: &str, inbox: &str) {
        if let Ok(mut m) = self.wakes.lock() {
            m.clear()
        }
        let auth = channel == "bane_protocol_auth";
        if auth {
            self.invalidate(Some(inbox))
        }
        events.publish(Some(inbox), auth);
    }
    pub fn invalidate(&self, inbox: Option<&str>) {
        if let Ok(mut c) = self.cache.lock() {
            self.revoked
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .record(inbox, Instant::now());
            c.retain(|_, (_, p)| inbox.is_some_and(|i| p.inbox != i));
        }
    }
    fn login(
        &self,
        user: &str,
        password: &str,
        proto: Protocol,
        deadline: Instant,
    ) -> Result<Principal, u16> {
        let started = Some(Instant::now());
        if !self.online.load(std::sync::atomic::Ordering::Acquire) {
            return Err(503);
        }
        let p = if proto == Protocol::Imap {
            "imap"
        } else {
            "smtp"
        };
        let mut hash = Hmac::<Sha256>::new_from_slice(self.key.as_bytes()).map_err(|_| 503u16)?;
        for x in [p, user, password] {
            hash.update(&(x.len() as u64).to_be_bytes());
            hash.update(x.as_bytes())
        }
        let k: [u8; 32] = hash.finalize().into_bytes().into();
        if let Some((_, v)) = self
            .cache
            .lock()
            .map_err(|_| 503u16)?
            .get(&k)
            .filter(|(t, _)| t.elapsed() < Duration::from_secs(5))
        {
            let mut cached = v.clone();
            cached.started = started;
            cached.cached = true;
            return Ok(cached);
        }
        let mut principal: Principal = serde_json::from_slice(&self.call_before(
            json!({"op":"login","protocol":p,"user":user,"password":password}),
            Some(deadline),
        )?)
        .map_err(|_| 503u16)?;
        let mut c = self.cache.lock().map_err(|_| 503u16)?;
        principal.started = started;
        if !self.current(&principal) {
            return Err(503);
        }
        if c.len() >= 1024 {
            c.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(5))
        }
        if c.len() < 1024 {
            c.insert(k, (Instant::now(), principal.clone()));
        }
        Ok(principal)
    }
}
pub struct Login {
    pub deadline: Instant,
    pub unavailable: std::sync::atomic::AtomicBool,
    pub limits: Arc<Mutex<crate::admission::Limits>>,
    pub ip: std::net::IpAddr,
    pub api: Arc<Api>,
    pub principal: Mutex<Option<Principal>>,
}
impl Identity for Login {
    fn owns(&self, a: &str) -> bool {
        self.principal.lock().is_ok_and(|p| {
            p.as_ref()
                .is_some_and(|p| p.addresses.iter().any(|x| x.eq_ignore_ascii_case(a)))
        })
    }
    fn login(&self, p: Protocol, user: &[u8], pass: &[u8]) -> bool {
        let (Ok(u), Ok(pw)) = (str::from_utf8(user), str::from_utf8(pass)) else {
            return false;
        };
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        u.to_ascii_lowercase().hash(&mut h);
        let k = h.finish();
        let now = tokio::time::Instant::now();
        if self.limits.lock().is_ok_and(|l| l.blocked(self.ip, k, now)) {
            return false;
        }
        let v = match self.api.login(u, pw, p, self.deadline) {
            Ok(v) => v,
            Err(403) => {
                if let Ok(mut l) = self.limits.lock() {
                    l.failure(self.ip, k, now)
                }
                return false;
            }
            Err(_) => {
                self.unavailable
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                return false;
            }
        };
        let Ok(mut slot) = self.principal.lock() else {
            return false;
        };
        if let Ok(mut l) = self.limits.lock() {
            l.success(self.ip, k);
        }
        *slot = Some(v);
        true
    }
}
type PreviewPage = BTreeMap<u32, (Arc<[u8]>, bool)>;
pub struct Store {
    pending_copy: Option<([u8; 32], Value)>,
    page_wait: std::cell::Cell<Duration>,
    page: std::cell::RefCell<PreviewPage>,
    headers: std::cell::RefCell<BTreeMap<u32, Arc<[u8]>>>,
    bytes: std::cell::RefCell<Option<crate::admission::Reservation>>,
    pub lanes: crate::admission::Lanes,
    pub upload: Option<crate::upload::Upload>,
    pub upload_rate: Arc<Mutex<crate::admission::Bucket>>,
    api: Arc<Api>,
    pub principal: Principal,
    folders: BTreeMap<String, Folder>,
    keys: BTreeMap<String, String>,
    handles: BTreeMap<u32, String>,
    selected: Option<String>,
    pub stamp: Instant,
    checkpoint: Option<(u32, u64)>,
    /// The snapshot may be behind the API (a committed change whose refresh failed, a
    /// failed SELECT, a cached login): the next command refreshes first.
    dirty: bool,
    pub deadline: Instant,
}
impl Store {
    pub fn finish_command(&mut self) {
        self.page_wait.set(Duration::ZERO);
        self.page.get_mut().clear();
        drop(self.upload.take());
    }
    pub fn new(api: Arc<Api>, p: Principal) -> Result<Self> {
        let meta = p.folders.clone();
        let cached = p.cached;
        let (lanes, upload_rate) = {
            let mut gates = api.gates.lock().unwrap_or_else(|p| p.into_inner());
            let open = |v: &Gate| Arc::strong_count(&v.lanes.0[0]) > 1;
            gates.retain(|_, v| open(v) || v.last.elapsed() < Duration::from_secs(60));
            if gates.len() >= GATES && !gates.contains_key(&p.kid) {
                // Open sessions are bounded by the task's connections. A credential without
                // one holds only its rate state, which gives way to the next login.
                gates.retain(|_, v| open(v));
            }
            ensure!(
                gates.len() < GATES || gates.contains_key(&p.kid),
                "credential admission full"
            );
            let account_share = gates
                .values()
                .find(|g| g.account == p.account)
                .map(|g| g.lanes.0[3].clone())
                .unwrap_or_else(|| Arc::new(crate::admission::Shares::new(4, 2, 4, 144)));
            let workspace_share = gates
                .values()
                .find(|g| g.workspace == p.workspace)
                .map(|g| g.lanes.0[2].clone())
                .unwrap_or_else(|| Arc::new(crate::admission::Shares::new(4, 2, 4, 144)));
            let inbox_share = gates
                .values()
                .find(|g| g.inbox == p.inbox)
                .map(|g| g.lanes.0[1].clone())
                .unwrap_or_else(|| Arc::new(crate::admission::Shares::new(3, 2, 3, 136)));
            let g = gates.entry(p.kid.clone()).or_insert_with(|| Gate {
                lanes: crate::admission::Lanes([
                    Arc::new(crate::admission::Shares::new(3, 2, 3, 128)),
                    inbox_share,
                    workspace_share,
                    account_share,
                ]),
                inbox: p.inbox.clone(),
                workspace: p.workspace.clone(),
                account: p.account.clone(),
                last: Instant::now(),
                bytes: Arc::new(Mutex::new(crate::admission::Bucket::new(
                    tokio::time::Instant::now(),
                    16384,
                    2048,
                ))),
                calls: crate::admission::Bucket::new(tokio::time::Instant::now(), 200, 50),
            });
            g.last = Instant::now();
            (g.lanes.clone(), g.bytes.clone())
        };
        let mut s = Self {
            pending_copy: None,
            page_wait: Default::default(),
            page: Default::default(),
            api,
            bytes: Default::default(),
            upload: None,
            headers: Default::default(),
            lanes,
            upload_rate,
            principal: p,
            folders: BTreeMap::new(),
            keys: BTreeMap::new(),
            handles: BTreeMap::new(),
            selected: None,
            stamp: Instant::now(),
            checkpoint: None,
            // A cached login's folder list may be behind: the first command other than
            // SELECT/EXAMINE refreshes it, so APPEND or COPY to a folder created since
            // doesn't answer TRYCREATE.
            dirty: cached,
            deadline: Instant::now() + Duration::from_secs(5),
        };
        s.install(meta);
        Ok(s)
    }
    fn install(&mut self, meta: Vec<FolderMeta>) {
        self.folders.clear();
        self.keys.clear();
        for f in meta {
            self.keys.insert(f.path.clone(), f.key.clone());
            self.folders.insert(
                f.path,
                Folder {
                    validity: f.validity,
                    next: f.next,
                    highest: f.highest,
                    entries: vec![],
                    counts: Some((f.total, f.unseen)),
                    subscribed: f.subscribed,
                    role: match f.key.as_str() {
                        "sent" => Some("\\Sent"),
                        "drafts" => Some("\\Drafts"),
                        "trash" => Some("\\Trash"),
                        "junk" => Some("\\Junk"),
                        "archive" => Some("\\Archive"),
                        _ => None,
                    },
                },
            );
        }
    }
    fn reserve_view(&self, bytes: usize) -> Result<(), store::Error> {
        let target = bytes.div_ceil(1024);
        if target > 96 * 1024 {
            return Err(store::Error::Limit);
        }
        let mut slot = self.bytes.borrow_mut();
        let held = slot.as_ref().map_or(0, |p| p.len());
        if target > held {
            let extra = tokio::runtime::Handle::current()
                .block_on(crate::admission::Reservation::take(
                    self.api.views.clone(),
                    Some(self.lanes.pools(|s| &s.views)),
                    (target - held) as u32,
                ))
                .ok_or(store::Error::Limit)?;
            if let Some(p) = slot.as_mut() {
                p.merge(extra)
            } else {
                *slot = Some(extra)
            }
        }
        Ok(())
    }
    fn clear_selection(&mut self) {
        if let Some(f) = self.selected.take().and_then(|p| self.folders.get_mut(&p)) {
            f.entries = Vec::new();
        }
        self.handles.clear();
        self.headers.get_mut().clear();
        self.page.get_mut().clear();
        self.checkpoint = None;
        drop(self.bytes.get_mut().take());
    }
    pub fn refresh(&mut self) -> Result<(), store::Error> {
        self.reload(false)
    }
    /// After the internal API committed a change. A failed refresh must not turn the
    /// committed command into a failure (RFC 3501 6.4.7: a client told NO retries the COPY
    /// or APPEND that already happened); the snapshot stays as it was and the next command
    /// refreshes it.
    fn settle(&mut self) {
        if self.refresh().is_err() {
            self.dirty = true
        }
    }
    /// One IMAP command on a logged-in connection. A snapshot marked stale by a change
    /// hint, or older than 240 s, is refreshed first; SELECT and EXAMINE load their own.
    pub fn imap(
        &mut self,
        core: &mut Imap,
        bytes: &[u8],
        identity: &dyn Identity,
        stale: &mut bool,
        now: store::Date,
    ) -> Result<Reply, store::Error> {
        let selects = bytes.split(|b| *b == b' ').nth(1).is_some_and(|w| {
            w.eq_ignore_ascii_case(b"SELECT") || w.eq_ignore_ascii_case(b"EXAMINE")
        });
        if !selects && (*stale || self.dirty || self.stamp.elapsed() > Duration::from_secs(240)) {
            self.refresh()?;
            *stale = false
        }
        if selects {
            *stale = false;
        }
        let reply = core.step(bytes, identity, self, now);
        // A parse, folder or access refusal can bypass Store::change.
        // No uploaded literal ever belongs to the next command.
        self.finish_command();
        Ok(reply)
    }
    /// A change hint while idling: reload (possibly from the wake cache) and push the update.
    pub fn wake(&mut self, core: &mut Imap, stale: &mut bool) -> Result<Reply, store::Error> {
        self.reload(true)?;
        *stale = false;
        Ok(core.update(self))
    }
    pub fn reload(&mut self, wake: bool) -> Result<(), store::Error> {
        let checkpoint = self.checkpoint;
        if wake {
            self.deadline = Instant::now() + Duration::from_secs(5);
        }
        let since = checkpoint.map_or(0, |x| x.1);
        let read = || {
            let mut after = 0;
            let mut estimated = 0usize;
            let mut result: Option<Snapshot> = None;
            loop {
                let mut page:Snapshot=self.api.json(json!({"op":"snapshot","kid":self.principal.kid,"path":self.selected,"since":since,"after":after}))?;
                estimated += page
                    .entries
                    .iter()
                    .map(|m| {
                        512 + m.handle.as_ref().map_or(0, String::len)
                            + m.flags.iter().map(|s| s.len() + 96).sum::<usize>()
                    })
                    .sum::<usize>();
                self.reserve_view(
                    estimated.max(self.folders.values().map(|f| f.entries.len() * 512).sum()),
                )?;
                let cursor = page.more;
                if let Some(first) = &mut result {
                    let stamp = |s: &Snapshot| {
                        s.folders
                            .iter()
                            .find(|f| Some(&f.path) == self.selected.as_ref())
                            .map(|f| (f.validity, f.highest))
                    };
                    if stamp(first) != stamp(&page) {
                        return Err(store::Error::Unavailable);
                    }
                    first.entries.append(&mut page.entries);
                    first.gone.append(&mut page.gone);
                } else {
                    result = Some(page)
                }
                if let Some(next) = cursor {
                    if next <= after || self.deadline < std::time::Instant::now() {
                        return Err(store::Error::Limit);
                    }
                    after = next
                } else {
                    break;
                }
            }
            result.ok_or(store::Error::Unavailable)
        };
        let snap = if wake && since != 0 {
            let cell = {
                let mut m = self
                    .api
                    .wakes
                    .lock()
                    .map_err(|_| store::Error::Unavailable)?;
                if m.len() >= 8 {
                    m.clear()
                }
                m.entry((self.principal.kid.clone(), self.selected.clone(), since))
                    .or_default()
                    .clone()
            };
            // Coalesce small IDLE updates only. Large deltas belong to a session's
            // view budget, not to a process-global cache after that session exits.
            let mut uncached = None;
            let cached = cell.get_or_init(|| match read() {
                Ok(s) if s.entries.len() <= 16 && s.gone.len() <= 128 && s.folders.len() <= 64 => {
                    Some(s)
                }
                other => {
                    uncached = Some(other);
                    None
                }
            });
            if let Some(s) = cached {
                s.clone()
            } else {
                uncached.unwrap_or_else(read)?
            }
        } else {
            read()?
        };
        let stamp = snap
            .folders
            .iter()
            .find(|f| Some(&f.path) == self.selected.as_ref())
            .map(|f| (f.validity, f.highest));
        if since != 0 && (checkpoint.map(|x| x.0) != stamp.map(|x| x.0) || since < snap.floor) {
            self.checkpoint = None;
            return self.reload(false);
        }
        let mut old = if since > 0 {
            self.selected
                .as_ref()
                .and_then(|p| self.folders.get_mut(p))
                .map(|f| std::mem::take(&mut f.entries))
                .unwrap_or_default()
        } else {
            self.handles.clear();
            self.headers.get_mut().clear();
            vec![]
        };
        self.install(snap.folders);
        self.checkpoint = stamp;
        let gone: std::collections::HashSet<_> = snap.gone.into_iter().collect();
        old.retain(|e| !gone.contains(&e.uid));
        for uid in gone {
            self.handles.remove(&uid);
        }
        let empty: Arc<[u8]> = Arc::default();
        for m in snap.entries {
            if let Some(h) = m.handle {
                self.handles.insert(m.uid, h);
            }
            let e = Entry {
                size: m.size,
                uid: m.uid,
                id: 0,
                date: m.date,
                flags: m.flags,
                modseq: m.modseq,
                raw: empty.clone(),
            };
            if let Ok(i) = old.binary_search_by_key(&e.uid, |e| e.uid) {
                old[i] = e
            } else {
                old.push(e)
            }
        }
        if let Some(f) = self.selected.as_ref().and_then(|p| self.folders.get_mut(p)) {
            f.entries = old;
        }
        let weight = self
            .folders
            .values()
            .flat_map(|f| &f.entries)
            .map(|e| 512 + e.flags.iter().map(|s| 96 + s.len()).sum::<usize>())
            .sum::<usize>()
            + self.handles.values().map(String::len).sum::<usize>();
        self.reserve_view(weight)?;
        if let Some(p) = self.bytes.get_mut() {
            let excess = p.len().saturating_sub(weight.div_ceil(1024));
            if excess > 0 {
                p.shrink(excess);
            }
        }
        self.stamp = Instant::now();
        self.dirty = false;
        Ok(())
    }
}
impl MailStore for Store {
    fn prefetch(&self, p: &str, uids: &[u32]) -> Result<usize, store::Error> {
        #[derive(Deserialize)]
        struct Row {
            uid: u32,
            raw: String,
            complete: bool,
        }
        self.budget()?;
        let entries = &self.folder(p)?.entries;
        let mut bytes = 0usize;
        let mut n = 0;
        for uid in uids {
            let size = entries
                .binary_search_by_key(uid, |e| e.uid)
                .ok()
                .map_or(0, |i| entries[i].size);
            if bytes.saturating_add(size) > 4 << 20 && n > 0 {
                break;
            }
            bytes = bytes.saturating_add(size);
            n += 1;
        }
        let uids = &uids[..n];
        self.page.borrow_mut().clear();
        // Use a signed binary read instead of base64 JSON for a single very large object.
        if n == 1 && bytes > 4 << 20 {
            return Ok(n);
        }
        let start = Instant::now();
        let rows:Vec<Row>=self.api.json(json!({"op":"projections","kid":self.principal.kid,"folder":self.keys.get(p).ok_or(store::Error::Missing)?,"uids":uids}))?;
        self.page_wait
            .set((self.page_wait.get() + start.elapsed()).min(Duration::from_secs(180)));
        let mut page = self.page.borrow_mut();
        page.clear();
        for r in rows {
            page.insert(
                r.uid,
                (
                    STANDARD
                        .decode(r.raw)
                        .map_err(|_| store::Error::Unavailable)?
                        .into(),
                    r.complete,
                ),
            );
        }
        Ok(n)
    }
    fn subject(&self, p: &str, term: &str) -> Result<Option<Vec<u32>>, store::Error> {
        if term.len() > 1024 {
            return Err(store::Error::Limit);
        }
        self.api.json(json!({"op":"subject","kid":self.principal.kid,"folder":self.keys.get(p).ok_or(store::Error::Missing)?,"term":term})).map(Some)
    }
    fn list_fresh(&mut self) -> Result<(), store::Error> {
        // Cached LOGIN data can predate a folder edit. Read only folder metadata;
        // LIST must not download a selected folder or advance its MODSEQ checkpoint.
        let snap: Snapshot = self
            .api
            .json(json!({"op":"snapshot","kid":self.principal.kid,"path":null}))?;
        let selected = self.selected.as_ref().and_then(|p| self.folders.remove(p));
        self.install(snap.folders);
        if let (Some(old), Some(f)) = (
            selected,
            self.selected.as_ref().and_then(|p| self.folders.get_mut(p)),
        ) && old.validity == f.validity
        {
            f.entries = old.entries;
            f.highest = old.highest;
        }
        Ok(())
    }
    fn select(&mut self, path: &str) -> Result<(), store::Error> {
        // RFC SELECT deselects the old mailbox even if the new selection fails.
        self.clear_selection();
        self.selected = Some(path.into());
        let refreshed = self.refresh();
        // The folder list stays whatever the last snapshot said; don't trust it for the
        // next command (APPEND to a folder created since would answer TRYCREATE).
        self.dirty |= refreshed.is_err();
        let result = refreshed.and_then(|()| self.folder(path).map(|_| ()));
        if result.is_err() {
            self.clear_selection();
        }
        result
    }
    fn budget(&self) -> Result<(), store::Error> {
        if Instant::now() > self.deadline + self.page_wait.get() {
            Err(store::Error::Limit)
        } else {
            Ok(())
        }
    }
    fn header(&self, _: &str, e: &Entry) -> Result<Entry, store::Error> {
        self.budget()?;
        if let Some((raw, _)) = self.page.borrow().get(&e.uid) {
            let mut e = e.clone();
            e.raw = raw.clone();
            return Ok(e);
        }
        if let Some(raw) = self.headers.borrow().get(&e.uid) {
            let mut entry = e.clone();
            entry.raw = raw.clone();
            return Ok(entry);
        }
        let h = self.handles.get(&e.uid).ok_or(store::Error::Missing)?;
        let raw = self
            .api
            .call(json!({"op":"body","handle":h,"kid":self.principal.kid,"headers":true}))
            .map_err(|_| store::Error::Unavailable)?;
        let mut entry = e.clone();
        entry.raw = raw.into();
        if entry.raw.len() <= 8192 {
            let mut cache = self.headers.borrow_mut();
            if cache.len() >= 8 {
                cache.pop_first();
            }
            cache.insert(e.uid, entry.raw.clone());
        }
        Ok(entry)
    }
    fn materialize(&self, _: &str, e: &Entry) -> Result<Entry, store::Error> {
        if let Some((raw, true)) = self.page.borrow().get(&e.uid) {
            let mut e = e.clone();
            e.raw = raw.clone();
            return Ok(e);
        }
        let h = self.handles.get(&e.uid).ok_or(store::Error::Missing)?;
        let raw = self
            .api
            .call(json!({"op":"body","handle":h,"kid":self.principal.kid}))
            // 509: the API's fair-use download cap for this inbox (migration 246).
            .map_err(|s| {
                if s == 509 {
                    store::Error::DownloadLimit
                } else {
                    store::Error::Unavailable
                }
            })?;
        if raw.len() != e.size {
            return Err(store::Error::Unavailable);
        }
        let mut entry = e.clone();
        entry.raw = raw.into();
        Ok(entry)
    }
    fn folder(&self, p: &str) -> Result<&Folder, store::Error> {
        self.folders.get(p).ok_or(store::Error::Missing)
    }
    fn folders(&self) -> Vec<String> {
        self.folders.keys().cloned().collect()
    }
    fn edit_folder(&mut self, p: &str, op: FolderOp<'_>) -> Result<(), store::Error> {
        if matches!(op, FolderOp::Create) && self.keys.contains_key(p) {
            return Err(store::Error::Exists);
        }
        if !matches!(op, FolderOp::Create) && !self.keys.contains_key(p) {
            return Err(store::Error::Missing);
        }
        let (action, path, sub) = match op {
            FolderOp::Create => ("create", Some(p), None),
            FolderOp::Rename(n) => ("rename", Some(n), None),
            FolderOp::Delete => ("delete", None, None),
            FolderOp::Subscribe(b) => ("subscribe", None, Some(b)),
        };
        self.api.json::<Value>(json!({"op":"edit","kid":self.principal.kid,"folder":self.keys.get(p).map_or("",String::as_str),"action":action,"path":path,"sub":sub}))?;
        self.settle();
        Ok(())
    }
    fn change(&mut self, p: &str, c: Change<'_>) -> Result<Applied, store::Error> {
        let folder = self.keys.get(p).ok_or(store::Error::Missing)?;
        let mut arg = json!({"op":"mutate","kid":self.principal.kid,"folder":folder,"flags":[],"mode":"add","to":null,"uids":null});
        match c {
            Change::Flags(uids, mode, flags) => {
                arg["action"] = json!("flags");
                arg["flags"] = json!(flags);
                arg["uids"] = json!(uids);
                arg["mode"] = json!(match mode {
                    Mode::Add => "add",
                    Mode::Remove => "remove",
                    Mode::Replace => "replace",
                })
            }
            Change::Expunge(uids) => {
                arg["action"] = json!("expunge");
                // A plain EXPUNGE (or CLOSE) names every UID this snapshot holds; the API
                // keeps only the \Deleted ones. Batches then bound each statement, where a
                // NULL list would expunge a whole folder in one.
                arg["uids"] = match uids {
                    Some(u) => json!(u),
                    None => json!(
                        self.folder(p)?
                            .entries
                            .iter()
                            .map(|e| e.uid)
                            .collect::<Vec<_>>()
                    ),
                }
            }
            Change::Transfer(uids, to, moving) => {
                arg["action"] = json!(if moving { "move" } else { "copy" });
                arg["uids"] = json!(uids);
                arg["to"] = json!(self.keys.get(to).ok_or(store::Error::Missing)?);
                if !moving {
                    let fingerprint: [u8; 32] = Sha256::digest(
                        serde_json::to_vec(&(
                            &arg,
                            self.folder(p)?.validity,
                            self.folder(to)?.validity,
                        ))
                        .map_err(|_| store::Error::Unavailable)?,
                    )
                    .into();
                    if self
                        .pending_copy
                        .as_ref()
                        .is_none_or(|(hash, _)| *hash != fingerprint)
                    {
                        let mut nonce = [0u8; 16];
                        getrandom::fill(&mut nonce).map_err(|_| store::Error::Unavailable)?;
                        self.pending_copy = Some((
                            fingerprint,
                            json!({"nonce":hex::encode(nonce),"issued":chrono::Utc::now().timestamp()}),
                        ));
                    }
                    arg["ticket"] = self
                        .pending_copy
                        .as_ref()
                        .ok_or(store::Error::Unavailable)?
                        .1
                        .clone();
                }
            }
            Change::Append { date, flags, .. } => {
                if let Some(mut upload) = self.upload.take() {
                    let meta=STANDARD.encode(serde_json::to_vec(&json!({"kid":self.principal.kid,"folder":folder,"date":date.to_rfc3339(),"flags":flags,"size":upload.size})).map_err(|_|store::Error::Unavailable)?);
                    let scope = hex::encode(Sha256::digest(self.principal.kid.as_bytes()));
                    let api = &self.api;
                    let size = upload.size;
                    let a: Value = tokio::runtime::Handle::current().block_on(async {
                        let (body, hash) = upload
                            .finish()
                            .await
                            .map_err(|_| store::Error::Unavailable)?;
                        let ts = chrono::Utc::now().timestamp();
                        let mut mac = Hmac::<Sha256>::new_from_slice(api.key.as_bytes())
                            .map_err(|_| store::Error::Unavailable)?;
                        mac.update(
                            format!(
                                "POST\n/internal/v1/mail\n{ts}\n{hash}\n{scope}\n{}",
                                hex::encode(Sha256::digest(meta.as_bytes()))
                            )
                            .as_bytes(),
                        );
                        let r = api
                            .client
                            .post(&api.url)
                            .header("x-bane-append", meta)
                            .header("x-bane-scope", scope)
                            .header("x-bane-content", hash)
                            .header("x-bane-timestamp", ts.to_string())
                            .header("x-bane-signature", hex::encode(mac.finalize().into_bytes()))
                            .header("content-length", size)
                            .body(body)
                            .send()
                            .await
                            .map_err(|_| store::Error::Unavailable)?;
                        if !r.status().is_success() {
                            return Err(match r.status().as_u16() {
                                409 | 413 | 429 => store::Error::Limit,
                                403 | 422 => store::Error::Denied,
                                _ => store::Error::Unavailable,
                            });
                        }
                        r.json().await.map_err(|_| store::Error::Unavailable)
                    })?;
                    let a: AppliedWire =
                        serde_json::from_value(a).map_err(|_| store::Error::Unavailable)?;
                    self.settle();
                    return Ok(Applied {
                        pairs: a.pairs,
                        validity: a.validity,
                    });
                }
                return Err(store::Error::Denied);
            }
        }
        #[derive(serde::Deserialize)]
        struct AppliedWire {
            validity: u32,
            pairs: Vec<(u32, u32)>,
        }
        let mut out = Applied {
            validity: 0,
            pairs: vec![],
        };
        let arg_is_copy = arg["action"] == "copy";
        if let Some(Value::Array(uids)) = arg.get_mut("uids") {
            let all = std::mem::take(uids);
            if all.is_empty() {
                out.validity = self.folder(p)?.validity;
            }
            // Large sets go in batches of BATCH UIDs inside this one command: each batch is
            // one atomic API call with its own statement, its own 5 s budget and its own COPY
            // replay ticket (derived from the command's, so a retry replays the batches that
            // committed). Other connections get a turn between batches.
            let ticket = arg.get("ticket").cloned();
            for (i, batch) in all.chunks(BATCH).enumerate() {
                if i > 0 {
                    std::thread::yield_now();
                }
                self.deadline = Instant::now() + Duration::from_secs(5);
                arg["uids"] = Value::Array(batch.to_vec());
                if let Some(t) = &ticket {
                    arg["ticket"] = batch_ticket(t, i);
                }
                match self.api.json::<AppliedWire>(arg.clone()) {
                    Ok(a) => {
                        out.validity = a.validity;
                        out.pairs.extend(a.pairs)
                    }
                    // Nothing committed yet (that we know of): the plain error.
                    Err(e) if i == 0 => return Err(e),
                    // Earlier batches committed: show them, then fail the rest.
                    Err(_) => {
                        self.settle();
                        return Err(store::Error::Partial);
                    }
                }
            }
        } else {
            let a: AppliedWire = self.api.json(arg)?;
            out.validity = a.validity;
            out.pairs = a.pairs
        }
        self.settle();
        if arg_is_copy {
            self.pending_copy = None;
        }
        Ok(out)
    }
}
/// UIDs per internal mutation call (the API's per-statement bound for COPY receipts too).
const BATCH: usize = 1000;
/// The replay ticket of batch `i`: the command's issue time and a nonce derived from the
/// command's nonce, so each batch has its own receipt and a retry finds the same ones.
fn batch_ticket(t: &Value, i: usize) -> Value {
    let nonce = t["nonce"].as_str().unwrap_or_default();
    let derived = Sha256::digest(format!("{nonce}:{i}").as_bytes());
    json!({"nonce": hex::encode(&derived[..16]), "issued": t["issued"]})
}
impl Submitter for Store {
    fn submit(&mut self, s: Submission<'_>) -> Result<(), SubmitError> {
        self.api.call(json!({"op":"submit","kid":self.principal.kid,"from":s.sender,"to":s.recipients,"content":STANDARD.encode(s.raw)})).map(drop).map_err(|s|match s{402=>SubmitError::Balance,429=>SubmitError::Cap,400..500=>SubmitError::Rejected,_=>SubmitError::Unavailable})
    }
}
pub struct Offline;
impl Submitter for Offline {
    fn submit(&mut self, _: Submission<'_>) -> Result<(), SubmitError> {
        Err(SubmitError::Unavailable)
    }
}

pub async fn listen(
    url: &str,
    events: &crate::hints::Hints,
    api: &Api,
    ready: &tokio::sync::watch::Sender<bool>,
) -> Result<()> {
    let roots: tokio_rustls::rustls::RootCertStore =
        webpki_roots::TLS_SERVER_ROOTS.iter().cloned().collect();
    let tls = tokio_rustls::rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    // tokio-postgres calls TLS "require"; the rustls connector still verifies the CA and DNS name.
    let mut dsn = reqwest::Url::parse(url)?;
    let opts: Vec<_> = dsn
        .query_pairs()
        .filter(|(k, v)| !(k == "sslrootcert" && v == "system"))
        .map(|(k, v)| {
            let value = if k == "sslmode" && v == "verify-full" {
                "require".into()
            } else {
                v.into_owned()
            };
            (k.into_owned(), value)
        })
        .collect();
    dsn.set_query(None);
    if !opts.is_empty() {
        dsn.query_pairs_mut().extend_pairs(opts);
    }
    let cfg = dsn.as_str().parse::<tokio_postgres::Config>()?;
    ensure!(cfg.get_ssl_mode()==tokio_postgres::config::SslMode::Require || cfg.get_hosts().iter().all(|h|matches!(h,tokio_postgres::config::Host::Tcp(s) if s=="localhost"||s=="127.0.0.1")),"database TLS required");
    let (client, mut connection) = tokio::time::timeout(
        Duration::from_secs(10),
        cfg.connect(tokio_postgres_rustls::MakeRustlsConnect::new(tls)),
    )
    .await??;
    let pump = async {
        while let Some(msg) = futures_util::future::poll_fn(|cx| connection.poll_message(cx)).await
        {
            if let tokio_postgres::AsyncMessage::Notification(n) = msg? {
                api.notified(events, n.channel(), n.payload())
            }
        }
        Err::<(), _>(anyhow!("listener ended"))
    };
    tokio::select! {r=pump=>r,r=async{client.batch_execute("LISTEN bane_inbox_changed; LISTEN bane_protocol_auth").await?;api.invalidate(None);api.online.store(true,std::sync::atomic::Ordering::Release);ready.send_replace(true);std::future::pending::<Result<()>>().await}=>r}
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    /// A credential keeps its rate state for a minute after its last session. When the
    /// table is full that state gives way to the next login; a credential with an open
    /// session keeps its place and its lanes.
    #[test]
    fn a_full_credential_table_admits_the_next_login_and_keeps_open_sessions() {
        let api = Arc::new(Api::new("http://localhost".into(), "x".repeat(32)).unwrap());
        let login = |n: usize| {
            Store::new(
                api.clone(),
                Principal {
                    workspace: "w".into(),
                    account: "owner".into(),
                    inbox: "inbox".into(),
                    kid: format!("app{n}"),
                    addresses: vec![],
                    folders: vec![],
                    started: None,
                    cached: false,
                },
            )
        };
        let tracked = || api.gates.lock().unwrap().len();
        let open: Vec<_> = (0..3).map(|n| login(n).unwrap()).collect();
        for n in 3..GATES {
            drop(login(n).unwrap());
        }
        assert_eq!(tracked(), GATES);
        let returning = login(GATES - 1).unwrap();
        assert_eq!(tracked(), GATES);
        let next = login(GATES).unwrap();
        assert_eq!(tracked(), 5);
        let gates = api.gates.lock().unwrap();
        for session in open.iter().chain([&returning, &next]) {
            let gate = &gates[&session.principal.kid];
            assert!(Arc::ptr_eq(&gate.lanes.0[0], &session.lanes.0[0]));
            assert!(Arc::ptr_eq(&gate.lanes.0[2], &open[0].lanes.0[2]));
        }
    }
    #[tokio::test]
    async fn account_and_workspace_capacity_is_shared_and_waiters_are_fifo() {
        use crate::admission::{Reservation, Shares};
        use futures_util::FutureExt;
        let api = Arc::new(Api::new("http://localhost".into(), "x".repeat(32)).unwrap());
        let store = |kid: &str, w: &str, account: &str| {
            Store::new(
                api.clone(),
                Principal {
                    workspace: w.into(),
                    account: account.into(),
                    inbox: kid.into(),
                    kid: kid.into(),
                    addresses: vec![],
                    folders: vec![],
                    started: None,
                    cached: false,
                },
            )
            .unwrap()
        };
        let a = store("a", "w", "owner");
        let b = store("b", "w", "owner");
        let c = store("c", "other", "other_owner");
        let second_workspace = store("d", "w2", "owner");
        let sibling = store("a", "w", "owner");
        let responses = Arc::new(tokio::sync::Semaphore::new(6));
        let mut concurrent = vec![];
        for session in [&a, &sibling, &a] {
            concurrent.push(
                Reservation::take(
                    responses.clone(),
                    Some(session.lanes.pools(|s| &s.responses)),
                    1,
                )
                .await
                .unwrap(),
            );
        }
        assert_eq!(sibling.lanes.0[0].responses.available_permits(), 0);
        drop(concurrent);
        type Resource = fn(&Shares) -> &Arc<tokio::sync::Semaphore>;
        for (resource, global) in [
            ((|s| &s.responses) as Resource, 6),
            (|s| &s.data, 4),
            (|s| &s.uploads, 8),
            (|s| &s.views, 192 * 1024),
            (|s| &s.reads, 4),
        ] {
            let lanes = a.lanes.pools(resource);
            for (level, waiting_store) in [(2, &b), (3, &second_workspace)] {
                let share = lanes[level].available_permits();
                assert!(share < global);
                let held = lanes[level]
                    .clone()
                    .acquire_many_owned(share as u32)
                    .await
                    .unwrap();
                let pool = Arc::new(tokio::sync::Semaphore::new(global - share));
                let take =
                    |s: &Store| Reservation::take(pool.clone(), Some(s.lanes.pools(resource)), 1);
                let mut first = Box::pin(take(waiting_store));
                let mut second = Box::pin(take(&a));
                assert!(first.as_mut().now_or_never().is_none());
                assert!(second.as_mut().now_or_never().is_none());
                assert!(take(&c).await.is_some());
                let mut held = held;
                drop(held.split(1));
                let head = first.await.unwrap();
                assert!(second.as_mut().now_or_never().is_none());
                drop(head);
                assert!(second.await.is_some());
            }
        }
    }
    #[test]
    fn revoke_fences_only_the_inflight_login_for_that_inbox() {
        let t = Instant::now();
        let after = t + Duration::from_millis(1);
        let mut r = Revocations::default();
        r.record(Some("one"), after);
        assert!(!r.current("one", t, after));
        assert!(r.current("two", t, after));
        r.record(None, after);
        assert!(!r.current("two", t, after));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailgw_core::store::{Change, MailStore};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    type Mutation = (String, Vec<u64>, Option<String>);
    /// A scripted internal API: INBOX holds UID 1; snapshots fail while `down` is set.
    struct Script {
        down: AtomicBool,
        snapshots: AtomicUsize,
        /// Every mutate call: (action, UIDs, ticket nonce).
        mutations: Mutex<Vec<Mutation>>,
        /// Fail the mutate call with this 1-based index (before committing).
        fail_call: AtomicUsize,
    }
    fn reply(script: &Script, body: &[u8]) -> (u16, String) {
        let p: Value = serde_json::from_slice(body).unwrap_or_default();
        let meta = |next: u32, highest: u64| {
            json!([{"key":"inbox","path":"INBOX","validity":1,"next":next,"highest":highest,"subscribed":true,"total":1,"unseen":1},
                   {"key":"archive","path":"Archive","validity":4,"next":2,"highest":3,"subscribed":true,"total":1,"unseen":1}])
        };
        match p["op"].as_str() {
            // The login's folder list predates Archive; snapshots list it.
            Some("login") => (
                200,
                json!({"kid":"kid_test","inbox":"box_test","workspace":"ws_test","account":"owner_test","addresses":[],
                       "folders":[meta(2, 2)[0].clone()]})
                .to_string(),
            ),
            Some("snapshot") => {
                script.snapshots.fetch_add(1, Ordering::SeqCst);
                if script.down.load(Ordering::SeqCst) {
                    return (503, "{}".into());
                }
                let entries = if p["path"] == "INBOX" && p["since"] == 0 {
                    json!([{"uid":1,"modseq":2,"date":"2026-01-01T00:00:00+00:00","size":5,"flags":[],"handle":"h"}])
                } else {
                    json!([])
                };
                let body = json!({"folders": meta(2, 2), "entries": entries, "gone": [], "floor": 0, "more": null});
                (200, body.to_string())
            }
            Some("mutate") => {
                let uids: Vec<u64> = p["uids"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default();
                let mut log = script.mutations.lock().unwrap();
                log.push((
                    p["action"].as_str().unwrap_or_default().to_owned(),
                    uids.clone(),
                    p["ticket"]["nonce"].as_str().map(str::to_owned),
                ));
                if log.len() == script.fail_call.load(Ordering::SeqCst) {
                    return (503, "{}".into());
                }
                let pairs: Vec<[u64; 2]> = if p["action"] == "copy" {
                    uids.iter().map(|u| [*u, *u]).collect()
                } else {
                    vec![]
                };
                (200, json!({"pairs": pairs, "validity": 4}).to_string())
            }
            _ => (422, "{}".into()),
        }
    }
    async fn serve(l: tokio::net::TcpListener, script: Arc<Script>) {
        while let Ok((mut s, _)) = l.accept().await {
            let script = script.clone();
            tokio::spawn(async move {
                let mut buf = vec![];
                loop {
                    let mut chunk = [0u8; 4096];
                    let Ok(n) = s.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if buf.len() < end + 4 + len {
                        continue;
                    }
                    let body: Vec<u8> = buf.drain(..end + 4 + len).skip(end + 4).collect();
                    let (status, text) = reply(&script, &body);
                    let out = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\n\r\n{text}",
                        text.len()
                    );
                    if s.write_all(out.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    }
    fn principal() -> Principal {
        serde_json::from_value(json!({"kid":"kid_test","inbox":"box_test","workspace":"ws_test","account":"owner_test","addresses":["x@example.invalid"],
            "folders":[{"key":"inbox","path":"INBOX","validity":1,"next":2,"highest":2,"subscribed":true,"total":1,"unseen":1},
                       {"key":"archive","path":"Archive","validity":4,"next":1,"highest":1,"subscribed":true,"total":0,"unseen":0}]}))
        .unwrap()
    }

    /// Found by gateway/tear (witness: deliver, hint, A noop, fail-snapshot, A copy 1 Archive):
    /// the API committed the COPY, the refresh after it failed, and the client was told NO.
    #[test]
    fn a_committed_change_survives_a_failed_refresh() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _enter = rt.enter();
        let script = Arc::new(Script {
            down: false.into(),
            snapshots: 0.into(),
            mutations: Mutex::default(),
            fail_call: 0.into(),
        });
        let l = rt
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        rt.spawn(serve(l, script.clone()));
        let api = Arc::new(Api::new(url, "k".repeat(32)).unwrap());
        let mut store = Store::new(api, principal()).unwrap();
        store.select("INBOX").unwrap();
        assert_eq!(store.folder("INBOX").unwrap().entries.len(), 1);

        script.down.store(true, Ordering::SeqCst);
        let applied = store
            .change("INBOX", Change::Transfer(&[1], "Archive", false))
            .expect("a committed COPY must not report failure");
        assert_eq!(applied.pairs, vec![(1, 1)]);
        assert_eq!(applied.validity, 4);

        // The next command refreshes the snapshot it could not refresh before.
        script.down.store(false, Ordering::SeqCst);
        let before = script.snapshots.load(Ordering::SeqCst);
        let mut core = Imap::new(true);
        core.authenticated = true;
        let account =
            mailgw_core::session::Account::new("box_test".into(), vec![], "x".into(), true);
        let mut stale = false;
        let r = store
            .imap(
                &mut core,
                b"a NOOP\r\n",
                &account,
                &mut stale,
                store::Date::default(),
            )
            .unwrap();
        assert!(r.bytes.ends_with(b"a OK Completed\r\n"));
        assert_eq!(script.snapshots.load(Ordering::SeqCst), before + 1);
        assert_eq!(store.folder("Archive").unwrap().next, 2);
    }

    /// Found by gateway/tear (witness: B idle, fail-snapshot, hint, B wake, A create Work,
    /// fail-snapshot, B reconnect, B append Work). A login served from the 5 s cache carries
    /// the folder list of an earlier login, and a failed SELECT keeps whatever list the
    /// store had: an APPEND to a folder created since answered NO [TRYCREATE]. Now the next
    /// command other than SELECT refreshes first.
    #[test]
    fn a_cached_login_or_failed_select_refreshes_before_the_next_command() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _enter = rt.enter();
        let script = Arc::new(Script {
            down: false.into(),
            snapshots: 0.into(),
            mutations: Mutex::default(),
            fail_call: 0.into(),
        });
        let l = rt
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        rt.spawn(serve(l, script.clone()));
        let api = Arc::new(Api::new(url, "k".repeat(32)).unwrap());
        api.online.store(true, Ordering::Release);
        let proto = mailgw_core::session::Protocol::Imap;
        assert!(
            !api.login(
                "u@example.invalid",
                "pw",
                proto,
                Instant::now() + Duration::from_secs(5)
            )
            .unwrap()
            .cached
        );
        let p = api
            .login(
                "u@example.invalid",
                "pw",
                proto,
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap();
        assert!(p.cached);
        let mut store = Store::new(api, p).unwrap();
        assert!(store.folder("Archive").is_err());

        let mut core = Imap::new(true);
        core.authenticated = true;
        let account =
            mailgw_core::session::Account::new("box_test".into(), vec![], "x".into(), true);
        let mut stale = false;
        let mut run = |store: &mut Store, line: &[u8]| {
            let r = store
                .imap(
                    &mut core,
                    line,
                    &account,
                    &mut stale,
                    store::Date::default(),
                )
                .unwrap();
            String::from_utf8_lossy(&r.bytes).into_owned()
        };
        let text = run(&mut store, b"a STATUS Archive (MESSAGES)\r\n");
        assert!(text.contains("* STATUS \"Archive\" (MESSAGES 1)"), "{text}");
        assert_eq!(script.snapshots.load(Ordering::SeqCst), 1);
        assert_eq!(run(&mut store, b"b NOOP\r\n"), "b OK Completed\r\n");
        assert_eq!(
            script.snapshots.load(Ordering::SeqCst),
            1,
            "fresh: no refresh"
        );

        // A failed SELECT: the next command refreshes first.
        script.down.store(true, Ordering::SeqCst);
        assert!(run(&mut store, b"c SELECT INBOX\r\n").starts_with("c NO"));
        script.down.store(false, Ordering::SeqCst);
        let before = script.snapshots.load(Ordering::SeqCst);
        assert_eq!(run(&mut store, b"d NOOP\r\n"), "d OK Completed\r\n");
        assert_eq!(script.snapshots.load(Ordering::SeqCst), before + 1);
    }

    /// Large STORE/COPY/EXPUNGE sets run in 1,000-UID batches inside one command, each its own
    /// call (a refused "STORE 1:*" broke "mark all read" in real clients). A batch failing
    /// after others committed answers Partial; a COPY retry sends the same per-batch tickets,
    /// so the API replays the batches it already committed.
    #[test]
    fn large_sets_run_in_batches_and_a_copy_retry_replays_them() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let _enter = rt.enter();
        let script = Arc::new(Script {
            down: false.into(),
            snapshots: 0.into(),
            mutations: Mutex::default(),
            fail_call: 0.into(),
        });
        let l = rt
            .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
            .unwrap();
        let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        rt.spawn(serve(l, script.clone()));
        let api = Arc::new(Api::new(url, "k".repeat(32)).unwrap());
        let mut store = Store::new(api, principal()).unwrap();
        store.select("INBOX").unwrap();
        let uids: Vec<u32> = (1..=2500).collect();
        let sizes = |from: usize| -> Vec<usize> {
            script.mutations.lock().unwrap()[from..]
                .iter()
                .map(|m| m.1.len())
                .collect()
        };

        let flags = mailgw_core::store::Flags::from(["\\Seen".to_owned()]);
        store
            .change(
                "INBOX",
                Change::Flags(&uids, mailgw_core::store::Mode::Add, flags.clone()),
            )
            .unwrap();
        assert_eq!(sizes(0), [1000, 1000, 500]);

        // The second batch fails: the first stays committed, the snapshot is refreshed.
        script.fail_call.store(5, Ordering::SeqCst);
        let before = script.snapshots.load(Ordering::SeqCst);
        let r = store.change(
            "INBOX",
            Change::Flags(&uids, mailgw_core::store::Mode::Add, flags),
        );
        assert!(matches!(r, Err(store::Error::Partial)));
        assert_eq!(sizes(3), [1000, 1000]);
        assert!(script.snapshots.load(Ordering::SeqCst) > before);

        // COPY: batch two fails; the retry carries the same three batch tickets.
        script.mutations.lock().unwrap().clear();
        script.fail_call.store(2, Ordering::SeqCst);
        let r = store.change("INBOX", Change::Transfer(&uids, "Archive", false));
        assert!(matches!(r, Err(store::Error::Partial)));
        script.fail_call.store(0, Ordering::SeqCst);
        let a = store
            .change("INBOX", Change::Transfer(&uids, "Archive", false))
            .unwrap();
        assert_eq!(a.pairs.len(), 2500);
        let log = script.mutations.lock().unwrap().clone();
        let nonces: Vec<_> = log.iter().map(|m| m.2.clone().unwrap()).collect();
        assert_eq!(
            log.iter().map(|m| m.1.len()).collect::<Vec<_>>(),
            [1000, 1000, 1000, 1000, 500]
        );
        assert_eq!(
            nonces[..2],
            nonces[2..4],
            "a retry must reuse the batch tickets"
        );
        assert_ne!(nonces[2], nonces[3], "each batch has its own receipt");
        // A new COPY after success gets a new ticket.
        store
            .change("INBOX", Change::Transfer(&uids[..1], "Archive", false))
            .unwrap();
        assert_ne!(
            script.mutations.lock().unwrap().last().unwrap().2.as_ref(),
            Some(&nonces[0])
        );

        // A plain EXPUNGE names the snapshot's UIDs instead of a NULL (whole folder) list.
        script.mutations.lock().unwrap().clear();
        store.change("INBOX", Change::Expunge(None)).unwrap();
        assert_eq!(script.mutations.lock().unwrap()[0].1, [1]);
    }

    /// Found by gateway/tear (witness with one credential: B append Work, A append Work,
    /// A append INBOX), and fixed upstream in 20222d4 (finish_command): a refused APPEND kept
    /// its spool and upload reservation, so the credential's next APPEND could not get one.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_append_releases_its_upload() {
        let api = Arc::new(Api::new("http://127.0.0.1:9".into(), "k".repeat(32)).unwrap());
        let mut store = Store::new(api, principal()).unwrap();
        let global = Arc::new(tokio::sync::Semaphore::new(8));
        let lanes = store.lanes.pools(|s| &s.uploads);
        let free = lanes.each_ref().map(|l| l.available_permits());
        let reservation =
            crate::admission::Reservation::take(global.clone(), Some(lanes.clone()), 1)
                .await
                .unwrap();
        store.upload = Some(crate::upload::Upload::new(5, reservation).unwrap());
        assert_eq!(lanes[0].available_permits(), free[0] - 1);
        let mut core = Imap::new(true);
        core.authenticated = true;
        let account =
            mailgw_core::session::Account::new("box_test".into(), vec![], "x".into(), true);
        let r = tokio::task::block_in_place(|| {
            store.imap(
                &mut core,
                b"a APPEND Nowhere {0+}\r\n\r\n",
                &account,
                &mut false,
                store::Date::default(),
            )
        })
        .unwrap();
        assert!(r.bytes.starts_with(b"a NO [TRYCREATE]"));
        assert!(store.upload.is_none());
        assert_eq!(lanes.each_ref().map(|l| l.available_permits()), free);
        assert_eq!(global.available_permits(), 8);
    }
}
