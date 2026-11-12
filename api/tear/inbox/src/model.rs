//! Independent reference model of inbox phase 2 (folders, UIDs, MODSEQ, flags, move/copy/expunge,
//! tombstones, counters, change sync) under concurrent ingest. See `main.rs` for the edge-case
//! checklist this model reaches.
//!
//! The model keeps the committed database (`db`), the head state (`head`: committed plus every
//! completed but uncommitted statement), and one transaction slot per connection. Each API request,
//! SNS notification and ingest store is one statement followed by its own commit, so a step can
//! land between a statement's locks and its commit. A statement that needs a lock another open
//! transaction holds is `blocked`; it completes when that holder commits or aborts, and its effect
//! is computed then (serialized after the holder). Lock order is the documented one:
//! workspace ingest lane, then the receipt row, then inbox rows in id order.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const ROLES: [&str; 5] = ["archive", "inbox", "junk", "sent", "trash"];
pub const INBOX: u8 = 1;
pub const SENT: u8 = 3;
pub const TRASH: u8 = 4;
pub const BOXES: [&str; 2] = ["A", "B"];
pub const CONNS: [&str; 4] = ["I", "J", "W", "V"];
/// Inbound size (bytes) of every synthetic delivery and of every Sent copy.
pub const INBOUND_BYTES: i64 = 42;
pub const SENT_BYTES: i64 = 100;

