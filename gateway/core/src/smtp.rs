use crate::{
    session::{Action, Identity, Protocol, Reply, decode64},
    store::{Change, Date, MailStore},
    wire,
};
use mail_parser::{HeaderName, MessageParser};
use smtp_proto::{AUTH_LOGIN, AUTH_PLAIN, MAIL_BODY_7BIT, MAIL_BODY_8BITMIME, Request as C};
use zeroize::Zeroizing;

pub const MAX_SIZE: usize = 8 << 20;
#[derive(Debug, thiserror::Error)]
pub enum SubmitError {
    #[error("451 4.7.1 Inbox send cap reached")]
    Cap,
    /// Hosted billing: the workspace's prepaid balance is empty (the API answered 402). A temporary failure, so mail
    /// clients keep the message and retry after a top-up.
    #[error("451 4.7.1 Bane balance is empty; add credit in Settings > Billing")]
    Balance,
    #[error("451 4.3.0 Submission unavailable")]
    Unavailable,
    #[error("552 5.3.4 Message exceeds submission size limits")]
    TooLarge,
    #[error("552 5.2.2 Inbox storage quota exceeded")]
    InboxFull,
    #[error("550 5.7.1 Rejected")]
    Rejected,
}
pub struct Submission<'a> {
    pub principal: &'a dyn Identity,
    pub sender: &'a str,
    pub recipients: &'a [String],
    pub raw: &'a [u8],
    pub date: Date,
}
pub trait Submitter {
    fn submit(&mut self, input: Submission<'_>) -> Result<(), SubmitError>;
}
/// Never delivers. Counters belong to this synthetic inbox, not to the socket, login alias or protocol.
pub struct Sink<'a> {
    pub store: &'a mut dyn MailStore,
    pub caps: &'a mut Caps,
}
pub struct Caps {
    day: (i64, u32),
    month: (i32, u32),
    pub daily: u32,
    pub monthly: u32,
}
impl Caps {
    pub fn new(daily: u32, monthly: u32) -> Self {
        Self {
            daily,
            monthly,
            day: (0, 0),
            month: (0, 0),
        }
    }
}
impl Submitter for Sink<'_> {
    fn submit(&mut self, s: Submission<'_>) -> Result<(), SubmitError> {
        use chrono::Datelike;
        let now = s.date.to_utc();
        let day = now.timestamp().div_euclid(86400);
        let month = now.year() * 12 + now.month0() as i32;
        let c = &mut self.caps;
        // Windows only move forward: a clock that steps back (NTP, a skewed host) stays in
        // the current window instead of reopening an earlier day's or month's cap.
        if day > c.day.0 {
            c.day = (day, 0)
        }
        if month > c.month.0 {
            c.month = (month, 0)
        }
        let recipients = u32::try_from(s.recipients.len()).map_err(|_| SubmitError::Cap)?;
        if recipients > c.daily.saturating_sub(c.day.1)
            || recipients > c.monthly.saturating_sub(c.month.1)
        {
            return Err(SubmitError::Cap);
        }
        let raw = remove_bcc(s.raw);
        self.store
            .change(
                "Sent",
                Change::Append {
                    raw: &raw,
                    date: s.date,
                    flags: Default::default(),
                    source: crate::store::Origin::Submission,
                },
            )
            .map_err(|_| SubmitError::Unavailable)?;
        c.day.1 += recipients;
        c.month.1 += recipients;
        Ok(())
    }
}

fn remove_bcc(raw: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    use std::borrow::Cow;
    let end = crate::fetch::header_end(raw);
    let mut kept = vec![];
    let mut skip = false;
    let mut changed = false;
    for line in raw[..end].split_inclusive(|&b| b == b'\n') {
        if !line.starts_with(b" ") && !line.starts_with(b"\t") {
            skip = line
                .get(..4)
                .is_some_and(|b| b.eq_ignore_ascii_case(b"Bcc:"))
        }
        if skip {
            changed = true
        } else {
            kept.extend(line)
        }
    }
    if changed {
        kept.extend(&raw[end..]);
        Cow::Owned(kept)
    } else {
        Cow::Borrowed(raw)
    }
}

enum Phase {
    Command,
    Plain,
    User,
    Pass(Zeroizing<Vec<u8>>),
    Data(Vec<u8>),
    Oversize,
}

