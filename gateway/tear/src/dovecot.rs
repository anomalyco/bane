//! Conformance against Dovecot 2.3 (the digest-pinned image `e2e.py` uses) on generated
//! traces. The same model and traces run on two products:
//!
//! 1. Dovecot over TCP (a fresh user per trace, an observer connection that reads the server
//!    truth with EXAMINE and FETCH after every step). A mismatch here is a place where the
//!    model's RFC 3501 reading disagrees with a reference server.
//! 2. The gateway core over the Memory store, then tear's checkpointed campaign with
//!    Dovecot as the `base`: a gateway mismatch is classified `target-only` (a gateway bug) or
//!    `also-on-base` (the model, or behavior both servers share).
//!
//! Comparisons are at sync points only (the mirror after SELECT/NOOP/EXPUNGE/MOVE/APPEND and
//! the server truth every step). The alphabet leaves out what differs by design or by timing:
//! COPY (Bane shares ordinary flags across copies, Dovecot copies them), IDLE (Dovecot pushes
//! asynchronously), folder create/delete (Bane ends a session whose folder vanished). `\Recent`
//! is dropped from every FLAGS list. The client NOOPs before each sequence-addressed command
//! (`Config::eager`), because Dovecot announces changes after any command and Bane only at
//! sync points; the NOOP gives both servers the same view of "1" and "1:*".
//!
//! Documented differences, left out of the alphabet after a first run found them:
//! - a sequence set naming messages that do not exist (`FETCH 1`, `STORE 1:*` on an empty
//!   mailbox): Dovecot answers BAD, Bane answers OK with no data;
//! - EXPUNGE, MOVE and UID EXPUNGE in a mailbox opened with EXAMINE: Dovecot answers OK and
//!   changes nothing, Bane answers BAD.
//!
//! Dovecot 2.3.21 diverges from RFC 3501 6.4.3 in one place the model checks: an EXPUNGE
//! that removes a message the session was never told about announces it with EXISTS but
//! sends no EXPUNGE before the OK (witness: deliver, B uid-store +deleted 1, deliver,
//! A expunge). Such a trace mismatches on Dovecot and matches on the gateway.
use crate::{
    Check,
    client::{Client, Kind},
    model::{Act, Config, FLAG_NAMES, FOLDERS, Flags, Set, alphabet, parse},
};
use serde_json::{Value, json};
use statecheck::{Error, Host, R, conformance};
use std::{
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

const IMAGE: &str =
    "dovecot/dovecot@sha256:547d28f9a893c93a1d2f6dc164880cd7bfa74009106dfa46b36a6a2ee636d921";
const PASSWORD: &str = "fixture-secret";

pub fn config() -> Config {
    let mut c = Config::memory();
    c.folders = false;
    c.idle = false;
    c.copy = false;
    c.eager = true;
    // EXPUNGE, MOVE and UID EXPUNGE under EXAMINE: Dovecot answers OK (no-op), Bane BAD.
    c.examine = false;
    c
}

/// A running Dovecot container; removed on drop.
pub struct Server {
    id: String,
    port: u16,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.id]).output();
    }
}
fn docker(args: &[&str]) -> R<String> {
    let out = Command::new("docker")
        .args(args)
        .output()
        .map_err(|e| Error::new(format!("docker: {e}")))?;
    if !out.status.success() {
        return Err(Error::new(format!(
            "docker {}: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
impl Server {
    pub fn start() -> R<Self> {
        let dir = std::env::temp_dir().join(format!("mailgw-tear-dovecot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| Error::new(e.to_string()))?;
        let conf = format!(
            "protocols = imap\nlisten = *\nssl = no\ndisable_plaintext_auth = no\n\
             default_vsz_limit = 0\nservice imap-login {{\n vsz_limit = 0\n}}\nservice auth {{\n vsz_limit = 0\n}}\n\
             mail_location = maildir:/tmp/mail/%u\nmail_uid = 1000\nmail_gid = 1000\nfirst_valid_uid = 1\n\
             mail_max_userip_connections = 100\nlog_path = /dev/stderr\n\
             passdb {{\n driver = static\n args = password={PASSWORD}\n}}\n\
             userdb {{\n driver = static\n args = uid=1000 gid=1000 home=/tmp/mail/%u\n}}\n"
        );
        std::fs::write(dir.join("dovecot.conf"), conf).map_err(|e| Error::new(e.to_string()))?;
        let mount = format!("{}:/fixture:ro", dir.display());
        let id = docker(&[
            "run",
            "-d",
            "--platform",
            "linux/amd64",
            "-p",
            "127.0.0.1::143",
            "-v",
            &mount,
            IMAGE,
            "/usr/sbin/dovecot",
            "-F",
            "-c",
            "/fixture/dovecot.conf",
        ])?;
        let id = id.lines().last().unwrap_or_default().to_owned();
        let mut server = Self { id, port: 0 };
        let port = docker(&["port", &server.id, "143"])?;
        server.port = port
            .lines()
            .next()
            .and_then(|l| l.rsplit(':').next()?.parse().ok())
            .ok_or_else(|| Error::new(format!("no port mapping: {port}")))?;
        let end = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(mut s) = TcpStream::connect(("127.0.0.1", server.port)) {
                s.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut b = [0u8; 64];
                if s.read(&mut b).is_ok_and(|n| b[..n].starts_with(b"* OK")) {
                    return Ok(server);
                }
            }
            if Instant::now() > end {
                return Err(Error::new(format!(
                    "dovecot did not start: {}",
                    docker(&["logs", &server.id]).unwrap_or_default()
                )));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    pub fn version(&self) -> String {
        docker(&["exec", &self.id, "/usr/sbin/dovecot", "--version"]).unwrap_or_default()
    }
}

struct Conn {
    stream: TcpStream,
    buf: Vec<u8>,
}
impl Conn {
    fn open(port: u16) -> R<Self> {
        let stream =
            TcpStream::connect(("127.0.0.1", port)).map_err(|e| Error::new(e.to_string()))?;
        stream.set_nodelay(true).ok();
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let mut c = Self {
            stream,
            buf: vec![],
        };
        c.until(|b| b.ends_with(b"\r\n"))?;
        c.buf.clear();
        Ok(c)
    }
    fn until(&mut self, done: impl Fn(&[u8]) -> bool) -> R<()> {
        while !done(&self.buf) {
            let mut chunk = [0u8; 65536];
            let n = self
                .stream
                .read(&mut chunk)
                .map_err(|e| Error::new(format!("dovecot read: {e}")))?;
            if n == 0 {
                return Err(Error::new("dovecot closed the connection"));
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
        Ok(())
    }
    /// Send bytes and read through the tagged response (or a continuation).
    fn exchange(&mut self, tag: &str, bytes: &[u8]) -> R<Vec<u8>> {
        self.stream
            .write_all(bytes)
            .map_err(|e| Error::new(e.to_string()))?;
        let marker = format!("{tag} ");
        self.until(|b| {
            b.ends_with(b"\r\n")
                && (b.starts_with(marker.as_bytes())
                    || b.windows(marker.len() + 2)
                        .any(|w| w.starts_with(b"\r\n") && &w[2..] == marker.as_bytes()))
        })?;
        Ok(std::mem::take(&mut self.buf))
    }
}

static USERS: AtomicU64 = AtomicU64::new(0);

/// Product fixture over Dovecot: sessions A and B plus an observer for deliveries and truth.
pub struct Fixture {
    clients: Vec<Client>,
    conns: Vec<Conn>,
    observer: Conn,
    tag: u32,
    serial: u32,
    safety: Vec<String>,
}
impl Fixture {
    pub fn open(port: u16, sessions: usize) -> R<Self> {
        let user = format!(
            "t{}x{}",
            std::process::id(),
            USERS.fetch_add(1, Ordering::Relaxed)
        );
        let mut f = Self {
            clients: crate::model::SESSIONS[..sessions]
                .iter()
                .map(|n| Client::new(n))
                .collect(),
            conns: vec![],
            observer: Conn::open(port)?,
            tag: 0,
            serial: 0,
            safety: vec![],
        };
        f.observe(&format!("LOGIN {user} {PASSWORD}"))?;
        f.observe("CREATE Archive")?;
        for s in 0..sessions {
            let mut c = Conn::open(port)?;
            let r = c.exchange("l", format!("l LOGIN {user} {PASSWORD}\r\n").as_bytes())?;
            if !String::from_utf8_lossy(&r).contains("l OK") {
                return Err(Error::new("dovecot login failed"));
            }
            f.conns.push(c);
            if !f.select(s, "INBOX", false)? {
                return Err(Error::new("dovecot select failed"));
            }
        }
        f.safety.clear();
        Ok(f)
    }
    fn observe(&mut self, body: &str) -> R<Vec<u8>> {
        self.tag += 1;
        let tag = format!("o{}", self.tag);
        self.observer
            .exchange(&tag, format!("{tag} {body}\r\n").as_bytes())
    }
    fn command(&mut self, s: usize, body: &str, kind: Kind) -> R<bool> {
        let tag = self.clients[s].next_tag();
        self.raw(s, &tag, format!("{tag} {body}\r\n").as_bytes(), kind)
    }
    fn raw(&mut self, s: usize, tag: &str, bytes: &[u8], kind: Kind) -> R<bool> {
        let r = self.conns[s].exchange(tag, bytes)?;
        if kind == Kind::Select {
            self.clients[s].reset();
        }
        Ok(self.clients[s].absorb_all(&r, kind, &mut self.safety) == ["OK"])
    }
    fn fill(&mut self, s: usize) -> R<bool> {
        let Some((lo, hi)) = self.clients[s].unknown_range() else {
            return Ok(true);
        };
        self.command(s, &format!("FETCH {lo}:{hi} (UID FLAGS)"), Kind::NoExpunge)
    }
    fn select(&mut self, s: usize, folder: &str, ro: bool) -> R<bool> {
        let verb = if ro { "EXAMINE" } else { "SELECT" };
        self.clients[s].reset();
        Ok(self.command(s, &format!("{verb} {folder}"), Kind::Select)? && self.fill(s)?)
    }
    fn message(&mut self) -> Vec<u8> {
        self.serial += 1;
        let n = self.serial;
        format!("From: a@example.invalid\r\nTo: tear@example.invalid\r\nSubject: m{n}\r\nMessage-ID: <m{n}@example.invalid>\r\n\r\nbody {n}\r\n").into_bytes()
    }
    fn append(&mut self, s: Option<usize>, folder: &str) -> R<bool> {
        let raw = self.message();
        let tag = match s {
            Some(s) => self.clients[s].next_tag(),
            None => {
                self.tag += 1;
                format!("o{}", self.tag)
            }
        };
        let mut line = format!("{tag} APPEND {folder} {{{}+}}\r\n", raw.len()).into_bytes();
        line.extend(&raw);
        line.extend(b"\r\n");
        match s {
            Some(s) => Ok(self.raw(s, &tag, &line, Kind::Plain)? && self.fill(s)?),
            None => Ok(
                String::from_utf8_lossy(&self.observer.exchange(&tag, &line)?)
                    .contains(&format!("{tag} OK")),
            ),
        }
    }
    fn server(&mut self) -> R<Value> {
        let mut out = serde_json::Map::new();
        for name in ["INBOX", "Archive"] {
            let r =
                String::from_utf8_lossy(&self.observe(&format!("EXAMINE {name}"))?).into_owned();
            let next: u32 = r
                .split("[UIDNEXT ")
                .nth(1)
                .and_then(|x| x.split(']').next()?.parse().ok())
                .unwrap_or(0);
            let exists: usize = r
                .lines()
                .find_map(|l| l.strip_prefix("* ")?.strip_suffix(" EXISTS")?.parse().ok())
                .unwrap_or(0);
            let mut entries: Vec<(u32, Flags)> = vec![];
            if exists > 0 {
                let mut c = Client::new("observer");
                c.mirror.resize(exists, None);
                let bytes = self.observe(&format!("FETCH 1:{exists} (UID FLAGS)"))?;
                c.absorb_all(&bytes, Kind::NoExpunge, &mut vec![]);
                entries = c.mirror.into_iter().flatten().collect();
            }
            out.insert(name.into(), json!({"next": next, "entries": entries}));
        }
        out.insert("Work".into(), Value::Null);
        out.insert("Trash".into(), json!({"next": 1, "entries": []}));
        Ok(Value::Object(out))
    }
    pub fn act(&mut self, label: &str) -> R<Value> {
        let act = parse(label).ok_or_else(|| Error::new(format!("unknown action {label}")))?;
        self.safety.clear();
        let mut sync = None;
        use Act::*;
        if let Some(s) = act.session()
            && act.addresses()
            && !(self.command(s, "NOOP", Kind::Plain)? && self.fill(s)?)
        {
            return Err(Error::new("dovecot NOOP failed"));
        }
        let ok = match act {
            Deliver => self.append(None, "INBOX")?,
            Select { s, f, ro } => {
                sync = Some(s);
                self.select(s, FOLDERS[f], ro)?
            }
            Noop(s) => {
                let ok = self.command(s, "NOOP", Kind::Plain)? && self.fill(s)?;
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
                let ok = self.command(s, &body, if uid { Kind::Plain } else { Kind::NoExpunge })?;
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
                self.command(s, &body, if uid { Kind::Plain } else { Kind::NoExpunge })?
            }
            Expunge(s) | UidExpunge(s) => {
                let cmd = if matches!(act, Expunge(_)) {
                    "EXPUNGE"
                } else {
                    "UID EXPUNGE 1:*"
                };
                let ok = self.command(s, cmd, Kind::Plain)? && self.fill(s)?;
                sync = ok.then_some(s);
                ok
            }
            Close(s) | Unselect(s) => {
                let cmd = if matches!(act, Close(_)) {
                    "CLOSE"
                } else {
                    "UNSELECT"
                };
                let ok = self.command(s, cmd, Kind::Plain)?;
                if ok {
                    self.clients[s].reset();
                }
                sync = ok.then_some(s);
                ok
            }
            Transfer { s, to, moving, uid } => {
                let set = if uid {
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
                let ok = self.command(s, &body, Kind::Plain)? && self.fill(s)?;
                sync = ok.then_some(s);
                ok
            }
            Append(s, f) => {
                let ok = self.append(Some(s), FOLDERS[f])?;
                sync = ok.then_some(s);
                ok
            }
            other => {
                return Err(Error::new(format!(
                    "not in the Dovecot alphabet: {other:?}"
                )));
            }
        };
        for c in &self.clients {
            c.check_order(&mut self.safety);
        }
        let mut v = json!({"ok": ok, "safety": self.safety, "server": self.server()?, "gone": Vec::<&str>::new()});
        if let Some(s) = sync {
            v["mirror"] = json!({crate::model::SESSIONS[s]: self.clients[s].view()});
        }
        Ok(v)
    }
}

/// Conformance host over Dovecot: the same model callbacks as the gateway host.
pub struct DovecotHost {
    pub model: Check,
    pub port: u16,
    pub fixture: Option<Fixture>,
}
impl Host for DovecotHost {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        match name {
            "id" => Ok(json!("bane.imap.memory-mirror")),
            "open" => {
                self.fixture = Some(Fixture::open(self.port, self.model.cfg.sessions)?);
                Ok(Value::Null)
            }
            "act" => self
                .fixture
                .as_mut()
                .ok_or_else(|| Error::new("no open fixture"))?
                .act(args[1].as_str().unwrap_or_default()),
            "close" => {
                self.fixture = None;
                Ok(Value::Null)
            }
            _ => self.model.call(name, args),
        }
    }
}

pub fn run(n: u64, len: usize, seed: u64, deadline: Option<Instant>, _o: &crate::Opts) -> R<Value> {
    let start = Instant::now();
    let cfg = config();
    let server = Server::start()?;
    let version = server.version();
    let labels = alphabet(&cfg);
    let traces: Vec<Vec<String>> = (0..n)
        .map(|i| {
            crate::walk(
                seed.wrapping_mul(0x1000_0000).wrapping_add(i),
                len,
                &labels,
                &cfg,
            )
        })
        .collect();
    // 1. Dovecot against the model.
    let mut dovecot = DovecotHost {
        model: Check::new(cfg),
        port: server.port,
        fixture: None,
    };
    let reference = crate::campaign(
        "Dovecot 2.3 vs the model",
        traces.clone().into_iter(),
        &mut dovecot,
        deadline,
    )?;
    // 2. The gateway against the model on the same traces, Dovecot as the campaign base.
    let dir = PathBuf::from(
        std::env::var("TEAR_CHECKPOINTS").unwrap_or_else(|_| "target/tear-campaigns".into()),
    );
    let spec = json!({
        "product": format!("mailgw-core {}", env!("CARGO_PKG_VERSION")),
        "model": "bane.imap.memory-mirror (conformance alphabet)",
        "host": "gateway/tear fixture.rs",
        "base": format!("dovecot {version}"),
        "maxReplays": 64,
        "cases": traces.iter().enumerate().map(|(i, t)| json!({"id": i, "actions": t})).collect::<Vec<_>>(),
    });
    let mut target = Check::new(cfg);
    let mut base = DovecotHost {
        model: Check::new(cfg),
        port: server.port,
        fixture: None,
    };
    let mut events = 0u64;
    let campaign = statecheck::campaign::run(
        &dir.join(format!("seed-{seed}-{n}-{len}")),
        &spec,
        &mut target,
        Some(&mut base),
        &mut |_| {
            events += 1;
            Ok(())
        },
    )?;
    let records = campaign["records"].as_array().cloned().unwrap_or_default();
    let classes: Vec<Value> = records
        .iter()
        .filter(|r| r["outcome"] != "match")
        .map(|r| json!({"id": r["id"], "outcome": r["outcome"], "base": r["baseStatus"], "mismatch": r["original"]["mismatch"]}))
        .collect();
    let mismatched = reference["mismatched"].as_u64().unwrap_or(0) + classes.len() as u64;
    let _ = conformance::dispatch;
    Ok(json!({
        "campaign": format!("conformance, {version}"), "traces": n, "mismatched": mismatched,
        "errors": reference["errors"], "steps": reference["steps"],
        "dovecot": reference, "gateway": {"verdict": campaign["verdict"], "fingerprint": campaign["fingerprint"],
            "reused": campaign["reused"], "timingUs": campaign["timingUs"], "notMatching": classes},
        "totalMs": start.elapsed().as_millis() as u64,
    }))
}
