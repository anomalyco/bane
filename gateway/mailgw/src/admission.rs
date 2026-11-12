use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

pub struct Shares {
    pub responses: Arc<Semaphore>,
    pub data: Arc<Semaphore>,
    pub uploads: Arc<Semaphore>,
    pub views: Arc<Semaphore>,
}
impl Shares {
    pub fn new(responses: usize, data: usize, uploads: usize, view_mib: usize) -> Self {
        Self {
            responses: Arc::new(Semaphore::new(responses)),
            data: Arc::new(Semaphore::new(data)),
            uploads: Arc::new(Semaphore::new(uploads)),
            views: Arc::new(Semaphore::new(view_mib * 1024)),
        }
    }
}
pub struct Reservation(Vec<OwnedSemaphorePermit>);
impl Reservation {
    /// FIFO within each share; a busy credential waits without holding an inbox or global permit.
    pub async fn take(
        global: Arc<Semaphore>,
        shares: Option<(Arc<Semaphore>, Arc<Semaphore>)>,
        n: u32,
    ) -> Option<Self> {
        tokio::time::timeout(Duration::from_secs(2), async move {
            let mut permits = Vec::with_capacity(3);
            if let Some((credential, inbox)) = shares {
                for pool in [credential, inbox] {
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
pub struct Slot {
    pub after: Instant,
    pub tls: Arc<tokio::sync::Semaphore>,
    ip: IpAddr,
    limits: Arc<Mutex<Limits>>,
}
impl Slot {
    pub fn take(limits: Arc<Mutex<Limits>>, ip: IpAddr, now: Instant) -> Option<Self> {
        let mut l = limits.lock().ok()?;
        if !l.accepts.contains_key(&ip) && l.accepts.len() >= 8192 {
            l.accepts
                .retain(|_, b| now.saturating_duration_since(b.last) < Duration::from_secs(60));
            if l.accepts.len() >= 8192 {
                return None;
            }
        }
        if l.anonymous >= 128 {
            return None;
        }
        let (count, tls) = l
            .ips
            .entry(ip)
            .or_insert_with(|| (0, Arc::new(tokio::sync::Semaphore::new(4))));
        if *count >= 20 {
            return None;
        }
        *count += 1;
        let tls = tls.clone();
        l.anonymous += 1;
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
            tls,
        })
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        let mut l = self.limits.lock().unwrap_or_else(|p| p.into_inner());
        l.anonymous -= 1;
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
