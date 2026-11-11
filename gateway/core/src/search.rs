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
    let sub =
        |h: &[u8], n: &[u8]| n.is_empty() || h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n));
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
        K::Larger(s) => e.raw.len() > *s as usize,
        K::Smaller(s) => e.raw.len() < *s as usize,
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
