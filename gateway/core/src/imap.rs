use crate::{
    fetch, search,
    session::{Action, Identity, Protocol, Reply, decode64},
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
    announced: u64,
    synced: u64,
}
impl Selected {
    fn announce_flags(&mut self, f: &Folder, r: &mut Reply, force: bool) {
        if !force && self.announced == f.highest {
            return;
        }
        self.announced = f.highest;
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
        use imap_codec::imap_types::sequence::{SeqOrUid, Sequence};
        let v = |x: SeqOrUid| match x {
            SeqOrUid::Asterisk => last,
            SeqOrUid::Value(n) => n.get(),
        };
        let mut ranges = set
            .0
            .as_ref()
            .iter()
            .map(|s| match *s {
                Sequence::Single(a) => (v(a), v(a)),
                Sequence::Range(a, b) => (v(a).min(v(b)), v(a).max(v(b))),
            })
            .collect::<Vec<_>>();
        ranges.sort_unstable();
        let mut result = Vec::new();
        let mut prior = 0usize;
        for (a, b) in ranges {
            let (lo, hi) = if uid {
                (
                    self.view.partition_point(|x| x.0 < a),
                    self.view.partition_point(|x| x.0 <= b),
                )
            } else {
                (
                    a.saturating_sub(1) as usize,
                    (b as usize).min(self.view.len()),
                )
            };
            let start = lo.max(prior);
            if start < hi {
                result.extend(self.view[start..hi].iter().map(|x| x.0));
                prior = hi;
            }
        }
        result
    }
}
pub struct Imap {
    tls: bool,
    pub authenticated: bool,
    selected: Option<Selected>,
    idle: Option<String>,
    sasl: Option<String>,
    /// A BYE found while a command ran; sent after that command's tagged response.
    bye: Option<Vec<u8>>,
}
impl Imap {
    pub fn new(tls: bool) -> Self {
        Self {
            tls,
            authenticated: false,
            selected: None,
            idle: None,
            sasl: None,
            bye: None,
        }
    }
    pub fn idling(&self) -> bool {
        self.idle.is_some()
    }
    pub fn capabilities(&self) -> String {
        format!(
            "IMAP4rev1 IDLE UIDPLUS MOVE SPECIAL-USE LITERAL+ NAMESPACE ENABLE UNSELECT ID APPENDLIMIT=8388608{}",
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
    /// Add an update to a command's reply. If it ends the session (the selected folder
    /// vanished while the command ran, which a refreshed Remote snapshot can reveal), the
    /// command still completes and the BYE follows its tagged response, then the connection
    /// closes: no tagged response after BYE, no open connection after it (RFC 3501 7.1.5).
    fn merge(&mut self, store: &dyn MailStore, r: &mut Reply) {
        let u = self.update(store);
        if u.action == Action::Close {
            self.bye = Some(u.bytes)
        } else {
            r.bytes.extend(u.bytes)
        }
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
        if s.synced == f.highest {
            return r;
        }
        s.synced = f.highest;
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
        account: &dyn Identity,
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
                if let Some(bye) = self.bye.take() {
                    r.bytes.extend(bye);
                    r.action = Action::Close;
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
                s.list_fresh()?;
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
                    let glob = widest(&pat);
                    let head = glob.iter().take_while(|c| !WILD.contains(c)).count();
                    let listed: usize = names.iter().map(|n| n.len() + 1).sum();
                    if (glob.len() - head).saturating_mul(listed) > LIST_WORK {
                        return Err(Error::Limit);
                    }
                    for name in &names {
                        let f = s.folder(name)?;
                        let parent = lsub
                            && !f.subscribed
                            && pat.ends_with(b"%")
                            && names.iter().any(|p| {
                                p.strip_prefix(name).is_some_and(|s| s.starts_with('/'))
                                    && s.folder(p).is_ok_and(|f| f.subscribed)
                            });
                        if (!lsub || f.subscribed || parent) && wildcard(&glob, name.as_bytes()) {
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
                s.select(p)?;
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
                    announced: 0,
                    synced: f.highest,
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
                self.merge(s, r)
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
                    C::Check => self.merge(s, r),
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
                                .filter(|e| {
                                    uids.binary_search(&e.uid).is_ok()
                                        && !e.flags.contains("\\Seen")
                                })
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
                        let meta_only = items.iter().all(|x| {
                            matches!(
                                x,
                                Item::Flags | Item::Uid | Item::InternalDate | Item::Rfc822Size
                            )
                        });
                        let mut next_page = 0;
                        for (at, u) in uids.iter().enumerate() {
                            if !meta_only && uids.len() > 8 && at == next_page {
                                next_page += s.prefetch(&p, &uids[at..uids.len().min(at + 256)])?;
                            }
                            if let Ok(i) = sel.view.binary_search_by_key(u, |v| v.0)
                                && let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                            {
                                let e = &f.entries[j];
                                s.budget()?;
                                let loaded;
                                let e = if items.iter().all(|x| {
                                    matches!(
                                        x,
                                        Item::Flags
                                            | Item::Uid
                                            | Item::InternalDate
                                            | Item::Rfc822Size
                                    )
                                }) {
                                    e
                                } else {
                                    let header_only=items.iter().all(|x|matches!(x,Item::Flags|Item::Uid|Item::InternalDate|Item::Rfc822Size|Item::Envelope|Item::Rfc822Header|Item::BodyExt{section:Some(imap_codec::imap_types::fetch::Section::Header(None)|imap_codec::imap_types::fetch::Section::HeaderFields(None,_)|imap_codec::imap_types::fetch::Section::HeaderFieldsNot(None,_)),..}));
                                    loaded = if header_only {
                                        s.header(&p, e)?
                                    } else {
                                        s.materialize(&p, e)?
                                    };
                                    &loaded
                                };
                                if let Err(err) = fetch::render(&mut r.bytes, i + 1, e, &items) {
                                    r.bytes.clear();
                                    r.line(format!("{t} NO {err}"));
                                    return Ok(None);
                                }
                                if items.contains(&Item::Flags) {
                                    sel.view[i].1 = e.modseq
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
                        let applied = s.change(
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
                        );
                        // A large STORE goes in batches. If it stops partway, report the
                        // targets whose flags did change (their MODSEQ moved), then NO.
                        let partial = matches!(applied, Err(Error::Partial));
                        if !partial {
                            applied?;
                        }
                        let f = s.folder(&p)?;
                        sel.announce_flags(f, r, false);
                        for (i, (u, ms)) in sel.view.iter_mut().enumerate() {
                            if uids.binary_search(u).is_ok()
                                && let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                            {
                                let e = &f.entries[j];
                                // .SILENT leaves the recorded MODSEQ alone, so the next update
                                // reports the merged flags, including another session's earlier
                                // change (RFC 3501 6.4.6).
                                if *response == StoreResponse::Answer
                                    && (!partial || e.modseq != *ms)
                                {
                                    *ms = e.modseq;
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
                        if partial {
                            return Err(Error::Partial);
                        }
                    }
                    C::Search {
                        criteria,
                        charset,
                        uid,
                    } => {
                        if !criteria.as_ref().iter().all(search::bounded) {
                            return Err(Error::Limit);
                        }
                        if charset.as_ref().is_some_and(|c| {
                            !["utf-8", "us-ascii"]
                                .iter()
                                .any(|x| c.as_ref().eq_ignore_ascii_case(x))
                        }) {
                            r.line(format!("{t} NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported"));
                            return Ok(None);
                        }
                        let f = s.folder(&p)?;
                        if let [imap_codec::imap_types::search::SearchKey::Subject(q)] =
                            criteria.as_ref()
                            && let Ok(term) = str::from_utf8(q.as_ref())
                            && !term.is_empty()
                            && let Some(hits) = s.subject(&p, term)?
                        {
                            let mut line = String::from("* SEARCH");
                            for u in hits {
                                if let Ok(i) = sel.view.binary_search_by_key(&u, |x| x.0) {
                                    line.push_str(&format!(
                                        " {}",
                                        if *uid { u } else { i as u32 + 1 }
                                    ));
                                }
                            }
                            r.line(line);
                            return Ok(Some(String::new()));
                        }
                        let mut terms = std::collections::BTreeSet::new();
                        if criteria.as_ref().len() > 1
                            || criteria.as_ref().iter().any(|k| {
                                matches!(
                                    k,
                                    imap_codec::imap_types::search::SearchKey::And(_)
                                        | imap_codec::imap_types::search::SearchKey::Or(..)
                                        | imap_codec::imap_types::search::SearchKey::Not(_)
                                )
                            })
                        {
                            let mut hits = BTreeMap::new();
                            if criteria
                                .as_ref()
                                .iter()
                                .all(|k| search::subject_plan(k, &mut terms))
                                && !terms.is_empty()
                            {
                                for &term in &terms {
                                    if let Some(uids) = s.subject(&p, term)? {
                                        hits.insert(term, uids);
                                    }
                                }
                                if hits.len() == terms.len() {
                                    let mut line = String::from("* SEARCH");
                                    let max = sel.view.last().map_or(0, |v| v.0);
                                    for (i, (u, _)) in sel.view.iter().enumerate() {
                                        if let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                                            && criteria.as_ref().iter().all(|k| {
                                                search::planned(
                                                    k,
                                                    &f.entries[j],
                                                    i as u32 + 1,
                                                    sel.view.len() as u32,
                                                    max,
                                                    &hits,
                                                )
                                            })
                                        {
                                            line.push_str(&format!(
                                                " {}",
                                                if *uid { *u } else { i as u32 + 1 }
                                            ));
                                        }
                                    }
                                    r.line(line);
                                    return Ok(Some(String::new()));
                                }
                            }
                        }
                        let need = criteria
                            .as_ref()
                            .iter()
                            .map(search::need)
                            .max()
                            .unwrap_or_default();
                        let mut text = String::from("* SEARCH");
                        let scans = criteria
                            .as_ref()
                            .iter()
                            .map(search::scan_count)
                            .sum::<usize>();
                        let mut bytes_left = 64usize << 20;
                        let mut next_page = 0;
                        for (i, (u, _)) in sel.view.iter().enumerate() {
                            if need != search::Need::Meta && sel.view.len() > 8 && i == next_page {
                                let page: Vec<_> = sel.view[i..sel.view.len().min(i + 256)]
                                    .iter()
                                    .map(|x| x.0)
                                    .collect();
                                next_page += s.prefetch(&p, &page)?;
                            }
                            if let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid) {
                                s.budget()?;
                                let mem;
                                let entry = &f.entries[j];
                                if !criteria
                                    .as_ref()
                                    .iter()
                                    .filter(|k| search::need(k) == search::Need::Meta)
                                    .all(|k| {
                                        search::matches(
                                            k,
                                            entry,
                                            i as u32 + 1,
                                            sel.view.len() as u32,
                                            sel.view.last().map_or(0, |v| v.0),
                                        )
                                    })
                                {
                                    continue;
                                }
                                if need == search::Need::Body
                                    && entry.size.saturating_mul(scans) > bytes_left
                                {
                                    return Err(Error::Limit);
                                }
                                let loaded = match need {
                                    search::Need::Meta => entry,
                                    search::Need::Header => {
                                        mem = s.header(&p, entry)?;
                                        &mem
                                    }
                                    search::Need::Body => {
                                        mem = s.materialize(&p, entry)?;
                                        &mem
                                    }
                                };
                                bytes_left = bytes_left
                                    .checked_sub(loaded.raw.len().saturating_mul(scans))
                                    .ok_or(Error::Limit)?;
                                if criteria.as_ref().iter().all(|k| {
                                    search::matches(
                                        k,
                                        loaded,
                                        i as u32 + 1,
                                        sel.view.len() as u32,
                                        sel.view.last().map_or(0, |v| v.0),
                                    )
                                }) {
                                    text.push_str(&format!(
                                        " {}",
                                        if *uid { *u } else { i as u32 + 1 }
                                    ))
                                }
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
                        let a = match s.change(
                            &p,
                            Change::Transfer(&sel.targets(sequence_set, *uid), to, moving),
                        ) {
                            // Batches committed before the failure: report them (EXISTS,
                            // EXPUNGE), then NO. COPYUID belongs to a completed COPY only.
                            Err(Error::Partial) => {
                                self.merge(s, r);
                                return Err(Error::Partial);
                            }
                            other => other?,
                        };
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
                        self.merge(s, r)
                    }
                    C::Expunge | C::ExpungeUid { .. } => {
                        write()?;
                        let uids = if let C::ExpungeUid { sequence_set } = c {
                            Some(sel.targets(sequence_set, true))
                        } else {
                            None
                        };
                        // Batches that committed before a failure are reported, then NO.
                        let applied = s.change(&p, Change::Expunge(uids.as_deref()));
                        if matches!(applied, Ok(_) | Err(Error::Partial)) {
                            self.merge(s, r);
                        }
                        applied?;
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
        Status::Messages => ("MESSAGES", f.counts.map_or(f.entries.len(), |c| c.0)),
        Status::Unseen if f.counts.is_some() => ("UNSEEN", f.counts.map_or(0, |c| c.1)),
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
const WILD: &[u8] = b"*%";
/// Matching steps one LIST may spend past the pattern's literal start, across every folder:
/// its wildcard part times the bytes of all names. Folder queries sit far below it.
const LIST_WORK: usize = 1 << 20;
/// The pattern with each run of wildcards written as its widest member, which matches the same names.
fn widest(pat: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    for &c in pat {
        match out.last_mut() {
            Some(last) if WILD.contains(last) && WILD.contains(&c) => *last = (*last).max(c),
            _ => out.push(c),
        }
    }
    out
}
fn wildcard(pat: &[u8], name: &[u8]) -> bool {
    let head = pat.iter().take_while(|c| !WILD.contains(c)).count();
    let Some(name) = name.strip_prefix(&pat[..head]) else {
        return false;
    };
    let pat = &pat[head..];
    if pat.is_empty() {
        return name.is_empty();
    }
    let mut prev = vec![false; name.len() + 1];
    let mut next = prev.clone();
    prev[0] = true;
    for &c in pat {
        next[0] = prev[0] && WILD.contains(&c);
        let mut open = next[0];
        for (i, &b) in name.iter().enumerate() {
            next[i + 1] = match c {
                b'*' => prev[i + 1] || next[i],
                b'%' => prev[i + 1] || (b != b'/' && next[i]),
                _ => prev[i] && c == b,
            };
            open |= next[i + 1];
        }
        if !open {
            return false;
        }
        std::mem::swap(&mut prev, &mut next);
    }
    prev[name.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Account;
    use crate::store::{Applied, Memory};

    /// A store whose snapshot loses the selected folder during a change, the way a Remote
    /// refresh reveals that another session deleted it.
    struct Vanishing(Memory, bool);
    impl MailStore for Vanishing {
        fn folders(&self) -> Vec<String> {
            self.0.folders()
        }
        fn folder(&self, path: &str) -> Result<&Folder, Error> {
            if self.1 && path == "Work" {
                return Err(Error::Missing);
            }
            self.0.folder(path)
        }
        fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error> {
            self.0.edit_folder(path, op)
        }
        fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error> {
            let r = self.0.change(path, change);
            self.1 = true;
            r
        }
    }

    /// A batched change that stops halfway: half of the UIDs commit, then Partial.
    struct Halfway(Memory);
    impl MailStore for Halfway {
        fn folders(&self) -> Vec<String> {
            self.0.folders()
        }
        fn folder(&self, path: &str) -> Result<&Folder, Error> {
            self.0.folder(path)
        }
        fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error> {
            self.0.edit_folder(path, op)
        }
        fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error> {
            match change {
                Change::Flags(uids, mode, flags) => {
                    self.0
                        .change(path, Change::Flags(&uids[..uids.len() / 2], mode, flags))?;
                    Err(Error::Partial)
                }
                Change::Transfer(uids, to, moving) => {
                    self.0
                        .change(path, Change::Transfer(&uids[..uids.len() / 2], to, moving))?;
                    Err(Error::Partial)
                }
                other => self.0.change(path, other),
            }
        }
    }

    /// Chunked mutations (gateway/tear, 1,000-UID batches): a STORE that stops partway
    /// reports the messages whose flags changed, then NO; a COPY reports the new messages
    /// (EXISTS), then NO without COPYUID.
    #[test]
    fn a_partial_batched_change_reports_what_committed_then_fails() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Halfway(Memory::default());
        let now = Date::default();
        for _ in 0..4 {
            store
                .0
                .change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags: Flags::new(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        imap.step(b"a SELECT INBOX\r\n", &account, &mut store, now);
        let r = imap.step(
            b"b STORE 1:4 +FLAGS (\\Flagged)\r\n",
            &account,
            &mut store,
            now,
        );
        let text = String::from_utf8_lossy(&r.bytes);
        assert_eq!(text.matches("FETCH").count(), 2, "{text}");
        assert!(
            text.contains("* 1 FETCH") && text.contains("* 2 FETCH"),
            "{text}"
        );
        assert!(
            text.ends_with(
                "b NO [UNAVAILABLE] Interrupted after part of the command was applied\r\n"
            ),
            "{text}"
        );
        let r = imap.step(b"c COPY 1:4 INBOX\r\n", &account, &mut store, now);
        let text = String::from_utf8_lossy(&r.bytes);
        assert!(
            text.contains("* 6 EXISTS") && !text.contains("COPYUID"),
            "{text}"
        );
        assert!(
            text.ends_with(
                "c NO [UNAVAILABLE] Interrupted after part of the command was applied\r\n"
            ),
            "{text}"
        );
    }

    /// LIST reads `*` as any run and `%` as a run within one level. Writing each run of
    /// wildcards as its widest member and comparing the literal start first changes no answer.
    #[test]
    fn list_patterns_keep_the_plain_reading_of_both_wildcards() {
        fn plain(pat: &[u8], name: &[u8]) -> bool {
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
        fn words(alphabet: &[u8], longest: usize) -> Vec<Vec<u8>> {
            let mut all = vec![vec![]];
            let mut from = 0;
            for _ in 0..longest {
                let until = all.len();
                for i in from..until {
                    for &c in alphabet {
                        let mut w = all[i].clone();
                        w.push(c);
                        all.push(w);
                    }
                }
                from = until;
            }
            all
        }
        let names = words(b"ab/", 5);
        for pat in words(b"a/*%", 5) {
            let short = widest(&pat);
            assert!(
                !short
                    .windows(2)
                    .any(|w| WILD.contains(&w[0]) && WILD.contains(&w[1]))
            );
            for name in &names {
                assert_eq!(
                    wildcard(&short, name),
                    plain(&pat, name),
                    "{:?} on {:?}",
                    String::from_utf8_lossy(&pat),
                    String::from_utf8_lossy(name)
                );
            }
        }
    }

    /// An inbox at its folder limits (200 folders, 255-byte names) lists for any pattern
    /// with work set by its folders: a run of wildcards is one wildcard, a literal pattern
    /// is a comparison, and a wildcard part too long for the listed names is refused before
    /// any folder is matched.
    #[test]
    fn list_work_follows_the_folders_not_the_length_of_the_pattern() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Memory::default();
        let now = Date::default();
        let deep = vec!["x".repeat(27); 7].join("/");
        let folder = |i: usize| format!("{deep}/{}{i:06}", "y".repeat(53));
        let existing = store.folders().len();
        for i in 0..200 - existing {
            assert_eq!(folder(i).len(), 255);
            store.edit_folder(&folder(i), FolderOp::Create).unwrap();
        }
        store
            .edit_folder(&folder(7), FolderOp::Subscribe(true))
            .unwrap();
        let listed: usize = store.folders().iter().map(|n| n.len() + 1).sum();
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut list = |command: String| {
            let r = imap.step(
                format!("a {command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8_lossy(&r.bytes).into_owned()
        };
        let stars = "*".repeat(65_000);
        let mixed = "%*".repeat(32_500);
        assert_eq!(widest(format!("{stars}{stars}").as_bytes()), b"*");
        assert_eq!(widest(format!("a{mixed}b%%c").as_bytes()), b"a*b%c");
        for (command, lines) in [
            ("LIST \"\" \"*\"".to_string(), 200),
            (
                format!("LIST {{65000+}}\r\n{stars} {{65000+}}\r\n{stars}"),
                200,
            ),
            (format!("LIST \"\" {{65000+}}\r\n{mixed}"), 200),
            (format!("LIST \"\" \"{deep}/%\""), 200 - existing),
            (format!("LIST \"\" \"{}\"", folder(3)), 1),
            (format!("LIST \"{deep}/\" \"%000003\""), 1),
            (format!("LIST \"\" \"{}%\"", "x".repeat(27)), 0),
            (format!("LIST \"\" {{65000+}}\r\n{}", "x".repeat(65_000)), 0),
            (format!("LSUB \"\" {{65000+}}\r\n{mixed}"), existing + 1),
        ] {
            let text = list(command.clone());
            let shown = &command[..command.len().min(40)];
            assert!(text.ends_with("a OK  Completed\r\n"), "{shown}: {text}");
            assert_eq!(text.matches("\r\n").count() - 1, lines, "{shown}");
        }
        let fits = LIST_WORK / listed;
        let text = list(format!("LIST \"\" \"%{}\"", "y".repeat(fits - 1)));
        assert_eq!(text, "a OK  Completed\r\n");
        for command in ["LIST", "LSUB"] {
            let text = list(format!("{command} \"\" \"%{}\"", "y".repeat(fits)));
            assert_eq!(text, "a NO [LIMIT] Inbox limit exceeded\r\n");
        }
        let text = list(format!(
            "LIST \"\" \"{}%{}\"",
            "x".repeat(fits),
            "y".repeat(8)
        ));
        assert_eq!(text, "a OK  Completed\r\n");
    }

    /// Found by gateway/tear on the Remote store (witness: B create Work, A select Work,
    /// B delete Work, A copy 1 Archive): the COPY's update said BYE, then the command sent a
    /// tagged OK and the connection stayed open.
    #[test]
    fn bye_found_during_a_command_follows_its_completion_and_closes() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Vanishing(Memory::default(), false);
        store.0.edit_folder("Work", FolderOp::Create).unwrap();
        let now = Date::default();
        for cmd in ["COPY 1 INBOX", "MOVE 1 INBOX", "EXPUNGE", "UID EXPUNGE 1:*"] {
            store.1 = false;
            let mut imap = Imap::new(true);
            imap.authenticated = true;
            assert!(
                imap.step(b"a SELECT Work\r\n", &account, &mut store, now)
                    .bytes
                    .ends_with(b"a OK [READ-WRITE] Completed\r\n")
            );
            let r = imap.step(format!("b {cmd}\r\n").as_bytes(), &account, &mut store, now);
            let text = String::from_utf8_lossy(&r.bytes);
            let ok = text.find("b OK").unwrap_or(usize::MAX);
            let bye = text.find("* BYE").unwrap_or(0);
            assert!(ok < bye, "{cmd}: {text}");
            assert!(
                text.ends_with("Selected mailbox no longer exists\r\n"),
                "{cmd}: {text}"
            );
            assert!(r.action == Action::Close, "{cmd}");
        }
    }
}
