use crate::store::{Entry, Flags};
use imap_codec::imap_types::fetch::{MessageDataItemName as Item, Part, Section};
use mail_parser::{Address, Message, MessageParser};
use std::borrow::Cow;

pub fn quoted(s: &str) -> String {
    if s.bytes().any(|b| !(32..127).contains(&b)) {
        format!("{{{}}}\r\n{}", s.len(), s.replace('\0', " "))
    } else {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }
}
fn ns(s: Option<&str>) -> String {
    s.map(quoted).unwrap_or_else(|| "NIL".into())
}
pub fn flags(f: &Flags) -> String {
    f.iter().cloned().collect::<Vec<_>>().join(" ")
}
pub fn header_end(raw: &[u8]) -> usize {
    if raw.starts_with(b"\r\n") {
        2
    } else {
        raw.windows(4)
            .position(|s| s == b"\r\n\r\n")
            .map_or(raw.len(), |p| p + 4)
    }
}
fn addr(a: Option<&Address<'_>>) -> String {
    let render = |a: &mail_parser::Addr<'_>| {
        let address = a.address.as_deref()?;
        let (route, mailbox) = if address.starts_with('@') {
            address
                .split_once(':')
                .map_or((None, address), |(s, a)| (Some(s), a))
        } else {
            (None, address)
        };
        let (local, domain) = mailbox.rsplit_once('@').unwrap_or((mailbox, ""));
        Some(format!(
            "({} {} {} {})",
            ns(a.name.as_deref()),
            ns(route),
            quoted(local),
            quoted(domain)
        ))
    };
    let mut entries = Vec::new();
    match a {
        Some(Address::List(list)) => entries.extend(list.iter().filter_map(render)),
        Some(Address::Group(groups)) => {
            for g in groups {
                if let Some(name) = &g.name {
                    entries.push(format!("(NIL NIL {} NIL)", quoted(name)))
                }
                entries.extend(g.addresses.iter().filter_map(render));
                if g.name.is_some() {
                    entries.push("(NIL NIL NIL NIL)".into())
                }
            }
        }
        None => (),
    }
    if entries.is_empty() {
        "NIL".into()
    } else {
        format!("({})", entries.join(""))
    }
}
fn envelope(m: Option<&Message<'_>>) -> String {
    let Some(m) = m else {
        return "(NIL NIL NIL NIL NIL NIL NIL NIL NIL NIL)".into();
    };
    format!(
        "({})",
        [
            ns(m.header_raw("Date").map(str::trim)),
            ns(m.header_raw("Subject").map(str::trim)),
            addr(m.from()),
            addr(
                m.sender()
                    .filter(|a| a.iter().any(|a| a.address.is_some()))
                    .or(m.from())
            ),
            addr(
                m.reply_to()
                    .filter(|a| a.iter().any(|a| a.address.is_some()))
                    .or(m.from())
            ),
            addr(m.to()),
            addr(m.cc()),
            addr(m.bcc()),
            ns(m.header_raw("In-Reply-To").map(str::trim)),
            ns(m.header_raw("Message-ID").map(str::trim))
        ]
        .join(" ")
    )
}
// The full parser stores parts/messages in flat arenas. Limits apply inside its
// parser, not to a second classifier or just to the rendering traversal.
fn index(raw: &[u8]) -> Option<mime_index::Message<'_>> {
    let m = mime_index::MessageParser::new()
        .max_depth(16)
        .max_parts(200)
        .max_encoded_nesting(2)
        .parse(raw)?;
    let limited = m
        .parts()
        .any(|p| p.flags().contains(mime_index::PartFlags::LIMIT_REACHED));
    (!limited).then_some(m)
}
fn structure(p: mime_index::MessagePart<'_>) -> String {
    let ct = p.content_type();
    let sub = ct.as_ref().and_then(|c| c.subtype()).unwrap_or("PLAIN");
    if p.is_multipart() && p.children().len() > 0 {
        return format!(
            "({} {})",
            p.children().map(structure).collect::<String>(),
            quoted(sub)
        );
    }
    let ty = ct.as_ref().map_or("TEXT", |c| c.ctype());
    let attrs: Vec<_> = ct
        .into_iter()
        .flat_map(|c| c.attributes())
        .map(|(k, v)| format!("{} {}", quoted(k), quoted(v)))
        .collect();
    let params = if !attrs.is_empty() {
        format!("({})", attrs.join(" "))
    } else if ty.eq_ignore_ascii_case("text") {
        r#"("CHARSET" "US-ASCII")"#.into()
    } else {
        "NIL".into()
    };
    let body = p.raw_body();
    let lines = body.iter().filter(|&&b| b == b'\n').count();
    let ext = if ty.eq_ignore_ascii_case("text") {
        format!(" {lines}")
    } else if let Some(n) = p.nested() {
        format!(
            " {} {} {lines}",
            envelope(MessageParser::default().parse_headers(n.raw()).as_ref()),
            structure(n.root_part())
        )
    } else {
        String::new()
    };
    format!(
        "({} {} {params} {} {} {} {}{ext})",
        quoted(ty),
        quoted(sub),
        ns(p.content_id()),
        ns(p.content_description()),
        quoted(p.content_transfer_encoding().unwrap_or("7BIT")),
        body.len()
    )
}
fn resolve<'a>(m: &'a mime_index::Message<'_>, part: &Part) -> Option<mime_index::MessagePart<'a>> {
    let mut node = m.root_part();
    for (i, n) in part.0.as_ref().iter().enumerate() {
        let inner = if i == 0 { None } else { node.nested() };
        if let Some(inner) = inner {
            node = inner.root_part()
        }
        if node.is_multipart() {
            node = node.children().nth(n.get() as usize - 1)?
        } else if n.get() != 1 || (i != 0 && inner.is_none()) {
            return None;
        }
    }
    Some(node)
}
fn section<'a>(
    s: Option<&Section<'_>>,
    raw: &'a [u8],
    m: Option<&'a mime_index::Message<'_>>,
) -> (String, Option<Cow<'a, [u8]>>) {
    let Some(s) = s else {
        return (String::new(), Some(raw.into()));
    };
    let (part, key) = match s {
        Section::Part(p) => (Some(p), ""),
        Section::Header(p) => (p.as_ref(), "HEADER"),
        Section::Mime(p) => (Some(p), "MIME"),
        Section::Text(p) => (p.as_ref(), "TEXT"),
        Section::HeaderFields(p, _) => (p.as_ref(), "HEADER.FIELDS"),
        Section::HeaderFieldsNot(p, _) => (p.as_ref(), "HEADER.FIELDS.NOT"),
    };
    let mut name = part
        .map(|p| {
            p.0.as_ref()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(".")
        })
        .unwrap_or_default();
    if !name.is_empty() && !key.is_empty() {
        name.push('.')
    }
    name.push_str(key);
    let mut slice = raw;
    let mut end = header_end(raw);
    if let Some(p) = part {
        let Some(p) = m.and_then(|m| resolve(m, p)) else {
            return (name, None);
        };
        slice = p.raw();
        end = p.raw_headers().len();
        if !matches!(s, Section::Part(_) | Section::Mime(_))
            && let Some(n) = p.nested()
        {
            slice = p.raw_body();
            end = n.root_part().raw_headers().len().min(slice.len());
        }
    }
    match s {
        Section::HeaderFields(_, f) | Section::HeaderFieldsNot(_, f) => {
            let fields = f.as_ref();
            name.push_str(&format!(
                " ({})",
                fields
                    .iter()
                    .map(|a| {
                        let b = a.as_ref();
                        if b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-') {
                            String::from_utf8_lossy(b).into_owned()
                        } else {
                            quoted(&String::from_utf8_lossy(b))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
            let mut body = vec![];
            let mut keep = false;
            for line in slice[..end].split_inclusive(|&b| b == b'\n') {
                if line == b"\r\n" {
                    break;
                }
                if !line.starts_with(b" ") && !line.starts_with(b"\t") {
                    keep = line.iter().position(|&b| b == b':').is_some_and(|i| {
                        fields
                            .iter()
                            .any(|f| f.as_ref().eq_ignore_ascii_case(&line[..i]))
                    }) ^ matches!(s, Section::HeaderFieldsNot(..));
                }
                if keep {
                    body.extend(line)
                }
            }
            body.extend(b"\r\n");
            (name, Some(body.into()))
        }
        Section::Header(_) | Section::Mime(_) => (name, Some(slice[..end].into())),
        _ => (name, Some(slice[end..].into())),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported FETCH item")]
    Unsupported,
    #[error("FETCH response limit; request a partial")]
    Limit,
}
pub fn render(out: &mut Vec<u8>, seq: usize, e: &Entry, items: &[Item<'_>]) -> Result<(), Error> {
    let mut mime = None;
    out.extend(format!("* {seq} FETCH (").bytes());
    for (i, item) in items.iter().enumerate() {
        if i != 0 {
            out.push(b' ')
        }
        let text = match item {
            Item::Flags => format!("FLAGS ({})", flags(&e.flags)),
            Item::Uid => format!("UID {}", e.uid),
            Item::Rfc822Size => format!("RFC822.SIZE {}", e.size),
            Item::InternalDate => format!("INTERNALDATE \"{}\"", e.date.format("%d-%b-%Y %T %z")),
            Item::Envelope => format!(
                "ENVELOPE {}",
                envelope(MessageParser::default().parse_headers(&*e.raw).as_ref())
            ),
            Item::Body | Item::BodyStructure => {
                let m = mime.get_or_insert_with(|| index(&e.raw)).as_ref();
                format!(
                    "{} {}",
                    if matches!(item, Item::Body) {
                        "BODY"
                    } else {
                        "BODYSTRUCTURE"
                    },
                    m.map(|m| structure(m.root_part()))
                        .unwrap_or_else(|| format!(
                            "(\"APPLICATION\" \"OCTET-STREAM\" NIL NIL NIL \"8BIT\" {})",
                            e.raw.len()
                        ))
                )
            }
            Item::BodyExt { .. } | Item::Rfc822 | Item::Rfc822Text | Item::Rfc822Header => {
                let (key, bytes, partial) = match item {
                    Item::BodyExt {
                        section: s,
                        partial,
                        ..
                    } => {
                        let m = if s.as_ref().is_some_and(|v| {
                            !matches!(
                                v,
                                Section::Header(None)
                                    | Section::Text(None)
                                    | Section::HeaderFields(None, _)
                                    | Section::HeaderFieldsNot(None, _)
                            )
                        }) {
                            mime.get_or_insert_with(|| index(&e.raw)).as_ref()
                        } else {
                            None
                        };
                        let (name, bytes) = section(s.as_ref(), &e.raw, m);
                        (format!("BODY[{name}]"), bytes, *partial)
                    }
                    Item::Rfc822Header => (
                        "RFC822.HEADER".into(),
                        Some(Cow::Borrowed(&e.raw[..header_end(&e.raw)])),
                        None,
                    ),
                    Item::Rfc822Text => (
                        "RFC822.TEXT".into(),
                        Some(Cow::Borrowed(&e.raw[header_end(&e.raw)..])),
                        None,
                    ),
                    _ => ("RFC822".into(), Some(Cow::Borrowed(&e.raw[..])), None),
                };
                out.extend(key.bytes());
                if let Some((start, _)) = partial {
                    out.extend(format!("<{start}>").bytes())
                }
                if let Some(data) = bytes {
                    let slice = if let Some((start, n)) = partial {
                        data.get(start as usize..)
                            .map(|s| &s[..s.len().min(n.get() as usize)])
                            .unwrap_or_default()
                    } else {
                        &data
                    };
                    if out.len() + slice.len() > 48 << 20 {
                        return Err(Error::Limit);
                    }
                    out.extend(format!(" {{{}}}\r\n", slice.len()).bytes());
                    out.extend(slice)
                } else {
                    out.extend(b" NIL")
                }
                continue;
            }
            _ => return Err(Error::Unsupported),
        };
        out.extend(text.bytes());
    }
    out.extend(b")\r\n");
    Ok(())
}

/// Exercises the same bounded arena and renderer as FETCH, without a socket.
pub fn inspect_structure(raw: &[u8]) -> Option<String> {
    index(raw).map(|m| structure(m.root_part()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nesting_policy() {
        let raw = include_bytes!("../../fixtures/forwarded.eml");
        assert!(inspect_structure(raw).is_some());
        let m = mime_index::MessageParser::new()
            .max_depth(1)
            .parse(raw)
            .unwrap();
        assert!(
            m.parts()
                .any(|p| p.flags().contains(mime_index::PartFlags::LIMIT_REACHED))
        );
    }
}
