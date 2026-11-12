//! A deterministic in-process fake of Bane's internal mail RPC (`POST /internal/v1/mail`),
//! served over loopback HTTP so the gateway's real signed `reqwest` path runs unchanged.
//!
//! It re-implements the phase-2 SQL contract the gateway relies on (`api/src/mail-gateway.ts`,
//! `mailgw_mutate`, `inbox_mutate`, `inbox_edit_folder`, `mailgw_append`, the snapshot query):
//! one inbox-wide MODSEQ per mutated UID, shared message flags with per-entry `\Deleted`,
//! tombstones with a pruning floor, deleted custom folders' last copies moved to Trash,
//! `since`/`after` snapshot paging. Pages hold `page` rows (2 by default, not 2048) so the
//! gateway's paging and page-consistency checks run on every small folder.
//!
//! Faults are explicit and one-shot: a failing snapshot read, a revoked credential.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const KEY: &str = "tear-fixture-gateway-key-0123456789abcdef";
pub const INBOX_ID: &str = "box_tear";
pub const ADDRESSES: [&str; 2] = ["tear@example.invalid", "alias@example.invalid"];

const FIELDS: [&str; 7] = [
    "flagged",
    "answered",
    "draft",
    "forwarded",
    "junk",
    "notJunk",
    "mdnSent",
];
const NAMES: [&str; 7] = [
    "\\Flagged",
    "\\Answered",
    "\\Draft",
    "$Forwarded",
    "$Junk",
    "$NotJunk",
    "$MDNSent",
];
const RESERVED: [&str; 3] = ["unverified", "spam", "guard-allowed"];

#[derive(Clone, Debug)]
pub struct FEntry {
    pub uid: u32,
    pub mid: u64,
    pub modseq: u64,
    pub deleted: bool,
}
#[derive(Clone, Debug)]
pub struct FFolder {
    pub role: String,
    pub custom: Option<String>,
    pub validity: u32,
    pub next: u32,
    pub highest: u64,
    pub subscribed: bool,
    pub entries: Vec<FEntry>,
}
impl FFolder {
    pub fn path(&self) -> String {
        self.custom.clone().unwrap_or_else(|| {
            if self.role == "inbox" {
                "INBOX".into()
            } else {
                let mut c = self.role.chars();
                c.next()
                    .map(|f| f.to_ascii_uppercase().to_string() + c.as_str())
                    .unwrap_or_default()
            }
        })
    }
}
#[derive(Clone, Debug)]
pub struct FMessage {
    pub read: bool,
    pub bits: u32,
    pub labels: Vec<String>,
    pub raw: Vec<u8>,
    pub message_id: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Credential {
    pub kid: String,
    pub password: String,
    pub protocols: Vec<&'static str>,
    pub revoked: bool,
}

#[derive(Clone, Debug)]
pub struct Fake {
    pub modseq: u64,
    pub floor: u64,
    pub folders: Vec<FFolder>,
    pub messages: BTreeMap<u64, FMessage>,
    /// Objects of messages whose last membership is gone: R2 keeps them until GC, and an
    /// unexpired body handle still reads them (the API rechecks only expired handles).
    pub collected: BTreeMap<u64, Vec<u8>>,
    pub vanished: Vec<(String, u32, u64)>,
    pub credentials: Vec<Credential>,
    pub fail_snapshot: bool,
    /// A fault on an upcoming mutation that reaches its commit point: (calls until it fires,
    /// kind). Refused calls (missing folder, bad ticket) do not count.
    pub fault: Option<(u8, crate::model::Fault)>,
    /// A `Crash` fault fired: the fixture kills the acting gateway process.
    pub crashed: bool,
    pub page: usize,
    pub next_mid: u64,
    pub next_validity: u32,
    pub next_role: u32,
    pub calls: BTreeMap<String, u64>,
    /// Rejections the fake had to make (bad signature, bad digest): fixture safety failures.
    pub violations: Vec<String>,
    pub now: chrono::DateTime<chrono::FixedOffset>,
    pub daily: u32,
    pub monthly: u32,
    pub ledger: BTreeMap<i64, u32>,
    pub submitted: Vec<(String, Vec<String>, Vec<u8>)>,
    /// `mailgw_copy_once` receipts: (credential, nonce) -> (arguments digest, COPY result).
    pub receipts: BTreeMap<(String, String), (String, Value)>,
}

fn err(status: u16, code: &str) -> (u16, Vec<u8>) {
    (status, json!({"error": code}).to_string().into_bytes())
}
fn ok(v: Value) -> (u16, Vec<u8>) {
    (200, v.to_string().into_bytes())
}

impl Fake {
    pub fn new(kids: &[(&str, &str)]) -> Self {
        let folders = ["inbox", "sent", "drafts", "junk", "archive", "trash"]
            .iter()
            .enumerate()
            .map(|(i, r)| FFolder {
                role: (*r).into(),
                custom: None,
                validity: 1 + i as u32,
                next: 1,
                highest: 1,
                subscribed: true,
                entries: vec![],
            })
            .collect();
        Self {
            modseq: 1,
            floor: 0,
            folders,
            messages: BTreeMap::new(),
            collected: BTreeMap::new(),
            vanished: vec![],
            credentials: kids
                .iter()
                .map(|(kid, password)| Credential {
                    kid: (*kid).into(),
                    password: (*password).into(),
                    protocols: vec!["imap", "smtp"],
                    revoked: false,
                })
                .collect(),
            fail_snapshot: false,
            fault: None,
            crashed: false,
            page: 2,
            next_mid: 1,
            next_validity: 100,
            next_role: 1,
            calls: BTreeMap::new(),
            violations: vec![],
            now: "2026-11-30T23:59:58Z".parse().unwrap_or_default(),
            daily: 3,
            monthly: 5,
            ledger: BTreeMap::new(),
            submitted: vec![],
            receipts: BTreeMap::new(),
        }
    }
    pub fn folder(&self, path: &str) -> Option<&FFolder> {
        self.folders.iter().find(|f| f.path() == path)
    }
    fn index(&self, role: &str) -> Option<usize> {
        self.folders.iter().position(|f| f.role == role)
    }
    pub fn flags(&self, e: &FEntry) -> Vec<String> {
        let Some(m) = self.messages.get(&e.mid) else {
            return vec![];
        };
        let mut out: Vec<String> = m
            .labels
            .iter()
            .filter(|l| {
                l.len() <= 64
                    && l.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_$-".contains(c))
                    && !RESERVED.contains(&l.as_str())
            })
            .cloned()
            .collect();
        out.extend(
            NAMES
                .iter()
                .enumerate()
                .filter(|(i, _)| m.bits & (1 << i) != 0)
                .map(|(_, n)| (*n).to_owned()),
        );
        if m.read {
            out.push("\\Seen".into());
        }
        if e.deleted {
            out.push("\\Deleted".into());
        }
        out
    }
    fn meta(&self) -> Value {
        let mut list: Vec<&FFolder> = self.folders.iter().collect();
        list.sort_by(|a, b| a.role.cmp(&b.role));
        Value::Array(
            list.iter()
                .map(|f| {
                    let unseen = f
                        .entries
                        .iter()
                        .filter(|e| self.messages.get(&e.mid).is_some_and(|m| !m.read))
                        .count();
                    json!({"key": f.role, "path": f.path(), "validity": f.validity, "next": f.next,
                        "highest": f.highest, "subscribed": f.subscribed, "total": f.entries.len(), "unseen": unseen})
                })
                .collect(),
        )
    }
    fn stamp(&mut self) -> u64 {
        self.modseq += 1;
        self.modseq
    }
    fn live(&self, kid: &str, protocol: &str) -> bool {
        self.credentials
            .iter()
            .any(|c| c.kid == kid && !c.revoked && c.protocols.contains(&protocol))
    }

