//! Real rust-imap client used by the loopback acceptance runner.
use anyhow::{Context, Result};
use std::{env, fs, time::Duration};
fn main() -> Result<()> {
    let port: u16 = env::var("MAILGW_IMAPS_PORT")?.parse()?;
    let tls = native_tls::TlsConnector::builder()
        .add_root_certificate(native_tls::Certificate::from_pem(&fs::read(env::var(
            "MAILGW_CERT",
        )?)?)?)
        .build()?;
    let socket = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))?;
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut client = imap::Client::new(tls.connect("localhost", socket)?);
    client.read_greeting()?;
    let mut s = client
        .login(
            "alias@example.invalid",
            env::var("MAILGW_FIXTURE_PASSWORD")?,
        )
        .map_err(|(e, _)| e)?;
    s.select("INBOX")?;
    let raw = b"From: alias@example.invalid\r\nSubject: Rust probe\r\n\r\nHello\r\n";
    s.append("INBOX", raw)?;
    s.noop()?;
    let u = *s
        .uid_search("SUBJECT \"Rust probe\"")?
        .iter()
        .next()
        .context("missing fixture")?;
    let fetched = s.uid_fetch(u.to_string(), "(UID ENVELOPE BODYSTRUCTURE BODY.PEEK[])")?;
    let f = fetched.iter().next().context("missing fetch")?;
    anyhow::ensure!(f.body() == Some(raw) && f.envelope().is_some() && f.bodystructure().is_some());
    s.logout()?;
    Ok(())
}
