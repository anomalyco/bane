use base64::{Engine as _, engine::general_purpose::STANDARD};
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Imap,
    Smtp,
}

pub struct Account {
    pub addresses: Vec<String>,
    pub id: String,
    secret: Zeroizing<String>,
    pub imap_enabled: bool,
}
impl Account {
    pub fn new(id: String, addresses: Vec<String>, secret: String, imap_enabled: bool) -> Self {
        Self {
            id,
            addresses,
            secret: Zeroizing::new(secret),
            imap_enabled,
        }
    }
}
pub trait Identity {
    fn owns(&self, address: &str) -> bool;
    fn login(&self, p: Protocol, user: &[u8], password: &[u8]) -> bool;
    fn plain(&self, p: Protocol, bytes: &[u8]) -> bool {
        let fields: Vec<_> = bytes.split(|&b| b == 0).take(4).collect();
        matches!(&fields[..],[az,user,pw] if (az.is_empty()||az==user)&&self.login(p,user,pw))
    }
}
impl Identity for Account {
    fn owns(&self, address: &str) -> bool {
        self.addresses
            .iter()
            .any(|s| s.eq_ignore_ascii_case(address))
    }
    fn login(&self, p: Protocol, user: &[u8], password: &[u8]) -> bool {
        (p != Protocol::Imap || self.imap_enabled)
            && str::from_utf8(user).is_ok_and(|s| self.owns(s) || s == self.id)
            && !self.secret.is_empty()
            && self.secret.as_bytes() == password
    }
}
pub fn decode64(b: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    STANDARD.decode(b).ok().map(Zeroizing::new)
}

#[derive(Default, PartialEq, Eq)]
pub enum Action {
    #[default]
    Continue,
    Upgrade,
    Close,
    Login,
    Failure,
}
#[derive(Default)]
pub struct Reply {
    pub bytes: Vec<u8>,
    pub action: Action,
}

impl Reply {
    pub fn line(&mut self, line: impl AsRef<[u8]>) {
        self.bytes.extend(line.as_ref());
        self.bytes.extend(b"\r\n");
    }
    pub fn one(line: &str) -> Self {
        let mut r = Self::default();
        r.line(line);
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn smtp_only_and_authz_identity() {
        let mut a = Account::new(
            "mbx_test".into(),
            vec!["x@example.invalid".into()],
            "fixture".into(),
            false,
        );
        assert!(!a.plain(Protocol::Imap, b"\0x@example.invalid\0fixture"));
        assert!(a.plain(Protocol::Smtp, b"\0x@example.invalid\0fixture"));
        assert!(!a.plain(Protocol::Smtp, b"other\0x@example.invalid\0fixture"));
        a.imap_enabled = true;
        assert!(a.login(Protocol::Imap, b"mbx_test", b"fixture"));
    }
}