    // ---- store operations shared by the RPCs and the fixture's external actors ----
    pub fn deliver(&mut self, raw: Vec<u8>) -> u32 {
        let mid = self.new_message(raw, false, 0, vec![]);
        let stamp = self.stamp();
        self.add_entry(0, mid, false, stamp)
    }
    fn new_message(&mut self, raw: Vec<u8>, read: bool, bits: u32, labels: Vec<String>) -> u64 {
        let mid = self.next_mid;
        self.next_mid += 1;
        let message_id = message_id(&raw);
        self.messages.insert(
            mid,
            FMessage {
                read,
                bits,
                labels,
                raw,
                message_id,
            },
        );
        mid
    }
    fn add_entry(&mut self, folder: usize, mid: u64, deleted: bool, stamp: u64) -> u32 {
        let f = &mut self.folders[folder];
        let uid = f.next;
        f.next += 1;
        f.highest = stamp;
        f.entries.push(FEntry {
            uid,
            mid,
            modseq: stamp,
            deleted,
        });
        uid
    }
    fn remove_entry(&mut self, folder: usize, uid: u32, stamp: u64) {
        let f = &mut self.folders[folder];
        f.entries.retain(|e| e.uid != uid);
        f.highest = stamp;
        let role = f.role.clone();
        self.vanished.push((role, uid, stamp));
    }
    fn copies(&self, mid: u64) -> usize {
        self.folders
            .iter()
            .flat_map(|f| &f.entries)
            .filter(|e| e.mid == mid)
            .count()
    }
    /// `inbox_mutate` for one entry. `p` holds the flag fields present in the request.
    #[allow(clippy::too_many_arguments)]
    fn mutate_one(
        &mut self,
        folder: usize,
        uid: u32,
        op: &str,
        p: &BTreeMap<&'static str, bool>,
        add_labels: &[String],
        remove_labels: &[String],
        dest: Option<usize>,
    ) -> Option<u32> {
        let ent = self.folders[folder]
            .entries
            .iter()
            .find(|e| e.uid == uid)?
            .clone();
        let m = self.messages.get(&ent.mid)?.clone();
        let seen = p.get("read").copied().unwrap_or(m.read);
        let mut bits = m.bits;
        for (i, k) in FIELDS.iter().enumerate() {
            if let Some(on) = p.get(k) {
                bits = if *on {
                    bits | (1 << i)
                } else {
                    bits & !(1 << i)
                };
            }
        }
        let mut keywords: Vec<String> = m
            .labels
            .iter()
            .chain(
                add_labels
                    .iter()
                    .filter(|l| !RESERVED.contains(&l.as_str())),
            )
            .filter(|l| !remove_labels.contains(l) || RESERVED.contains(&l.as_str()))
            .cloned()
            .collect();
        keywords.sort();
        keywords.dedup();
        let stamp = self.stamp();
        let mut allocated = None;
        let mut gone = false;
        match op {
            "flags" => {
                let has_deleted = p.contains_key("deleted");
                let changed = m.read != seen || bits != m.bits || keywords != m.labels;
                let source = self.folders[folder].role.clone();
                for f in &mut self.folders {
                    let mut touched = false;
                    for e in &mut f.entries {
                        if e.mid != ent.mid {
                            continue;
                        }
                        let target = f.role == source && e.uid == uid;
                        if changed || !has_deleted || target {
                            e.modseq = stamp;
                            if target && let Some(d) = p.get("deleted") {
                                e.deleted = *d;
                            }
                            touched = true;
                        }
                    }
                    if touched {
                        f.highest = stamp;
                    }
                }
            }
            _ => {
                if let ("copy" | "move", Some(d)) = (op, dest) {
                    allocated = Some(self.add_entry(d, ent.mid, ent.deleted, stamp));
                }
                if op == "move" || op == "expunge" {
                    self.remove_entry(folder, uid, stamp);
                    if op == "expunge" && self.copies(ent.mid) == 0 {
                        if let Some(m) = self.messages.remove(&ent.mid) {
                            self.collected.insert(ent.mid, m.raw);
                        }
                        gone = true;
                    }
                }
            }
        }
        if !gone && let Some(msg) = self.messages.get_mut(&ent.mid) {
            msg.bits = bits;
            msg.read = seen;
            msg.labels = keywords;
        }
        allocated
    }
    pub fn external_seen(&mut self) {
        if let Some(uid) = self.folders[0].entries.first().map(|e| e.uid) {
            let mid = self.folders[0].entries[0].mid;
            let read = self.messages.get(&mid).is_some_and(|m| m.read);
            let p = BTreeMap::from([("read", !read)]);
            self.mutate_one(0, uid, "flags", &p, &[], &[], None);
        }
    }
    pub fn external_expunge(&mut self) {
        if let Some(uid) = self.folders[0].entries.first().map(|e| e.uid) {
            self.mutate_one(0, uid, "expunge", &BTreeMap::new(), &[], &[], None);
        }
    }
    pub fn prune(&mut self) {
        if let Some(max) = self.vanished.iter().map(|v| v.2).max() {
            self.floor = self.floor.max(max);
        }
        self.vanished.clear();
    }

