mod admission;
mod remote;
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
    api: Option<Arc<remote::Api>>,
    events: tokio::sync::broadcast::Sender<(String, bool)>,
    per_inbox: Mutex<std::collections::HashMap<String, std::sync::Weak<Semaphore>>>,
    limit: usize,
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
        let mut events = self.events.subscribe();
        let identity = self.api.as_ref().map(|api| remote::Login {
            api: api.clone(),
            principal: Mutex::new(None),
        });
        let mut backend: Option<remote::Store> = None;
        let mut stale = false;
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
                event=events.recv(),if backend.is_some()=>{let Some(store)=backend.as_mut()else{continue};match event{Ok((inbox,auth)) if inbox.is_empty()||inbox==store.principal.inbox=>{if auth{write(&mut stream,match port.protocol{Protocol::Imap=>b"* BYE Credential changed\r\n",Protocol::Smtp=>b"421 4.7.0 Credential changed\r\n"}).await?;break}stale=true;},Err(_)=>break,_=>continue}
                    if idling && let Core::Imap(i)=&mut core{tokio::task::block_in_place(||store.reload(true))?;stale=false;let r=i.update(store);write(&mut stream,&r.bytes).await?;if r.action==Action::Close{break}}continue},
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
                let r = if let Some(identity) = &identity {
                    tokio::task::block_in_place(|| -> Result<Reply> {
                        let now = chrono::Utc::now().fixed_offset();
                        if let Some(store) = backend.as_mut() {
                            if matches!(core, Core::Imap(_))
                                && (stale || store.stamp.elapsed() > Duration::from_secs(240))
                            {
                                store.refresh()?;
                                stale = false
                            }
                            Ok(match &mut core {
                                Core::Imap(i) => i.step(&bytes, identity, store, now),
                                Core::Smtp(s) => s.step(&bytes, identity, store, now),
                            })
                        } else {
                            Ok(match &mut core {
                                Core::Imap(i) => {
                                    i.step(&bytes, identity, &mut Memory::default(), now)
                                }
                                Core::Smtp(s) => {
                                    s.step(&bytes, identity, &mut remote::Offline, now)
                                }
                            })
                        }
                    })?
                } else {
                    self.step(&mut core, &bytes)?
                };
                if r.action == Action::Login {
                    let slots = if let Some(auth) = &identity {
                        let p = auth
                            .principal
                            .lock()
                            .map_err(|_| anyhow!("login unavailable"))?
                            .clone()
                            .context("missing principal")?;
                        let mut m = self
                            .per_inbox
                            .lock()
                            .map_err(|_| anyhow!("limits unavailable"))?;
                        m.retain(|_, s| s.strong_count() > 0);
                        let slots = m
                            .get(&p.inbox)
                            .and_then(std::sync::Weak::upgrade)
                            .unwrap_or_else(|| Arc::new(Semaphore::new(self.limit)));
                        m.insert(p.inbox.clone(), Arc::downgrade(&slots));
                        backend = Some(remote::Store::new(auth.api.clone(), p));
                        slots
                    } else {
                        self.slots.clone()
                    };
                    let Ok(permit) = slots.try_acquire_owned() else {
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
    fn pem(value: &str, file: &str) -> Result<Box<dyn std::io::Read>> {
        if let Ok(s) = env::var(value) {
            return Ok(Box::new(std::io::Cursor::new(s.into_bytes())));
        }
        Ok(Box::new(File::open(env::var(file)?)?))
    }
    let cert = pem("MAILGW_CERT_PEM", "MAILGW_CERT")?;
    let key = pem("MAILGW_KEY_PEM", "MAILGW_KEY")?;
    let api = env::var("MAILGW_API_TOKEN")
        .ok()
        .map(|key| {
            remote::Api::new(
                env::var("MAILGW_API_URL").unwrap_or_else(|_| "https://bane.mx".into()),
                key,
            )
            .map(Arc::new)
        })
        .transpose()?;
    tokio_rustls::rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            rustls_pemfile::certs(&mut BufReader::new(cert)).collect::<std::io::Result<_>>()?,
            rustls_pemfile::private_key(&mut BufReader::new(key))?.context("No TLS private key")?,
        )?;
    config.send_tls13_tickets = 0;
    let pass = env::var("MAILGW_FIXTURE_PASSWORD").unwrap_or_default();
    anyhow::ensure!(
        api.is_some() != !pass.is_empty(),
        "configure exactly one backend"
    );
    let bind = setting("MAILGW_BIND", std::net::Ipv4Addr::LOCALHOST)?;
    anyhow::ensure!(
        api.is_some() || bind.is_loopback(),
        "fixture must stay on loopback"
    );
    let limit = setting("MAILGW_LOGIN_LIMIT", 10)?;
    let gw = Arc::new(Gateway {
        api: api.clone(),
        events: tokio::sync::broadcast::channel(256).0,
        per_inbox: Mutex::default(),
        limit,
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
    if let Some(api) = api {
        let db = env::var("DATABASE_URL")?;
        let events = gw.events.clone();
        let (ready, mut rx) = watch::channel(false);
        listeners.spawn(async move {
            loop {
                if remote::listen(&db, &events, &api, &ready).await.is_err() {
                    ready.send_replace(false);
                    tracing::warn!("protocol notification connection unavailable");
                    api.clear();
                    drop(events.send((String::new(), true)));
                    tokio::time::sleep(Duration::from_secs(1)).await
                }
            }
        });
        timeout(IO, rx.wait_for(|up| *up)).await??;
        let health = TcpListener::bind((bind, setting("MAILGW_HEALTH_PORT", 8080)?)).await?;
        listeners.spawn(async move{let mut tasks=JoinSet::new();loop{tokio::select!{v=health.accept()=>{let(mut s,_)=v?;if tasks.len()<32{tasks.spawn(async move{let _result=timeout(Duration::from_secs(2),async{let mut line=Vec::new();while line.len()<128{let b=s.read_u8().await?;line.push(b);if b==b'\n'{break}}let status=if line==b"GET /health HTTP/1.1\r\n"||line==b"GET /health HTTP/1.0\r\n"{"200 OK"}else{"404 Not Found"};s.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await}).await;});}},Some(res)=tasks.join_next()=>res?,}}#[allow(unreachable_code)]Ok::<(),anyhow::Error>(())});
    }
    for (name, number, protocol, implicit) in [
        ("IMAPS", 993, Protocol::Imap, true),
        ("IMAP", 143, Protocol::Imap, false),
        ("SMTPS", 465, Protocol::Smtp, true),
        ("SMTP", 587, Protocol::Smtp, false),
    ] {
        let l = TcpListener::bind((bind, setting(&format!("MAILGW_{name}_PORT"), number)?)).await?;
        println!("{name} {}", l.local_addr()?.port());
        let gw = gw.clone();
        listeners.spawn(async move{let mut connections=JoinSet::new();loop{tokio::select!{c=l.accept()=>{let(t,a)=c?;let g=gw.clone();if let Some(slot)=Slot::take(g.limits.clone(),a.ip(),Instant::now()){connections.spawn(async move{if g.serve(t,Port{protocol,implicit},a.ip(),slot).await.is_err(){tracing::debug!("connection ended before logout")}});}},Some(result)=connections.join_next()=>{result?;}}}#[allow(unreachable_code)]Ok::<(),anyhow::Error>(())});
    }
    println!("READY");
    tokio::select! {_=tokio::signal::ctrl_c()=>(),Some(res)=listeners.join_next()=>res??}
    Ok(())
}
