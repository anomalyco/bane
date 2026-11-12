//! Independent reference model of one inbox shared by up to three IMAP sessions.
//!
//! Written from the contracts, not from the gateway code:
//!
//! - **Store contract** (`core/src/store.rs`, the phase-2 SQL in `api/migrations/14x-15x`):
//!   ordinary flags and keywords belong to the message (every copy sees them), `\Deleted`
//!   belongs to the folder entry, UIDs are per folder, strictly ascending and never reused,
//!   and a recreated folder gets a new UIDVALIDITY.
//! - **Bane's notification policy**: a session's view changes only on SELECT/EXAMINE, NOOP,
//!   IDLE, APPEND, COPY, MOVE, EXPUNGE and CLOSE, never during FETCH or STORE (RFC 3501
//!   7.4.1). A deleted selected folder ends the session with BYE at its next command.
//! - **Remote store** (`Backend::Remote`): each connection owns a snapshot of its selected
//!   folder (`Known`). It reloads on SELECT, after its own mutations, before a command once a
//!   change hint or the 240 s age marks it stale, and on a hint while idling, where the reload
//!   may be served from the process-wide wake cache keyed by (credential, folder, since-MODSEQ)
//!   that every hint clears. The internal API's MODSEQ rules (one MODSEQ per UID in a batch;
//!   a `\Deleted`-only change bumps only its own entry; folder deletion raises the tombstone
//!   floor) are encoded here independently, so the fake API and this model cross-check.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub type Flags = BTreeSet<String>;
/// Client-visible folders. `Work` is a custom folder that sessions create and delete.
pub const FOLDERS: [&str; 3] = ["INBOX", "Archive", "Work"];
/// Everything the server comparison covers. The API moves a deleted custom folder's last
/// copies to Trash, so Trash is part of the truth even though clients never select it here.
pub const SERVER: [&str; 4] = ["INBOX", "Archive", "Work", "Trash"];
pub const WORK: usize = 2;
pub const TRASH: usize = 3;
pub const SESSIONS: [&str; 4] = ["A", "B", "C", "D"];
pub const FLAG_NAMES: [(&str, &str); 4] = [
    ("seen", "\\Seen"),
    ("flagged", "\\Flagged"),
    ("deleted", "\\Deleted"),
    ("todo", "$Todo"),
];
const DELETED: usize = 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    Memory,
    Remote,
}