    // ---- RPCs ----
    fn rpc(&mut self, p: &Value) -> (u16, Vec<u8>) {
        let op = p["op"].as_str().unwrap_or_default();
        *self.calls.entry(op.into()).or_default() += 1;
        if op == "login" {
            let (user, password, protocol) = (
                p["user"].as_str().unwrap_or_default(),
                p["password"].as_str().unwrap_or_default(),
                p["protocol"].as_str().unwrap_or_default(),
            );
            let Some(c) = self
                .credentials
                .iter()
                .find(|c| c.password == password && !c.revoked && c.protocols.contains(&protocol))
            else {
                return err(403, "PROTOCOL_DENIED");
            };
            if user != INBOX_ID && !ADDRESSES.iter().any(|a| a.eq_ignore_ascii_case(user)) {
                return err(403, "PROTOCOL_DENIED");
            }
            return ok(
                json!({"kid": c.kid, "inbox": INBOX_ID, "workspace": "ws_tear", "account": "sponsor_tear", "addresses": ADDRESSES, "folders": self.meta()}),
            );
        }
        let kid = p["kid"].as_str().unwrap_or_default().to_owned();
        let protocol = if op == "submit" { "smtp" } else { "imap" };
        if !self.live(&kid, protocol) {
            return err(403, "PROTOCOL_DENIED");
        }
        match op {
            "snapshot" => self.snapshot(&kid, p),
            "body" => {
                let handle = p["handle"].as_str().unwrap_or_default();
                let Some((hk, mid)) = handle
                    .strip_prefix("h:")
                    .and_then(|h| h.rsplit_once(':'))
                    .and_then(|(k, m)| Some((k, m.parse::<u64>().ok()?)))
                else {
                    return err(403, "PROTOCOL_DENIED");
                };
                if hk != kid {
                    return err(403, "PROTOCOL_DENIED");
                }
                let Some(raw) = self
                    .messages
                    .get(&mid)
                    .map(|m| &m.raw)
                    .or(self.collected.get(&mid))
                else {
                    return err(404, "MISSING_BODY");
                };
                if p["headers"].as_bool() == Some(true) {
                    let n = raw
                        .windows(4)
                        .position(|w| w == b"\r\n\r\n")
                        .map_or(raw.len(), |i| i + 4);
                    return (200, raw[..n].to_vec());
                }
                (200, raw.clone())
            }
            "edit" => self.edit(p),
            "mutate" => {
                use crate::model::Fault;
                let firing = matches!(self.fault, Some((1, _)));
                let saved =
                    (firing && matches!(self.fault, Some((_, Fault::Fail)))).then(|| self.clone());
                let r = self.mutate(p);
                if r.0 != 200 {
                    return r;
                }
                let Some((n, kind)) = self.fault else {
                    return r;
                };
                if n > 1 {
                    self.fault = Some((n - 1, kind));
                    return r;
                }
                self.fault = None;
                match kind {
                    // Before the commit: roll the call back.
                    Fault::Fail => {
                        if let Some(mut before) = saved {
                            before.fault = None;
                            before.calls = self.calls.clone();
                            *self = before;
                        }
                        err(503, "UNAVAILABLE")
                    }
                    Fault::Lost => err(503, "UNAVAILABLE"),
                    Fault::Crash => {
                        self.crashed = true;
                        err(503, "UNAVAILABLE")
                    }
                    Fault::Race => {
                        if let Some(uid) = self.folders[0].entries.last().map(|e| e.uid) {
                            self.mutate_one(0, uid, "expunge", &BTreeMap::new(), &[], &[], None);
                        }
                        r
                    }
                }
            }
            "submit" => self.submit(p),
            "projections" => self.projections(p),
            "subject" => ok(json!([])),
            _ => err(422, "INVALID_REQUEST"),
        }
    }
    fn snapshot(&mut self, kid: &str, p: &Value) -> (u16, Vec<u8>) {
        if std::mem::take(&mut self.fail_snapshot) {
            return err(503, "UNAVAILABLE");
        }
        let since = p["since"].as_u64().unwrap_or(0);
        let after = p["after"].as_u64().unwrap_or(0) as u32;
        PAGES.fetch_add(u64::from(after > 0), std::sync::atomic::Ordering::Relaxed);
        DELTAS.fetch_add(u64::from(since > 0), std::sync::atomic::Ordering::Relaxed);
        let path = p["path"].as_str();
        let folder = path.and_then(|x| self.folders.iter().position(|f| f.path() == x));
        let limit = self.page + 1;
        let mut gone: Vec<u32> = match folder {
            Some(i) if since > 0 => {
                let role = &self.folders[i].role;
                let mut v: Vec<u32> = self
                    .vanished
                    .iter()
                    .filter(|(r, uid, m)| r == role && *m > since && *uid > after)
                    .map(|x| x.1)
                    .collect();
                v.sort_unstable();
                v.truncate(limit);
                v
            }
            _ => vec![],
        };
        let mut entries: Vec<FEntry> = folder
            .map(|i| {
                let mut v: Vec<FEntry> = self.folders[i]
                    .entries
                    .iter()
                    .filter(|e| e.uid > after && e.modseq > since)
                    .cloned()
                    .collect();
                v.sort_by_key(|e| e.uid);
                v.truncate(limit);
                v
            })
            .unwrap_or_default();
        let next = [
            (entries.len() > self.page).then(|| entries[self.page - 1].uid),
            (gone.len() > self.page).then(|| gone[self.page - 1]),
        ]
        .into_iter()
        .flatten()
        .min();
        if let Some(n) = next {
            gone.retain(|u| *u <= n);
            entries.retain(|e| e.uid <= n);
        }
        let entries: Vec<Value> = entries
            .iter()
            .map(|e| {
                let size = self.messages.get(&e.mid).map_or(0, |m| m.raw.len());
                json!({"uid": e.uid, "modseq": e.modseq, "date": "2026-01-01T00:00:00+00:00",
                    "size": size, "flags": self.flags(e), "handle": format!("h:{kid}:{}", e.mid)})
            })
            .collect();
        ok(
            json!({"folders": self.meta(), "floor": self.floor, "gone": gone, "more": next, "entries": entries}),
        )
    }
    fn edit(&mut self, p: &Value) -> (u16, Vec<u8>) {
        let action = p["action"].as_str().unwrap_or_default();
        let path = p["path"].as_str();
        let fid = p["folder"].as_str().unwrap_or_default();
        let invalid = |x: Option<&str>| {
            x.is_none_or(|x| {
                x.is_empty()
                    || x.len() > 255
                    || x.starts_with('/')
                    || x.ends_with('/')
                    || x.contains("//")
                    || x.chars().any(char::is_control)
                    || x.split('/').count() > 8
                    || ["inbox", "sent", "drafts", "junk", "archive", "trash"]
                        .contains(&x.to_ascii_lowercase().as_str())
            })
        };
        if matches!(action, "create" | "rename") && invalid(path) {
            return err(409, "INVALID_PATH");
        }
        let at = (action != "create").then(|| self.index(fid));
        if let Some(None) = at {
            return err(409, "NOT_FOUND");
        }
        if matches!(action, "create" | "rename")
            && self.folders.iter().any(|f| f.custom.as_deref() == path)
        {
            return err(409, "ALREADYEXISTS");
        }
        match (action, at.flatten()) {
            ("create", _) => {
                if self.folders.len() >= 200 {
                    return err(409, "FOLDER_LIMIT");
                }
                let role = format!("fld_{:032x}", self.next_role);
                self.next_role += 1;
                let validity = self.next_validity;
                self.next_validity += 1;
                self.folders.push(FFolder {
                    role,
                    custom: path.map(str::to_owned),
                    validity,
                    next: 1,
                    highest: 1,
                    subscribed: false,
                    entries: vec![],
                });
            }
            ("subscribe", Some(i)) => self.folders[i].subscribed = p["sub"].as_bool() == Some(true),
            (_, Some(i)) if self.folders[i].custom.is_none() => {
                return err(409, "PROTECTED_FOLDER");
            }
            ("delete", Some(i)) => {
                let trash = self.index("trash").unwrap_or(5);
                let entries = self.folders[i].entries.clone();
                for e in entries {
                    if self.copies(e.mid) > 1 {
                        self.mutate_one(i, e.uid, "expunge", &BTreeMap::new(), &[], &[], None);
                    } else {
                        self.mutate_one(i, e.uid, "move", &BTreeMap::new(), &[], &[], Some(trash));
                    }
                }
                self.folders.remove(i);
            }
            _ => return err(409, "INVALID_OP"),
        }
        let stamp = self.stamp();
        if action == "delete" {
            self.floor = stamp;
        }
        ok(json!({"id": fid, "state": stamp.to_string()}))
    }
    fn mutate(&mut self, p: &Value) -> (u16, Vec<u8>) {
        let action = p["action"].as_str().unwrap_or_default();
        if action == "copy" {
            // COPY requires a replay ticket; a retry with the same ticket and arguments gets the
            // committed mapping back instead of a second copy (`mailgw_copy_once`).
            let Some(nonce) = p["ticket"]["nonce"].as_str().filter(|n| n.len() == 32) else {
                return err(422, "MISSING_COPY_TICKET");
            };
            let key = (
                p["kid"].as_str().unwrap_or_default().to_owned(),
                nonce.to_owned(),
            );
            let digest = hex::encode(Sha256::digest(
                json!([p["folder"], p["to"], p["uids"]]).to_string(),
            ));
            if let Some((d, result)) = self.receipts.get(&key) {
                if *d != digest {
                    return err(409, "MUTATION_REFUSED");
                }
                return ok(result.clone());
            }
            let (status, body) = self.mutate_once(p);
            if status == 200
                && let Ok(v) = serde_json::from_slice::<Value>(&body)
            {
                self.receipts.insert(key, (digest, v));
            }
            return (status, body);
        }
        self.mutate_once(p)
    }
    fn mutate_once(&mut self, p: &Value) -> (u16, Vec<u8>) {
        let action = p["action"].as_str().unwrap_or_default();
        let mode = p["mode"].as_str().unwrap_or("add");
        // `SELECT uid_validity INTO STRICT ... role=coalesce(dst,src)`: the folder that must
        // exist is the destination for copy/move, else the source. A missing source of a copy
        // or move just has no entries.
        let src = self.index(p["folder"].as_str().unwrap_or_default());
        let dest = p["to"].as_str().map(|t| self.index(t));
        let target = match (dest, src) {
            (Some(Some(d)), _) => d,
            (Some(None), _) | (None, None) => return err(500, "STRICT"),
            (None, Some(s)) => s,
        };
        let validity = self.folders[target].validity;
        let names: Vec<String> = p["flags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let mut bits = BTreeMap::new();
        for (key, name) in FIELDS
            .iter()
            .zip(NAMES)
            .chain([(&"read", "\\Seen"), (&"deleted", "\\Deleted")])
        {
            let on = names.iter().any(|f| f.eq_ignore_ascii_case(name));
            if mode == "replace" || on {
                bits.insert(*key, on && mode != "remove");
            }
        }
        let labels: Vec<String> = names
            .iter()
            .filter(|x| !x.starts_with('\\') && !NAMES.iter().any(|n| n.eq_ignore_ascii_case(x)))
            .cloned()
            .collect();
        if labels.iter().any(|x| {
            x.is_empty()
                || x.len() > 64
                || !x
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_$-".contains(c))
                || RESERVED.contains(&x.as_str())
        }) {
            return err(422, "INVALID_FLAG");
        }
        let uids: Option<Vec<u32>> = p["uids"].as_array().map(|a| {
            a.iter()
                .filter_map(|x| x.as_u64().map(|u| u as u32))
                .collect()
        });
        let Some(src) = src else {
            return ok(json!({"pairs": [], "validity": validity}));
        };
        let mut picked: Vec<FEntry> = self.folders[src]
            .entries
            .iter()
            .filter(|e| uids.as_ref().is_none_or(|u| u.contains(&e.uid)))
            .filter(|e| action != "expunge" || e.deleted)
            .cloned()
            .collect();
        picked.sort_by_key(|e| e.uid);
        let mut pairs = vec![];
        for e in picked {
            let (add, remove) = if action == "flags" {
                let existing = self
                    .messages
                    .get(&e.mid)
                    .map(|m| m.labels.clone())
                    .unwrap_or_default();
                let add = if mode == "remove" {
                    vec![]
                } else {
                    labels.clone()
                };
                let remove = match mode {
                    "replace" => existing
                        .into_iter()
                        .filter(|x| !labels.contains(x))
                        .collect(),
                    "remove" => labels.clone(),
                    _ => vec![],
                };
                (add, remove)
            } else {
                (vec![], vec![])
            };
            let flags = if action == "flags" {
                bits.clone()
            } else {
                BTreeMap::new()
            };
            let to = (action == "copy" || action == "move").then_some(target);
            if let Some(u) = self.mutate_one(src, e.uid, action, &flags, &add, &remove, to) {
                pairs.push(json!([e.uid, u]));
            }
        }
        ok(json!({"pairs": pairs, "validity": validity}))
    }
    /// `previewPage`: per requested UID still in the folder, the whole message when it fits
    /// in 2048 bytes (`complete`), else its exact header block, else nothing.
    fn projections(&mut self, p: &Value) -> (u16, Vec<u8>) {
        let Some(f) = self.index(p["folder"].as_str().unwrap_or_default()) else {
            return ok(json!([]));
        };
        let uids: Vec<u64> = p["uids"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_u64).collect())
            .unwrap_or_default();
        let mut rows = vec![];
        for e in &self.folders[f].entries {
            if !uids.contains(&u64::from(e.uid)) {
                continue;
            }
            let Some(m) = self.messages.get(&e.mid) else {
                continue;
            };
            let raw = &m.raw;
            let complete = raw.len() <= 2048;
            let n = if complete {
                raw.len()
            } else {
                raw[..2048]
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map_or(0, |i| i + 4)
            };
            if n > 0 {
                rows.push(
                    json!({"uid": e.uid, "raw": STANDARD.encode(&raw[..n]), "complete": complete}),
                );
            }
        }
        ok(Value::Array(rows))
    }
    fn submit(&mut self, p: &Value) -> (u16, Vec<u8>) {
        let to: Vec<String> = p["to"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let Ok(raw) = STANDARD.decode(p["content"].as_str().unwrap_or_default()) else {
            return err(422, "INVALID_REQUEST");
        };
        let from = p["from"].as_str().unwrap_or_default();
        let header = header_from(&raw);
        let owned = |a: &str| ADDRESSES.iter().any(|x| x.eq_ignore_ascii_case(a));
        if !owned(from) || !header.as_deref().is_some_and(owned) {
            return err(403, "SENDER_NOT_OWNED");
        }
        // `inbox_protocol_sends`: one row per UTC day; the cap reads today's row and every
        // row from this month's first day on (`day >= date_trunc('month', now())`).
        use chrono::Datelike;
        let now = self.now.to_utc();
        let day = now.timestamp().div_euclid(86400);
        let first = chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map_or(0, |d| d.and_utc().timestamp().div_euclid(86400));
        let today = self.ledger.get(&day).copied().unwrap_or(0);
        let month: u32 = self.ledger.range(first..).map(|e| e.1).sum();
        let n = to.len() as u32;
        if today + n > self.daily || month + n > self.monthly {
            return err(429, "INBOX_SEND_LIMIT");
        }
        *self.ledger.entry(day).or_default() += n;
        self.submitted.push((from.to_owned(), to, raw));
        ok(json!({"accepted": n}))
    }
    fn append(&mut self, meta: &Value, raw: Vec<u8>) -> (u16, Vec<u8>) {
        let kid = meta["kid"].as_str().unwrap_or_default();
        if !self.live(kid, "imap") {
            return err(403, "CREDENTIAL_REVOKED");
        }
        if meta["size"].as_u64() != Some(raw.len() as u64) {
            return err(422, "INVALID_LENGTH");
        }
        let Some(f) = self.index(meta["folder"].as_str().unwrap_or_default()) else {
            return err(500, "STRICT");
        };
        let validity = self.folders[f].validity;
        let flags: Vec<String> = meta["flags"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let id = message_id(&raw);
        if self.folders[f].role == "sent"
            && let Some(id) = &id
            && let Some(e) = self.folders[f].entries.iter().find(|e| {
                self.messages
                    .get(&e.mid)
                    .is_some_and(|m| m.message_id.as_ref() == Some(id))
            })
        {
            return ok(json!({"validity": validity, "pairs": [[1, e.uid]]}));
        }
        let seen = flags.iter().any(|x| x == "\\Seen");
        let mut bits = 0;
        for (i, n) in NAMES.iter().enumerate() {
            if flags.iter().any(|x| x == n) {
                bits |= 1 << i;
            }
        }
        let labels = flags
            .iter()
            .filter(|x| !NAMES.contains(&x.as_str()) && *x != "\\Seen" && *x != "\\Deleted")
            .filter(|x| !x.starts_with('\\') && !RESERVED.contains(&x.as_str()))
            .cloned()
            .collect();
        let mid = self.new_message(raw, seen, bits, labels);
        let stamp = self.stamp();
        let deleted = flags.iter().any(|x| x == "\\Deleted");
        let uid = self.add_entry(f, mid, deleted, stamp);
        ok(json!({"validity": validity, "pairs": [[0, uid]]}))
    }
}

fn message_id(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    text.split("\r\n")
        .take_while(|l| !l.is_empty())
        .find_map(|l| {
            l.get(..11)
                .filter(|p| p.eq_ignore_ascii_case("message-id:"))
                .map(|_| l[11..].trim().to_owned())
        })
}
fn header_from(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    text.split("\r\n")
        .take_while(|l| !l.is_empty())
        .find_map(|l| {
            let v = l.get(..5).filter(|p| p.eq_ignore_ascii_case("from:"))?;
            let _ = v;
            let rest = l[5..].trim();
            Some(
                rest.rsplit_once('<')
                    .map_or(rest, |(_, a)| a.trim_end_matches('>'))
                    .to_ascii_lowercase(),
            )
        })
}

// ---------------- loopback HTTP ----------------

static STATE: Mutex<Option<Fake>> = Mutex::new(None);
/// Snapshot reads past the first page, and since-MODSEQ (delta) reads: coverage counters.
pub static PAGES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static DELTAS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SERVER: OnceLock<String> = OnceLock::new();
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap_or_else(|e| panic!("tokio runtime: {e}"))
    })
}

