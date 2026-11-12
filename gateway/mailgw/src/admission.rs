use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

pub struct Shares {
    pub reads: Arc<Semaphore>,
    pub responses: Arc<Semaphore>,
    pub data: Arc<Semaphore>,
    pub uploads: Arc<Semaphore>,
    pub views: Arc<Semaphore>,
    /// Open sessions, on the lanes that share them: a workspace and its sponsoring account.
    pub sessions: Option<Arc<Semaphore>>,
}
impl Shares {
    pub fn new(responses: usize, data: usize, uploads: usize, view_mib: usize) -> Self {
        Self {
            reads: Arc::new(Semaphore::new(2)),
            responses: Arc::new(Semaphore::new(responses)),
            data: Arc::new(Semaphore::new(data)),
            uploads: Arc::new(Semaphore::new(uploads)),
            views: Arc::new(Semaphore::new(view_mib * 1024)),
            sessions: None,
        }
    }
    pub fn with_sessions(mut self, open: usize) -> Self {
        self.sessions = Some(Arc::new(Semaphore::new(open)));
        self
    }
}
pub struct Reservation(Vec<OwnedSemaphorePermit>);
#[derive(Clone)]
pub struct Lanes(pub [Arc<Shares>; 4]); // credential, inbox, workspace, account
impl Lanes {
    pub fn pools(&self, f: fn(&Shares) -> &Arc<Semaphore>) -> [Arc<Semaphore>; 4] {
        self.0.each_ref().map(|s| f(s).clone())
    }
    /// A place in every lane that shares open sessions, held until the session ends.
    /// A full lane refuses at once and keeps nothing: a session is not a queue.
    pub fn session(&self) -> Option<Vec<OwnedSemaphorePermit>> {
        self.0
            .iter()
            .filter_map(|s| s.sessions.clone())
            .map(|s| s.try_acquire_owned().ok())
            .collect()
    }
}
impl Reservation {
    /// FIFO within each share; a busy credential waits without holding an inbox or global permit.
    pub async fn take(
        global: Arc<Semaphore>,
        shares: Option<[Arc<Semaphore>; 4]>,
        n: u32,
    ) -> Option<Self> {
        tokio::time::timeout(Duration::from_secs(2), async move {
            let mut permits = Vec::with_capacity(5);
            if let Some(lanes) = shares {
                for pool in lanes {
                    permits.push(pool.acquire_many_owned(n).await.ok()?);
                }
            }
            permits.push(global.acquire_many_owned(n).await.ok()?);
            Some(Self(permits))
        })
        .await
        .ok()
        .flatten()
    }
    pub fn len(&self) -> usize {
        self.0[0].num_permits()
    }
    pub fn merge(&mut self, p: Self) {
        for (a, b) in self.0.iter_mut().zip(p.0) {
            a.merge(b)
        }
    }
    pub fn shrink(&mut self, n: usize) {
        for a in &mut self.0 {
            drop(a.split(n));
        }
    }
}

