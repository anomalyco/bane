//! Request-scoped gateway adapters. Core methods are synchronous; the shell invokes
//! them on a Tokio blocking region, never with a shared store mutex held.
use anyhow::{Result, anyhow, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use mailgw_core::{
    session::{Identity, Protocol},
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
    pub kid: String,
    pub inbox: String,
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
}
type WakeCache = HashMap<(String, Option<String>), Arc<std::sync::OnceLock<Option<Snapshot>>>>;
pub struct Api {
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
            online: false.into(),
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
        let b = serde_json::to_vec(&p).map_err(|_| 500u16)?;
        let hash = hex::encode(Sha256::digest(&b));
        let ts = chrono::Utc::now().timestamp().to_string();
        let mut mac = Hmac::<Sha256>::new_from_slice(self.key.as_bytes()).map_err(|_| 500u16)?;
        mac.update(format!("POST\n/internal/v1/mail\n{ts}\n{hash}").as_bytes());
        let req = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("x-bane-content", hash)
            .header("x-bane-timestamp", ts)
            .header("x-bane-signature", hex::encode(mac.finalize().into_bytes()))
            .body(b);
        tokio::runtime::Handle::current().block_on(async {
            let mut r = req.send().await.map_err(|_| 503u16)?;
            if !r.status().is_success() {
                return Err(r.status().as_u16());
            }
            let mut out = vec![];
            while let Some(chunk) = r.chunk().await.map_err(|_| 503u16)? {
                if out.len() + chunk.len() > 48 << 20 {
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
    pub fn clear(&self) {
        if let Ok(mut c) = self.cache.lock() {
            c.clear()
        }
    }
    fn login(&self, user: &str, password: &str, proto: Protocol) -> Option<Principal> {
        if !self.online.load(std::sync::atomic::Ordering::Acquire) {
            return None;
        }
        let p = if proto == Protocol::Imap {
            "imap"
        } else {
            "smtp"
        };
        let mut hash = Hmac::<Sha256>::new_from_slice(self.key.as_bytes()).ok()?;
        for x in [p, user, password] {
            hash.update(&(x.len() as u64).to_be_bytes());
            hash.update(x.as_bytes())
        }
        let k: [u8; 32] = hash.finalize().into_bytes().into();
        if let Some((_, v)) = self
            .cache
            .lock()
            .ok()?
            .get(&k)
            .filter(|(t, _)| t.elapsed() < Duration::from_secs(5))
        {
            return Some(v.clone());
        }
        let principal: Principal = self
            .json(json!({"op":"login","protocol":p,"user":user,"password":password}))
            .ok()?;
        let mut c = self.cache.lock().ok()?;
        if c.len() >= 1024 {
            c.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(5))
        }
        if c.len() < 1024 {
            c.insert(k, (Instant::now(), principal.clone()));
        }
        Some(principal)
    }
}
pub struct Login {
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
        let Some(v) = self.api.login(u, pw, p) else {
            return false;
        };
        let Ok(mut slot) = self.principal.lock() else {
            return false;
        };
        *slot = Some(v);
        true
    }
}
pub struct Store {
    api: Arc<Api>,
    pub principal: Principal,
    folders: BTreeMap<String, Folder>,
    keys: BTreeMap<String, String>,
    handles: BTreeMap<u32, String>,
    selected: Option<String>,
    pub stamp: Instant,
}
impl Store {
    pub fn new(api: Arc<Api>, p: Principal) -> Self {
        let meta = p.folders.clone();
        let mut s = Self {
            api,
            principal: p,
            folders: BTreeMap::new(),
            keys: BTreeMap::new(),
            handles: BTreeMap::new(),
            selected: None,
            stamp: Instant::now(),
        };
        s.install(meta);
        s
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
    pub fn refresh(&mut self) -> Result<(), store::Error> {
        self.reload(false)
    }
    pub fn reload(&mut self, wake: bool) -> Result<(), store::Error> {
        let read = || {
            self.api.json::<Snapshot>(
                json!({"op":"snapshot","kid":self.principal.kid,"path":self.selected}),
            )
        };
        let snap = if wake {
            let cell = {
                let mut m = self
                    .api
                    .wakes
                    .lock()
                    .map_err(|_| store::Error::Unavailable)?;
                if m.len() >= 64 {
                    m.clear()
                }
                m.entry((self.principal.kid.clone(), self.selected.clone()))
                    .or_default()
                    .clone()
            };
            cell.get_or_init(|| read().ok())
                .clone()
                .ok_or(store::Error::Unavailable)?
        } else {
            read()?
        };
        self.install(snap.folders);
        self.handles.clear();
        if let Some(f) = self.selected.as_ref().and_then(|p| self.folders.get_mut(p)) {
            for m in snap.entries {
                if let Some(h) = m.handle {
                    self.handles.insert(m.uid, h);
                }
                f.entries.push(Entry {
                    size: m.size,
                    uid: m.uid,
                    id: 0,
                    date: m.date,
                    flags: m.flags,
                    modseq: m.modseq,
                    raw: Arc::default(),
                });
            }
        }
        self.stamp = Instant::now();
        Ok(())
    }
}
impl MailStore for Store {
    fn list_fresh(&mut self) -> Result<(), store::Error> {
        self.refresh()
    }
    fn select(&mut self, path: &str) -> Result<(), store::Error> {
        self.selected = Some(path.into());
        self.refresh()
    }
    fn materialize(&self, _: &str, e: &Entry) -> Result<Entry, store::Error> {
        let h = self.handles.get(&e.uid).ok_or(store::Error::Missing)?;
        let raw = self
            .api
            .call(json!({"op":"body","handle":h}))
            .map_err(|_| store::Error::Unavailable)?;
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
        self.refresh()
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
                arg["uids"] = json!(uids)
            }
            Change::Transfer(uids, to, moving) => {
                arg["action"] = json!(if moving { "move" } else { "copy" });
                arg["uids"] = json!(uids);
                arg["to"] = json!(self.keys.get(to).ok_or(store::Error::Missing)?)
            }
            Change::Append {
                raw, date, flags, ..
            } => {
                arg = json!({"op":"append","kid":self.principal.kid,"folder":folder,"date":date.to_rfc3339(),"flags":flags,"content":STANDARD.encode(raw)})
            }
        }
        #[derive(Deserialize)]
        struct AppliedWire {
            validity: u32,
            pairs: Vec<(u32, u32)>,
        }
        let a: AppliedWire = self.api.json(arg)?;
        self.refresh()?;
        Ok(Applied {
            validity: a.validity,
            pairs: a.pairs,
        })
    }
}
impl Submitter for Store {
    fn submit(&mut self, s: Submission<'_>) -> Result<(), SubmitError> {
        self.api.call(json!({"op":"submit","kid":self.principal.kid,"from":s.sender,"to":s.recipients,"content":STANDARD.encode(s.raw)})).map(drop).map_err(|s|match s{429|402=>SubmitError::Cap,400..500=>SubmitError::Rejected,_=>SubmitError::Unavailable})
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
    events: &tokio::sync::broadcast::Sender<(String, bool)>,
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
                if let Ok(mut m) = api.wakes.lock() {
                    m.clear()
                }
                let auth = n.channel() == "bane_protocol_auth";
                if auth {
                    api.clear()
                }
                drop(events.send((n.payload().into(), auth)));
            }
        }
        Err::<(), _>(anyhow!("listener ended"))
    };
    tokio::select! {r=pump=>r,r=async{client.batch_execute("LISTEN bane_inbox_changed; LISTEN bane_protocol_auth").await?;api.clear();api.online.store(true,std::sync::atomic::Ordering::Release);ready.send_replace(true);std::future::pending::<Result<()>>().await}=>r}
}