pub fn install(fake: Fake) {
    *STATE.lock().unwrap_or_else(|p| p.into_inner()) = Some(fake);
}
pub fn with<T>(f: impl FnOnce(&mut Fake) -> T) -> Option<T> {
    STATE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_mut()
        .map(f)
}

/// The fake's base URL; starts the listener on first use.
pub fn url() -> String {
    SERVER
        .get_or_init(|| {
            let rt = runtime();
            let l = rt
                .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
                .unwrap_or_else(|e| panic!("bind: {e}"));
            let addr = l.local_addr().unwrap_or_else(|e| panic!("addr: {e}"));
            rt.spawn(async move {
                while let Ok((s, _)) = l.accept().await {
                    tokio::spawn(connection(s));
                }
            });
            format!("http://127.0.0.1:{}", addr.port())
        })
        .clone()
}

/// Live connections and the abort signal: when a fixture closes, every keep-alive
/// connection is reset from the server side (linger 0) before the client drops its pool, so
/// thousands of fixtures leave no TIME_WAIT sockets behind to exhaust ephemeral ports.
static LIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static ABORT: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
fn abort_signal() -> &'static tokio::sync::watch::Sender<u64> {
    ABORT.get_or_init(|| tokio::sync::watch::channel(0).0)
}
pub fn abort_connections() {
    abort_signal().send_modify(|g| *g += 1);
    let start = std::time::Instant::now();
    while LIVE.load(std::sync::atomic::Ordering::Acquire) > 0
        && start.elapsed() < std::time::Duration::from_millis(200)
    {
        std::thread::yield_now();
    }
}

