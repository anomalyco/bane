mod admission;
mod hints;
mod remote;
mod upload;
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
    io::Read,
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
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};
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
    events: Arc<hints::Hints>,
    stop: watch::Sender<bool>,
    sockets: Arc<Semaphore>,
    uploads: Arc<Semaphore>,
    smtp_data: Arc<Semaphore>,
    responses: Arc<Semaphore>,
    handshakes: Semaphore,
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
    async fn accept_tls(
        &self,
        stream: Stream,
        deadline: Instant,
        peer: &Semaphore,
    ) -> Result<Stream> {
        let deadline = deadline.min(Instant::now() + Duration::from_secs(4));
        let _peer = timeout_at(deadline, peer.acquire()).await??;
        let _permit = timeout_at(deadline, self.handshakes.acquire()).await??;
        Ok(Box::new(
            timeout_at(deadline, self.tls.accept(stream)).await??,
        ))
    }
    #[tracing::instrument(skip_all,fields(imap=port.protocol==Protocol::Imap,implicit_tls=port.implicit))]
    async fn serve(&self, tcp: TcpStream, port: Port, ip: IpAddr, slot: Slot) -> Result<()> {
        let start = slot.accepted;
        let auth_deadline = start + self.preauth;
        const PREAUTH_IDLE: Duration = Duration::from_secs(4);
        let greeting_deadline = auth_deadline.min(start + PREAUTH_IDLE);
        timeout_at(greeting_deadline, tokio::time::sleep_until(slot.after)).await?;
        tcp.set_nodelay(true)?;
        if port.implicit {
            let mut prefix = [0];
            anyhow::ensure!(
                timeout_at(greeting_deadline, tcp.peek(&mut prefix)).await?? > 0,
                "closed before TLS"
            );
        }
        let mut stream: Stream = Box::new(tcp);
        if port.implicit {
            stream = self
                .accept_tls(stream, greeting_deadline, &slot.tls)
                .await?
        }
        let mut core = Core::new(port.protocol, port.implicit);
        let greeting = match &core {
            Core::Imap(i) => format!("* OK [CAPABILITY {}] Bane ready\r\n", i.capabilities()),
            Core::Smtp(_) => "220 smtp.bane.mx ESMTP Bane ready\r\n".into(),
        };
        timeout_at(greeting_deadline, write(&mut stream, greeting.as_bytes())).await??;
        let mut changed = self.changed.subscribe();
        let mut feed = None;
        let mut login_generation = 0;
        let mut stop = self.stop.subscribe();
        if *stop.borrow() {
            return Ok(());
        }
        let mut commands = admission::Bucket::new(start, 200, 50);
        let identity = self.api.as_ref().map(|api| remote::Login {
            deadline: auth_deadline.into_std(),
            api: api.clone(),
            principal: Mutex::new(None),
            unavailable: false.into(),
            limits: self.limits.clone(),
            ip,
        });
        let mut backend: Option<remote::Store> = None;
        let mut stale = false;
        let mut slot = Some(slot);
        let mut login = None;
        let mut failures = 0;
        let mut frame = Frame::default();
        let mut data_permit = None;
        let mut spool: Option<upload::Upload> = None;
        let mut discard = 0usize;
        let mut terminator = 0usize;
        let mut buf = [0u8; 4096];
        let mut deadline = auth_deadline.min(Instant::now() + PREAUTH_IDLE);
        const KEEPALIVE: Duration = Duration::from_secs(240);
        let mut heartbeat = Instant::now() + KEEPALIVE;
        loop {
            let idling = matches!(&core,Core::Imap(i) if i.idling());
            let read_deadline = if spool.is_some() {
                deadline.min(Instant::now() + IO)
            } else {
                deadline
            };
            let read = tokio::select! {
                biased;
                _=tokio::time::sleep_until(read_deadline)=>break,
                _=stop.changed()=>{write(&mut stream,match port.protocol{Protocol::Imap=>b"* BYE [UNAVAILABLE] Restarting\r\n",Protocol::Smtp=>b"421 4.3.2 Restarting\r\n"}).await?;break},
                event=async {match &mut feed{Some((_,rx))=>next_hint(rx).await,None=>std::future::pending().await}}=>{
                    let generation=event?;
                    if generation.auth!=login_generation{write(&mut stream,match port.protocol{Protocol::Imap=>b"* BYE Credential changed\r\n",Protocol::Smtp=>b"421 4.7.0 Credential changed\r\n"}).await?;break}
                    stale=true;
                    if idling && let Some(store)=backend.as_mut() && let Core::Imap(i)=&mut core {
                        let r = tokio::task::block_in_place(|| store.wake(i, &mut stale)).unwrap_or_else(snapshot_bye);
                        write(&mut stream, &r.bytes).await?;
                        if r.action == Action::Close {break}
                    }
                    continue
                },
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
                if discard > 0 {
                    let n = discard.min(src.len());
                    discard -= n;
                    src = &src[n..];
                    if discard == 0 {
                        deadline = Instant::now() + IDLE;
                    }
                    continue;
                }
                if let Some(u) = spool.as_mut() {
                    if u.remaining != 0 {
                        let n = u.remaining.min(src.len());
                        u.write(&src[..n]).await?;
                        src = &src[n..];
                        if src.is_empty() {
                            break;
                        }
                    }
                    let needed = &b"\r\n"[terminator..];
                    let n = src.len().min(needed.len());
                    anyhow::ensure!(src[..n] == needed[..n], "invalid append terminator");
                    terminator += n;
                    src = &src[n..];
                    if terminator < 2 {
                        break;
                    }
                }
                let was_partial = frame.partial();
                let stream_body = backend.is_some() && matches!(&core,Core::Imap(i) if !i.idling());
                let event = if let Some(u) = spool.take() {
                    terminator = 0;
                    backend.as_mut().context("missing upload owner")?.upload = Some(u);
                    frame.consume_mode(&mut &b"\r\n"[..], true, true, true)?
                } else {
                    frame.consume_mode(
                        &mut src,
                        port.protocol == Protocol::Imap,
                        login.is_some() && !idling,
                        stream_body,
                    )?
                };
                if login.is_some() && !was_partial && frame.partial() {
                    deadline = Instant::now() + IO
                }
                let bytes = match event {
                    Event::AppendBody { len, sync } => {
                        let store = backend.as_mut().context("missing upload owner")?;
                        let permit = admission::Reservation::take(
                            self.uploads.clone(),
                            Some(store.lanes.pools(|s| &s.uploads)),
                            1,
                        )
                        .await;
                        let permitted = permit.is_some()
                            && store
                                .upload_rate
                                .lock()
                                .map_err(|_| anyhow!("limits unavailable"))?
                                .take(Instant::now(), len.div_ceil(1024).max(1) as u64);
                        if !permitted {
                            let mut no = frame.tag().to_vec();
                            no.extend_from_slice(b" NO [LIMIT] Upload capacity busy\r\n");
                            write(&mut stream, &no).await?;
                            frame = Frame::default();
                            if !sync {
                                discard = len + 2;
                                deadline = Instant::now() + IO
                            } else {
                                deadline = Instant::now() + IDLE
                            }
                            continue;
                        }
                        spool = Some(upload::Upload::new(
                            len,
                            permit.context("reservation missing")?,
                        )?);
                        deadline = Instant::now() + Duration::from_secs(180);
                        if sync {
                            write(&mut stream, b"+ Ready for literal\r\n").await?;
                        }
                        continue;
                    }
                    Event::More => break,
                    Event::Continue => {
                        write(&mut stream, b"+ Ready for literal\r\n").await?;
                        continue;
                    }
                    Event::Complete(bytes) => bytes,
                };
                if !matches!(&core,Core::Smtp(s) if s.receiving_data()) {
                    while !commands.take(Instant::now(), 1) {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
                if login.is_none() && Instant::now() >= auth_deadline {
                    return Ok(());
                }
                let verb = bytes
                    .split(|b| b.is_ascii_whitespace())
                    .nth(1)
                    .unwrap_or_default();
                let _response = if login.is_some()
                    && matches!(core, Core::Imap(_))
                    && [b"FETCH".as_slice(), b"UID", b"SEARCH"]
                        .iter()
                        .any(|v| verb.eq_ignore_ascii_case(v))
                {
                    let shares = backend.as_ref().map(|s| s.lanes.pools(|s| &s.responses));
                    let Some(permit) =
                        admission::Reservation::take(self.responses.clone(), shares, 1).await
                    else {
                        let mut no = bytes.split(|b| *b == b' ').next().unwrap_or(b"*").to_vec();
                        no.extend_from_slice(b" NO [LIMIT] Response capacity busy\r\n");
                        write(&mut stream, &no).await?;
                        continue;
                    };
                    Some(permit)
                } else {
                    None
                };
                let mut r = if let Some(identity) = &identity {
                    tokio::task::block_in_place(|| -> Result<Reply> {
                        let now = chrono::Utc::now().fixed_offset();
                        if let Some(store) = backend.as_mut() {
                            store.deadline = std::time::Instant::now() + Duration::from_secs(5);
                            Ok(match &mut core {
                                // Store::imap refreshes a stale snapshot, steps the core and
                                // finishes the command (drops an unclaimed APPEND spool).
                                Core::Imap(i) => store
                                    .imap(i, &bytes, identity, &mut stale, now)
                                    .unwrap_or_else(snapshot_bye),
                                Core::Smtp(s) => {
                                    let reply = s.step(&bytes, identity, store, now);
                                    store.finish_command();
                                    reply
                                }
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
                if matches!(&core,Core::Smtp(s) if s.receiving_data()) {
                    if data_permit.is_none() {
                        let shares = backend.as_ref().map(|s| s.lanes.pools(|s| &s.data));
                        let Some(permit) =
                            admission::Reservation::take(self.smtp_data.clone(), shares, 1).await
                        else {
                            if let Core::Smtp(s) = &mut core {
                                s.refuse_data();
                            }
                            write(&mut stream, b"452 4.3.1 Submission capacity busy\r\n").await?;
                            continue;
                        };
                        data_permit = Some(permit);
                    }
                } else {
                    drop(data_permit.take())
                }
                if login.is_none() && Instant::now() >= auth_deadline {
                    return Ok(());
                }
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
                        let sub = self.events.subscribe(&p.inbox);
                        login_generation = sub.1.borrow().auth;
                        anyhow::ensure!(
                            auth.api.current(&p),
                            "authentication changed during login"
                        );
                        feed = Some(sub);
                        backend = Some(remote::Store::new(auth.api.clone(), p)?);
                        slots
                    } else {
                        self.slots.clone()
                    };
                    let shared = backend
                        .as_ref()
                        .map_or_else(|| Some(Vec::new()), |s| s.lanes.session());
                    let Some(permit) = slots.try_acquire_owned().ok().zip(shared) else {
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
                    if identity.as_ref().is_some_and(|i| {
                        i.unavailable
                            .swap(false, std::sync::atomic::Ordering::Relaxed)
                    }) {
                        failures -= 1;
                        if matches!(port.protocol, Protocol::Imap) {
                            let tag = r
                                .bytes
                                .split(|b| *b == b' ')
                                .next()
                                .unwrap_or(b"*")
                                .to_vec();
                            r.bytes = tag;
                            r.bytes
                                .extend(b" NO [UNAVAILABLE] Authentication service unavailable\r\n")
                        } else {
                            r = Reply::one("454 4.7.0 Authentication service unavailable");
                        }
                    } else {
                        tracing::info!(reason = "credentials_denied", "login refused");
                    }
                    tokio::time::sleep_until(
                        auth_deadline.min(Instant::now() + Duration::from_secs(1)),
                    )
                    .await;
                }
                if login.is_none() {
                    timeout_at(auth_deadline, write(&mut stream, &r.bytes)).await??;
                } else {
                    write(&mut stream, &r.bytes).await?;
                }
                if failures >= 3 || r.action == Action::Close {
                    timeout(IO, stream.shutdown()).await??;
                    return Ok(());
                }
                if r.action == Action::Upgrade {
                    if !src.is_empty() {
                        return Ok(());
                    }
                    stream = self
                        .accept_tls(
                            stream,
                            auth_deadline,
                            &slot.as_ref().context("missing preauth slot")?.tls,
                        )
                        .await?;
                    core = Core::new(port.protocol, true);
                }
                deadline = if data_permit.is_some() {
                    Instant::now() + IO
                } else if login.is_some() {
                    Instant::now() + IDLE
                } else {
                    auth_deadline.min(Instant::now() + PREAUTH_IDLE)
                };
            }
        }
        Ok(())
    }
}
fn snapshot_bye(e: mailgw_core::store::Error) -> Reply {
    Reply {
        action: Action::Close,
        ..Reply::one(&format!("* BYE {e}"))
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
fn tls_materials(
    cert: impl Read,
    key: impl Read,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
    Ok((
        CertificateDer::pem_reader_iter(cert).collect::<Result<_, _>>()?,
        PrivateKeyDer::from_pem_reader(key).context("No TLS private key")?,
    ))
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
    let (cert, key) = tls_materials(
        pem("MAILGW_CERT_PEM", "MAILGW_CERT")?,
        pem("MAILGW_KEY_PEM", "MAILGW_KEY")?,
    )?;
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
        .with_single_cert(cert, key)?;
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
    if let Some(api) = &api {
        use std::sync::atomic::Ordering::Relaxed;
        let open = &api.tenant_sessions;
        open.store(
            setting("MAILGW_TENANT_SESSIONS", open.load(Relaxed))?,
            Relaxed,
        );
    }
    let gw = Arc::new(Gateway {
        api: api.clone(),
        events: Arc::default(),
        stop: watch::channel(false).0,
        sockets: Arc::new(Semaphore::new(1024)),
        uploads: Arc::new(Semaphore::new(8)),
        smtp_data: Arc::new(Semaphore::new(4)),
        responses: Arc::new(Semaphore::new(6)),
        handshakes: Semaphore::new(32),
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
        preauth: Duration::from_secs(setting("MAILGW_AUTH_SECONDS", 15u64)?.min(20)),
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
                    api.online
                        .store(false, std::sync::atomic::Ordering::Release);
                    tracing::warn!("protocol notification connection unavailable");
                    api.invalidate(None);
                    events.publish(None, true);
                    tokio::time::sleep(Duration::from_secs(1)).await
                }
            }
        });
        timeout(IO, rx.wait_for(|up| *up)).await??;
        let health = TcpListener::bind((bind, setting("MAILGW_HEALTH_PORT", 8080)?)).await?;
        let healthy = rx.clone();
        listeners.spawn(health_listener(health, healthy, gw.stop.subscribe()));
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
        let mut stop = gw.stop.subscribe();
        listeners.spawn(async move {
            let mut connections=JoinSet::new();
            loop {tokio::select! {
                biased;
                _=stop.changed()=>break,
                Some(result)=connections.join_next()=>if result.is_err(){tracing::warn!("isolated connection task failed")},
                c=l.accept()=>{
                    let (tcp,peer)=match c{Ok(v)=>v,Err(e)=>{tracing::warn!(kind=?e.kind(),"accept deferred");tokio::time::sleep(Duration::from_millis(100)).await;continue}};
                    if let Ok(permit)=gw.sockets.clone().try_acquire_owned() && let Some(slot)=Slot::take(gw.limits.clone(),peer.ip(),Instant::now()) {
                        let g=gw.clone();
                        connections.spawn(async move {let _permit=permit;if g.serve(tcp,Port{protocol,implicit},peer.ip(),slot).await.is_err(){tracing::debug!("connection ended before logout")}});
                    }
                }
            }}
            drop(l);
            while let Some(result)=connections.join_next().await {if result.is_err(){tracing::warn!("connection task failed while draining")}}
            Ok(())
        });
    }
    println!("READY");
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {_=tokio::signal::ctrl_c()=>(),_=term.recv()=>(),Some(res)=listeners.join_next()=>res??}
    gw.stop.send_replace(true);
    let _drain = timeout(Duration::from_secs(105), async {
        let mut ports = 0;
        while let Some(result) = listeners.join_next().await {
            result??;
            ports += 1;
            if ports == 4 + usize::from(gw.api.is_some()) {
                break;
            }
        }
        Ok::<(), anyhow::Error>(())
    })
    .await;
    Ok(())
}
async fn next_hint(rx: &mut watch::Receiver<hints::Generation>) -> Result<hints::Generation> {
    rx.changed().await?;
    Ok(*rx.borrow_and_update())
}

async fn health_listener(
    l: TcpListener,
    ready: watch::Receiver<bool>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _=stop.changed()=>return Ok(()),
            Some(res)=tasks.join_next()=>if res.is_err(){tracing::warn!("health task failed")},
            v=l.accept()=>{
                let Ok((mut s,_))=v else{tokio::time::sleep(Duration::from_millis(100)).await;continue};
                if tasks.len()<32 {
                    let ready=ready.clone();
                    tasks.spawn(async move {let _result=timeout(Duration::from_secs(2),async{
                        let mut line=Vec::new();
                        while line.len()<128 {let b=s.read_u8().await?;line.push(b);if b==b'\n'{break}}
                        let status=match line.as_slice(){b"GET /health HTTP/1.1\r\n"|b"GET /health HTTP/1.0\r\n"=>if *ready.borrow(){"200 OK"}else{"503 Service Unavailable"},_=>"404 Not Found"};
                        s.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await
                    }).await;});
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pem_reader_keeps_certificate_order_and_supported_key_formats() {
        // Small DER stand-ins exercise PEM decoding; the loopback TLS gate validates real keys.
        let chain = b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nBAUG\n-----END CERTIFICATE-----\n";
        for label in ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"] {
            let pem = format!("-----BEGIN {label}-----\nAQID\n-----END {label}-----\n");
            let (certs, key) = tls_materials(&chain[..], pem.as_bytes()).unwrap();
            assert_eq!(certs.len(), 2);
            assert_eq!(certs[0].as_ref(), &[1, 2, 3]);
            assert_eq!(certs[1].as_ref(), &[4, 5, 6]);
            assert_eq!(key.secret_der(), &[1, 2, 3]);
            assert!(matches!(
                (label, key),
                ("PRIVATE KEY", PrivateKeyDer::Pkcs8(_))
                    | ("RSA PRIVATE KEY", PrivateKeyDer::Pkcs1(_))
                    | ("EC PRIVATE KEY", PrivateKeyDer::Sec1(_))
            ));
        }
        let key = b"-----BEGIN PRIVATE KEY-----\nAQID\n-----END PRIVATE KEY-----\n";
        assert!(tls_materials(&chain[..], b"no key".as_slice()).is_err());
        assert!(
            tls_materials(
                b"-----BEGIN CERTIFICATE-----\n!\n-----END CERTIFICATE-----\n".as_slice(),
                &key[..]
            )
            .is_err()
        );
        assert!(
            tls_materials(&chain[..], b"-----BEGIN PRIVATE KEY-----\nAQID".as_slice()).is_err()
        );
    }

    #[tokio::test]
    async fn health_reflects_listener_state() {
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp.local_addr().unwrap();
        let (ready, rx) = watch::channel(false);
        let (stop, shutdown) = watch::channel(false);
        let task = tokio::spawn(health_listener(tcp, rx, shutdown));
        for (online, status) in [(false, "503"), (true, "200"), (false, "503")] {
            ready.send_replace(online);
            let mut s = TcpStream::connect(addr).await.unwrap();
            s.write_all(b"GET /health HTTP/1.1\r\n").await.unwrap();
            let mut response = String::new();
            s.read_to_string(&mut response).await.unwrap();
            assert!(response.starts_with(&format!("HTTP/1.1 {status}")));
        }
        stop.send_replace(true);
        task.await.unwrap().unwrap();
    }
}