pub struct Smtp {
    tls: bool,
    ehlo: bool,
    pub authenticated: bool,
    phase: Phase,
    from: Option<String>,
    rcpt: Vec<String>,
}
impl Smtp {
    pub fn receiving_data(&self) -> bool {
        matches!(self.phase, Phase::Data(_) | Phase::Oversize)
    }
    pub fn refuse_data(&mut self) {
        self.phase = Phase::Command;
        self.reset();
    }
    pub fn new(tls: bool) -> Self {
        Self {
            tls,
            ehlo: false,
            authenticated: false,
            phase: Phase::Command,
            from: None,
            rcpt: vec![],
        }
    }
    fn reset(&mut self) {
        self.from = None;
        self.rcpt.clear();
    }
    fn auth(&mut self, ok: bool) -> Reply {
        self.authenticated = ok;
        let mut r = Reply::one(if ok {
            "235 2.7.0 Authenticated"
        } else {
            "535 5.7.8 Authentication failed"
        });
        r.action = if ok { Action::Login } else { Action::Failure };
        r
    }
    pub fn step(
        &mut self,
        bytes: &[u8],
        account: &dyn Identity,
        submit: &mut dyn Submitter,
        date: Date,
    ) -> Reply {
        let line = bytes.strip_suffix(b"\r\n").unwrap_or(bytes);
        match std::mem::replace(&mut self.phase, Phase::Command) {
            Phase::Data(mut body) => {
                if line == b"." {
                    let r = if !owned_headers(&body, account) {
                        Reply::one("553 5.7.1 Header sender not owned")
                    } else {
                        let s = Submission {
                            principal: account,
                            sender: self.from.as_deref().unwrap_or(""),
                            recipients: &self.rcpt,
                            raw: &body,
                            date,
                        };
                        match submit.submit(s) {
                            Ok(()) => Reply::one("250 2.0.0 Submission accepted"),
                            Err(e) => Reply::one(&e.to_string()),
                        }
                    };
                    self.reset();
                    return r;
                }
                let chunk = bytes.strip_prefix(b".").unwrap_or(bytes);
                self.phase = if body.len() + chunk.len() > MAX_SIZE {
                    Phase::Oversize
                } else {
                    body.extend_from_slice(chunk);
                    Phase::Data(body)
                };
                return Reply::default();
            }
            Phase::Oversize => {
                if line == b"." {
                    self.reset();
                    return Reply::one("552 5.3.4 Too large");
                }
                self.phase = Phase::Oversize;
                return Reply::default();
            }
            Phase::Plain | Phase::User | Phase::Pass(_) if line == b"*" => {
                return Reply::one("501 5.7.0 Cancelled");
            }
            Phase::Plain => {
                return self
                    .auth(decode64(line).is_some_and(|v| account.plain(Protocol::Smtp, &v)));
            }
            Phase::User => return self.user(line),
            Phase::Pass(u) => {
                return self
                    .auth(decode64(line).is_some_and(|v| account.login(Protocol::Smtp, &u, &v)));
            }
            Phase::Command => (),
        }
        let Ok(cmd) = wire::smtp(bytes) else {
            return Reply::one("500 5.5.2 Invalid command");
        };
        match cmd {
            C::Quit => {
                let mut r = Reply::one("221 2.0.0 Bye");
                r.action = Action::Close;
                r
            }
            C::Ehlo { .. } => {
                self.ehlo = true;
                self.reset();
                let mut r = Reply::default();
                r.line("250-smtp.bane.mx");
                r.line("250-PIPELINING");
                r.line(format!("250-SIZE {MAX_SIZE}"));
                r.line("250-8BITMIME");
                r.line(if !self.tls {
                    "250 STARTTLS"
                } else if !self.authenticated {
                    "250 AUTH PLAIN LOGIN"
                } else {
                    "250 OK"
                });
                r
            }
            C::StartTls if self.ehlo && !self.tls => {
                let mut r = Reply::one("220 2.0.0 Begin TLS");
                r.action = Action::Upgrade;
                r
            }
            _ if !self.tls => Reply::one("530 5.7.0 Must issue STARTTLS first"),
            C::Noop { .. } => Reply::one("250 2.0.0 OK"),
            _ if !self.ehlo => Reply::one("503 5.5.1 Send EHLO first"),
            C::Auth {
                mechanism,
                initial_response,
            } if !self.authenticated => match mechanism {
                AUTH_PLAIN if initial_response.is_empty() => {
                    self.phase = Phase::Plain;
                    Reply::one("334 ")
                }
                AUTH_PLAIN => self.auth(
                    decode64(initial_response.as_bytes())
                        .is_some_and(|v| account.plain(Protocol::Smtp, &v)),
                ),
                AUTH_LOGIN if initial_response.is_empty() => {
                    self.phase = Phase::User;
                    Reply::one("334 VXNlcm5hbWU6")
                }
                AUTH_LOGIN => self.user(initial_response.as_bytes()),
                _ => Reply::one("504 5.5.4 Mechanism unsupported"),
            },
            C::Rset => {
                self.reset();
                Reply::one("250 2.0.0 Reset")
            }
            _ if !self.authenticated => Reply::one("530 5.7.0 Authentication required"),
            C::Mail { from } => {
                if self.from.is_some() {
                    return Reply::one("503 5.5.1 Transaction active");
                }
                if from.size > MAX_SIZE {
                    return Reply::one("552 5.3.4 Too large");
                }
                if from.flags & !(MAIL_BODY_7BIT | MAIL_BODY_8BITMIME) != 0
                    || from.env_id.is_some()
                    || from.auth.is_some()
                    || from.hold_for != 0
                    || from.hold_until != 0
                    || from.mt_priority != 0
                    || from.mtrk.is_some()
                    || from.solicit.is_some()
                    || from.trans_id.is_some()
                    || from.by != 0
                {
                    return Reply::one("555 5.5.4 Unsupported parameter");
                }
                if !account.owns(&from.address) {
                    return Reply::one("553 5.7.1 Sender not owned");
                }
                self.from = Some(from.address.into_owned());
                Reply::one("250 2.1.0 Sender accepted")
            }
            C::Rcpt { to } if self.from.is_some() => {
                if to.flags != 0 || to.orcpt.is_some() || to.rrvs != 0 {
                    return Reply::one("555 5.5.4 Unsupported parameter");
                }
                if self.rcpt.len() >= 50 {
                    return Reply::one("452 4.5.3 Too many recipients");
                }
                if !to.address.is_ascii() || !to.address.contains('@') {
                    return Reply::one("553 5.1.3 Invalid recipient");
                }
                self.rcpt.push(to.address.into_owned());
                Reply::one("250 2.1.5 Recipient accepted")
            }
            C::Data if !self.rcpt.is_empty() => {
                self.phase = Phase::Data(vec![]);
                Reply::one("354 End with <CRLF>.<CRLF>")
            }
            _ => Reply::one("503 5.5.1 Bad sequence or unsupported command"),
        }
    }
    fn user(&mut self, user: &[u8]) -> Reply {
        let Some(u) = decode64(user) else {
            return self.auth(false);
        };
        self.phase = Phase::Pass(u);
        Reply::one("334 UGFzc3dvcmQ6")
    }
}
fn owned_headers(body: &[u8], account: &dyn Identity) -> bool {
    let Some(m) = MessageParser::default().parse_headers(body) else {
        return false;
    };
    let mut from = 0;
    let mut sender = 0;
    for h in m.headers() {
        match h.name {
            HeaderName::From => from += 1,
            HeaderName::Sender => sender += 1,
            _ => continue,
        }
        let Some(a) = h.value.as_address() else {
            return false;
        };
        let mut list = a.iter();
        if !list
            .next()
            .and_then(|a| a.address.as_deref())
            .is_some_and(|a| account.owns(a))
            || list.next().is_some()
        {
            return false;
        }
    }
    from == 1 && sender <= 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Account;
    use crate::store::Memory;
    #[test]
    fn quota_resets_on_utc_day_and_month_and_rejections_do_not_archive() {
        let a = Account::new("mbx_test".into(), vec![], "fixture".into(), false);
        let mut m = Memory::default();
        let mut c = Caps::new(1, 2);
        let mut submit = |t: &str| {
            Sink {
                store: &mut m,
                caps: &mut c,
            }
            .submit(Submission {
                principal: &a,
                sender: "",
                recipients: &["reader@example.invalid".into()],
                raw: b"Subject: test\r\n\r\nfixture",
                date: t.parse().unwrap(),
            })
        };
        assert!(submit("2025-01-17T23:59:59Z").is_ok());
        assert!(matches!(
            submit("2025-01-17T23:59:59Z"),
            Err(SubmitError::Cap)
        ));
        assert!(submit("2025-01-18T00:00:00Z").is_ok());
        assert!(matches!(
            submit("2025-01-19T00:00:00Z"),
            Err(SubmitError::Cap)
        ));
        assert!(submit("2025-02-01T00:00:00Z").is_ok());
        assert_eq!(m.folder("Sent").unwrap().entries.len(), 3);
    }
    /// Found by gateway/tear (13-step witness: ehlo, auth, cross midnight into a new month,
    /// send to 3 recipients at a daily cap of 3, the clock steps back 1 s, send again): the
    /// step back reset both windows and the second message was accepted.
    #[test]
    fn a_clock_stepping_back_does_not_reopen_a_cap() {
        let a = Account::new("mbx_test".into(), vec![], "fixture".into(), false);
        let mut m = Memory::default();
        let mut c = Caps::new(3, 5);
        let mut submit = |t: &str, n: usize| {
            Sink {
                store: &mut m,
                caps: &mut c,
            }
            .submit(Submission {
                principal: &a,
                sender: "",
                recipients: &vec!["reader@example.invalid".to_owned(); n],
                raw: b"Subject: test\r\n\r\nfixture",
                date: t.parse().unwrap(),
            })
        };
        assert!(submit("2025-12-01T00:00:00Z", 3).is_ok());
        assert!(matches!(
            submit("2025-11-30T23:59:59Z", 1),
            Err(SubmitError::Cap)
        ));
        assert!(matches!(
            submit("2025-12-01T00:00:01Z", 1),
            Err(SubmitError::Cap)
        ));
        assert!(submit("2025-12-02T00:00:00Z", 2).is_ok());
        assert!(matches!(
            submit("2025-12-01T23:59:59Z", 1),
            Err(SubmitError::Cap)
        ));
        assert_eq!(m.folder("Sent").unwrap().entries.len(), 2);
    }
    #[test]
    fn scrub_only_bcc_headers_including_folded_lines() {
        assert_eq!(
            &*remove_bcc(b"To: x\r\nBcC: a,\r\n b\r\n\r\nBcc: body\r\n"),
            b"To: x\r\n\r\nBcc: body\r\n"
        );
    }
}