/// Message labels: m1..m3 inbound (m2 replies to m1, so it joins m1's thread when m1 arrived first),
/// d1 the same email as m1 under another SES message id (deduplicated by Message-ID: whichever is
/// stored first owns the content), sA/sB the Sent copy of a reply from inbox A/B.
pub fn mid_name(m: u8) -> String {
    match m {
        3 => "d1".into(),
        10 => "sA".into(),
        11 => "sB".into(),
        n => format!("m{}", n + 1),
    }
}
fn mid_parse(s: &str) -> Option<u8> {
    match s {
        "m1" => Some(0),
        "m2" => Some(1),
        "m3" => Some(2),
        "d1" => Some(3),
        _ => None,
    }
}
/// The stored row a client addresses as m1: d1's row when the duplicate was stored first.
pub fn resolve(db: &Db, m: u8) -> u8 {
    if m == 0 && !db.content.contains_key(&0) && db.content.contains_key(&3) {
        3
    } else {
        m
    }
}
fn resolve_mut(db: &Db, mu: Mut) -> Mut {
    let r = |m| resolve(db, m);
    match mu {
        Mut::Read(x, m, v) => Mut::Read(x, r(m), v),
        Mut::Flag(x, m) => Mut::Flag(x, r(m)),
        Mut::Deleted(x, m, s, v) => Mut::Deleted(x, r(m), s, v),
        Mut::Move(x, m, s, d) => Mut::Move(x, r(m), s, d),
        Mut::Copy(x, m, s, d) => Mut::Copy(x, r(m), s, d),
        Mut::Trash(x, m, s) => Mut::Trash(x, r(m), s),
        Mut::Expunge(x, m, s) => Mut::Expunge(x, r(m), s),
        Mut::Thread(x, m, k) => Mut::Thread(x, r(m), k),
        other => other,
    }
}
/// Synthetic arrival order (received_at): m1 and its duplicate d1 first, then m2, then m3.
fn arrival(m: u8) -> u8 {
    if m == 3 { 0 } else { m }
}
fn role_parse(s: &str) -> Option<u8> {
    ROLES.iter().position(|r| *r == s).map(|i| i as u8)
}
fn box_parse(s: &str) -> Option<u8> {
    BOXES.iter().position(|r| *r == s).map(|i| i as u8)
}
fn recips_parse(s: &str) -> Option<u8> {
    match s {
        "a" => Some(1),
        "b" => Some(2),
        "ab" => Some(3),
        _ => None,
    }
}
fn recips_name(r: u8) -> &'static str {
    ["-", "a", "b", "ab"][r as usize & 3]
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub next: u32,
    pub high: u64,
    pub total: i64,
    pub unseen: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub role: u8,
    pub uid: u32,
    pub mid: u8,
    pub modseq: u64,
    pub deleted: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub read: bool,
    pub flagged: bool,
    pub modseq: u64,
    pub held: bool,
    pub bytes: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vanished {
    pub role: u8,
    pub uid: u32,
    pub mid: u8,
    pub modseq: u64,
    /// Older than the 30-day expunge-history window (after `age`).
    pub old: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inbox {
    /// 0 live, 1 ended (deleting, invisible), 2 erased by the sweep.
    pub status: u8,
    pub modseq: u64,
    pub floor: u64,
    pub messages: i64,
    pub bytes: i64,
    pub held: i64,
    pub folders: Vec<Folder>,
    pub entries: Vec<Entry>,
    pub members: BTreeMap<u8, Member>,
    pub vanished: Vec<Vanished>,
    /// Thread summary per thread label (the first message of the thread): (messages, unread).
    pub threads: BTreeMap<u8, (i64, i64)>,
    /// Message ids ever filed here (their memberships existed at some point).
    pub seen: Vec<u8>,
}
impl Inbox {
    fn new() -> Self {
        let folder = Folder {
            next: 1,
            high: 1,
            total: 0,
            unseen: 0,
        };
        Inbox {
            status: 0,
            modseq: 1,
            floor: 0,
            messages: 0,
            bytes: 0,
            held: 0,
            folders: vec![folder; 5],
            entries: vec![],
            members: BTreeMap::new(),
            vanished: vec![],
            threads: BTreeMap::new(),
            seen: vec![],
        }
    }
    fn locate(&self, m: u8, role: u8) -> Result<usize, &'static str> {
        let hits: Vec<usize> = (0..self.entries.len())
            .filter(|&i| self.entries[i].mid == m && self.entries[i].role == role)
            .collect();
        match hits.len() {
            0 => Err("MESSAGE_GONE"),
            1 => Ok(hits[0]),
            _ => Err("AMBIGUOUS_ENTRY"),
        }
    }
    fn has_entry(&self, m: u8, role: u8) -> bool {
        self.entries.iter().any(|e| e.mid == m && e.role == role)
    }
    fn add_entry(&mut self, m: u8, role: u8, stamp: u64, seen: bool, deleted: bool) -> u32 {
        let f = &mut self.folders[role as usize];
        let uid = f.next;
        f.next += 1;
        f.total += 1;
        f.unseen += (!seen) as i64;
        f.high = stamp;
        self.entries.push(Entry {
            role,
            uid,
            mid: m,
            modseq: stamp,
            deleted,
        });
        self.entries.sort_by_key(|e| (e.role, e.uid));
        uid
    }
    fn remove_entry(&mut self, i: usize, stamp: u64, was_read: bool) {
        let e = self.entries.remove(i);
        self.vanished.push(Vanished {
            role: e.role,
            uid: e.uid,
            mid: e.mid,
            modseq: stamp,
            old: false,
        });
        self.vanished.sort_by_key(|v| (v.role, v.uid));
        let f = &mut self.folders[e.role as usize];
        f.high = stamp;
        f.total -= 1;
        f.unseen -= (!was_read) as i64;
    }
    /// `inbox_refresh_thread`: recount one conversation; never creates a missing summary.
    fn refresh(&mut self, thread: u8, content: &BTreeMap<u8, u8>) {
        let mut n = 0;
        let mut unread = 0;
        for (m, mem) in &self.members {
            if content.get(m) == Some(&thread) && !mem.held {
                n += 1;
                unread += (!mem.read) as i64;
            }
        }
        if n == 0 {
            self.threads.remove(&thread);
        } else if let Some(t) = self.threads.get_mut(&thread) {
            *t = (n, unread);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub pending: bool,
    pub recips: u8,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Db {
    pub boxes: Vec<Inbox>,
    pub receipts: BTreeMap<u8, Receipt>,
    /// Stored mail_messages content: message -> thread label.
    pub content: BTreeMap<u8, u8>,
    /// 30+ days have passed: the SES notification window for already-received mail is closed.
    pub aged: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Mut {
    Read(u8, u8, bool),
    Flag(u8, u8),
    Deleted(u8, u8, u8, bool),
    Move(u8, u8, u8, u8),
    Copy(u8, u8, u8, u8),
    Trash(u8, u8, u8),
    Expunge(u8, u8, u8),
    Purge(u8, u8),
    Delete(u8),
    Subscribe(u8),
    /// Conversation PATCH (/v1/inbound/threads/{id}) for the thread of a message:
    /// 0 archived=true, 1 archived=false, 2 trashed=true, 3 trashed=false, 4 read=true, 5 read=false.
    Thread(u8, u8, u8),
}
impl Mut {
    fn inbox(self) -> u8 {
        match self {
            Mut::Read(x, ..)
            | Mut::Flag(x, ..)
            | Mut::Deleted(x, ..)
            | Mut::Move(x, ..)
            | Mut::Copy(x, ..) => x,
            Mut::Trash(x, ..)
            | Mut::Expunge(x, ..)
            | Mut::Purge(x, ..)
            | Mut::Delete(x)
            | Mut::Subscribe(x)
            | Mut::Thread(x, ..) => x,
        }
    }
    /// Takes the workspace ingest lane before the inbox row (final removal and deletion).
    fn lane(self) -> bool {
        matches!(
            self,
            Mut::Expunge(..) | Mut::Purge(..) | Mut::Delete(..) | Mut::Thread(..)
        )
    }
}

/// One SQL statement inside its own transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Stmt {
    Accept(u8, u8),
    Store(u8, u8),
    Mut(Mut),
}

pub const LANE: u8 = 0;
/// The workspace's receiving-turn row, updated by the trigger on every queued `mailbox.ingest`
/// job, so SNS notifications that queue a job serialize per workspace.
pub const TURN: u8 = 30;
/// The workspace's hourly receive-window row. The BEFORE INSERT admission trigger charges it
/// whenever the receipt is not visible in the statement's snapshot, before the conflict check.
pub const WINDOW: u8 = 31;
fn receipt_lock(m: u8) -> u8 {
    10 + m
}
fn inbox_lock(x: u8) -> u8 {
    20 + x
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Txn {
    pub stmt: Option<Stmt>,
    pub held: Vec<u8>,
    /// Lock the statement is waiting for.
    pub wait: Option<u8>,
    pub done: bool,
    /// Store lock-plan progress (lane, receipt, inboxes).
    pub stage: u8,
    /// Ingest job claim (message, recipients); survives until the job's transaction ends.
    pub claim: Option<(u8, u8)>,
    /// Completion order among open transactions, for rebuilding `head` on abort.
    pub seq: u32,
    /// Accept: the receipt was not committed when the statement started (admission charge).
    pub window: bool,
    /// Inbox rows a store may or may not have locked: whether PostgreSQL scans `locked_inboxes`
    /// when every delivery row is filtered out (tombstoned-only owners) depends on the plan.
    pub maybe: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Model {
    pub db: Db,
    pub head: Db,
    pub conns: Vec<Txn>,
    pub tick: u32,
    /// Change-sync client cursor per inbox (the last `state` it was given).
    pub cursor: Vec<u64>,
    /// Client cache of a message's MODSEQ from its last GET, keyed "X:m".
    pub cache: BTreeMap<String, u64>,
    /// Inbox A's message quota (None: unlimited). Inbox B is unlimited.
    pub quota: Option<i64>,
    /// Number of inbound messages in the alphabet.
    pub msgs: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Act {
    /// conn: None for an autocommit request, Some(c) for a statement held open on connection c.
    Stmt(Option<u8>, Stmt),
    Claim(u8, u8),
    StoreClaimed(u8),
    StoreAuto(u8),
    Commit(u8),
    Abort(u8),
    Send(u8),
    Folders(u8),
    Sync(u8),
    /// GET /changes with since one above the current state (a checkpoint from the future).
    SyncAhead(u8),
    Get(u8, u8),
    Cas(u8, u8),
    ReadOnly(u8, u8),
    LegacyRead(u8, u8),
    LegacyThread(u8, u8),
    /// The pre-folder Worker's conversation PATCH {read:false}.
    LegacyUnread(u8, u8),
    Sweep,
    Age,
    Prune,
}

pub fn parse(label: &str) -> Option<Act> {
    let words: Vec<&str> = label.split(' ').collect();
    let (conn, w) = match CONNS.iter().position(|c| *c == words[0]) {
        Some(c) => (Some(c as u8), &words[1..]),
        None => (None, &words[..]),
    };
    let x = |i: usize| w.get(i).and_then(|s| box_parse(s));
    let m = |i: usize| w.get(i).and_then(|s| mid_parse(s));
    let r = |i: usize| w.get(i).and_then(|s| role_parse(s));
    let mutation = |mu: Option<Mut>| mu.map(|mu| Act::Stmt(conn, Stmt::Mut(mu)));
    let auto = |a: Option<Act>| if conn.is_none() { a } else { None };
    let ingest = conn.filter(|c| *c < 2);
    match *w.first()? {
        "accept" if conn.is_none_or(|c| c >= 2) => Some(Act::Stmt(
            conn,
            Stmt::Accept(m(1)?, recips_parse(w.get(2)?)?),
        )),
        "claim" => Some(Act::Claim(ingest?, m(1)?)),
        "store" if conn.is_some() && w.len() == 1 => Some(Act::StoreClaimed(ingest?)),
        "store" => auto(Some(Act::StoreAuto(m(1)?))),
        "commit" => Some(Act::Commit(conn?)),
        "abort" => Some(Act::Abort(conn?)),
        _ if ingest.is_some() => None,
        "seen" => mutation(Some(Mut::Read(x(1)?, m(2)?, true))),
        "unseen" => mutation(Some(Mut::Read(x(1)?, m(2)?, false))),
        "flag" => mutation(Some(Mut::Flag(x(1)?, m(2)?))),
        "del" => mutation(Some(Mut::Deleted(x(1)?, m(2)?, r(3)?, true))),
        "undel" => mutation(Some(Mut::Deleted(x(1)?, m(2)?, r(3)?, false))),
        "move" => mutation(Some(Mut::Move(x(1)?, m(2)?, r(3)?, r(4)?))),
        "copy" => mutation(Some(Mut::Copy(x(1)?, m(2)?, r(3)?, r(4)?))),
        "trash" => mutation(Some(Mut::Trash(x(1)?, m(2)?, r(3)?))),
        "expunge" => mutation(Some(Mut::Expunge(x(1)?, m(2)?, r(3)?))),
        "purge" => mutation(Some(Mut::Purge(x(1)?, r(2)?))),
        "subscribe" => mutation(Some(Mut::Subscribe(x(1)?))),
        "delete" => mutation(Some(Mut::Delete(x(1)?))),
        "thread" if conn.is_none() => {
            let kind = ["archive", "unarchive", "trash", "untrash", "read", "unread"]
                .iter()
                .position(|k| Some(k) == w.get(3))? as u8;
            mutation(Some(Mut::Thread(x(1)?, m(2)?, kind)))
        }
        "legacy-unread" => auto(Some(Act::LegacyUnread(x(1)?, m(2)?))),
        "send" => auto(Some(Act::Send(x(1)?))),
        "folders" => auto(Some(Act::Folders(x(1)?))),
        "sync" => auto(Some(Act::Sync(x(1)?))),
        "sync-ahead" => auto(Some(Act::SyncAhead(x(1)?))),
        "get" => auto(Some(Act::Get(x(1)?, m(2)?))),
        "cas" => auto(Some(Act::Cas(x(1)?, m(2)?))),
        "ro" => auto(Some(Act::ReadOnly(x(1)?, m(2)?))),
        "legacy-read" => auto(Some(Act::LegacyRead(x(1)?, m(2)?))),
        "legacy-thread" => auto(Some(Act::LegacyThread(x(1)?, m(2)?))),
        "sweep" => auto(Some(Act::Sweep)),
        "age" => auto(Some(Act::Age)),
        "prune" => auto(Some(Act::Prune)),
        _ => None,
    }
}

/// Every action label of a configuration. `core` is the smaller alphabet for exhaustive edges.
pub fn alphabet(msgs: u8, core: bool) -> Vec<String> {
    let mut out = vec![];
    let ms: Vec<String> = (0..msgs).map(mid_name).collect();
    let mut arriving = ms.clone();
    if msgs == 3 {
        arriving.push(mid_name(3));
    }
    let roles: &[&str] = if core {
        &["inbox", "trash"]
    } else {
        &["inbox", "archive", "trash", "sent"]
    };
    let writers: &[&str] = &["", "W ", "V "];
    for m in &arriving {
        for r in ["a", "b", "ab"] {
            for c in writers {
                out.push(format!("{c}accept {m} {r}"));
            }
        }
        out.push(format!("store {m}"));
        for c in if core { &["I"][..] } else { &["I", "J"][..] } {
            out.push(format!("{c} claim {m}"));
        }
    }
    for c in if core { &["I"][..] } else { &["I", "J"][..] } {
        out.push(format!("{c} store"));
    }
    for c in CONNS {
        if core && c == "J" {
            continue;
        }
        out.push(format!("{c} commit"));
        out.push(format!("{c} abort"));
    }
    for x in BOXES {
        for c in writers {
            out.push(format!("{c}subscribe {x}"));
            out.push(format!("{c}delete {x}"));
            for role in roles {
                out.push(format!("{c}purge {x} {role}"));
            }
        }
        for m in &ms {
            for c in writers {
                for v in ["seen", "unseen", "flag"] {
                    if core && v == "unseen" {
                        continue;
                    }
                    out.push(format!("{c}{v} {x} {m}"));
                }
                for role in roles {
                    out.push(format!("{c}del {x} {m} {role}"));
                    if !core {
                        out.push(format!("{c}undel {x} {m} {role}"));
                    }
                    out.push(format!("{c}trash {x} {m} {role}"));
                    out.push(format!("{c}expunge {x} {m} {role}"));
                    for dst in roles {
                        if !core || role != dst {
                            out.push(format!("{c}move {x} {m} {role} {dst}"));
                        }
                        out.push(format!("{c}copy {x} {m} {role} {dst}"));
                    }
                }
            }
            if !core {
                for k in ["archive", "unarchive", "trash", "untrash", "read", "unread"] {
                    out.push(format!("thread {x} {m} {k}"));
                }
            }
            for v in [
                "get",
                "cas",
                "ro",
                "legacy-read",
                "legacy-thread",
                "legacy-unread",
            ] {
                if core && v != "legacy-read" {
                    continue;
                }
                out.push(format!("{v} {x} {m}"));
            }
        }
        out.push(format!("folders {x}"));
        out.push(format!("sync {x}"));
        if !core {
            out.push(format!("send {x}"));
            out.push(format!("sync-ahead {x}"));
        }
    }
    if !core {
        out.extend(["sweep".into(), "age".into(), "prune".into()]);
    }
    out
}

fn err(code: &str) -> Value {
    json!(format!("e:{code}"))
}

/// Apply one statement's effect to `db`; returns the request's result. Deterministic, so the
/// same statement replays identically onto the committed state at COMMIT.
fn apply(db: &mut Db, stmt: Stmt, quota: Option<i64>) -> Value {
    match stmt {
        Stmt::Accept(m, r) => {
            // SNS Received: insert a pending receipt, or reopen with the union of recipients.
            // A duplicate (subset) changes nothing and queues no job.
            match db.receipts.get_mut(&m) {
                None => {
                    db.receipts.insert(
                        m,
                        Receipt {
                            pending: true,
                            recips: r,
                        },
                    );
                    json!({"queued": 1})
                }
                Some(rc) if rc.recips | r != rc.recips => {
                    rc.recips |= r;
                    rc.pending = true;
                    json!({"queued": 1})
                }
                Some(_) => json!({"queued": 0}),
            }
        }
        Stmt::Store(m, r) => {
            match db.receipts.get(&m) {
                Some(rc) if rc.pending && rc.recips == r => {}
                // Stale claim (reopened since) or already processed: a no-op.
                _ => return json!("ok"),
            }
            // The stored row: the same SES id (reopen) or the same Message-ID and content (duplicate).
            let group = |k: u8| {
                if k == 0 || k == 3 {
                    vec![0, 3]
                } else {
                    vec![k]
                }
            };
            let id = group(m)
                .into_iter()
                .find(|k| db.content.contains_key(k))
                .unwrap_or(m);
            let thread = match db.content.get(&id) {
                Some(t) => *t,
                None => {
                    // m2 replies to m1: it joins that conversation only if m1 (or d1) is stored.
                    let t = if m == 1 {
                        group(0)
                            .into_iter()
                            .find_map(|k| db.content.get(&k).copied())
                            .unwrap_or(1)
                    } else {
                        id
                    };
                    db.content.insert(id, t);
                    t
                }
            };
            db.receipts.get_mut(&m).unwrap().pending = false;
            for x in 0..2u8 {
                if r & (1 << x) == 0 {
                    continue;
                }
                let b = &mut db.boxes[x as usize];
                // Ended inboxes stop receiving; an expunged message never returns to this inbox.
                if b.status != 0 || b.members.contains_key(&id) || b.seen.contains(&id) {
                    continue;
                }
                let held = x == 0 && quota.is_some_and(|q| b.messages >= q);
                b.messages += 1;
                b.bytes += INBOUND_BYTES;
                b.held += held as i64;
                b.seen.push(id);
                b.seen.sort();
                b.modseq += 1;
                let stamp = b.modseq;
                b.members.insert(
                    id,
                    Member {
                        read: false,
                        flagged: false,
                        modseq: stamp,
                        held,
                        bytes: INBOUND_BYTES,
                    },
                );
                if !held {
                    let t = b.threads.entry(thread).or_insert((0, 0));
                    t.0 += 1;
                    t.1 += 1;
                    b.add_entry(id, INBOX, stamp, false, false);
                }
            }
            json!("ok")
        }
        Stmt::Mut(mu) => mutate(db, mu),
    }
}

fn mutate(db: &mut Db, mu: Mut) -> Value {
    let x = mu.inbox() as usize;
    if db.boxes[x].status != 0 {
        return err("NOT_FOUND");
    }
    let content = db.content.clone();
    let b = &mut db.boxes[x];
    if let Mut::Subscribe(_) = mu {
        b.modseq += 1;
        return json!(b.modseq);
    }
    if let Mut::Delete(_) = mu {
        b.status = 1;
        return json!("deleting");
    }
    if let Mut::Purge(_, role) = mu {
        let targets: Vec<(u32, u8)> = b
            .entries
            .iter()
            .filter(|e| e.role == role && e.deleted)
            .map(|e| (e.uid, e.mid))
            .collect();
        for (uid, m) in &targets {
            let i = b
                .entries
                .iter()
                .position(|e| e.role == role && e.uid == *uid)
                .unwrap();
            expunge_entry(b, *m, i, &content);
        }
        return json!({"expunged": targets.len()});
    }
    if let Mut::Thread(_, m, kind) = mu {
        let t = content.get(&m).copied().unwrap_or(m);
        return thread_patch(b, t, kind, &content);
    }
    let m = match mu {
        Mut::Read(_, m, _)
        | Mut::Flag(_, m)
        | Mut::Deleted(_, m, ..)
        | Mut::Move(_, m, ..)
        | Mut::Copy(_, m, ..) => m,
        Mut::Trash(_, m, _) | Mut::Expunge(_, m, _) => m,
        _ => unreachable!(),
    };
    let Some(mem) = b.members.get(&m).cloned() else {
        return err("MESSAGE_GONE");
    };
    let src = match mu {
        Mut::Deleted(_, _, r, _)
        | Mut::Move(_, _, r, _)
        | Mut::Copy(_, _, r, _)
        | Mut::Trash(_, _, r)
        | Mut::Expunge(_, _, r) => Some(r),
        _ => None,
    };
    let ent = match src.map(|r| b.locate(m, r)) {
        Some(Err(code)) => return err(code),
        Some(Ok(i)) => Some(i),
        None => None,
    };
    match mu {
        Mut::Read(..) | Mut::Flag(..) | Mut::Deleted(..) => {
            let seen = if let Mut::Read(_, _, v) = mu {
                v
            } else {
                mem.read
            };
            let flagged = matches!(mu, Mut::Flag(..)) || mem.flagged;
            let target = match (mu, ent) {
                (Mut::Deleted(_, _, _, v), Some(i)) => {
                    Some((b.entries[i].role, b.entries[i].uid, v))
                }
                _ => None,
            };
            let stamp = b.set_flags(m, seen, flagged, target, true, &content);
            json!({"modseq": stamp, "uid": null, "read": seen, "removed": false})
        }
        Mut::Move(..) | Mut::Copy(..) | Mut::Trash(..) => {
            let dst = match mu {
                Mut::Move(_, _, _, d) | Mut::Copy(_, _, _, d) => d,
                _ => TRASH,
            };
            let (stamp, uid) = b.transfer(
                m,
                ent.unwrap(),
                dst,
                matches!(mu, Mut::Copy(..)),
                true,
                &content,
            );
            json!({"modseq": stamp, "uid": uid, "read": mem.read, "removed": false})
        }
        Mut::Expunge(..) => {
            let (stamp, gone) = expunge_entry(b, m, ent.unwrap(), &content);
            json!({"modseq": stamp, "uid": null, "read": mem.read, "removed": gone})
        }
        _ => unreachable!(),
    }
}

/// `inbox_patch_thread`: per non-held message of the conversation (by id), a flag change without
/// refresh, then one move per folder entry that the patch relocates, then one recount.
fn thread_patch(b: &mut Inbox, t: u8, kind: u8, content: &BTreeMap<u8, u8>) -> Value {
    if !b.threads.contains_key(&t) {
        return err("NOT_FOUND");
    }
    let mut members: Vec<u8> = b
        .members
        .iter()
        .filter(|(m, mem)| content.get(m) == Some(&t) && !mem.held)
        .map(|(m, _)| *m)
        .collect();
    members.sort_by_key(|m| mid_name(*m));
    let newest = members
        .iter()
        .filter(|m| **m < 10)
        .max_by_key(|m| arrival(**m))
        .copied();
    for m in members {
        if kind >= 4 {
            let read = kind == 4;
            if read || newest == Some(m) {
                let flagged = b.members[&m].flagged;
                b.set_flags(m, read, flagged, None, false, content);
            }
        }
        let home = if m >= 10 { SENT } else { INBOX };
        let entries: Vec<(u8, u32)> = b
            .entries
            .iter()
            .filter(|e| e.mid == m)
            .map(|e| (e.role, e.uid))
            .collect();
        for (role, uid) in entries {
            let dest = match kind {
                0 => Some(0),
                2 => Some(TRASH),
                1 if role == 0 => Some(home),
                3 if role == TRASH => Some(home),
                _ => None,
            };
            if let Some(dest) = dest.filter(|d| *d != role) {
                let i = b
                    .entries
                    .iter()
                    .position(|e| e.role == role && e.uid == uid)
                    .unwrap();
                b.transfer(m, i, dest, false, false, content);
            }
        }
    }
    b.refresh(t, content);
    json!("ok")
}

impl Inbox {
    /// Flag/read change: bumps every entry of the message unless only one entry's \Deleted changes.
    fn set_flags(
        &mut self,
        m: u8,
        seen: bool,
        flagged: bool,
        target: Option<(u8, u32, bool)>,
        refresh: bool,
        content: &BTreeMap<u8, u8>,
    ) -> u64 {
        let mem = self.members[&m].clone();
        self.modseq += 1;
        let stamp = self.modseq;
        let changed = seen != mem.read || flagged != mem.flagged;
        for e in self.entries.iter_mut() {
            let is_target = target.is_some_and(|(r, u, _)| (e.role, e.uid) == (r, u));
            if e.mid != m || !(changed || target.is_none() || is_target) {
                continue;
            }
            e.modseq = stamp;
            if let (Some((_, _, v)), true) = (target, is_target) {
                e.deleted = v;
            }
            let f = &mut self.folders[e.role as usize];
            f.high = stamp;
            if seen != mem.read {
                f.unseen += if seen { -1 } else { 1 };
            }
        }
        let entry = self.members.get_mut(&m).unwrap();
        entry.modseq = stamp;
        entry.read = seen;
        entry.flagged = flagged;
        if refresh && !mem.held {
            self.refresh(content.get(&m).copied().unwrap_or(m), content);
        }
        stamp
    }
    /// Move or copy one entry to `dst` with a fresh UID; a move tombstones the source UID.
    fn transfer(
        &mut self,
        m: u8,
        i: usize,
        dst: u8,
        copy: bool,
        refresh: bool,
        content: &BTreeMap<u8, u8>,
    ) -> (u64, u32) {
        let mem = self.members[&m].clone();
        let (deleted, uid0, src) = (
            self.entries[i].deleted,
            self.entries[i].uid,
            self.entries[i].role,
        );
        self.modseq += 1;
        let stamp = self.modseq;
        let uid = self.add_entry(m, dst, stamp, mem.read, deleted);
        if !copy {
            let i = self
                .entries
                .iter()
                .position(|e| e.role == src && e.uid == uid0)
                .unwrap();
            self.remove_entry(i, stamp, mem.read);
        }
        self.members.get_mut(&m).unwrap().modseq = stamp;
        if refresh && !mem.held {
            self.refresh(content.get(&m).copied().unwrap_or(m), content);
        }
        (stamp, uid)
    }
}

fn expunge_entry(b: &mut Inbox, m: u8, i: usize, content: &BTreeMap<u8, u8>) -> (u64, bool) {
    let mem = b.members[&m].clone();
    b.modseq += 1;
    let stamp = b.modseq;
    b.remove_entry(i, stamp, mem.read);
    let gone = !b.entries.iter().any(|e| e.mid == m);
    if gone {
        b.members.remove(&m);
        b.messages = (b.messages - 1).max(0);
        b.bytes = (b.bytes - mem.bytes).max(0);
    } else {
        b.members.get_mut(&m).unwrap().modseq = stamp;
    }
    if !mem.held {
        b.refresh(content.get(&m).copied().unwrap_or(m), content);
    }
    (stamp, gone)
}

impl Model {
    pub fn initial(msgs: u8, quota: Option<i64>) -> Self {
        let db = Db {
            boxes: vec![Inbox::new(), Inbox::new()],
            receipts: BTreeMap::new(),
            content: BTreeMap::new(),
            aged: false,
        };
        Model {
            head: db.clone(),
            db,
            conns: vec![Txn::default(); 4],
            tick: 0,
            cursor: vec![0, 0],
            cache: BTreeMap::new(),
            quota,
            msgs,
        }
    }

    fn holder(&self, lock: u8, except: usize) -> bool {
        self.conns
            .iter()
            .enumerate()
            .any(|(i, t)| i != except && t.held.contains(&lock))
    }
    fn blocked_any(&self) -> bool {
        self.conns.iter().any(|t| t.wait.is_some())
    }
    fn busy(&self, c: usize) -> bool {
        self.conns[c].stmt.is_some()
    }

    /// Next lock the statement on `c` needs, or None when it can run now.
    fn need(&self, c: usize, stmt: Stmt) -> Option<u8> {
        let held = &self.conns[c].held;
        let take = |l: u8| (!held.contains(&l)).then_some(l);
        match stmt {
            Stmt::Accept(m, r) => {
                if self.conns[c].window
                    && let Some(l) = take(WINDOW)
                {
                    return Some(l);
                }
                if let Some(l) = take(receipt_lock(m)) {
                    return Some(l);
                }
                let queues = self
                    .head
                    .receipts
                    .get(&m)
                    .is_none_or(|rc| rc.recips | r != rc.recips);
                if queues { take(TURN) } else { None }
            }
            Stmt::Store(m, r) => {
                if let Some(l) = take(LANE) {
                    return Some(l);
                }
                // The store statement's snapshot starts after the lane: it only locks (waits for)
                // the receipt row when that committed row is still this claim's pending receipt.
                let live = |db: &Db| {
                    db.receipts
                        .get(&m)
                        .is_some_and(|rc| rc.pending && rc.recips == r)
                };
                if !live(&self.db) {
                    return None;
                }
                if let Some(l) = take(receipt_lock(m)) {
                    return Some(l);
                }
                // `locked_inboxes` is scanned only if some delivery row reaches its join: one
                // owner that is not tombstoned-only for this message. Then it locks every owner.
                let head = &self.head;
                let group = |k: u8| {
                    if k == 0 || k == 3 {
                        vec![0u8, 3]
                    } else {
                        vec![k]
                    }
                };
                let id = group(m)
                    .into_iter()
                    .find(|k| head.content.contains_key(k))
                    .unwrap_or(m);
                let owners: Vec<u8> = (0..2u8)
                    .filter(|x| r & (1 << x) != 0 && head.boxes[*x as usize].status == 0)
                    .collect();
                let reaches = owners.iter().any(|x| {
                    let b = &head.boxes[*x as usize];
                    !(b.seen.contains(&id) && !b.members.contains_key(&id))
                });
                if !reaches {
                    return None;
                }
                let _ = &owners;
                owners.into_iter().find_map(|x| take(inbox_lock(x)))
            }
            Stmt::Mut(mu) => {
                // The route's visibility check reads the committed inbox row before any lock.
                if self.conns[c].stage == 0 && self.db.boxes[mu.inbox() as usize].status != 0 {
                    return None;
                }
                if mu.lane()
                    && let Some(l) = take(LANE)
                {
                    return Some(l);
                }
                take(inbox_lock(mu.inbox()))
            }
        }
    }

    /// Acquire locks until the statement on `c` blocks or completes; returns its result if done.
    fn advance(&mut self, c: usize) -> Option<Value> {
        let stmt = self.conns[c].stmt.unwrap();
        loop {
            match self.need(c, stmt) {
                Some(l) if self.holder(l, c) => {
                    self.conns[c].wait = Some(l);
                    return None;
                }
                Some(l) => {
                    self.conns[c].held.push(l);
                    self.conns[c].stage += 1;
                }
                None => {
                    self.conns[c].maybe = self.maybe_locks(c, stmt);
                    self.conns[c].wait = None;
                    self.conns[c].done = true;
                    self.tick += 1;
                    self.conns[c].seq = self.tick;
                    return Some(apply(&mut self.head, stmt, self.quota));
                }
            }
        }
    }

    /// Owners' inbox rows a completed store may hold without delivering to any of them.
    fn maybe_locks(&self, c: usize, stmt: Stmt) -> Vec<u8> {
        let Stmt::Store(m, r) = stmt else {
            return vec![];
        };
        if !self
            .db
            .receipts
            .get(&m)
            .is_some_and(|rc| rc.pending && rc.recips == r)
        {
            return vec![];
        }
        (0..2u8)
            .filter(|x| r & (1 << x) != 0 && self.head.boxes[*x as usize].status == 0)
            .map(inbox_lock)
            .filter(|l| !self.conns[c].held.contains(l))
            .collect()
    }
    /// The first lock the statement would wait for, if any.
    fn first_wait(&self, c: usize, stmt: Stmt) -> Option<u8> {
        let mut probe = self.clone();
        probe.begin(c, stmt);
        probe.advance(c);
        probe.conns[c].wait
    }
    /// The statement would touch a row lock that another open store may or may not hold.
    fn contends_maybe(&self, c: usize, stmt: Stmt) -> bool {
        let mut probe = self.clone();
        for t in probe.conns.iter_mut() {
            let maybe = std::mem::take(&mut t.maybe);
            t.held.extend(maybe);
        }
        if c >= probe.conns.len() {
            probe.conns.push(Txn::default());
        }
        let c = c.min(probe.conns.len() - 1);
        if probe
            .first_wait(c, stmt)
            .is_some_and(|l| self.conns.iter().any(|t| t.maybe.contains(&l)))
        {
            return true;
        }
        // A store whose only owners are tombstoned may or may not wait for their inbox rows.
        let mut run = self.clone();
        if c >= run.conns.len() {
            run.conns.push(Txn::default());
        }
        run.begin(c, stmt);
        run.advance(c).is_some() && run.conns[c].maybe.iter().any(|l| run.holder(*l, c))
    }

    /// Ending `c` would wake a store into a state where it may or may not wait for an inbox row
    /// another open transaction holds (see `maybe`).
    fn wake_ambiguous(&self, c: usize, commit: bool) -> bool {
        let mut probe = self.clone();
        probe.finish(c, commit);
        (0..probe.conns.len()).any(|w| {
            let t = &probe.conns[w];
            t.done && self.conns[w].wait.is_some() && t.maybe.iter().any(|l| probe.holder(*l, w))
        })
    }

    /// Statement on connection `c` would block right away.
    fn would_block(&self, c: usize, stmt: Stmt) -> bool {
        let mut probe = self.clone();
        probe.begin(c, stmt);
        probe.advance(c).is_none()
    }
    fn begin(&mut self, c: usize, stmt: Stmt) {
        let stmt = match stmt {
            Stmt::Mut(mu) => Stmt::Mut(resolve_mut(&self.db, mu)),
            s => s,
        };
        let window = matches!(stmt, Stmt::Accept(m, _) if !self.db.receipts.contains_key(&m));
        self.conns[c].stmt = Some(stmt);
        self.conns[c].window = window;
    }
    /// An autocommit request runs only when none of its locks is held by an open transaction.
    fn free(&self, stmt: Stmt) -> bool {
        let mut probe = self.clone();
        probe.conns.push(Txn::default());
        let c = probe.conns.len() - 1;
        probe.begin(c, stmt);
        probe.advance(c).is_some()
    }
    fn inbox_free(&self, x: u8) -> bool {
        let l = inbox_lock(x);
        !self.holder(l, usize::MAX) && !self.conns.iter().any(|t| t.maybe.contains(&l))
    }
    fn quiescent(&self) -> bool {
        self.conns.iter().all(|t| t.stmt.is_none())
    }
    fn knows(&self, x: u8, m: u8) -> bool {
        self.head.boxes[x as usize]
            .seen
            .contains(&resolve(&self.head, m))
    }

    pub fn enabled(&self, a: Act) -> bool {
        let head = &self.head;
        let live = |x: u8| head.boxes[x as usize].status != 2;
        match a {
            Act::Stmt(conn, stmt) => {
                let ok = match stmt {
                    Stmt::Accept(m, _) => {
                        !self.db.aged
                            || !(head.receipts.contains_key(&m)
                                || m == 3 && head.content.contains_key(&0)
                                || m == 0 && head.content.contains_key(&3))
                    }
                    Stmt::Store(..) => true,
                    Stmt::Mut(mu) => {
                        let x = mu.inbox();
                        let b = &head.boxes[x as usize];
                        live(x)
                            && match mu {
                                Mut::Subscribe(_) => true,
                                Mut::Delete(_) => b.status == 0,
                                Mut::Purge(_, r) => b.entries.iter().any(|e| e.role == r),
                                Mut::Read(_, m, _) | Mut::Flag(_, m) | Mut::Thread(_, m, _) => {
                                    self.knows(x, m)
                                }
                                Mut::Deleted(_, m, r, _)
                                | Mut::Move(_, m, r, _)
                                | Mut::Copy(_, m, r, _)
                                | Mut::Trash(_, m, r)
                                | Mut::Expunge(_, m, r) => {
                                    let rm = resolve(head, m);
                                    b.has_entry(rm, r)
                                        || (self.knows(x, m) && !b.members.contains_key(&rm))
                                }
                            }
                    }
                };
                ok && match conn {
                    None => self.free(stmt) && !self.contends_maybe(usize::MAX, stmt),
                    Some(c) => {
                        !self.busy(c as usize)
                            && (!self.blocked_any() || !self.would_block(c as usize, stmt))
                            && !self.contends_maybe(c as usize, stmt)
                    }
                }
            }
            Act::Claim(c, m) => {
                let t = &self.conns[c as usize];
                t.stmt.is_none()
                    && t.claim.is_none()
                    && self.db.receipts.contains_key(&m)
                    && !self.db.aged
            }
            Act::StoreClaimed(c) => {
                let t = &self.conns[c as usize];
                t.stmt.is_none()
                    && t.claim.is_some_and(|(m, r)| {
                        (!self.blocked_any() || !self.would_block(c as usize, Stmt::Store(m, r)))
                            && !self.contends_maybe(c as usize, Stmt::Store(m, r))
                    })
            }
            Act::StoreAuto(m) => {
                self.db.receipts.get(&m).is_some_and(|rc| {
                    rc.pending
                        && self.free(Stmt::Store(m, rc.recips))
                        && !self.contends_maybe(usize::MAX, Stmt::Store(m, rc.recips))
                }) && !self.db.aged
            }
            Act::Commit(c) | Act::Abort(c) => {
                let t = &self.conns[c as usize];
                t.done && !self.wake_ambiguous(c as usize, matches!(a, Act::Commit(_)))
            }
            Act::Send(x) => {
                head.boxes[x as usize].status == 0
                    && !head.content.contains_key(&(10 + x))
                    && self.inbox_free(x)
            }
            Act::Folders(x) | Act::Sync(x) | Act::SyncAhead(x) => live(x),
            Act::Get(x, m) | Act::ReadOnly(x, m) => live(x) && self.knows(x, m),
            Act::Cas(x, m) => {
                live(x)
                    && self
                        .cache
                        .contains_key(&format!("{}:{}", BOXES[x as usize], mid_name(m)))
                    && self.free(Stmt::Mut(Mut::Flag(x, m)))
                    && !self.contends_maybe(usize::MAX, Stmt::Mut(Mut::Flag(x, m)))
            }
            Act::LegacyRead(x, m) | Act::LegacyThread(x, m) | Act::LegacyUnread(x, m) => {
                live(x) && self.knows(x, m) && self.inbox_free(x)
            }
            Act::Sweep => self.quiescent() && head.boxes.iter().any(|b| b.status == 1),
            Act::Age => self.quiescent() && !self.db.aged,
            Act::Prune => self.quiescent() && self.db.aged,
        }
    }

    fn finish(&mut self, c: usize, commit: bool) -> Value {
        let t = std::mem::take(&mut self.conns[c]);
        if commit && let Some(stmt) = t.stmt {
            apply(&mut self.db, stmt, self.quota);
        }
        // Rebuild head = committed + remaining completed statements, in completion order.
        let mut done: Vec<(u32, Stmt)> = self
            .conns
            .iter()
            .filter(|t| t.done)
            .map(|t| (t.seq, t.stmt.unwrap()))
            .collect();
        done.sort_by_key(|d| d.0);
        self.head = self.db.clone();
        for (_, s) in done {
            apply(&mut self.head, s, self.quota);
        }
        // Wake the (single) blocked statement if it can proceed now.
        let mut woke = serde_json::Map::new();
        for w in 0..self.conns.len() {
            if let Some(l) = self.conns[w].wait
                && !self.holder(l, w)
            {
                // A row-lock waiter acquires the lock it waited for, even when its recheck then
                // finds the new row version no longer matches (the lock stays until it ends).
                self.conns[w].held.push(l);
                self.conns[w].stage += 1;
                self.conns[w].wait = None;
                if let Some(r) = self.advance(w) {
                    woke.insert(CONNS[w].into(), r);
                }
            }
        }
        json!(woke)
    }

    /// Run an autocommit statement: it holds no lock across steps, so commit at once.
    fn auto(&mut self, stmt: Stmt) -> Value {
        let stmt = match stmt {
            Stmt::Mut(mu) => Stmt::Mut(resolve_mut(&self.db, mu)),
            s => s,
        };
        let r = apply(&mut self.head, stmt, self.quota);
        apply(&mut self.db, stmt, self.quota);
        r
    }

    /// Advance the model; returns the expected request result and any statements it unblocked.
    pub fn step(&mut self, a: Act) -> (Value, Value) {
        let none = json!({});
        match a {
            Act::Stmt(None, stmt) => (self.auto(stmt), none),
            Act::Stmt(Some(c), stmt) => {
                self.begin(c as usize, stmt);
                (self.advance(c as usize).unwrap_or(json!("blocked")), none)
            }
            Act::Claim(c, m) => {
                let rc = self
                    .db
                    .receipts
                    .get(&m)
                    .filter(|rc| rc.pending)
                    .map(|rc| rc.recips);
                self.conns[c as usize].claim = rc.map(|r| (m, r));
                (rc.map_or(Value::Null, |r| json!(recips_name(r))), none)
            }
            Act::StoreClaimed(c) => {
                let (m, r) = self.conns[c as usize].claim.unwrap();
                self.begin(c as usize, Stmt::Store(m, r));
                (self.advance(c as usize).unwrap_or(json!("blocked")), none)
            }
            Act::StoreAuto(m) => {
                let r = self.db.receipts[&m].recips;
                self.auto(Stmt::Store(m, r));
                (json!(recips_name(r)), none)
            }
            Act::Commit(c) => (json!("ok"), self.finish(c as usize, true)),
            Act::Abort(c) => (json!("ok"), self.finish(c as usize, false)),
            Act::Send(x) => {
                for db in [&mut self.db, &mut self.head] {
                    let m = 10 + x;
                    db.content.insert(m, m);
                    let b = &mut db.boxes[x as usize];
                    b.threads.insert(m, (1, 0));
                    b.modseq += 1;
                    let stamp = b.modseq;
                    b.messages += 1;
                    b.bytes += SENT_BYTES;
                    b.seen.push(m);
                    b.members.insert(
                        m,
                        Member {
                            read: true,
                            flagged: false,
                            modseq: stamp,
                            held: false,
                            bytes: SENT_BYTES,
                        },
                    );
                    b.add_entry(m, SENT, stamp, true, false);
                }
                (json!("ok"), none)
            }
            Act::Folders(x) => (self.folders(x), none),
            Act::Sync(x) => (self.sync(x), none),
            Act::SyncAhead(x) => (
                if self.db.boxes[x as usize].status != 0 {
                    err("NOT_FOUND")
                } else {
                    err("CHANGES_EXPIRED")
                },
                none,
            ),
            Act::Get(x, m) => {
                let key = format!("{}:{}", BOXES[x as usize], mid_name(m));
                let m = resolve(&self.db, m);
                let b = &self.db.boxes[x as usize];
                match (b.status, b.members.get(&m)) {
                    (0, Some(mem)) => {
                        self.cache.insert(key, mem.modseq);
                        let locs: Vec<Value> = b
                            .entries
                            .iter()
                            .filter(|e| e.mid == m)
                            .map(|e| json!([ROLES[e.role as usize], e.uid, e.deleted]))
                            .collect();
                        (
                            json!({"modseq": mem.modseq, "read": mem.read, "flagged": mem.flagged, "held": mem.held, "folders": locs}),
                            none,
                        )
                    }
                    _ => (err("NOT_FOUND"), none),
                }
            }
            Act::Cas(x, m) => {
                let key = format!("{}:{}", BOXES[x as usize], mid_name(m));
                let cached = self.cache[&key];
                let b = &self.db.boxes[x as usize];
                if b.status == 0
                    && b.members
                        .get(&resolve(&self.db, m))
                        .is_some_and(|mem| mem.modseq > cached)
                {
                    return (err("MODIFIED"), none);
                }
                (self.auto(Stmt::Mut(Mut::Flag(x, m))), none)
            }
            Act::ReadOnly(..) => (err("PERMISSION_DENIED"), none),
            Act::LegacyRead(x, m) => {
                let m = resolve(&self.db, m);
                let b = &self.db.boxes[x as usize];
                (
                    match b.members.get(&m) {
                        _ if b.status == 1 => err("NOT_FOUND"),
                        None => err("NOT_FOUND"),
                        Some(mem) if !mem.read => err("40001"),
                        Some(_) => json!("ok"),
                    },
                    none,
                )
            }
            Act::LegacyThread(x, m) => {
                let m = resolve(&self.db, m);
                let b = &self.db.boxes[x as usize];
                let t = self.db.content.get(&m).copied().unwrap_or(m);
                // The pre-folder Worker's thread PATCH rewrote the summary row's labels directly.
                (
                    if b.status == 0 && b.threads.contains_key(&t) {
                        err("40001")
                    } else {
                        err("NOT_FOUND")
                    },
                    none,
                )
            }
            Act::LegacyUnread(x, m) => {
                let m = resolve(&self.db, m);
                // Spec: a pre-folder Worker write is rejected (40001) or changes nothing.
                let b = &self.db.boxes[x as usize];
                let t = self.db.content.get(&m).copied().unwrap_or(m);
                if b.status != 0 || !b.threads.contains_key(&t) {
                    return (err("NOT_FOUND"), none);
                }
                let inbound: Vec<(&u8, &Member)> = b
                    .members
                    .iter()
                    .filter(|(k, _)| **k < 10 && self.db.content.get(k) == Some(&t))
                    .collect();
                let latest = inbound.iter().max_by_key(|(k, _)| arrival(**k));
                // Its recount counts every unread inbound membership, held mail included.
                let recount = inbound.iter().filter(|(_, mem)| !mem.read).count() as i64;
                let changes = latest.is_some_and(|(_, mem)| mem.read) || recount != b.threads[&t].1;
                (if changes { err("40001") } else { json!("ok") }, none)
            }
            Act::Sweep => {
                for db in [&mut self.db, &mut self.head] {
                    for b in db.boxes.iter_mut().filter(|b| b.status == 1) {
                        *b = Inbox {
                            status: 2,
                            ..Inbox::new()
                        };
                    }
                }
                (json!("ok"), none)
            }
            Act::Age => {
                for db in [&mut self.db, &mut self.head] {
                    db.aged = true;
                    for b in db.boxes.iter_mut() {
                        b.vanished.iter_mut().for_each(|v| v.old = true);
                    }
                }
                (json!("ok"), none)
            }
            Act::Prune => {
                for db in [&mut self.db, &mut self.head] {
                    for b in db.boxes.iter_mut().filter(|b| b.status != 2) {
                        if let Some(top) =
                            b.vanished.iter().filter(|v| v.old).map(|v| v.modseq).max()
                        {
                            b.floor = b.floor.max(top);
                        }
                        b.vanished.retain(|v| !v.old);
                    }
                }
                (json!("ok"), none)
            }
        }
    }

    fn folders(&self, x: u8) -> Value {
        let b = &self.db.boxes[x as usize];
        if b.status != 0 {
            return err("NOT_FOUND");
        }
        let lists: Vec<Value> = (0..5u8)
            .map(|r| {
                json!(
                    b.entries
                        .iter()
                        .filter(|e| e.role == r)
                        .map(|e| {
                            let mem = &b.members[&e.mid];
                            json!([e.uid, mid_name(e.mid), mem.read, mem.flagged, e.deleted])
                        })
                        .collect::<Vec<_>>()
                )
            })
            .collect();
        json!({"state": b.modseq, "folders": b.folders.iter().map(|f| json!([f.next, f.high, f.total, f.unseen])).collect::<Vec<_>>(), "lists": lists})
    }

    fn sync(&mut self, x: u8) -> Value {
        let b = &self.db.boxes[x as usize];
        if b.status != 0 {
            return err("NOT_FOUND");
        }
        let since = self.cursor[x as usize];
        if b.modseq < since || b.floor > since {
            // The client lists folders again and resumes from the current state.
            self.cursor[x as usize] = b.modseq;
            return err("CHANGES_EXPIRED");
        }
        let mut ids: Vec<u8> = b
            .members
            .iter()
            .filter(|(_, mem)| mem.modseq > since)
            .map(|(m, _)| *m)
            .collect();
        ids.extend(
            b.vanished
                .iter()
                .filter(|v| v.modseq > since)
                .map(|v| v.mid),
        );
        ids.sort();
        ids.dedup();
        let (changed, removed): (Vec<u8>, Vec<u8>) =
            ids.into_iter().partition(|m| b.members.contains_key(m));
        self.cursor[x as usize] = b.modseq;
        let names = |v: Vec<u8>| {
            let mut n: Vec<String> = v.into_iter().map(mid_name).collect();
            n.sort();
            n
        };
        json!({"changed": names(changed), "removed": names(removed), "state": b.modseq})
    }

    /// The committed database as the host reports it after every step.
    pub fn view(&self) -> Value {
        let db = &self.db;
        let boxes: Vec<Value> = db
            .boxes
            .iter()
            .map(|b| {
                if b.status == 2 {
                    return json!({"st": 2});
                }
                json!({
                    "st": b.status, "ms": b.modseq, "fl": b.floor, "n": b.messages, "by": b.bytes, "h": b.held,
                    "f": b.folders.iter().map(|f| json!([f.next, f.high, f.total, f.unseen])).collect::<Vec<_>>(),
                    "e": b.entries.iter().map(|e| json!([ROLES[e.role as usize], e.uid, mid_name(e.mid), e.modseq, e.deleted])).collect::<Vec<_>>(),
                    "m": b.members.iter().map(|(m, v)| (mid_name(*m), json!([v.read, v.flagged, v.modseq, v.held]))).collect::<serde_json::Map<_, _>>(),
                    "v": b.vanished.iter().map(|v| json!([ROLES[v.role as usize], v.uid, mid_name(v.mid), v.modseq])).collect::<Vec<_>>(),
                    "t": b.threads.iter().map(|(t, (n, u))| (mid_name(*t), json!([n, u]))).collect::<serde_json::Map<_, _>>(),
                })
            })
            .collect();
        let receipts: serde_json::Map<String, Value> = db
            .receipts
            .iter()
            .map(|(m, r)| (mid_name(*m), json!([r.pending, recips_name(r.recips)])))
            .collect();
        json!({"A": boxes[0], "B": boxes[1], "r": receipts})
    }
}