async fn connection(mut s: tokio::net::TcpStream) {
    LIVE.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    let mut abort = abort_signal().subscribe();
    abort.borrow_and_update();
    serve_connection(&mut s, &mut abort).await;
    LIVE.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
}

/// Read more bytes into `buf`; false on EOF, error or abort (which resets the socket).
async fn more(
    s: &mut tokio::net::TcpStream,
    buf: &mut Vec<u8>,
    abort: &mut tokio::sync::watch::Receiver<u64>,
) -> bool {
    let mut chunk = [0u8; 65536];
    tokio::select! {
        r = s.read(&mut chunk) => match r {
            Ok(0) | Err(_) => false,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                true
            }
        },
        _ = abort.changed() => {
            let _ = socket2::SockRef::from(&*s).set_linger(Some(std::time::Duration::ZERO));
            false
        }
    }
}

async fn serve_connection(
    s: &mut tokio::net::TcpStream,
    abort: &mut tokio::sync::watch::Receiver<u64>,
) {
    let _ = s.set_nodelay(true);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let head_end = loop {
            if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
            if !more(s, &mut buf, abort).await {
                return;
            }
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let mut lines = head.split("\r\n");
        let request = lines.next().unwrap_or_default().to_owned();
        let headers: BTreeMap<String, String> = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
            .collect();
        buf.drain(..head_end);
        let body = if headers
            .get("transfer-encoding")
            .is_some_and(|v| v.contains("chunked"))
        {
            let mut out = vec![];
            loop {
                let line_end = loop {
                    if let Some(p) = buf.windows(2).position(|w| w == b"\r\n") {
                        break p;
                    }
                    if !more(s, &mut buf, abort).await {
                        return;
                    }
                };
                let size = usize::from_str_radix(
                    String::from_utf8_lossy(&buf[..line_end])
                        .split(';')
                        .next()
                        .unwrap_or("0")
                        .trim(),
                    16,
                )
                .unwrap_or(0);
                buf.drain(..line_end + 2);
                while buf.len() < size + 2 {
                    if !more(s, &mut buf, abort).await {
                        return;
                    }
                }
                out.extend_from_slice(&buf[..size]);
                buf.drain(..size + 2);
                if size == 0 {
                    break out;
                }
            }
        } else {
            let n: usize = headers
                .get("content-length")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            while buf.len() < n {
                if !more(s, &mut buf, abort).await {
                    return;
                }
            }
            buf.drain(..n).collect()
        };
        let (status, reply) = handle(&request, &headers, body);
        let text = format!(
            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
            reply.len()
        );
        if s.write_all(text.as_bytes()).await.is_err() || s.write_all(&reply).await.is_err() {
            return;
        }
    }
}