#[derive(Default)]
pub struct Limits {
    ips: HashMap<IpAddr, (u32, Arc<tokio::sync::Semaphore>)>,
    blocks: HashMap<IpAddr, u32>,
    anonymous: u32,
    failures: HashMap<(IpAddr, u64), Failures>,
    peer_failures: HashMap<IpAddr, VecDeque<Instant>>,
    accepts: HashMap<IpAddr, Bucket>,
}
#[derive(Default)]
struct Failures {
    times: VecDeque<Instant>,
    until: Option<Instant>,
}
const WINDOW: Duration = Duration::from_secs(600);
const LOCKOUT: Duration = Duration::from_secs(900);
impl Limits {
    pub fn success(&mut self, ip: IpAddr, key: u64) {
        self.failures.remove(&(ip, key));
    }
    pub fn blocked(&self, ip: IpAddr, key: u64, now: Instant) -> bool {
        self.peer_failures.get(&ip).is_some_and(|v| {
            v.len() >= 30
                && v.front()
                    .is_some_and(|&t| now - t < Duration::from_secs(60))
        }) || self
            .failures
            .get(&(ip, key))
            .and_then(|f| f.until)
            .is_some_and(|until| until > now)
    }
    pub fn failure(&mut self, ip: IpAddr, key: u64, now: Instant) {
        if self.peer_failures.len() >= 8192 {
            self.peer_failures
                .retain(|_, v| v.back().is_some_and(|&t| now - t < Duration::from_secs(60)));
        }
        if self.peer_failures.len() < 8192 || self.peer_failures.contains_key(&ip) {
            let v = self.peer_failures.entry(ip).or_default();
            v.retain(|&t| now - t < Duration::from_secs(60));
            if v.len() < 30 {
                v.push_back(now);
            }
        }
        self.failures.retain(|_, f| {
            f.until.is_some_and(|u| u > now) || f.times.back().is_some_and(|&t| now - t < WINDOW)
        });
        if self.failures.len() >= 8192 && !self.failures.contains_key(&(ip, key)) {
            return;
        }
        let f = self.failures.entry((ip, key)).or_default();
        f.times.retain(|&t| now - t < WINDOW);
        f.times.push_back(now);
        if f.times.len() >= 20 {
            f.until = Some(now + LOCKOUT);
            f.times.clear();
        }
    }
}
/// Milli-token fixed point; denied attempts do not move the next refill later.
pub struct Bucket {
    credit: u64,
    cap: u64,
    rate: u64,
    last: Instant,
}
impl Bucket {
    pub fn new(now: Instant, burst: u64, rate: u64) -> Self {
        Self {
            credit: burst * 1000,
            cap: burst * 1000,
            rate,
            last: now,
        }
    }
    pub fn take(&mut self, now: Instant, cost: u64) -> bool {
        let ms = now
            .duration_since(self.last)
            .as_millis()
            .min(u64::MAX as u128) as u64;
        if ms > 0 {
            self.credit = self
                .cap
                .min(self.credit.saturating_add(ms.saturating_mul(self.rate)));
            self.last = now;
        }
        if self.credit < cost * 1000 {
            return false;
        }
        self.credit -= cost * 1000;
        true
    }
}
const ANONYMOUS: u32 = 128;
const PER_SUBNET: u32 = 16; // Six busy networks still leave a quarter of the task available.
pub struct Slot {
    pub accepted: Instant,
    pub after: Instant,
    pub tls: Arc<tokio::sync::Semaphore>,
    ip: IpAddr,
    limits: Arc<Mutex<Limits>>,
}
impl Slot {
    pub fn take(limits: Arc<Mutex<Limits>>, ip: IpAddr, now: Instant) -> Option<Self> {
        let ip = ip.to_canonical();
        let block = network_block(ip);
        let mut l = limits.lock().ok()?;
        if !l.accepts.contains_key(&ip) && l.accepts.len() >= 8192 {
            l.accepts
                .retain(|_, b| now.saturating_duration_since(b.last) < Duration::from_secs(60));
            if l.accepts.len() >= 8192 {
                return None;
            }
        }
        if l.anonymous >= ANONYMOUS || l.blocks.get(&block).copied().unwrap_or(0) >= PER_SUBNET {
            return None;
        }
        let (count, tls) = l
            .ips
            .entry(ip)
            .or_insert_with(|| (0, Arc::new(tokio::sync::Semaphore::new(4))));
        if *count >= 8 {
            return None;
        }
        *count += 1;
        let tls = tls.clone();
        l.anonymous += 1;
        *l.blocks.entry(block).or_default() += 1;
        let b = l
            .accepts
            .entry(ip)
            .or_insert_with(|| Bucket::new(now, 32, 10));
        let after = if b.take(now, 1) {
            now
        } else {
            let at = b.last.max(now)
                + Duration::from_millis((1000 - b.credit.min(1000)).div_ceil(b.rate));
            b.credit = 0;
            b.last = at;
            at
        };
        drop(l);
        Some(Self {
            ip,
            limits,
            after,
            accepted: now,
            tls,
        })
    }
}
fn network_block(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(a) => IpAddr::V4((u32::from(a) & (u32::MAX << 8)).into()),
        IpAddr::V6(a) => IpAddr::V6((u128::from(a) & (u128::MAX << 80)).into()),
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        let mut l = self.limits.lock().unwrap_or_else(|p| p.into_inner());
        l.anonymous -= 1;
        let block = network_block(self.ip);
        if let Some(n) = l.blocks.get_mut(&block) {
            *n -= 1;
            if *n == 0 {
                l.blocks.remove(&block);
            }
        }
        if let Some((n, _)) = l.ips.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                l.ips.remove(&self.ip);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn anonymous_slots_are_scoped_and_returned_for_both_address_families() {
        for (peers, other) in [
            (
                ["192.0.2.1", "::ffff:192.0.2.2", "192.0.2.3", "192.0.2.4"],
                "192.0.3.1",
            ),
            (
                [
                    "2001:db8:1::1",
                    "2001:db8:1:2::2",
                    "2001:db8:1:3::3",
                    "2001:db8:1:4::4",
                ],
                "2001:db8:2::1",
            ),
        ] {
            let limits = Arc::new(Mutex::new(Limits::default()));
            let take = |ip: &str| Slot::take(limits.clone(), ip.parse().unwrap(), Instant::now());
            let mut held = Vec::new();
            for ip in &peers[..2] {
                for _ in 0..8 {
                    held.push(take(ip).unwrap());
                }
                assert!(take(ip).is_none());
            }
            assert!(take(peers[3]).is_none());
            assert!(take(other).is_some());
            held.clear();
            assert!(limits.lock().unwrap().blocks.is_empty());
            assert!(take(peers[3]).is_some());
        }
    }
    #[tokio::test]
    async fn a_waiting_share_never_reserves_another_tenants_capacity() {
        use futures_util::FutureExt;
        let global = Arc::new(Semaphore::new(2));
        let inbox = Arc::new(Semaphore::new(1));
        let one = Arc::new(Semaphore::new(1));
        let workspace = Arc::new(Semaphore::new(1));
        let account = Arc::new(Semaphore::new(1));
        let held = Reservation::take(
            global.clone(),
            Some([
                one.clone(),
                inbox.clone(),
                workspace.clone(),
                account.clone(),
            ]),
            1,
        )
        .await
        .unwrap();
        let sibling = Arc::new(Semaphore::new(1));
        let mut waiting = Box::pin(Reservation::take(
            global.clone(),
            Some([sibling, inbox, workspace, account]),
            1,
        ));
        assert!(waiting.as_mut().now_or_never().is_none());
        assert_eq!(global.available_permits(), 1);
        let other = Reservation::take(
            global.clone(),
            Some(std::array::from_fn(|_| Arc::new(Semaphore::new(1)))),
            1,
        )
        .await
        .unwrap();
        drop(held);
        assert!(waiting.await.is_some());
        drop(other);
        assert_eq!(global.available_permits(), 2);
    }
    #[test]
    fn peer_failure_window_is_shared_across_names_not_peers() {
        let mut a = Limits::default();
        let ip = "127.0.0.1".parse().unwrap();
        let t = Instant::now();
        for k in 0..30 {
            a.failure(ip, k, t);
        }
        assert!(a.blocked(ip, 31, t));
        assert!(!a.blocked("127.0.0.2".parse().unwrap(), 31, t));
        assert!(!a.blocked(ip, 31, t + Duration::from_secs(60)));
    }
    #[test]
    fn peer_handshake_share_is_distinct_from_other_peers_and_global_slots() {
        let limits = Arc::new(Mutex::new(Limits::default()));
        let t = Instant::now();
        let ip = "127.0.0.1".parse().unwrap();
        let a = Slot::take(limits.clone(), ip, t).unwrap();
        let b = Slot::take(limits.clone(), ip, t).unwrap();
        let _held = a.tls.try_acquire_many(4).unwrap();
        assert!(b.tls.try_acquire().is_err());
        let other = Slot::take(limits, "127.0.0.2".parse().unwrap(), t).unwrap();
        assert!(other.tls.try_acquire().is_ok());
    }
    #[test]
    fn lockout_expires_without_extending_on_probe() {
        let mut a = Limits::default();
        let ip = "127.0.0.1".parse().unwrap();
        let t = Instant::now();
        for _ in 0..19 {
            a.failure(ip, 7, t)
        }
        assert!(!a.blocked(ip, 7, t));
        a.failure(ip, 7, t);
        assert!(a.blocked(ip, 7, t + LOCKOUT - Duration::from_millis(1)));
        assert!(!a.blocked(ip, 7, t + LOCKOUT));
        assert!(!a.blocked(ip, 8, t));
        a.success(ip, 7);
        assert!(!a.blocked(ip, 7, t));
    }
    #[test]
    fn accept_burst_and_refill_are_scoped_to_peer() {
        let limits = Arc::new(Mutex::new(Limits::default()));
        let t = Instant::now();
        let ip = "127.0.0.1".parse().unwrap();
        for _ in 0..32 {
            assert_eq!(Slot::take(limits.clone(), ip, t).unwrap().after, t);
        }
        assert_eq!(
            Slot::take(limits.clone(), ip, t).unwrap().after,
            t + Duration::from_millis(100)
        );
        assert_eq!(
            Slot::take(limits, "127.0.0.2".parse().unwrap(), t)
                .unwrap()
                .after,
            t
        );
    }
}
