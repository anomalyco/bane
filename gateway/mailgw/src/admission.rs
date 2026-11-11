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
    failures: HashMap<IpAddr, Failures>,
}
#[derive(Default)]
struct Failures {
    times: VecDeque<Instant>,
    until: Option<Instant>,
}
const WINDOW: Duration = Duration::from_secs(600);
const LOCKOUT: Duration = Duration::from_secs(900);
impl Limits {
    pub fn blocked(&self, ip: IpAddr, now: Instant) -> bool {
        self.failures
            .get(&ip)
            .and_then(|f| f.until)
            .is_some_and(|until| until > now)
    }
    pub fn failure(&mut self, ip: IpAddr, now: Instant) {
        self.failures.retain(|_, f| {
            f.until.is_some_and(|u| u > now) || f.times.back().is_some_and(|&t| now - t < WINDOW)
        });
        let f = self.failures.entry(ip).or_default();
        f.times.retain(|&t| now - t < WINDOW);
        f.times.push_back(now);
        if f.times.len() >= 20 {
            f.until = Some(now + LOCKOUT);
            f.times.clear();
        }
    }
}
pub struct Slot {
    ip: IpAddr,
    limits: Arc<Mutex<Limits>>,
}
impl Slot {
    pub fn take(limits: Arc<Mutex<Limits>>, ip: IpAddr, now: Instant) -> Option<Self> {
        let mut l = limits.lock().ok()?;
        if l.blocked(ip, now) {
            return None;
        }
        let count = l.ips.entry(ip).or_default();
        if *count >= 20 {
            return None;
        }
        *count += 1;
        drop(l);
        Some(Self { ip, limits })
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
            a.failure(ip, t)
        }
        assert!(!a.blocked(ip, t));
        a.failure(ip, t);
        assert!(a.blocked(ip, t + LOCKOUT - Duration::from_millis(1)));
        assert!(!a.blocked(ip, t + LOCKOUT));
    }
}
