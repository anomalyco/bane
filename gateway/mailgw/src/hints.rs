use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::watch;

/// One coalescing mailbox per active inbox, not a queue of other tenants' events.
/// Auth changes are sticky across intervening mail notifications.
#[derive(Clone, Copy, Default)]
pub struct Generation {
    pub auth: u64,
    pub mail: u64,
}
type Sender = watch::Sender<Generation>;
#[derive(Default)]
pub struct Hints(Mutex<HashMap<String, Weak<Sender>>>);
impl Hints {
    pub fn subscribe(&self, inbox: &str) -> (Arc<Sender>, watch::Receiver<Generation>) {
        let mut m = self.0.lock().unwrap_or_else(|p| p.into_inner());
        m.retain(|_, w| w.strong_count() > 0);
        let s = m
            .get(inbox)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(watch::channel(Generation::default()).0));
        m.insert(inbox.to_owned(), Arc::downgrade(&s));
        let rx = s.subscribe();
        (s, rx)
    }
    pub fn publish(&self, inbox: Option<&str>, auth: bool) {
        let m = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let notify = |s: Arc<Sender>| {
            s.send_modify(|g| {
                if auth {
                    g.auth = g.auth.wrapping_add(1)
                } else {
                    g.mail = g.mail.wrapping_add(1)
                }
            })
        };
        match inbox {
            Some(id) => {
                if let Some(s) = m.get(id).and_then(Weak::upgrade) {
                    notify(s)
                }
            }
            None => m.values().filter_map(Weak::upgrade).for_each(notify),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hints_are_scoped_and_revocation_survives_coalescing() {
        let h = Hints::default();
        let (_a, mut a) = h.subscribe("a");
        let (_b, b) = h.subscribe("b");
        h.publish(Some("a"), true);
        for _ in 0..300 {
            h.publish(Some("a"), false)
        }
        assert!(!b.has_changed().unwrap());
        assert_eq!(a.borrow_and_update().auth, 1);
    }
}
