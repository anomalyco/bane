//! A correct IMAP client's mirror, rebuilt only from server responses (EXISTS, EXPUNGE,
//! FETCH) plus its own `.SILENT` deltas, with RFC 3501 safety checks on every response.
//! Shared by the in-process gateway fixtures and the Dovecot fixture.
use crate::model::Flags;
use std::collections::BTreeSet;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Plain,
    /// FETCH, STORE, SEARCH by sequence number: RFC 3501 7.4.1 forbids EXPUNGE responses.
    NoExpunge,
    Select,
}

/// Split a response stream into logical lines, keeping literals inside their line.
pub fn responses(bytes: &[u8]) -> Vec<String> {
    let mut out = vec![];
    let mut cur = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let end = bytes[i..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .map_or(bytes.len(), |p| i + p);
        let line = &bytes[i..end];
        cur.extend_from_slice(line);
        i = (end + 2).min(bytes.len());
        let literal = line
            .strip_suffix(b"}")
            .and_then(|x| x.iter().rposition(|&b| b == b'{').map(|p| &x[p + 1..]))
            .and_then(|d| std::str::from_utf8(d).ok()?.parse::<usize>().ok());
        if let Some(n) = literal {
            cur.extend_from_slice(b"\r\n");
            let stop = (i + n).min(bytes.len());
            cur.extend_from_slice(&bytes[i..stop]);
            i = stop;
            continue;
        }
        out.push(String::from_utf8_lossy(&std::mem::take(&mut cur)).into_owned());
    }
    out
}

fn fetch_items(text: &str) -> (Option<u32>, Option<Flags>) {
    let uid = text
        .find("UID ")
        .filter(|&p| p > 0 && matches!(text.as_bytes()[p - 1], b'(' | b' '))
        .and_then(|p| text[p + 4..].split([' ', ')']).next()?.parse().ok());
    let flags = text.find("FLAGS (").and_then(|p| {
        let rest = &text[p + 7..];
        let inner = &rest[..rest.find(')')?];
        // \Recent is per session and Bane never sets it; Dovecot does.
        Some(
            inner
                .split_whitespace()
                .filter(|f| !f.eq_ignore_ascii_case("\\Recent"))
                .map(str::to_owned)
                .collect(),
        )
    });
    (uid, flags)
}

pub struct Client {
    pub name: &'static str,
    pub tag: u32,
    pub mirror: Vec<Option<(u32, Flags)>>,
    pub gone: BTreeSet<u32>,
    /// The server said BYE.
    pub bye: bool,
    /// Text of the last tagged response, e.g. "OK [READ-WRITE] Completed".
    pub last: String,
}

impl Client {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            tag: 0,
            mirror: vec![],
            gone: BTreeSet::new(),
            bye: false,
            last: String::new(),
        }
    }
    pub fn reset(&mut self) {
        self.mirror.clear();
        self.gone.clear();
    }
    pub fn next_tag(&mut self) -> String {
        self.tag += 1;
        format!("t{}", self.tag)
    }
    /// The mirror as the model reports views (unknown slots stay null and so mismatch).
    pub fn view(&self) -> &Vec<Option<(u32, Flags)>> {
        &self.mirror
    }
    pub fn first_uid(&self) -> Option<u32> {
        self.mirror.first().and_then(|m| m.as_ref().map(|m| m.0))
    }
    /// Apply a response stream; returns the tagged statuses ("OK", "NO", "BAD", "+").
    pub fn absorb_all(
        &mut self,
        bytes: &[u8],
        kind: Kind,
        safety: &mut Vec<String>,
    ) -> Vec<String> {
        responses(bytes)
            .iter()
            .filter_map(|line| self.absorb(line, kind, safety))
            .collect()
    }
    /// Apply one server response to the mirror; returns the tagged status if any.
    pub fn absorb(&mut self, line: &str, kind: Kind, safety: &mut Vec<String>) -> Option<String> {
        let who = self.name;
        let mut words = line.split(' ');
        let first = words.next().unwrap_or_default();
        if first == "+" {
            return Some("+".into());
        }
        if first != "*" {
            if self.bye {
                safety.push(format!("{who}: tagged response after BYE"));
            }
            let status = words.next().map(str::to_owned);
            self.last = line[first.len()..].trim().to_owned();
            return status;
        }
        let (Some(n), Some(what)) = (words.next(), words.next()) else {
            return None;
        };
        if n == "BYE" {
            self.bye = true;
            return None;
        }
        let Ok(n) = n.parse::<usize>() else {
            return None;
        };
        let len = self.mirror.len();
        match what {
            "EXISTS" if n < len => safety.push(format!("{who}: EXISTS {n} below count {len}")),
            "EXISTS" => self.mirror.resize(n, None),
            "RECENT" => {}
            "EXPUNGE" => {
                if kind == Kind::NoExpunge {
                    safety.push(format!("{who}: EXPUNGE during FETCH/STORE"));
                }
                if n == 0 || n > len {
                    safety.push(format!("{who}: EXPUNGE {n} out of range 1..{len}"));
                } else if let Some((uid, _)) = self.mirror.remove(n - 1) {
                    self.gone.insert(uid);
                }
            }
            "FETCH" => {
                if n == 0 || n > len {
                    safety.push(format!("{who}: FETCH {n} out of range 1..{len}"));
                    return None;
                }
                let (uid, flags) = fetch_items(line);
                let slot = &mut self.mirror[n - 1];
                match (uid, slot.as_mut()) {
                    (Some(u), Some((known, _))) if *known != u => {
                        safety.push(format!("{who}: seq {n} changed UID {known} -> {u}"))
                    }
                    (Some(u), _) if self.gone.contains(&u) => {
                        safety.push(format!("{who}: expunged UID {u} reappeared"))
                    }
                    _ => {}
                }
                match (uid, slot.as_mut(), flags) {
                    (_, Some((_, known)), Some(f)) => *known = f,
                    (Some(u), None, f) => *slot = Some((u, f.unwrap_or_default())),
                    _ => {}
                }
            }
            _ => {}
        }
        None
    }
    /// A correct view lists strictly ascending UIDs.
    pub fn check_order(&self, safety: &mut Vec<String>) {
        let uids: Vec<u32> = self.mirror.iter().flatten().map(|m| m.0).collect();
        if uids.windows(2).any(|w| w[0] >= w[1]) {
            safety.push(format!("{}: mirror UIDs not ascending {uids:?}", self.name));
        }
    }
    /// The FETCH range for slots the client only knows from EXISTS.
    pub fn unknown_range(&self) -> Option<(usize, usize)> {
        let lo = self.mirror.iter().position(Option::is_none)?;
        let hi = self.mirror.iter().rposition(Option::is_none)?;
        Some((lo + 1, hi + 1))
    }
    pub fn apply_silent(&mut self, slots: std::ops::Range<usize>, flag: &str, add: bool) {
        for slot in self
            .mirror
            .iter_mut()
            .skip(slots.start)
            .take(slots.len())
            .flatten()
        {
            if add {
                slot.1.insert(flag.into());
            } else {
                slot.1.remove(flag);
            }
        }
    }
}
