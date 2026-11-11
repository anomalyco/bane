mod admission;
use admission::{Limits, Slot};
use anyhow::{Context, Result, anyhow};
use mailgw_core::{
    imap::Imap,
    session::{Account, Action, Protocol, Reply},
    smtp::{Caps, Sink, Smtp},
    store::Memory,
    wire::{Event, Frame},
};
use std::{
    env,
    fs::File,
    io::BufReader,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, watch},
    task::JoinSet,
    time::{Instant, timeout, timeout_at},
};
use tokio_rustls::{TlsAcceptor, rustls::ServerConfig};
trait Transport: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Transport for T {}
type Stream = Box<dyn Transport>;
const IO: Duration = Duration::from_secs(30);
const IDLE: Duration = Duration::from_secs(1800);
struct State {
    store: Memory,
    caps: Caps,
}
struct Gateway {
    tls: TlsAcceptor,
    account: Account,
    state: Mutex<State>,
    changed: watch::Sender<u64>,
    slots: Arc<Semaphore>,
    limits: Arc<Mutex<Limits>>,
    preauth: Duration,
}
#[derive(Clone, Copy)]
struct Port {
    protocol: Protocol,
    implicit: bool,
}
enum Core {
    Imap(Imap),
    Smtp(Smtp),
}
impl Core {
    fn new(p: Protocol, tls: bool) -> Self {
        match p {
            Protocol::Imap => Self::Imap(Imap::new(tls)),
            Protocol::Smtp => Self::Smtp(Smtp::new(tls)),
        }
    }
}
impl Gateway {
    fn step(&self, core: &mut Core, bytes: &[u8]) -> Result<Reply> {
        let now = chrono::Utc::now().fixed_offset();
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("store unavailable"))?;
        let State { store, caps } = &mut *state;
        let rev = store.revision();
        let r = match core {
            Core::Imap(i) => i.step(bytes, &self.account, store, now),
            Core::Smtp(s) => s.step(bytes, &self.account, &mut Sink { store, caps }, now),
        };
        if store.revision() != rev {
            self.changed.send_replace(store.revision());
        }
        Ok(r)
    }
    async fn accept_tls(&self, stream: Stream, deadline: Instant) -> Result<Stream> {
        Ok(Box::new(
            timeout_at(deadline, self.tls.accept(stream)).await??,
        ))
    }
    #[tracing::instrument(skip_all,fields(imap=port.protocol==Protocol::Imap,implicit_tls=port.implicit))]
    async fn serve(&self, tcp: TcpStream, port: Port, ip: IpAddr, slot: Slot) -> Result<()> {
        let start = Instant::now();
        let auth_deadline = start + self.preauth;
        tcp.set_nodelay(true)?;
        let mut stream: Stream = Box::new(tcp);
        if port.implicit {
            stream = self.accept_tls(stream, auth_deadline).await?
        }
        let mut core = Core::new(port.protocol, port.implicit);
        let greeting = match &core {
            Core::Imap(i) => format!("* OK [CAPABILITY {}] Bane ready\r\n", i.capabilities()),
            Core::Smtp(_) => "220 smtp.bane.mx ESMTP Bane ready\r\n".into(),
        };
        write(&mut stream, greeting.as_bytes()).await?;
        let mut changed = self.changed.subscribe();
        let mut slot = Some(slot);
        let mut login = None;
        let mut failures = 0;
        let mut frame = Frame::default();
        let mut buf = [0u8; 4096];
        let mut deadline = auth_deadline;
        const KEEPALIVE: Duration = Duration::from_secs(240);
        let mut heartbeat = Instant::now() + KEEPALIVE;
        loop {
            let idling = matches!(&core,Core::Imap(i) if i.idling());
            let read = tokio::select! {
                biased;
                _=tokio::time::sleep_until(deadline)=>break,
                n=stream.read(&mut buf)=>n?,
                _=tokio::time::sleep_until(heartbeat),if idling=>{
                    write(&mut stream,b"* OK Still here\r\n").await?;
                    heartbeat=Instant::now()+KEEPALIVE;
                    continue
                },
                ch=changed.changed(),if idling=>{
                    ch?;
                    if let Core::Imap(i)=&mut core {
                        let r={let s=self.state.lock().map_err(|_|anyhow!("store unavailable"))?;i.update(&s.store)};
                        write(&mut stream,&r.bytes).await?;
                        if r.action==Action::Close {break}
                    }
                    continue
                }
            };
            if read == 0 {
                break;
            }
            let mut src = &buf[..read];
            while !src.is_empty() {
                let was_partial = frame.partial();
                let event =
                    frame.consume(&mut src, port.protocol == Protocol::Imap, login.is_some())?;
                if login.is_some() && !was_partial && frame.partial() {
                    deadline = Instant::now() + IO
                }
                let bytes = match event {
                    Event::More => break,
                    Event::Continue => {
                        write(&mut stream, b"+ Ready for literal\r\n").await?;
                        continue;
                    }
                    Event::Complete(bytes) => bytes,
                };
                if login.is_none()
                    && self
                        .limits
                        .lock()
                        .map_err(|_| anyhow!("limits unavailable"))?
                        .blocked(ip, Instant::now())
                {
                    return Ok(());
                }
                let r = self.step(&mut core, &bytes)?;
                if r.action == Action::Login {
                    let Ok(permit) = self.slots.clone().try_acquire_owned() else {
                        write(
                            &mut stream,
                            match port.protocol {
                                Protocol::Imap => b"* BYE [LIMIT] Session limit\r\n",
                                Protocol::Smtp => b"421 4.7.0 Session limit\r\n",
                            },
                        )
                        .await?;
                        return Ok(());
                    };
                    login = Some(permit);
                    drop(slot.take());
                }
                if r.action == Action::Failure {
                    failures += 1;
                    self.limits
                        .lock()
                        .map_err(|_| anyhow!("limits unavailable"))?
                        .failure(ip, Instant::now());
                    tokio::time::sleep_until(
                        auth_deadline.min(Instant::now() + Duration::from_secs(1)),
                    )
                    .await;
                }
                write(&mut stream, &r.bytes).await?;
                if failures >= 3 || r.action == Action::Close {
                    timeout(IO, stream.shutdown()).await??;
                    return Ok(());
                }
                if r.action == Action::Upgrade {
                    if !src.is_empty() {
                        return Ok(());
                    }
                    stream = self.accept_tls(stream, auth_deadline).await?;
                    core = Core::new(port.protocol, true);
                }
                deadline = if login.is_some() {
                    Instant::now() + IDLE
                } else {
                    auth_deadline
                };
            }
        }
        Ok(())
    }
}
async fn write(stream: &mut Stream, data: &[u8]) -> Result<()> {
    if !data.is_empty() {
        timeout(IO, async {
            stream.write_all(data).await?;
            stream.flush().await
        })
        .await??;
    }
    Ok(())
}
fn setting<T: std::str::FromStr>(name: &str, default: T) -> Result<T> {
    match env::var(name) {
        Ok(s) => s.parse().map_err(|_| anyhow!("Invalid {name}")),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(e) => Err(e.into()),
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();
    let cert = File::open(env::var("MAILGW_CERT")?)?;
    let key = File::open(env::var("MAILGW_KEY")?)?;
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            rustls_pemfile::certs(&mut BufReader::new(cert)).collect::<std::io::Result<_>>()?,
            rustls_pemfile::private_key(&mut BufReader::new(key))?.context("No TLS private key")?,
        )?;
    config.send_tls13_tickets = 0;
    let pass = env::var("MAILGW_FIXTURE_PASSWORD")
        .context("memory adapter requires an explicit fixture password")?;
    anyhow::ensure!(!pass.is_empty(), "empty fixture password");
    let gw = Arc::new(Gateway {
        tls: TlsAcceptor::from(Arc::new(config)),
        account: Account::new(
            "mbx_fixture".into(),
            vec![
                "primary@example.invalid".into(),
                "alias@example.invalid".into(),
            ],
            pass,
            setting("MAILGW_IMAP_ENABLED", false)?,
        ),
        state: Mutex::new(State {
            store: Memory::default(),
            caps: Caps::new(
                setting("MAILGW_DAILY", 200)?,
                setting("MAILGW_MONTHLY", 2000)?,
            ),
        }),
        changed: watch::channel(0).0,
        slots: Arc::new(Semaphore::new(setting("MAILGW_LOGIN_LIMIT", 10)?)),
        limits: Arc::default(),
        preauth: Duration::from_secs(setting("MAILGW_AUTH_SECONDS", 30)?),
    });
    let mut listeners = JoinSet::new();
    for (name, number, protocol, implicit) in [
        ("IMAPS", 993, Protocol::Imap, true),
        ("IMAP", 143, Protocol::Imap, false),
        ("SMTPS", 465, Protocol::Smtp, true),
        ("SMTP", 587, Protocol::Smtp, false),
    ] {
        let l = TcpListener::bind((
            std::net::Ipv4Addr::LOCALHOST,
            setting(&format!("MAILGW_{name}_PORT"), number)?,
        ))
        .await?;
        println!("{name} {}", l.local_addr()?.port());
        let gw = gw.clone();
        listeners.spawn(async move{let mut connections=JoinSet::new();loop{tokio::select!{c=l.accept()=>{let(t,a)=c?;let g=gw.clone();if let Some(slot)=Slot::take(g.limits.clone(),a.ip(),Instant::now()){connections.spawn(async move{if g.serve(t,Port{protocol,implicit},a.ip(),slot).await.is_err(){tracing::debug!("connection ended before logout")}});}},Some(result)=connections.join_next()=>{result?;}}}#[allow(unreachable_code)]Ok::<(),anyhow::Error>(())});
    }
    println!("READY");
    tokio::select! {_=tokio::signal::ctrl_c()=>(),Some(res)=listeners.join_next()=>res??}
    Ok(())
}