fn handle(request: &str, h: &BTreeMap<String, String>, body: Vec<u8>) -> (u16, Vec<u8>) {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    let Some(fake) = guard.as_mut() else {
        return err(503, "NO_FIXTURE");
    };
    // The process that crashed makes no further calls; until the fixture reaps it, whatever
    // it still sends is lost.
    if fake.crashed {
        return err(503, "CRASHED");
    }
    if request != "POST /internal/v1/mail HTTP/1.1" {
        fake.violations
            .push(format!("unexpected request line {request}"));
        return err(403, "PROTOCOL_DENIED");
    }
    let get = |k: &str| h.get(k).cloned().unwrap_or_default();
    let (ts, hash, sig, scope) = (
        get("x-bane-timestamp"),
        get("x-bane-content"),
        get("x-bane-signature"),
        get("x-bane-scope"),
    );
    let meta = h.get("x-bane-append");
    let mut mac = Hmac::<Sha256>::new_from_slice(KEY.as_bytes()).unwrap_or_else(|e| panic!("{e}"));
    let mut signed = format!("POST\n/internal/v1/mail\n{ts}\n{hash}\n{scope}");
    if let Some(m) = meta {
        signed.push('\n');
        signed.push_str(&hex::encode(Sha256::digest(m.as_bytes())));
    }
    mac.update(signed.as_bytes());
    if hex::encode(mac.finalize().into_bytes()) != sig {
        fake.violations.push("bad request signature".into());
        return err(403, "PROTOCOL_DENIED");
    }
    if hex::encode(Sha256::digest(&body)) != hash {
        fake.violations.push("content digest mismatch".into());
        return err(403, "PROTOCOL_DENIED");
    }
    if let Some(m) = meta {
        let Some(meta) = STANDARD
            .decode(m)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        else {
            return err(422, "INVALID_REQUEST");
        };
        let expected = hex::encode(Sha256::digest(
            meta["kid"].as_str().unwrap_or_default().as_bytes(),
        ));
        if expected != scope {
            fake.violations.push("append scope mismatch".into());
        }
        if h.get("content-length").and_then(|v| v.parse::<u64>().ok()) != meta["size"].as_u64()
            && !h.contains_key("transfer-encoding")
        {
            return err(422, "INVALID_LENGTH");
        }
        return fake.append(&meta, body);
    }
    let Ok(p) = serde_json::from_slice::<Value>(&body) else {
        return err(422, "INVALID_REQUEST");
    };
    let who = p
        .get("kid")
        .or_else(|| p.get("user"))
        .and_then(Value::as_str)
        .unwrap_or("login")
        .to_ascii_lowercase();
    if hex::encode(Sha256::digest(who.as_bytes())) != scope {
        fake.violations.push("request scope mismatch".into());
    }
    fake.rpc(&p)
}