/// Fixed per run; not part of the model state.
#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub backend: Backend,
    pub sessions: usize,
    /// Remote: every session uses one app password, so they share wake-cache keys.
    pub shared_kid: bool,
    /// Remote: sessions B and C run on a second gateway process (deploy overlap): separate
    /// login caches, wake caches and hint listeners over the same internal API.
    pub split: bool,
    /// Messages across all folders.
    pub cap: usize,
    pub silent: bool,
    pub uid: bool,
    pub folders: bool,
    pub faults: bool,
    pub examine: bool,
    pub idle: bool,
    pub copy: bool,
    /// The client NOOPs before every command that addresses messages by sequence number or
    /// takes `1:*`, so a server that announces changes after any command (Dovecot) and one
    /// that announces them only at sync points (Bane) see the same set. Conformance runs.
    pub eager: bool,
    /// Remote: bulk delivery and `1:*` COPY/MOVE, to reach the 1,000-UID mutation bound.
    pub bulk: bool,
    /// Remote: APPEND split into its literal phase (`append-begin`) and completion
    /// (`append-end`), so upload reservations are held across other sessions' commands.
    pub uploads: bool,
}
impl Config {
    pub fn memory() -> Self {
        Self {
            backend: Backend::Memory,
            sessions: 2,
            shared_kid: false,
            split: false,
            cap: 6,
            silent: true,
            uid: true,
            folders: true,
            faults: false,
            examine: true,
            idle: true,
            copy: true,
            eager: false,
            bulk: false,
            uploads: false,
        }
    }
    pub fn remote() -> Self {
        Self {
            backend: Backend::Remote,
            faults: true,
            ..Self::memory()
        }
    }
    pub fn kid(&self, s: usize) -> usize {
        if self.shared_kid { 0 } else { s }
    }
    pub fn instance(&self, s: usize) -> usize {
        usize::from(self.split && s > 0)
    }
    /// The Remote store refuses a STORE or COPY over this many UIDs before writing anything;
    /// MOVE and UID EXPUNGE go to the API in chunks of this size.
    pub const BATCH: usize = 1000;
    /// Upload lanes: per credential, per inbox and per workspace (one process's shares), and
    /// the process-wide pool. A busy lane makes the APPEND answer `NO [LIMIT]`.
    pub const UPLOADS: [usize; 4] = [3, 3, 4, 8];
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Set {
    First,
    All,
}
impl Set {
    pub fn text(self) -> &'static str {
        match self {
            Self::First => "1",
            Self::All => "1:*",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Act {
    Deliver,
    Select {
        s: usize,
        f: usize,
        ro: bool,
    },
    Noop(usize),
    Idle(usize),
    Done(usize),
    Store {
        s: usize,
        add: bool,
        flag: usize,
        silent: bool,
        set: Set,
        uid: bool,
    },
    Fetch {
        s: usize,
        uid: bool,
    },
    Expunge(usize),
    UidExpunge(usize),
    Close(usize),
    Unselect(usize),
    Transfer {
        s: usize,
        to: usize,
        moving: bool,
        uid: bool,
        all: bool,
    },
    Append(usize, usize),
    /// The client sends `APPEND f {n+}`: the shell reserves an upload and spools the literal.
    AppendBegin(usize, usize),
    /// The literal ends: the core runs the APPEND with the spool.
    AppendEnd(usize),
    /// 1,000 messages arrive in INBOX at once.
    Bulk,
    /// Arm a fault on an upcoming internal mutation call (see `Fault`).
    Arm(Fault),
    Create(usize),
    Delete(usize),
    Reconnect(usize),
    // Remote-store environment and faults.
    /// One inbox-change notification reaches the listener of `instance` (None: every
    /// instance). It clears that process's wake cache and wakes its sessions.
    Hint(Option<usize>),
    /// The session's task consumes its pending hint (it always does before its next command).
    Wake(usize),
    /// Another API client (REST, dashboard) toggles `\Seen` on INBOX's first message.
    ExtSeen,
    /// Another API client deletes INBOX's first entry.
    ExtExpunge,
    /// Tombstone pruning raises the changes floor past every tombstone.
    Prune,
    /// The next internal snapshot read fails (503/429 from the API).
    FailSnapshot,
    /// The session's snapshot passes the 240 s refresh age.
    Age(usize),
    /// The app passwords are revoked and an auth notification is published.
    Revoke,
}

impl Act {
    pub fn session(self) -> Option<usize> {
        use Act::*;
        match self {
            Select { s, .. } | Store { s, .. } | Fetch { s, .. } | Transfer { s, .. } => Some(s),
            Noop(s)
            | Idle(s)
            | Done(s)
            | Expunge(s)
            | UidExpunge(s)
            | Close(s)
            | Unselect(s)
            | Append(s, _)
            | AppendBegin(s, _)
            | AppendEnd(s)
            | Create(s)
            | Delete(s)
            | Reconnect(s)
            | Age(s)
            | Wake(s) => Some(s),
            _ => None,
        }
    }
    /// Commands whose targets depend on the session's view ("1", "1:*", the first UID).
    pub fn addresses(self) -> bool {
        matches!(
            self,
            Act::Store { .. } | Act::Fetch { .. } | Act::Transfer { .. } | Act::UidExpunge(_)
        )
    }
    /// A client command (the shell consumes a pending hint first).
    fn command(self) -> bool {
        self.session().is_some() && !matches!(self, Act::Age(_) | Act::Wake(_))
    }
}

fn find<T: PartialEq + Copy>(items: &[T], x: T) -> Option<usize> {
    items.iter().position(|y| *y == x)
}
fn session_index(name: &str) -> Option<usize> {
    find(&SESSIONS, name)
}
fn folder_index(name: &str) -> Option<usize> {
    find(&FOLDERS, name)
}

pub fn parse(label: &str) -> Option<Act> {
    use Act::*;
    let words: Vec<_> = label.split(' ').collect();
    match words.as_slice() {
        ["deliver"] => return Some(Deliver),
        ["hint"] => return Some(Hint(None)),
        ["hint", s] => return Some(Hint(Some(usize::from(session_index(s)? > 0)))),
        ["ext-seen"] => return Some(ExtSeen),
        ["ext-expunge"] => return Some(ExtExpunge),
        ["prune"] => return Some(Prune),
        ["fail-snapshot"] => return Some(FailSnapshot),
        ["revoke"] => return Some(Revoke),
        ["bulk"] => return Some(Bulk),
        ["lose-response"] => return Some(Arm(Fault::Lost)),
        ["fail-batch"] => return Some(Arm(Fault::Fail)),
        ["crash-batch"] => return Some(Arm(Fault::Crash)),
        ["race-batch"] => return Some(Arm(Fault::Race)),
        _ => {}
    }
    let s = session_index(words.first()?)?;
    Some(match &words[1..] {
        ["select", f] => Select {
            s,
            f: folder_index(f)?,
            ro: false,
        },
        ["examine", f] => Select {
            s,
            f: folder_index(f)?,
            ro: true,
        },
        ["noop"] => Noop(s),
        ["idle"] => Idle(s),
        ["done"] => Done(s),
        [cmd @ ("store" | "uid-store"), op, mode, set] => {
            let add = op.starts_with('+');
            let name = op.get(1..)?;
            Store {
                s,
                add,
                flag: FLAG_NAMES.iter().position(|(k, _)| *k == name)?,
                silent: *mode == "silent",
                set: if *set == "1" { Set::First } else { Set::All },
                uid: *cmd == "uid-store",
            }
        }
        ["fetch-body", "1"] => Fetch { s, uid: false },
        ["uid-fetch-body", "1"] => Fetch { s, uid: true },
        ["expunge"] => Expunge(s),
        ["uid-expunge"] => UidExpunge(s),
        ["close"] => Close(s),
        ["unselect"] => Unselect(s),
        [
            cmd @ ("copy" | "move" | "uid-copy" | "uid-move"),
            set @ ("1" | "1:*"),
            f,
        ] => Transfer {
            s,
            to: folder_index(f)?,
            moving: cmd.ends_with("move"),
            uid: cmd.starts_with("uid"),
            all: *set == "1:*",
        },
        ["append-begin", f] => AppendBegin(s, folder_index(f)?),
        ["append-end"] => AppendEnd(s),
        ["append", f] => Append(s, folder_index(f)?),
        ["create", "Work"] => Create(s),
        ["delete", "Work"] => Delete(s),
        ["reconnect"] => Reconnect(s),
        ["wake"] => Wake(s),
        ["age"] => Age(s),
        _ => return None,
    })
}

/// Every action label for `cfg`, in a stable order.
pub fn alphabet(cfg: &Config) -> Vec<String> {
    let mut out = vec!["deliver".to_owned()];
    let remote = cfg.backend == Backend::Remote;
    if remote {
        out.push("hint".into());
        if cfg.split {
            out.push("hint A".into());
            out.push("hint B".into());
        }
        out.extend(["ext-seen", "ext-expunge", "prune"].map(String::from));
        if cfg.faults {
            out.extend(
                [
                    "fail-snapshot",
                    "revoke",
                    "lose-response",
                    "fail-batch",
                    "crash-batch",
                    "race-batch",
                ]
                .map(String::from),
            );
        }
        if cfg.bulk {
            out.push("bulk".into());
        }
    }
    let folders = if cfg.folders {
        &FOLDERS[..]
    } else {
        &FOLDERS[..2]
    };
    for s in &SESSIONS[..cfg.sessions] {
        for f in folders {
            out.push(format!("{s} select {f}"));
            if cfg.examine {
                out.push(format!("{s} examine {f}"));
            }
        }
        out.push(format!("{s} noop"));
        if cfg.idle {
            out.push(format!("{s} idle"));
            out.push(format!("{s} done"));
        }
        for (name, _) in FLAG_NAMES {
            for op in ["+", "-"] {
                for mode in ["loud", "silent"] {
                    if mode == "silent" && !cfg.silent {
                        continue;
                    }
                    for set in ["1", "1:*"] {
                        out.push(format!("{s} store {op}{name} {mode} {set}"));
                        if cfg.uid && set == "1" && mode == "loud" {
                            out.push(format!("{s} uid-store {op}{name} {mode} {set}"));
                        }
                    }
                }
            }
        }
        out.push(format!("{s} fetch-body 1"));
        if cfg.uid {
            out.push(format!("{s} uid-fetch-body 1"));
        }
        out.push(format!("{s} expunge"));
        out.push(format!("{s} uid-expunge"));
        out.push(format!("{s} close"));
        out.push(format!("{s} unselect"));
        for f in folders {
            if cfg.copy {
                out.push(format!("{s} copy 1 {f}"));
            }
            out.push(format!("{s} move 1 {f}"));
            if cfg.uid {
                out.push(format!("{s} uid-move 1 {f}"));
            }
            out.push(format!("{s} append {f}"));
            if cfg.bulk {
                out.push(format!("{s} copy 1:* {f}"));
                out.push(format!("{s} move 1:* {f}"));
            }
            if cfg.uploads && remote {
                out.push(format!("{s} append-begin {f}"));
            }
        }
        if cfg.uploads && remote {
            out.push(format!("{s} append-end"));
        }
        if cfg.folders {
            out.push(format!("{s} create Work"));
            out.push(format!("{s} delete Work"));
        }
        out.push(format!("{s} reconnect"));
        if remote {
            out.push(format!("{s} wake"));
            out.push(format!("{s} age"));
        }
    }
    out
}

/// Random-walk weight: faults and folder churn are rarer than ordinary commands.
pub fn weight(act: Act) -> u64 {
    use Act::*;
    match act {
        Revoke => 1,
        Bulk => 40,
        Arm(_) => 3,
        AppendBegin(..) => 20,
        AppendEnd(_) => 6,
        FailSnapshot | Prune | Create(_) | Delete(_) | Close(_) | Unselect(_) => 3,
        Select { ro: true, .. } => 4,
        ExtSeen | ExtExpunge | Age(_) => 4,
        Reconnect(_) | Wake(_) | Done(_) | Hint(_) => 30,
        _ => 10,
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Entry {
    pub uid: u32,
    pub id: usize,
    pub deleted: bool,
}
fn is_zero(x: &u64) -> bool {
    *x == 0
}
fn no(x: &bool) -> bool {
    !*x
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Folder {
    pub exists: bool,
    /// Generation: changes exactly when the folder is created again (new UIDVALIDITY).
    pub generation: u32,
    pub next: u32,
    pub entries: Vec<Entry>,
    /// Remote only: HIGHESTMODSEQ under the API rules.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub highest: u64,
}
/// What a Remote session's own snapshot holds for its selected folder.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug, Default)]
pub struct Known {
    pub entries: Vec<(u32, Flags)>,
    /// Folder generations as of the snapshot (None: absent).
    pub folders: Vec<Option<u32>>,
    /// The since-MODSEQ checkpoint (the selected folder's HIGHESTMODSEQ when read; 0: none).
    pub since: u64,
    /// The store's selected folder. It survives CLOSE/UNSELECT (the core deselects, the
    /// adapter keeps reloading that folder) and is set before a SELECT's read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<usize>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Selected {
    pub folder: usize,
    pub ro: bool,
    pub generation: u32,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Session {
    pub up: bool,
    pub sel: Option<Selected>,
    /// What a correct client believes: UID and flags per sequence number.
    pub view: Vec<(u32, Flags)>,
    #[serde(default, skip_serializing_if = "no")]
    pub idle: bool,
    // Remote session shell state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub known: Option<Known>,
    #[serde(default, skip_serializing_if = "no")]
    pub stale: bool,
    #[serde(default, skip_serializing_if = "no")]
    pub pending: bool,
    #[serde(default, skip_serializing_if = "no")]
    pub aged: bool,
    /// Slots announced by EXISTS whose FETCH returned no data: the client knows them only by
    /// position until the next update expunges them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blind: Vec<u32>,
    /// The connection's COPY replay ticket: kept until a COPY succeeds, replaced by a COPY
    /// with other arguments. `receipt` is what the API committed under it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket: Option<Ticket>,
    /// An APPEND whose literal is still arriving (holds an upload reservation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uploading: Option<usize>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Ticket {
    /// (source, its generation, destination, its generation in the snapshot, UIDs).
    pub of: (usize, u32, usize, Option<u32>, Vec<u32>),
    /// Per 1,000-UID batch: the API holds a receipt for it (a retry replays it).
    pub done: Vec<bool>,
}
/// What an armed fault does to the internal mutation call it hits.
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub enum Fault {
    /// The call commits, then its response is lost (503).
    Lost,
    /// The second call from now fails before committing (503): mid-command for a batched one.
    Fail,
    /// The second call from now commits, then the gateway process dies with all its sessions.
    Crash,
    /// After the call commits, another writer expunges INBOX's highest UID (a concurrent
    /// session between batches).
    Race,
}
impl Fault {
    pub fn countdown(self) -> u8 {
        match self {
            Fault::Lost | Fault::Race => 1,
            Fault::Fail | Fault::Crash => 2,
        }
    }
}
/// How a batched mutation ended.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Run {
    Done,
    /// The first batch failed (or its response was lost): the command answers the error.
    Failed,
    /// A later batch failed: earlier ones stay committed; the command reports them, then NO.
    Partial,
    /// The process died mid-command.
    Crashed,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Cached {
    pub instance: usize,
    pub kid: usize,
    pub folder: usize,
    pub since: u64,
    pub snap: Known,
    pub floor: u64,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Model {
    pub msgs: Vec<Flags>,
    pub folders: Vec<Folder>,
    pub sessions: Vec<Session>,
    // Remote internal-API state.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub modseq: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub floor: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub tombstone: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cache: Vec<Cached>,
    #[serde(default, skip_serializing_if = "no")]
    pub armed: bool,
    #[serde(default, skip_serializing_if = "no")]
    pub revoked: bool,
    /// A fault armed on an upcoming internal mutation call: (calls until it fires, kind).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fault: Option<(u8, Fault)>,
    /// Coverage events of the current step (not state).
    #[serde(skip)]
    pub events: Vec<&'static str>,
}

/// What one step is expected to report.
pub struct Outcome {
    pub ok: bool,
    /// The acting session reached a sync point: its client mirror must equal `view`.
    pub sync: Option<usize>,
    /// Sessions that got an idle push this step.
    pub pushed: Vec<usize>,
    /// Coverage events, mapped to the edge-case checklist in `main.rs`.
    pub events: Vec<&'static str>,
}

impl Model {
    pub fn initial(cfg: &Config) -> Self {
        let remote = cfg.backend == Backend::Remote;
        let mut m = Self {
            msgs: vec![],
            folders: (0..SERVER.len())
                .map(|i| Folder {
                    exists: i != WORK,
                    generation: 0,
                    next: 1,
                    entries: vec![],
                    highest: u64::from(remote),
                })
                .collect(),
            sessions: vec![],
            modseq: u64::from(remote),
            floor: 0,
            tombstone: 0,
            cache: vec![],
            armed: false,
            revoked: false,
            fault: None,
            events: vec![],
        };
        // Every session starts logged in with INBOX selected (the fixture's open).
        for _ in 0..cfg.sessions {
            let mut s = Session {
                up: true,
                sel: None,
                view: vec![],
                idle: false,
                known: None,
                stale: false,
                pending: false,
                aged: false,
                blind: vec![],
                ticket: None,
                uploading: None,
            };
            s.sel = Some(Selected {
                folder: 0,
                ro: false,
                generation: 0,
            });
            if remote {
                s.known = Some(Known::default());
            }
            m.sessions.push(s);
        }
        if remote {
            for s in 0..cfg.sessions {
                let k = m.read(0);
                m.sessions[s].known = Some(k);
            }
        }
        m
    }

    // ---------- truth ----------
    fn entry_flags(&self, e: &Entry) -> Flags {
        let mut f = self.msgs[e.id].clone();
        if e.deleted {
            f.insert("\\Deleted".into());
        }
        f
    }
    pub fn truth(&self, folder: usize) -> Vec<(u32, Flags)> {
        if !self.folders[folder].exists {
            return vec![];
        }
        self.folders[folder]
            .entries
            .iter()
            .map(|e| (e.uid, self.entry_flags(e)))
            .collect()
    }
    fn generations(&self) -> Vec<Option<u32>> {
        self.folders
            .iter()
            .map(|f| f.exists.then_some(f.generation))
            .collect()
    }
    /// The selected folder's contents (what an eager client's NOOP shows).
    fn truth_for(&self, s: usize) -> Vec<(u32, Flags)> {
        self.sessions[s]
            .sel
            .as_ref()
            .map(|x| self.truth(x.folder))
            .unwrap_or_default()
    }
    fn total(&self) -> usize {
        self.folders.iter().map(|f| f.entries.len()).sum()
    }
    /// A fresh internal snapshot of `folder` (Remote).
    fn read(&self, folder: usize) -> Known {
        Known {
            entries: self.truth(folder),
            folders: self.generations(),
            since: if self.folders[folder].exists {
                self.folders[folder].highest
            } else {
                0
            },
            folder: Some(folder),
        }
    }
    /// One internal-API MODSEQ (Remote only; the Memory model keeps no MODSEQs).
    fn stamp(&mut self) -> u64 {
        if self.modseq == 0 {
            return 0;
        }
        self.modseq += 1;
        self.modseq
    }
    fn bump(&mut self, folder: usize, stamp: u64) {
        if stamp != 0 {
            self.folders[folder].highest = self.folders[folder].highest.max(stamp);
        }
    }
    fn add_entry(&mut self, folder: usize, id: usize, deleted: bool, stamp: u64) -> u32 {
        let f = &mut self.folders[folder];
        let uid = f.next;
        f.entries.push(Entry { uid, id, deleted });
        f.next += 1;
        self.bump(folder, stamp);
        uid
    }
    fn remove_entry(&mut self, folder: usize, uid: u32, stamp: u64) {
        self.folders[folder].entries.retain(|e| e.uid != uid);
        self.tombstone = self.tombstone.max(stamp);
        self.bump(folder, stamp);
    }
    fn copies(&self, id: usize) -> usize {
        self.folders
            .iter()
            .flat_map(|f| &f.entries)
            .filter(|e| e.id == id)
            .count()
    }
    /// One API flag mutation of a single entry (one MODSEQ).
    fn set_flag(&mut self, folder: usize, uid: u32, flag: usize, add: bool) {
        let Some(id) = self.folders[folder]
            .entries
            .iter()
            .find(|e| e.uid == uid)
            .map(|e| e.id)
        else {
            return;
        };
        let stamp = self.stamp();
        let name = FLAG_NAMES[flag].1;
        if flag == DELETED {
            for e in &mut self.folders[folder].entries {
                if e.uid == uid {
                    e.deleted = add;
                }
            }
            self.bump(folder, stamp);
            return;
        }
        if add {
            self.msgs[id].insert(name.into());
        } else {
            self.msgs[id].remove(name);
        }
        // Not a \Deleted change: every copy of the message gets the new MODSEQ.
        for f in 0..self.folders.len() {
            if self.folders[f].entries.iter().any(|e| e.id == id) {
                self.bump(f, stamp);
            }
        }
    }
    fn expunge(&mut self, folder: usize, only: Option<&[u32]>) {
        let doomed: Vec<u32> = self.folders[folder]
            .entries
            .iter()
            .filter(|e| e.deleted && only.is_none_or(|u| u.contains(&e.uid)))
            .map(|e| e.uid)
            .collect();
        for uid in doomed {
            let stamp = self.stamp();
            self.remove_entry(folder, uid, stamp);
        }
    }
    fn transfer(&mut self, from: usize, to: usize, uids: &[u32], moving: bool) {
        let picked: Vec<(u32, usize, bool)> = self.folders[from]
            .entries
            .iter()
            .filter(|e| uids.contains(&e.uid))
            .map(|e| (e.uid, e.id, e.deleted))
            .collect();
        for (uid, id, deleted) in picked {
            let stamp = self.stamp();
            self.add_entry(to, id, deleted, stamp);
            if moving {
                self.remove_entry(from, uid, stamp);
            }
        }
    }
    fn new_message(&mut self, folder: usize) {
        self.msgs.push(Flags::new());
        let stamp = self.stamp();
        self.add_entry(folder, self.msgs.len() - 1, false, stamp);
    }

    // ---------- session view ----------
    /// The folder contents and folder list a session's store shows.
    fn shown(&self, cfg: &Config, s: usize) -> (Vec<(u32, Flags)>, Vec<Option<u32>>) {
        match (&self.sessions[s].known, cfg.backend) {
            (Some(k), Backend::Remote) => (k.entries.clone(), k.folders.clone()),
            _ => (
                self.sessions[s]
                    .sel
                    .as_ref()
                    .map(|sel| self.truth(sel.folder))
                    .unwrap_or_default(),
                self.generations(),
            ),
        }
    }
    fn exists_for(&self, cfg: &Config, s: usize, folder: usize) -> bool {
        self.shown(cfg, s).1[folder].is_some()
    }
    fn drop_session(&mut self, s: usize) {
        let x = &mut self.sessions[s];
        x.up = false;
        x.sel = None;
        x.view.clear();
        x.idle = false;
        x.stale = false;
        x.pending = false;
        x.aged = false;
        x.blind.clear();
        x.ticket = None;
        x.uploading = None;
        if let Some(k) = &mut x.known {
            *k = Known::default();
        }
    }
    /// Remote: the selected folder was deleted (or recreated) in the API after this session's
    /// snapshot. The API refuses flag and expunge mutations on it (`SELECT ... INTO STRICT`),
    /// and copies or moves out of it find no entries.
    fn source_gone(&self, cfg: &Config, s: usize) -> bool {
        cfg.backend == Backend::Remote
            && self.sessions[s].sel.as_ref().is_some_and(|sel| {
                !self.folders[sel.folder].exists
                    || self.folders[sel.folder].generation != sel.generation
            })
    }
    /// Whether the session's selected folder is gone from its store (core: BYE).
    fn bye(&self, cfg: &Config, s: usize) -> bool {
        self.sessions[s]
            .sel
            .as_ref()
            .is_some_and(|sel| self.shown(cfg, s).1[sel.folder] != Some(sel.generation))
    }
    /// The core's update(): BYE if the selected folder is gone, else the view converges.
    fn update(&mut self, cfg: &Config, s: usize) -> bool {
        if self.sessions[s].sel.is_none() {
            return true;
        }
        if self.bye(cfg, s) {
            self.drop_session(s);
            return false;
        }
        self.sessions[s].view = self.shown(cfg, s).0;
        self.sessions[s].blind.clear();
        true
    }
    /// update(), then the client's FETCH of the slots it knows only from EXISTS. That FETCH
    /// is a command of its own: a snapshot left stale by a failed refresh is refreshed first,
    /// so a slot announced from the stale snapshot gets fresher flags, or no data at all when
    /// the fresh snapshot no longer has it (RFC 2180 4.1), and stays unknown to the client.
    fn sync_fill(&mut self, cfg: &Config, s: usize) -> bool {
        let old: BTreeSet<u32> = self.sessions[s].view.iter().map(|e| e.0).collect();
        if !self.update(cfg, s) {
            // The selected folder vanished while the command ran: the command completes,
            // then BYE ends the session.
            self.event("bye-after-completion");
            return true;
        }
        let announced: Vec<usize> = (0..self.sessions[s].view.len())
            .filter(|&i| !old.contains(&self.sessions[s].view[i].0))
            .collect();
        let (Some(&lo), Some(&hi)) = (announced.first(), announced.last()) else {
            return true;
        };
        if cfg.backend != Backend::Remote {
            return true;
        }
        if self.sessions[s].stale || self.sessions[s].aged {
            self.event("fill-after-refresh");
            if self.reload(s).is_err() {
                return false;
            }
            self.sessions[s].stale = false;
        }
        let shown = self.shown(cfg, s).0;
        let x = &mut self.sessions[s];
        for i in lo..=hi {
            let uid = x.view[i].0;
            if let Some((_, f)) = shown.iter().find(|e| e.0 == uid) {
                x.view[i].1 = f.clone();
            } else if announced.contains(&i) {
                x.blind.push(uid);
            }
        }
        true
    }
    /// One internal mutation RPC that reaches the commit point: the fault it meets, if any.
    fn call(&mut self, cfg: &Config) -> Option<Fault> {
        if cfg.backend != Backend::Remote {
            return None;
        }
        match self.fault {
            Some((n, f)) if n > 1 => {
                self.fault = Some((n - 1, f));
                None
            }
            Some((_, f)) => {
                self.fault = None;
                self.event(match f {
                    Fault::Lost => "response-lost",
                    Fault::Fail => "batch-failed",
                    Fault::Crash => "crash-mid-command",
                    Fault::Race => "race-between-batches",
                });
                Some(f)
            }
            None => None,
        }
    }
    /// The batches a mutation of `uids` goes in: 1,000 UIDs each on the Remote store (none
    /// for an empty set: no API call), one on Memory.
    fn chunks(cfg: &Config, uids: &[u32]) -> Vec<Vec<u32>> {
        match cfg.backend {
            Backend::Remote => uids.chunks(Config::BATCH).map(<[u32]>::to_vec).collect(),
            Backend::Memory => vec![uids.to_vec()],
        }
    }
    /// One call per batch; `apply` commits batch i. Batches are atomic; a failure stops the
    /// command after the batches already committed.
    fn run(
        &mut self,
        cfg: &Config,
        s: usize,
        n: usize,
        apply: &mut dyn FnMut(&mut Self, usize),
    ) -> Run {
        if n > 1 {
            self.event("batched");
        }
        for i in 0..n {
            let fault = self.call(cfg);
            let stop = if i == 0 {
                Run::Failed
            } else {
                self.event("partial-applied");
                Run::Partial
            };
            if fault == Some(Fault::Fail) {
                return stop;
            }
            apply(self, i);
            match fault {
                Some(Fault::Lost) => return stop,
                Some(Fault::Crash) => {
                    let inst = cfg.instance(s);
                    for o in 0..self.sessions.len() {
                        if self.sessions[o].up && cfg.instance(o) == inst {
                            self.drop_session(o);
                        }
                    }
                    self.cache.retain(|c| c.instance != inst);
                    return Run::Crashed;
                }
                Some(Fault::Race) => {
                    if let Some(uid) = self.folders[0].entries.last().map(|e| e.uid) {
                        let stamp = self.stamp();
                        self.remove_entry(0, uid, stamp);
                    }
                }
                _ => {}
            }
        }
        if n > 1 {
            self.event("batched-done");
        }
        Run::Done
    }
    /// Whether the upload lanes of session s's process have a free permit.
    fn upload_free(&self, cfg: &Config, s: usize) -> bool {
        let busy = |f: &dyn Fn(usize) -> bool| {
            (0..self.sessions.len())
                .filter(|&o| self.sessions[o].up && self.sessions[o].uploading.is_some() && f(o))
                .count()
        };
        let (i, k) = (cfg.instance(s), cfg.kid(s));
        let [cred, inbox, workspace, global] = Config::UPLOADS;
        busy(&|o| cfg.instance(o) == i && cfg.kid(o) == k) < cred
            && busy(&|o| cfg.instance(o) == i) < inbox.min(workspace).min(global)
    }
    /// The target of "1": by sequence number the first slot; by UID the first slot's UID as
    /// the client knows it (UID 1 when it has no data for that slot).
    fn first(&self, s: usize, uid: bool) -> Vec<u32> {
        let x = &self.sessions[s];
        let Some(v0) = x.view.first() else {
            return vec![];
        };
        if !uid {
            return vec![v0.0];
        }
        let u = if x.blind.contains(&v0.0) { 1 } else { v0.0 };
        x.view.iter().filter(|e| e.0 == u).map(|e| e.0).collect()
    }
    /// Remote: the API addresses folders by the role key in this session's snapshot, so a
    /// folder deleted or recreated since then is refused (`INTO STRICT`).
    fn api_has(&self, cfg: &Config, s: usize, folder: usize) -> bool {
        let f = &self.folders[folder];
        f.exists
            && (cfg.backend == Backend::Memory
                || self.shown(cfg, s).1[folder] == Some(f.generation))
    }
    fn targets(&self, s: usize, set: Set) -> Vec<u32> {
        let v = self.sessions[s].view.iter().map(|x| x.0);
        match set {
            Set::First => v.take(1).collect(),
            Set::All => v.collect(),
        }
    }

    // ---------- Remote reloads ----------
    /// A fresh snapshot read for session s. Fails if a snapshot fault is armed.
    fn reload(&mut self, s: usize) -> Result<(), ()> {
        if std::mem::take(&mut self.armed) {
            self.event("snapshot-failed");
            return Err(());
        }
        self.event("snapshot-read");
        let folder = self.sessions[s].known.as_ref().and_then(|k| k.folder);
        let k = match folder {
            Some(f) => self.read(f),
            None => Known {
                entries: vec![],
                folders: self.generations(),
                since: 0,
                folder: None,
            },
        };
        let x = &mut self.sessions[s];
        x.known = Some(k);
        x.aged = false;
        Ok(())
    }
    /// The IDLE wake reload: served from this process's wake cache when another session
    /// with the same credential already read the same folder since the same MODSEQ.
    fn wake_reload(&mut self, cfg: &Config, s: usize) -> Result<(), ()> {
        let Some(k) = self.sessions[s].known.clone() else {
            return self.reload(s);
        };
        let (Some(folder), since) = (k.folder, k.since) else {
            return self.reload(s);
        };
        if since == 0 {
            return self.reload(s);
        }
        let (instance, kid) = (cfg.instance(s), cfg.kid(s));
        let hit = self
            .cache
            .iter()
            .find(|c| (c.instance, c.kid, c.folder, c.since) == (instance, kid, folder, since));
        let (snap, floor) = if let Some(c) = hit {
            let snap = (c.snap.clone(), c.floor);
            let stale = snap.0 != self.read(folder);
            self.event(if stale {
                "wake-cache-hit-stale"
            } else {
                "wake-cache-hit"
            });
            snap
        } else {
            if std::mem::take(&mut self.armed) {
                self.event("snapshot-failed");
                return Err(());
            }
            self.event("wake-cache-fill");
            let snap = self.read(folder);
            if self.cache.len() >= 8 {
                self.cache.clear();
            }
            self.cache.push(Cached {
                instance,
                kid,
                folder,
                since,
                snap: snap.clone(),
                floor: self.floor,
            });
            (snap, self.floor)
        };
        // A new UIDVALIDITY (or a vanished folder) or a since below the tombstone floor forces
        // a full read.
        if snap.folders[folder].is_none()
            || snap.folders[folder] != k.folders[folder]
            || since < floor
        {
            self.event(if since < floor {
                "floor-full-reload"
            } else {
                "validity-full-reload"
            });
            return self.reload(s);
        }
        let x = &mut self.sessions[s];
        x.known = Some(snap);
        x.aged = false;
        Ok(())
    }
    /// The shell before a non-SELECT command: consume a pending hint, refresh if stale.
    fn before(&mut self, cfg: &Config, s: usize, selects: bool) -> Result<(), ()> {
        if cfg.backend != Backend::Remote {
            return Ok(());
        }
        self.wake(cfg, s)?;
        if !self.sessions[s].up {
            return Err(());
        }
        let x = &self.sessions[s];
        if !x.idle && !selects && (x.stale || x.aged) {
            let e = if x.aged {
                "aged-refresh"
            } else {
                "stale-refresh"
            };
            self.event(e);
            self.reload(s)?;
            self.sessions[s].stale = false;
        }
        if selects {
            self.sessions[s].stale = false;
        }
        Ok(())
    }
    /// The session consumes a pending hint: reload and push if idling, else mark stale.
    fn wake(&mut self, cfg: &Config, s: usize) -> Result<(), ()> {
        if !std::mem::take(&mut self.sessions[s].pending) {
            return Ok(());
        }
        if self.revoked {
            self.event("revoked-bye");
            self.drop_session(s);
            return Err(());
        }
        self.event("hint-consumed");
        self.sessions[s].stale = true;
        if self.sessions[s].idle {
            if self.wake_reload(cfg, s).is_err() {
                self.drop_session(s);
                return Err(());
            }
            self.sessions[s].stale = false;
            self.update(cfg, s);
        }
        Ok(())
    }
    /// After a committed store change (Remote): the store refreshes its snapshot. A refresh
    /// failure after the commit must not turn the committed command into a failure: the
    /// snapshot stays as it was and the next command refreshes it.
    fn refresh_after(&mut self, cfg: &Config, s: usize) {
        if cfg.backend == Backend::Remote && self.reload(s).is_err() {
            self.event("refresh-failed-after-commit");
            self.sessions[s].stale = true;
        }
    }

    pub fn enabled(&self, cfg: &Config, act: Act) -> bool {
        use Act::*;
        if let Some(s) = act.session() {
            if s >= self.sessions.len() {
                return false;
            }
            let x = &self.sessions[s];
            match act {
                Reconnect(_) => return !x.up && !self.revoked,
                AppendEnd(_) => return x.up && x.uploading.is_some(),
                Wake(_) if x.uploading.is_some() => return x.up && x.pending,
                _ if x.uploading.is_some() => return false,
                Wake(_) => return x.up && x.pending,
                // Not while idling: a slot announced by EXISTS during IDLE and expunged before
                // the DONE refresh may legitimately stay unfetched (RFC 2180 4.1); the model
                // keeps no per-entry MODSEQ to predict which.
                Age(_) => return x.up && !x.aged && !x.idle,
                Done(_) => return x.up && x.idle,
                _ if !x.up || x.idle => return false,
                _ => {}
            }
        }
        // Conformance runs skip a sequence set naming messages that do not exist: Dovecot
        // answers BAD, Bane answers OK with no data (both seen in the wild; documented).
        if cfg.eager
            && let Some(s) = act.session()
            && matches!(
                act,
                Act::Store { uid: false, .. }
                    | Act::Fetch { uid: false, .. }
                    | Act::Transfer { uid: false, .. }
            )
            && self.truth_for(s).is_empty()
        {
            return false;
        }
        match act {
            Deliver | Append(..) | AppendBegin(..) | Transfer { moving: false, .. } => {
                self.total() < cfg.cap
            }
            Bulk => self.total() + Config::BATCH < cfg.cap,
            Arm(_) => self.fault.is_none(),
            Hint(Some(_)) => cfg.split,
            Revoke => !self.revoked,
            FailSnapshot => !self.armed,
            _ => true,
        }
    }

    /// Apply one action. The returned outcome says which mirrors must have converged.
    pub fn step(&mut self, cfg: &Config, act: Act) -> Outcome {
        use Act::*;
        let mut out = Outcome {
            ok: true,
            sync: None,
            pushed: vec![],
            events: vec![],
        };
        self.events.clear();
        let before: Vec<Vec<(u32, Flags)>> = (0..SERVER.len()).map(|f| self.truth(f)).collect();
        let gens = self.generations();
        if act.command()
            && let Some(s) = act.session()
            && !matches!(act, Reconnect(_))
        {
            // The shell consumes a pending hint first (biased select), then refreshes a
            // stale or aged snapshot before mailbox commands. DONE is local; a failed
            // pre-command refresh refuses the command, not the session.
            let selects = matches!(act, Select { .. });
            // An APPEND literal is reserved and spooled before the core runs: only the
            // pending hint is consumed first; the stale refresh and BYE come at completion.
            let spooled = matches!(act, AppendBegin(..))
                || (cfg.backend == Backend::Remote && matches!(act, Append(..)));
            if spooled {
                if self.wake(cfg, s).is_err() || !self.sessions[s].up {
                    self.drop_session(s);
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
            } else if self.before(cfg, s, selects).is_err() {
                self.event(if self.revoked {
                    "revoked-bye"
                } else {
                    "refused-before-command"
                });
                if matches!(act, AppendEnd(_)) {
                    self.sessions[s].uploading = None;
                }
                out.ok = false;
                return self.finish(cfg, out, &before, &gens);
            }
            if !matches!(act, Done(_)) && !spooled && self.bye(cfg, s) {
                self.event("bye-deleted-folder");
                self.drop_session(s);
                out.ok = false;
                return self.finish(cfg, out, &before, &gens);
            }
        }
        if cfg.eager
            && let Some(s) = act.session()
            && act.addresses()
            && self.sessions[s].sel.is_some()
            && !self.update(cfg, s)
        {
            out.ok = false;
            return self.finish(cfg, out, &before, &gens);
        }
        match act {
            Deliver => self.new_message(0),
            Select { s, f, ro } => {
                let x = &mut self.sessions[s];
                x.sel = None;
                x.view.clear();
                // Blind slots belong to the previous selection's view.
                x.blind.clear();
                out.sync = Some(s);
                if cfg.backend == Backend::Remote {
                    if let Some(k) = self.sessions[s].known.as_mut() {
                        k.folder = Some(f);
                        k.since = 0;
                    }
                    if self.reload(s).is_err() {
                        // The folder list stays as the last snapshot left it; the next
                        // command refreshes first.
                        self.sessions[s].stale = true;
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                }
                if !self.exists_for(cfg, s, f) {
                    out.ok = false;
                } else {
                    let generation = self.folders[f].generation;
                    self.sessions[s].sel = Some(Selected {
                        folder: f,
                        ro,
                        generation,
                    });
                    self.sessions[s].view = self.shown(cfg, s).0;
                }
            }
            Noop(s) => {
                out.sync = Some(s);
                out.ok = self.update(cfg, s);
            }
            Idle(s) => {
                out.ok = self.update(cfg, s);
                self.sessions[s].idle = out.ok;
            }
            Done(s) => {
                self.sessions[s].idle = false;
                out.sync = Some(s);
            }
            Store {
                s,
                add,
                flag,
                silent,
                set,
                uid,
            } => {
                let Some(sel) = self.sessions[s].sel.clone() else {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                };
                if sel.ro {
                    self.event("read-only-refused");
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                let uids = if uid && set == Set::First {
                    self.first(s, true)
                } else {
                    self.targets(s, set)
                };
                self.event(if uids.is_empty() {
                    "empty-set"
                } else if silent {
                    "store-silent"
                } else {
                    "store-loud"
                });
                if uid {
                    self.event("uid-command");
                }
                let present: BTreeSet<u32> = self.folders[sel.folder]
                    .entries
                    .iter()
                    .map(|e| e.uid)
                    .collect();
                if uids.iter().any(|u| !present.contains(u)) {
                    self.event("target-vanished");
                }
                if self.source_gone(cfg, s) && !uids.is_empty() {
                    self.event("api-refused-deleted-folder");
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                let chunks = Self::chunks(cfg, &uids);
                let folder = sel.folder;
                let run = self.run(cfg, s, chunks.len(), &mut |m, i| {
                    for u in &chunks[i] {
                        m.set_flag(folder, *u, flag, add);
                    }
                });
                if matches!(run, Run::Failed | Run::Crashed) {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                // Partial: the committed batches are reported (FETCH for the targets whose
                // MODSEQ moved), then NO; a .SILENT client applies nothing on NO.
                let partial = run == Run::Partial;
                out.ok = !partial;
                self.refresh_after(cfg, s);
                if self.bye(cfg, s) {
                    // The refreshed snapshot no longer has the folder: STORE answers NO and
                    // the next command ends the session.
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                let shown = self.shown(cfg, s).0;
                let name = FLAG_NAMES[flag].1;
                let x = &mut self.sessions[s];
                for (uid, known) in &mut x.view {
                    if !uids.contains(uid) {
                        continue;
                    }
                    if silent {
                        if partial || x.blind.contains(uid) {
                            continue;
                        }
                        // The client applies its own change locally.
                        if add {
                            known.insert(name.into());
                        } else {
                            known.remove(name);
                        }
                    } else if let Some((_, f)) = shown.iter().find(|e| e.0 == *uid) {
                        *known = f.clone();
                    }
                }
            }
            Fetch { s, uid } => {
                let Some(sel) = self.sessions[s].sel.clone() else {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                };
                let uids = self.first(s, uid);
                let shown = self.shown(cfg, s).0;
                // Implicit \Seen, decided on the session's own snapshot.
                let unseen: Vec<u32> = shown
                    .iter()
                    .filter(|(u, f)| uids.contains(u) && !f.contains("\\Seen"))
                    .map(|e| e.0)
                    .collect();
                if !sel.ro && !unseen.is_empty() {
                    if self.source_gone(cfg, s) {
                        self.event("api-refused-deleted-folder");
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    let chunks = Self::chunks(cfg, &unseen);
                    let folder = sel.folder;
                    let run = self.run(cfg, s, chunks.len(), &mut |m, i| {
                        for u in &chunks[i] {
                            m.set_flag(folder, *u, 0, true);
                        }
                    });
                    if run != Run::Done {
                        if run == Run::Partial {
                            self.refresh_after(cfg, s);
                        }
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    self.refresh_after(cfg, s);
                    if self.bye(cfg, s) {
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    let shown = self.shown(cfg, s).0;
                    if let Some(first) = uids.first()
                        && let Some((_, f)) = shown.iter().find(|e| e.0 == *first)
                        && let Some(v) = self.sessions[s].view.first_mut()
                    {
                        v.1 = f.clone();
                    }
                }
            }
            Expunge(s) | UidExpunge(s) | Close(s) | Unselect(s) => {
                let Some(sel) = self.sessions[s].sel.clone() else {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                };
                let closing = matches!(act, Close(_) | Unselect(_));
                if sel.ro && !closing {
                    self.event("read-only-refused");
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                out.sync = Some(s);
                if matches!(act, Unselect(_)) || (closing && sel.ro) {
                } else {
                    // UID EXPUNGE names its targets. A plain EXPUNGE (or CLOSE) on the Remote
                    // store sends every UID of its snapshot in batches and the API removes the
                    // \Deleted ones; Memory removes every \Deleted entry at once.
                    let remote = cfg.backend == Backend::Remote;
                    let only = if matches!(act, UidExpunge(_)) {
                        Some(self.targets(s, Set::All))
                    } else if remote {
                        Some(self.shown(cfg, s).0.iter().map(|e| e.0).collect::<Vec<_>>())
                    } else {
                        None
                    };
                    if self.source_gone(cfg, s) && only.as_ref().is_none_or(|u| !u.is_empty()) {
                        self.event("api-refused-deleted-folder");
                        out.sync = None;
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    let folder = sel.folder;
                    let run = match &only {
                        None => self.run(cfg, s, 1, &mut |m, _| m.expunge(folder, None)),
                        Some(u) => {
                            let chunks = Self::chunks(cfg, u);
                            self.run(cfg, s, chunks.len(), &mut |m, i| {
                                m.expunge(folder, Some(&chunks[i]))
                            })
                        }
                    };
                    match run {
                        Run::Failed | Run::Crashed => {
                            out.sync = None;
                            out.ok = false;
                            return self.finish(cfg, out, &before, &gens);
                        }
                        Run::Partial => {
                            // EXPUNGE reports the batches that committed, then NO. CLOSE
                            // answers NO and stays selected.
                            self.refresh_after(cfg, s);
                            out.sync = None;
                            out.ok = false;
                            if !closing {
                                self.sync_fill(cfg, s);
                            }
                            return self.finish(cfg, out, &before, &gens);
                        }
                        Run::Done => {}
                    }
                    self.refresh_after(cfg, s);
                }
                if closing {
                    let x = &mut self.sessions[s];
                    x.sel = None;
                    x.view.clear();
                    x.blind.clear();
                } else {
                    out.ok = self.sync_fill(cfg, s);
                }
            }
            Transfer {
                s,
                to,
                moving,
                uid,
                all,
            } => {
                let Some(sel) = self.sessions[s].sel.clone() else {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                };
                if moving && sel.ro {
                    self.event("read-only-refused");
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                let uids = if all {
                    self.targets(s, Set::All)
                } else {
                    self.first(s, uid)
                };
                if to == sel.folder && !moving && !uids.is_empty() {
                    self.event("copy-into-selected");
                }
                let present: BTreeSet<u32> = self.folders[sel.folder]
                    .entries
                    .iter()
                    .map(|e| e.uid)
                    .collect();
                if uids.iter().any(|u| !present.contains(u)) {
                    self.event("target-vanished");
                }
                if !self.exists_for(cfg, s, to) {
                    self.event("trycreate");
                }
                // TRYCREATE from the session's folder list (the core refuses before the
                // store). The API refusing a folder deleted meanwhile is handled per path.
                if !self.exists_for(cfg, s, to) {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                let remote = cfg.backend == Backend::Remote;
                let chunks = Self::chunks(cfg, &uids);
                let (from, n) = (sel.folder, chunks.len());
                let run = if remote && !moving {
                    // The COPY replay ticket: one per command, a receipt per batch. A retry
                    // with the same arguments replays committed batches instead of copying
                    // them again.
                    let to_gen = self.shown(cfg, s).1[to];
                    let of = (sel.folder, sel.generation, to, to_gen, uids.clone());
                    if self.sessions[s].ticket.as_ref().is_none_or(|t| t.of != of) {
                        self.sessions[s].ticket = Some(Ticket {
                            of,
                            done: vec![false; n],
                        });
                    }
                    if !uids.is_empty() && !self.api_has(cfg, s, to) {
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    let run = self.run(cfg, s, n, &mut |m, i| {
                        let done = m.sessions[s].ticket.as_ref().is_some_and(|t| t.done[i]);
                        if done {
                            m.event("copy-replayed");
                        } else {
                            m.transfer(from, to, &chunks[i], false);
                            if let Some(t) = m.sessions[s].ticket.as_mut() {
                                t.done[i] = true;
                            }
                        }
                    });
                    if run == Run::Done {
                        self.sessions[s].ticket = None;
                    }
                    run
                } else {
                    if !uids.is_empty() && !self.api_has(cfg, s, to) {
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    self.run(cfg, s, n, &mut |m, i| {
                        m.transfer(from, to, &chunks[i], moving)
                    })
                };
                match run {
                    Run::Failed | Run::Crashed => {
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    Run::Partial => {
                        // The committed batches are reported (EXISTS, EXPUNGE), then NO.
                        self.refresh_after(cfg, s);
                        self.sync_fill(cfg, s);
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    Run::Done => {}
                }
                self.refresh_after(cfg, s);
                out.sync = Some(s);
                out.ok = self.sync_fill(cfg, s);
            }
            AppendBegin(s, f) => {
                if !self.upload_free(cfg, s) {
                    self.event("upload-lane-busy");
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                self.event("upload-held");
                self.sessions[s].uploading = Some(f);
            }
            AppendEnd(s) => {
                let Some(f) = self.sessions[s].uploading.take() else {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                };
                if !self.exists_for(cfg, s, f) || !self.api_has(cfg, s, f) {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                self.new_message(f);
                self.refresh_after(cfg, s);
                out.sync = Some(s);
                out.ok = self.sync_fill(cfg, s);
            }
            Bulk => {
                for _ in 0..Config::BATCH {
                    self.new_message(0);
                }
            }
            Arm(f) => self.fault = Some((f.countdown(), f)),
            Append(s, f) => {
                if cfg.backend == Backend::Remote {
                    if !self.upload_free(cfg, s) {
                        self.event("upload-lane-busy");
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    if self.before(cfg, s, false).is_err() || !self.sessions[s].up {
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                    if self.bye(cfg, s) {
                        self.event("bye-deleted-folder");
                        self.drop_session(s);
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                }
                if !self.exists_for(cfg, s, f) || !self.api_has(cfg, s, f) {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                self.new_message(f);
                self.refresh_after(cfg, s);
                out.sync = Some(s);
                out.ok = self.sync_fill(cfg, s);
            }
            Create(s) => {
                if self.exists_for(cfg, s, WORK) || self.folders[WORK].exists {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                let f = &mut self.folders[WORK];
                f.exists = true;
                f.generation += 1;
                f.next = 1;
                f.entries.clear();
                f.highest = u64::from(cfg.backend == Backend::Remote);
                if cfg.backend == Backend::Remote {
                    self.stamp();
                }
                self.refresh_after(cfg, s);
            }
            Delete(s) => {
                if (0..self.sessions.len()).any(|o| {
                    o != s
                        && self.sessions[o].up
                        && self.sessions[o]
                            .sel
                            .as_ref()
                            .is_some_and(|x| x.folder == WORK)
                }) {
                    self.event("delete-selected-elsewhere");
                }
                if !self.exists_for(cfg, s, WORK) || !self.api_has(cfg, s, WORK) {
                    out.ok = false;
                    return self.finish(cfg, out, &before, &gens);
                }
                if cfg.backend == Backend::Remote {
                    // The API keeps a message's last membership by moving it to Trash.
                    let entries = self.folders[WORK].entries.clone();
                    for e in entries {
                        if self.copies(e.id) > 1 {
                            let stamp = self.stamp();
                            self.remove_entry(WORK, e.uid, stamp);
                        } else {
                            self.transfer(WORK, TRASH, &[e.uid], true);
                        }
                    }
                    let stamp = self.stamp();
                    self.floor = stamp;
                }
                let f = &mut self.folders[WORK];
                f.exists = false;
                f.entries.clear();
                self.refresh_after(cfg, s);
            }
            Reconnect(s) => {
                let x = &mut self.sessions[s];
                x.up = true;
                x.sel = None;
                out.sync = Some(s);
                if cfg.backend == Backend::Remote {
                    // LOGIN installs the principal's folder list; SELECT INBOX then reads.
                    let folders = self.generations();
                    self.sessions[s].known = Some(Known {
                        entries: vec![],
                        folders,
                        since: 0,
                        folder: Some(0),
                    });
                    if self.reload(s).is_err() {
                        // LOGIN succeeded, SELECT INBOX did not: the gateway's folder list
                        // is whatever LOGIN (possibly its cache) said; the next command
                        // refreshes first.
                        self.sessions[s].sel = None;
                        self.sessions[s].stale = true;
                        out.ok = false;
                        return self.finish(cfg, out, &before, &gens);
                    }
                }
                self.sessions[s].sel = Some(Selected {
                    folder: 0,
                    ro: false,
                    generation: 0,
                });
                self.sessions[s].view = self.shown(cfg, s).0;
            }
            Hint(instance) => {
                self.event(if self.sessions.iter().any(|x| x.pending) {
                    "hint-coalesced"
                } else {
                    "hint"
                });
                if instance.is_some() {
                    self.event("hint-one-process");
                }
                self.cache
                    .retain(|c| instance.is_some_and(|i| c.instance != i));
                for s in 0..self.sessions.len() {
                    if self.sessions[s].up && instance.is_none_or(|i| cfg.instance(s) == i) {
                        self.sessions[s].pending = true;
                    }
                }
            }
            Wake(s) => {
                let was_idle = self.sessions[s].idle;
                if self.wake(cfg, s).is_err() {
                    self.drop_session(s);
                } else if was_idle && self.sessions[s].up {
                    out.pushed.push(s);
                }
                // A wake reports whether the session survived it (BYE or a failed reload).
                out.ok = self.sessions[s].up;
            }
            ExtSeen => {
                if let Some(e) = self.folders[0].entries.first().cloned() {
                    let seen = self.msgs[e.id].contains("\\Seen");
                    self.set_flag(0, e.uid, 0, !seen);
                }
            }
            ExtExpunge => {
                if let Some(uid) = self.folders[0].entries.first().map(|e| e.uid) {
                    let stamp = self.stamp();
                    self.remove_entry(0, uid, stamp);
                }
            }
            Prune => {
                self.floor = self.floor.max(self.tombstone);
                self.tombstone = 0;
            }
            FailSnapshot => self.armed = true,
            Age(s) => self.sessions[s].aged = true,
            Revoke => {
                self.revoked = true;
                self.cache.clear();
                for x in &mut self.sessions {
                    if x.up {
                        x.pending = true;
                    }
                }
            }
        }
        self.finish(cfg, out, &before, &gens)
    }

    /// Memory store: idling sessions get an update pushed after every store change.
    fn event(&mut self, e: &'static str) {
        self.events.push(e);
    }
    fn finish(
        &mut self,
        cfg: &Config,
        mut out: Outcome,
        before: &[Vec<(u32, Flags)>],
        gens: &[Option<u32>],
    ) -> Outcome {
        if cfg.backend == Backend::Memory {
            let changed =
                (0..SERVER.len()).any(|f| self.truth(f) != before[f]) || self.generations() != gens;
            if changed {
                for s in 0..self.sessions.len() {
                    if self.sessions[s].up && self.sessions[s].idle && self.update(cfg, s) {
                        out.pushed.push(s);
                        self.events.push("idle-push");
                    }
                }
            }
        }
        out.events = std::mem::take(&mut self.events);
        out
    }

    /// Renumber MODSEQs by rank (0 stays 0). Only their order and equality matter, so equal
    /// canonical states have identical futures; this keeps the Remote state graph finite.
    pub fn canonical(mut self) -> Self {
        let mut all = BTreeSet::new();
        all.extend([self.modseq, self.floor, self.tombstone]);
        all.extend(self.folders.iter().map(|f| f.highest));
        all.extend(
            self.sessions
                .iter()
                .filter_map(|s| s.known.as_ref().map(|k| k.since)),
        );
        for c in &self.cache {
            all.extend([c.since, c.snap.since, c.floor]);
        }
        all.remove(&0);
        let rank = |x: u64| {
            if x == 0 {
                0
            } else {
                all.range(..=x).count() as u64
            }
        };
        self.modseq = rank(self.modseq);
        self.floor = rank(self.floor);
        self.tombstone = rank(self.tombstone);
        for f in &mut self.folders {
            f.highest = rank(f.highest);
        }
        for s in &mut self.sessions {
            if let Some(k) = &mut s.known {
                k.since = rank(k.since);
            }
        }
        for c in &mut self.cache {
            c.since = rank(c.since);
            c.snap.since = rank(c.snap.since);
            c.floor = rank(c.floor);
        }
        self
    }

    /// The store's contents for every compared folder.
    pub fn server(&self) -> Value {
        let mut out = serde_json::Map::new();
        for (i, name) in SERVER.iter().enumerate() {
            let f = &self.folders[i];
            out.insert(
                (*name).into(),
                if f.exists {
                    json!({"next": f.next, "entries": self.truth(i)})
                } else {
                    Value::Null
                },
            );
        }
        Value::Object(out)
    }
    pub fn gone(&self) -> Vec<&'static str> {
        (0..self.sessions.len())
            .filter(|&s| !self.sessions[s].up)
            .map(|s| SESSIONS[s])
            .collect()
    }

    pub fn expected(&self, out: &Outcome) -> Value {
        let mut v =
            json!({"ok": out.ok, "safety": [], "server": self.server(), "gone": self.gone()});
        let mut mirrors = serde_json::Map::new();
        if let Some(s) = &out.sync
            && self.sessions[*s].up
        {
            let x = &self.sessions[*s];
            let view: Vec<Value> = x
                .view
                .iter()
                .map(|(u, f)| {
                    if x.blind.contains(u) {
                        Value::Null
                    } else {
                        json!([u, f])
                    }
                })
                .collect();
            mirrors.insert(SESSIONS[*s].into(), Value::Array(view));
        }
        if !mirrors.is_empty() {
            v["mirror"] = Value::Object(mirrors);
        }
        v
    }
}
