use crate::{
    fetch, search,
    session::{Account, Action, Protocol, Reply, decode64},
    store::{Change, Date, Error, Flags, Folder, FolderOp, MailStore, Mode},
    wire,
};
use imap_codec::imap_types::{
    auth::AuthMechanism,
    command::CommandBody as C,
    core::Tag,
    extensions::binary::LiteralOrLiteral8,
    fetch::{MacroOrMessageDataItemNames as Items, MessageDataItemName as Item},
    flag::{StoreResponse, StoreType},
    mailbox::{ListMailbox, Mailbox},
    sequence::SequenceSet,
    status::StatusDataItemName as Status,
};
use std::collections::BTreeMap;
const FLAGS: &str = "\\Answered \\Flagged \\Deleted \\Seen \\Draft";
fn path<'a>(m: &'a Mailbox<'_>) -> Result<&'a str, Error> {
    match m {
        Mailbox::Inbox => Ok("INBOX"),
        Mailbox::Other(x) => str::from_utf8(x.as_ref()).map_err(|_| Error::Denied),
    }
}
struct Selected {
    path: String,
    validity: u32,
    ro: bool,
    view: Vec<(u32, u64)>,
    keywords: Flags,
}
impl Selected {
    fn announce_flags(&mut self, f: &Folder, r: &mut Reply, force: bool) {
        let before = self.keywords.len();
        for e in &f.entries {
            self.keywords
                .extend(e.flags.iter().filter(|k| !k.starts_with('\\')).cloned());
        }
        if force || before != self.keywords.len() {
            r.line(format!(
                "* FLAGS ({}{})",
                FLAGS,
                self.keywords
                    .iter()
                    .map(|k| format!(" {k}"))
                    .collect::<String>()
            ))
        }
    }
    fn targets(&self, set: &SequenceSet, uid: bool) -> Vec<u32> {
        let last = if uid {
            self.view.last().map_or(0, |p| p.0)
        } else {
            self.view.len() as u32
        };
        self.view
            .iter()
            .enumerate()
            .filter(|(i, (u, _))| search::contains(set, if uid { *u } else { *i as u32 + 1 }, last))
            .map(|(_, v)| v.0)
            .collect()
    }
}
pub struct Imap {
    tls: bool,
    pub authenticated: bool,
    selected: Option<Selected>,
    idle: Option<String>,
    sasl: Option<String>,
}
impl Imap {
    pub fn new(tls: bool) -> Self {
        Self {
            tls,
            authenticated: false,
            selected: None,
            idle: None,
            sasl: None,
        }
    }
    pub fn idling(&self) -> bool {
        self.idle.is_some()
    }
    pub fn capabilities(&self) -> String {
        format!(
            "IMAP4rev1 IDLE UIDPLUS MOVE SPECIAL-USE LITERAL+ NAMESPACE ENABLE UNSELECT ID APPENDLIMIT=41943040{}",
            if !self.tls {
                " STARTTLS LOGINDISABLED"
            } else if !self.authenticated {
                " AUTH=PLAIN SASL-IR"
            } else {
                ""
            }
        )
    }
    fn login(&mut self, t: &str, ok: bool) -> Reply {
        self.authenticated = ok;
        let mut r = Reply::one(&if ok {
            format!("{t} OK [CAPABILITY {}] Authenticated", self.capabilities())
        } else {
            format!("{t} NO [AUTHENTICATIONFAILED] Authentication failed")
        });
        r.action = if ok { Action::Login } else { Action::Failure };
        r
    }
    pub fn update(&mut self, store: &dyn MailStore) -> Reply {
        let mut r = Reply::default();
        let Some(s) = &mut self.selected else {
            return r;
        };
        let Ok(f) = store.folder(&s.path).and_then(|f| {
            if f.validity == s.validity {
                Ok(f)
            } else {
                Err(Error::Missing)
            }
        }) else {
            r.line("* BYE [ALERT] Selected mailbox no longer exists");
            r.action = Action::Close;
            return r;
        };
        s.announce_flags(f, &mut r, false);
        let entries: BTreeMap<_, _> = f.entries.iter().map(|e| (e.uid, e)).collect();
        let mut i = 0;
        s.view.retain_mut(|(uid, modseq)| {
            if let Some(e) = entries.get(uid) {
                i += 1;
                if e.modseq != *modseq {
                    r.line(format!(
                        "* {i} FETCH (UID {uid} FLAGS ({}))",
                        fetch::flags(&e.flags)
                    ));
                    *modseq = e.modseq
                }
                true
            } else {
                r.line(format!("* {} EXPUNGE", i + 1));
                false
            }
        });
        let n = s.view.len();
        s.view
            .extend(f.entries[n..].iter().map(|e| (e.uid, e.modseq)));
        if s.view.len() != n {
            r.line(format!("* {} EXISTS", s.view.len()))
        }
        r
    }
    pub fn step(
        &mut self,
        bytes: &[u8],
        account: &Account,
        store: &mut dyn MailStore,
        now: Date,
    ) -> Reply {
        if let Some(t) = self.idle.take() {
            return Reply::one(&format!(
                "{t} {}",
                if bytes.eq_ignore_ascii_case(b"DONE\r\n") {
                    "OK IDLE ended"
                } else {
                    "BAD Expected DONE"
                }
            ));
        }
        if let Some(t) = self.sasl.take() {
            if bytes == b"*\r\n" {
                return Reply::one(&format!("{t} BAD Cancelled"));
            }
            return self.login(
                &t,
                decode64(bytes.strip_suffix(b"\r\n").unwrap_or_default())
                    .is_some_and(|v| account.plain(Protocol::Imap, &v)),
            );
        }
        // imap-codec doesn't yet decode SPECIAL-USE RETURN on a basic LIST.
        let mut plain = Vec::new();
        let suff = b" RETURN (SPECIAL-USE)\r\n";
        let cmd = if bytes.len() > suff.len()
            && bytes[bytes.len() - suff.len()..].eq_ignore_ascii_case(suff)
            && bytes
                .split(|&b| b == b' ')
                .nth(1)
                .is_some_and(|s| s.eq_ignore_ascii_case(b"LIST"))
        {
            plain.extend(&bytes[..bytes.len() - suff.len()]);
            plain.extend(b"\r\n");
            wire::imap(&plain)
        } else {
            wire::imap(bytes)
        };
        let Ok(cmd) = cmd else {
            let tag = bytes
                .split(|&b| b == b' ')
                .next()
                .and_then(|b| str::from_utf8(b).ok())
                .and_then(|s| Tag::try_from(s).ok());
            return Reply::one(&format!(
                "{} BAD Invalid command",
                tag.as_ref().map_or("*", |t| t.inner())
            ));
        };
        let t = cmd.tag.inner();
        let c = cmd.body;
        let mut r = Reply::default();
        let ok = |r: &mut Reply| r.line(format!("{t} OK Completed"));
        match &c {
            C::Capability => {
                r.line(format!("* CAPABILITY {}", self.capabilities()));
                ok(&mut r)
            }
            C::Logout => {
                r.line("* BYE Logging out");
                ok(&mut r);
                r.action = Action::Close
            }
            C::StartTLS if !self.tls => {
                r.line(format!("{t} OK Begin TLS"));
                r.action = Action::Upgrade
            }
            C::Noop => {
                r = self.update(store);
                if r.action != Action::Close {
                    ok(&mut r)
                }
            }
            _ if !self.tls => r.line(format!("{t} NO [PRIVACYREQUIRED] Start TLS first")),
            C::Id { .. } => {
                r.line("* ID (\"name\" \"Bane\")");
                ok(&mut r)
            }
            C::Login { username, password } if !self.authenticated => {
                return self.login(
                    t,
                    account.login(
                        Protocol::Imap,
                        username.as_ref(),
                        password.declassify().as_ref(),
                    ),
                );
            }
            C::Authenticate {
                mechanism: AuthMechanism::Plain,
                initial_response,
            } if !self.authenticated => {
                if let Some(s) = initial_response {
                    return self.login(t, account.plain(Protocol::Imap, s.declassify()));
                }
                self.sasl = Some(t.into());
                r.line("+ ")
            }
            _ if !self.authenticated => r.line(format!("{t} BAD Authenticate first")),
            _ => {
                if let Some(s) = &self.selected
                    && !store
                        .folder(&s.path)
                        .is_ok_and(|f| f.validity == s.validity)
                {
                    return self.update(store);
                }
                match self.command(t, &c, store, now, &mut r) {
                    Ok(Some(code)) => r.line(format!("{t} OK {code} Completed")),
                    Ok(None) => (),
                    Err(Error::Denied) => r.line(format!(
                        "{t} BAD Not permitted in this state or unsupported"
                    )),
                    Err(e) => r.line(format!("{t} NO {e}")),
                }
            }
        }
        r
    }
    fn command(
        &mut self,
        t: &str,
        c: &C<'_>,
        s: &mut dyn MailStore,
        now: Date,
        r: &mut Reply,
    ) -> Result<Option<String>, Error> {
        let mut code = String::new();
        match c {
            C::Namespace => r.line("* NAMESPACE ((\"\" \"/\")) NIL NIL"),
            C::Enable { .. } if self.selected.is_none() => r.line("* ENABLED"),
            C::Idle => {
                let updates = self.update(s);
                r.bytes.extend(updates.bytes);
                self.idle = Some(t.into());
                r.line("+ idling");
                return Ok(None);
            }
            C::List {
                reference,
                mailbox_wildcard,
            }
            | C::Lsub {
                reference,
                mailbox_wildcard,
            } => {
                let lsub = matches!(c, C::Lsub { .. });
                let kind = if lsub { "LSUB" } else { "LIST" };
                let pat = match mailbox_wildcard {
                    ListMailbox::String(x) => x.as_ref(),
                    ListMailbox::Token(x) => x.as_ref(),
                };
                if pat.is_empty() {
                    r.line(format!("* {kind} (\\Noselect) \"/\" \"\""))
                } else {
                    let pat = [path(reference)?.as_bytes(), pat].concat();
                    let names = s.folders();
                    for name in &names {
                        let f = s.folder(name)?;
                        let parent = lsub
                            && !f.subscribed
                            && pat.ends_with(b"%")
                            && names.iter().any(|p| {
                                p.strip_prefix(name).is_some_and(|s| s.starts_with('/'))
                                    && s.folder(p).is_ok_and(|f| f.subscribed)
                            });
                        if (!lsub || f.subscribed || parent) && wildcard(&pat, name.as_bytes()) {
                            r.line(format!(
                                "* {kind} ({}) \"/\" {}",
                                if parent {
                                    "\\Noselect"
                                } else {
                                    f.role.unwrap_or("")
                                },
                                fetch::quoted(name)
                            ))
                        }
                    }
                }
            }
            C::Create { mailbox } => {
                s.edit_folder(path(mailbox)?.trim_end_matches('/'), FolderOp::Create)?
            }
            C::Delete { mailbox } => s.edit_folder(path(mailbox)?, FolderOp::Delete)?,
            C::Rename { from, to } => s.edit_folder(path(from)?, FolderOp::Rename(path(to)?))?,
            C::Subscribe { mailbox } | C::Unsubscribe { mailbox } => s.edit_folder(
                path(mailbox)?,
                FolderOp::Subscribe(matches!(c, C::Subscribe { .. })),
            )?,
            C::Select { mailbox, .. } | C::Examine { mailbox, .. } => {
                self.selected = None;
                let p = path(mailbox)?;
                let f = s.folder(p)?;
                let ro = matches!(c, C::Examine { .. });
                r.line(format!(
                    "* OK [PERMANENTFLAGS ({})] Flags",
                    if ro {
                        String::new()
                    } else {
                        format!("{FLAGS} \\*")
                    }
                ));
                r.line(format!("* {} EXISTS", f.entries.len()));
                r.line("* 0 RECENT");
                if let Some(i) = f.entries.iter().position(|e| !e.flags.contains("\\Seen")) {
                    r.line(format!("* OK [UNSEEN {}] First unseen", i + 1))
                }
                r.line(format!("* OK [UIDVALIDITY {}] Validity", f.validity));
                r.line(format!("* OK [UIDNEXT {}] Next UID", f.next));
                code = if ro { "[READ-ONLY]" } else { "[READ-WRITE]" }.into();
                let mut selected = Selected {
                    path: p.into(),
                    validity: f.validity,
                    ro,
                    view: f.entries.iter().map(|e| (e.uid, e.modseq)).collect(),
                    keywords: Flags::new(),
                };
                selected.announce_flags(f, r, true);
                self.selected = Some(selected);
            }
            C::Status {
                mailbox,
                item_names,
            } => {
                let p = path(mailbox)?;
                let f = s.folder(p)?;
                let fields = item_names
                    .iter()
                    .map(|item| status(f, item))
                    .collect::<Vec<_>>()
                    .join(" ");
                r.line(format!("* STATUS {} ({fields})", fetch::quoted(p)))
            }
            C::Append {
                mailbox,
                flags,
                date,
                message,
                ..
            } => {
                let LiteralOrLiteral8::Literal(data) = message else {
                    return Err(Error::Denied);
                };
                let path = path(mailbox)?;
                if s.folder(path).is_err() {
                    r.line(format!("{t} NO [TRYCREATE] No such mailbox"));
                    return Ok(None);
                }
                let a = s.change(
                    path,
                    Change::Append {
                        raw: data.as_ref(),
                        date: date.as_ref().map_or(now, |d| *d.as_ref()),
                        flags: flags.iter().map(ToString::to_string).collect(),
                        source: crate::store::Origin::Client { now },
                    },
                )?;
                code = format!("[APPENDUID {} {}]", a.validity, a.pairs[0].1);
                r.bytes.extend(self.update(s).bytes)
            }
            _ => {
                let sel = self.selected.as_mut().ok_or(Error::Denied)?;
                let p = sel.path.clone();
                sel.announce_flags(s.folder(&p)?, r, false);
                let ro = sel.ro;
                let write = || if ro { Err(Error::Denied) } else { Ok(()) };
                match c {
                    C::Unselect | C::Close => {
                        if matches!(c, C::Close) && !ro {
                            s.change(&p, Change::Expunge(None))?;
                        }
                        self.selected = None
                    }
                    C::Check => r.bytes.extend(self.update(s).bytes),
                    C::Fetch {
                        sequence_set,
                        macro_or_item_names,
                        uid,
                        ..
                    } => {
                        let uids = sel.targets(sequence_set, *uid);
                        let mut items = match macro_or_item_names {
                            Items::Macro(m) => m.expand(),
                            Items::MessageDataItemNames(v) => v.clone(),
                        };
                        if *uid && !items.contains(&Item::Uid) {
                            items.push(Item::Uid)
                        }
                        let seen = !ro
                            && items.iter().any(|i| {
                                matches!(
                                    i,
                                    Item::Rfc822
                                        | Item::Rfc822Text
                                        | Item::BodyExt { peek: false, .. }
                                )
                            });
                        if seen {
                            let unseen: Vec<_> = s
                                .folder(&p)?
                                .entries
                                .iter()
                                .filter(|e| uids.contains(&e.uid) && !e.flags.contains("\\Seen"))
                                .map(|e| e.uid)
                                .collect();
                            if !unseen.is_empty() {
                                s.change(
                                    &p,
                                    Change::Flags(
                                        &unseen,
                                        Mode::Add,
                                        Flags::from(["\\Seen".into()]),
                                    ),
                                )?;
                                if !items.contains(&Item::Flags) {
                                    items.push(Item::Flags)
                                }
                            }
                        }
                        let f = s.folder(&p)?;
                        for (i, (u, ms)) in sel.view.iter_mut().enumerate() {
                            if uids.binary_search(u).is_ok()
                                && let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                            {
                                let e = &f.entries[j];
                                if let Err(err) = fetch::render(&mut r.bytes, i + 1, e, &items) {
                                    r.bytes.clear();
                                    r.line(format!("{t} NO {err}"));
                                    return Ok(None);
                                }
                                if items.contains(&Item::Flags) {
                                    *ms = e.modseq
                                }
                            }
                        }
                    }
                    C::Store {
                        sequence_set,
                        kind,
                        response,
                        flags,
                        uid,
                        ..
                    } => {
                        write()?;
                        let uids = sel.targets(sequence_set, *uid);
                        s.change(
                            &p,
                            Change::Flags(
                                &uids,
                                match kind {
                                    StoreType::Add => Mode::Add,
                                    StoreType::Remove => Mode::Remove,
                                    StoreType::Replace => Mode::Replace,
                                },
                                flags.iter().map(ToString::to_string).collect(),
                            ),
                        )?;
                        let f = s.folder(&p)?;
                        sel.announce_flags(f, r, false);
                        for (i, (u, ms)) in sel.view.iter_mut().enumerate() {
                            if uids.binary_search(u).is_ok()
                                && let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                            {
                                let e = &f.entries[j];
                                *ms = e.modseq;
                                if *response == StoreResponse::Answer {
                                    r.line(format!(
                                        "* {} FETCH ({}FLAGS ({}))",
                                        i + 1,
                                        if *uid {
                                            format!("UID {u} ")
                                        } else {
                                            String::new()
                                        },
                                        fetch::flags(&e.flags)
                                    ))
                                }
                            }
                        }
                    }
                    C::Search {
                        criteria,
                        charset,
                        uid,
                    } => {
                        if charset.as_ref().is_some_and(|c| {
                            !["utf-8", "us-ascii"]
                                .iter()
                                .any(|x| c.as_ref().eq_ignore_ascii_case(x))
                        }) {
                            r.line(format!("{t} NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported"));
                            return Ok(None);
                        }
                        let f = s.folder(&p)?;
                        let mut text = String::from("* SEARCH");
                        for (i, (u, _)) in sel.view.iter().enumerate() {
                            if let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                                && criteria.as_ref().iter().all(|k| {
                                    search::matches(
                                        k,
                                        &f.entries[j],
                                        i as u32 + 1,
                                        sel.view.len() as u32,
                                        sel.view.last().map_or(0, |v| v.0),
                                    )
                                })
                            {
                                text.push_str(&format!(" {}", if *uid { *u } else { i as u32 + 1 }))
                            }
                        }
                        r.line(text)
                    }
                    C::Copy {
                        sequence_set,
                        mailbox,
                        uid,
                    }
                    | C::Move {
                        sequence_set,
                        mailbox,
                        uid,
                    } => {
                        let moving = matches!(c, C::Move { .. });
                        if moving {
                            write()?
                        }
                        let to = path(mailbox)?;
                        if s.folder(to).is_err() {
                            r.line(format!("{t} NO [TRYCREATE] No such mailbox"));
                            return Ok(None);
                        }
                        let a = s.change(
                            &p,
                            Change::Transfer(&sel.targets(sequence_set, *uid), to, moving),
                        )?;
                        if !a.pairs.is_empty() {
                            let csv = |dst: bool| {
                                a.pairs
                                    .iter()
                                    .map(|(x, y)| if dst { y } else { x }.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            };
                            code = format!("[COPYUID {} {} {}]", a.validity, csv(false), csv(true));
                            if moving {
                                r.line(format!("* OK {code} Moved"));
                                code.clear()
                            }
                        }
                        r.bytes.extend(self.update(s).bytes)
                    }
                    C::Expunge | C::ExpungeUid { .. } => {
                        write()?;
                        let uids = if let C::ExpungeUid { sequence_set } = c {
                            Some(sel.targets(sequence_set, true))
                        } else {
                            None
                        };
                        s.change(&p, Change::Expunge(uids.as_deref()))?;
                        r.bytes.extend(self.update(s).bytes)
                    }
                    _ => return Err(Error::Denied),
                }
            }
        }
        Ok(Some(code))
    }
}
fn status(f: &Folder, s: &Status) -> String {
    let (name, n) = match s {
        Status::Messages => ("MESSAGES", f.entries.len()),
        Status::Unseen => (
            "UNSEEN",
            f.entries
                .iter()
                .filter(|e| !e.flags.contains("\\Seen"))
                .count(),
        ),
        Status::Recent => ("RECENT", 0),
        Status::Deleted => (
            "DELETED",
            f.entries
                .iter()
                .filter(|e| e.flags.contains("\\Deleted"))
                .count(),
        ),
        Status::DeletedStorage => (
            "DELETED-STORAGE",
            f.entries
                .iter()
                .filter(|e| e.flags.contains("\\Deleted"))
                .map(|e| e.raw.len())
                .sum::<usize>()
                .div_ceil(1024),
        ),
        Status::UidValidity => ("UIDVALIDITY", f.validity as usize),
        Status::UidNext => ("UIDNEXT", f.next as usize),
    };
    format!("{name} {n}")
}
fn wildcard(pat: &[u8], name: &[u8]) -> bool {
    let mut prev = vec![false; name.len() + 1];
    prev[0] = true;
    for &c in pat {
        let mut next = vec![false; prev.len()];
        next[0] = prev[0] && matches!(c, b'*' | b'%');
        for (i, &b) in name.iter().enumerate() {
            next[i + 1] = match c {
                b'*' => prev[i + 1] || next[i],
                b'%' => prev[i + 1] || (b != b'/' && next[i]),
                _ => prev[i] && c == b,
            }
        }
        prev = next
    }
    prev[name.len()]
}
