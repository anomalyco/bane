use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;

#[derive(Default)]
pub struct Limits {
    ips: HashMap<IpAddr, u32>,
    failures: HashMap<(IpAddr, u64), Failures>,
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
        self.failures
            .get(&(ip, key))
            .and_then(|f| f.until)
            .is_some_and(|until| until > now)
    }
    pub fn failure(&mut self, ip: IpAddr, key: u64, now: Instant) {
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
        let count = l.ips.entry(ip).or_default();
        if *count >= 20 {
            return None;
        }
        *count += 1;
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
        Some(Self { ip, limits, after })
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        let mut l = self.limits.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(n) = l.ips.get_mut(&self.ip) {
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
