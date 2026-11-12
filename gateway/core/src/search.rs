use crate::{fetch::header_end, store::Entry};
use imap_codec::imap_types::{
    search::SearchKey as K,
    sequence::{SeqOrUid, Sequence, SequenceSet},
};
use mail_parser::MessageParser;
pub fn contains(set: &SequenceSet, n: u32, last: u32) -> bool {
    let value = |x: SeqOrUid| match x {
        SeqOrUid::Value(i) => i.get(),
        SeqOrUid::Asterisk => last,
    };
    set.0.as_ref().iter().any(|s| match *s {
        Sequence::Single(x) => value(x) == n,
        Sequence::Range(x, y) => {
            let (a, b) = (value(x), value(y));
            (a.min(b)..=a.max(b)).contains(&n)
        }
    })
}
pub fn matches(k: &K<'_>, e: &Entry, seq: u32, last: u32, uidmax: u32) -> bool {
    let has = |s: &str| e.flags.iter().any(|f| f.eq_ignore_ascii_case(s));
    let sub = |h: &[u8], n: &[u8]| {
        n.is_empty()
            || memchr::memmem::find(&h.to_ascii_lowercase(), &n.to_ascii_lowercase()).is_some()
    };
    let hdr = |name: &[u8], n: &[u8]| {
        MessageParser::default()
            .parse_headers(&*e.raw)
            .is_some_and(|m| {
                m.headers_raw().any(|(k, v)| {
                    k.as_bytes().eq_ignore_ascii_case(name) && sub(v.trim().as_bytes(), n)
                })
            })
    };
    let sent = || {
        MessageParser::default()
            .parse_headers(&*e.raw)
            .and_then(|m| m.date().copied())
            .and_then(|d| {
                chrono::NaiveDate::from_ymd_opt(d.year as i32, d.month.into(), d.day.into())
            })
    };
    let date = e.date.date_naive();
    match k {
        K::And(v) => v.as_ref().iter().all(|k| matches(k, e, seq, last, uidmax)),
        K::Or(a, b) => matches(a, e, seq, last, uidmax) || matches(b, e, seq, last, uidmax),
        K::Not(a) => !matches(a, e, seq, last, uidmax),
        K::SequenceSet(s) => contains(s, seq, last),
        K::Uid(s) => contains(s, e.uid, uidmax),
        K::All | K::Old => true,
        K::New | K::Recent => false,
        K::Seen => has("\\Seen"),
        K::Unseen => !has("\\Seen"),
        K::Deleted => has("\\Deleted"),
        K::Undeleted => !has("\\Deleted"),
        K::Flagged => has("\\Flagged"),
        K::Unflagged => !has("\\Flagged"),
        K::Answered => has("\\Answered"),
        K::Unanswered => !has("\\Answered"),
        K::Draft => has("\\Draft"),
        K::Undraft => !has("\\Draft"),
        K::Keyword(a) => has(a.inner()),
        K::Unkeyword(a) => !has(a.inner()),
        K::Before(d) => date < *d.as_ref(),
        K::On(d) => date == *d.as_ref(),
        K::Since(d) => date >= *d.as_ref(),
        K::SentBefore(d) => sent().is_some_and(|s| s < *d.as_ref()),
        K::SentOn(d) => sent() == Some(*d.as_ref()),
        K::SentSince(d) => sent().is_some_and(|s| s >= *d.as_ref()),
        K::Larger(s) => e.size > *s as usize,
        K::Smaller(s) => e.size < *s as usize,
        K::Body(n) => sub(&e.raw[header_end(&e.raw)..], n.as_ref()),
        K::Text(n) => sub(&e.raw, n.as_ref()),
        K::Header(k, n) => hdr(k.as_ref(), n.as_ref()),
        K::From(n) | K::To(n) | K::Cc(n) | K::Bcc(n) => {
            let Some(m) = MessageParser::default().parse_headers(&*e.raw) else {
                return false;
            };
            let (name, a) = match k {
                K::From(_) => ("From", m.from()),
                K::To(_) => ("To", m.to()),
                K::Cc(_) => ("Cc", m.cc()),
                _ => ("Bcc", m.bcc()),
            };
            hdr(name.as_bytes(), n.as_ref())
                || a.is_some_and(|a| {
                    a.iter()
                        .filter_map(|a| a.address.as_deref())
                        .any(|s| sub(s.as_bytes(), n.as_ref()))
                })
        }
        K::Subject(n) => hdr(b"Subject", n.as_ref()),
    }
}

#[derive(Ord, PartialOrd, Eq, PartialEq, Clone, Copy, Default)]
pub enum Need {
    #[default]
    Meta,
    Header,
    Body,
}
pub fn need(k: &K<'_>) -> Need {
    match k {
        K::Body(_) | K::Text(_) => Need::Body,
        K::From(_)
        | K::To(_)
        | K::Cc(_)
        | K::Bcc(_)
        | K::Header(..)
        | K::Subject(_)
        | K::SentBefore(_)
        | K::SentOn(_)
        | K::SentSince(_) => Need::Header,
        K::Or(a, b) => need(a).max(need(b)),
        K::Not(k) => need(k),
        K::And(v) => v.as_ref().iter().map(need).max().unwrap_or_default(),
        _ => Need::Meta,
    }
}

pub fn bounded(k: &K<'_>) -> bool {
    match k {
        K::Body(q) | K::Text(q) | K::From(q) | K::To(q) | K::Cc(q) | K::Bcc(q) | K::Subject(q) => {
            q.as_ref().len() <= 1024
        }
        K::Header(key, q) => key.as_ref().len() <= 256 && q.as_ref().len() <= 1024,
        K::Not(q) => bounded(q),
        K::Or(a, b) => bounded(a) && bounded(b),
        K::And(v) => v.as_ref().iter().all(bounded),
        _ => true,
    }
}

/// Upper bound on repeated scans of a candidate message, independent of short-circuiting.
pub fn scan_count(k: &K<'_>) -> usize {
    match k {
        K::Not(q) => scan_count(q),
        K::Or(a, b) => scan_count(a).saturating_add(scan_count(b)),
        K::And(v) => v
            .as_ref()
            .iter()
            .map(scan_count)
            .fold(0, usize::saturating_add),
        K::From(_) | K::To(_) | K::Cc(_) | K::Bcc(_) => 3,
        _ => usize::from(need(k) != Need::Meta),
    }
}
