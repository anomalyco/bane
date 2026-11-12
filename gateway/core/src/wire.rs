//! Incremental CRLF/literal framing. The caller retains the unconsumed tail (including pipelined commands).
use imap_codec::{CommandCodec, decode::Decoder, imap_types::command::Command};
use std::borrow::Cow;
use zeroize::Zeroizing;

pub const MAX_APPEND: usize = 8 << 20;
pub const MAX_LINE: usize = 64 << 10;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum Error {
    #[error("frame exceeds size limit")]
    Limit,
    #[error("invalid protocol syntax")]
    Syntax,
}

pub enum Event {
    More,
    Continue,
    AppendBody { len: usize, sync: bool },
    Complete(Zeroizing<Vec<u8>>),
}

#[derive(Default)]
pub struct Frame {
    bytes: Zeroizing<Vec<u8>>,
    start: usize,
    literal: usize,
}

impl Frame {
    pub fn partial(&self) -> bool {
        !self.bytes.is_empty()
    }

    pub fn consume(
        &mut self,
        src: &mut &[u8],
        imap: bool,
        allow_append: bool,
    ) -> Result<Event, Error> {
        self.consume_mode(src, imap, allow_append, false)
    }
    /// For the network adapter, divert only the final APPEND message literal. Validate
    /// the entire prefix with the command codec; mailbox/name literals stay in the frame.
    pub fn consume_mode(
        &mut self,
        src: &mut &[u8],
        imap: bool,
        allow_append: bool,
        stream: bool,
    ) -> Result<Event, Error> {
        while !src.is_empty() {
            if self.literal != 0 {
                let n = self.literal.min(src.len());
                self.bytes.extend_from_slice(&src[..n]);
                *src = &src[n..];
                self.literal -= n;
                self.start = self.bytes.len();
                continue;
            }
            let n = src
                .iter()
                .position(|&b| b == b'\n')
                .map_or(src.len(), |n| n + 1);
            let limit = if imap { MAX_LINE } else { 16 << 10 };
            if self.bytes.len() - self.start + n > limit
                || self.bytes.len() + n > MAX_APPEND + MAX_LINE
            {
                return Err(Error::Limit);
            }
            self.bytes.extend_from_slice(&src[..n]);
            *src = &src[n..];
            if !self.bytes.ends_with(b"\n") {
                continue;
            }
            let line = self.bytes[self.start..]
                .strip_suffix(b"\r\n")
                .ok_or(Error::Syntax)?;
            if imap
                && let Some(marker) = line
                    .strip_suffix(b"}")
                    .and_then(|x| x.iter().rposition(|&b| b == b'{').map(|p| &x[p + 1..]))
            {
                let digits = marker.strip_suffix(b"+").unwrap_or(marker);
                if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) {
                    let len: usize = str::from_utf8(digits)
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .ok_or(Error::Limit)?;
                    let append = allow_append
                        && self
                            .bytes
                            .split(|&b| b == b' ')
                            .nth(1)
                            .is_some_and(|s| s.eq_ignore_ascii_case(b"APPEND"));
                    let max = if append { MAX_APPEND } else { MAX_LINE };
                    if len > max || self.bytes.len() + len > max + MAX_LINE {
                        return Err(Error::Limit);
                    }
                    if stream && append {
                        let cut = self.bytes.len() - marker.len() - 4;
                        let mut empty = self.bytes[..cut].to_vec();
                        empty.extend_from_slice(b"{0+}\r\n\r\n");
                        if matches!(
                            crate::wire::imap(&empty),
                            Ok(Command {
                                body: imap_codec::imap_types::command::CommandBody::Append { .. },
                                ..
                            })
                        ) {
                            let sync = marker == digits;
                            empty.truncate(empty.len() - 2);
                            self.bytes = Zeroizing::new(empty);
                            self.start = self.bytes.len();
                            return Ok(Event::AppendBody { len, sync });
                        }
                        if self.bytes.len() + len > MAX_LINE {
                            return Err(Error::Limit);
                        }
                    }
                    self.literal = len;
                    self.start = self.bytes.len();
                    if marker == digits {
                        return Ok(Event::Continue);
                    }
                    continue;
                }
            }
            self.start = 0;
            return Ok(Event::Complete(std::mem::take(&mut self.bytes)));
        }
        Ok(Event::More)
    }
}

pub fn imap(bytes: &[u8]) -> Result<Command<'_>, Error> {
    match CommandCodec::new().decode(bytes) {
        Ok(([], cmd)) => Ok(cmd),
        _ => Err(Error::Syntax),
    }
}
pub fn smtp(bytes: &[u8]) -> Result<smtp_proto::Request<Cow<'_, str>>, Error> {
    let mut it = bytes.iter();
    let cmd = smtp_proto::Request::parse(&mut it).map_err(|_| Error::Syntax)?;
    if it.len() != 0 {
        return Err(Error::Syntax);
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[test]
    fn streamed_append_leaves_payload_to_its_owner() {
        for (marker, sync) in [("{5}", true), ("{5+}", false)] {
            let line = format!("a APPEND INBOX {marker}\r\nhello\r\nb NOOP\r\n");
            let mut rest = line.as_bytes();
            let mut f = Frame::default();
            assert!(
                matches!(f.consume_mode(&mut rest,true,true,true),Ok(Event::AppendBody{len:5,sync:s}) if s==sync)
            );
            assert_eq!(rest, b"hello\r\nb NOOP\r\n");
            rest = &rest[5..];
            let Ok(Event::Complete(metadata)) = f.consume_mode(&mut rest, true, true, true) else {
                panic!("missing append metadata")
            };
            assert!(wire_append(&metadata));
            assert_eq!(rest, b"b NOOP\r\n");
        }
        fn wire_append(bytes: &[u8]) -> bool {
            matches!(
                imap(bytes),
                Ok(Command {
                    body: imap_codec::imap_types::command::CommandBody::Append { .. },
                    ..
                })
            )
        }
    }
    proptest! {
        #[test]
        fn literal_chunk_boundaries(body in prop::collection::vec(any::<u8>(), 0..4096), chunk in 1..100usize) {
            let mut cmd = format!("a APPEND INBOX {{{}+}}\r\n", body.len()).into_bytes(); cmd.extend(body); cmd.extend(b"\r\n");
            let mut frame = Frame::default(); let mut completed = 0;
            for mut part in cmd.chunks(chunk) {
                if let Event::Complete(got) = frame.consume(&mut part,true,true).unwrap() {prop_assert_eq!(got.as_slice(), &cmd); completed += 1;}
                prop_assert!(part.is_empty());
            }
            prop_assert_eq!(completed, 1);
        }
        #[test]
        fn smtp_ehlo_roundtrip(host in "[a-z]{1,40}\\.invalid", chunk in 1..30usize) {
            let bytes = format!("EHLO {host}\r\n"); let mut frame = Frame::default(); let mut count = 0;
            for mut part in bytes.as_bytes().chunks(chunk) { if let Event::Complete(got) = frame.consume(&mut part,false,false).unwrap() {
                prop_assert_eq!(smtp(&got).unwrap(), smtp_proto::Request::Ehlo {host: Cow::Borrowed(host.as_str())}); count += 1;
            }} prop_assert_eq!(count,1);
        }
    }
}
