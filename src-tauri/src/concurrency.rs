//! Small std-only concurrency primitives for the protocol handlers: a fixed
//! worker pool (no thread per request), per-key single-flight (concurrent
//! cache misses wait for ONE render), and a counting semaphore.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};

type Job = Box<dyn FnOnce() + Send + 'static>;

/// Fixed-size pool fed by a channel. Jobs queue when every worker is busy.
pub struct WorkerPool {
    tx: mpsc::Sender<Job>,
}

impl WorkerPool {
    pub fn new(name: &str, workers: usize) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..workers.max(1) {
            let rx = rx.clone();
            std::thread::Builder::new()
                .name(format!("{name}-{i}"))
                .spawn(move || loop {
                    // Hold the lock only while dequeuing, never while running.
                    let job = match rx.lock() {
                        Ok(guard) => guard.recv(),
                        Err(_) => return,
                    };
                    match job {
                        // A panicking job must not take the worker down.
                        Ok(job) => {
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                        }
                        Err(_) => return, // pool dropped
                    }
                })
                .expect("spawn pool worker");
        }
        WorkerPool { tx }
    }

    pub fn execute(&self, job: impl FnOnce() + Send + 'static) {
        let _ = self.tx.send(Box::new(job));
    }
}

struct Slot<V> {
    value: Mutex<Option<Option<V>>>,
    ready: Condvar,
}

/// Per-key single-flight: the first caller for a key runs the work, every
/// concurrent caller for the same key blocks and receives a clone of the
/// leader's result. Results are not memoized here — callers keep their own
/// cache and re-check it inside the flight.
pub struct SingleFlight<K, V> {
    inflight: Mutex<HashMap<K, Arc<Slot<V>>>>,
}

impl<K, V> Default for SingleFlight<K, V> {
    fn default() -> Self {
        SingleFlight { inflight: Mutex::new(HashMap::new()) }
    }
}

impl<K: Hash + Eq + Clone, V: Clone> SingleFlight<K, V> {
    pub fn run(&self, key: K, work: impl FnOnce() -> Option<V>) -> Option<V> {
        let (slot, leader) = {
            let mut map = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
            match map.get(&key) {
                Some(s) => (s.clone(), false),
                None => {
                    let s = Arc::new(Slot { value: Mutex::new(None), ready: Condvar::new() });
                    map.insert(key.clone(), s.clone());
                    (s, true)
                }
            }
        };
        if !leader {
            let mut v = slot.value.lock().unwrap_or_else(|e| e.into_inner());
            while v.is_none() {
                v = slot.ready.wait(v).unwrap_or_else(|e| e.into_inner());
            }
            return v.as_ref().and_then(|r| r.clone());
        }
        // Leader. The guard publishes a result (None if `work` panics) and
        // clears the in-flight entry so followers never wait forever.
        struct Publish<'a, K: Hash + Eq, V> {
            owner: &'a Mutex<HashMap<K, Arc<Slot<V>>>>,
            key: Option<K>,
            slot: Arc<Slot<V>>,
            result: Option<Option<V>>,
        }
        impl<K: Hash + Eq, V> Drop for Publish<'_, K, V> {
            fn drop(&mut self) {
                if let Some(k) = self.key.take() {
                    self.owner.lock().unwrap_or_else(|e| e.into_inner()).remove(&k);
                }
                let mut v = self.slot.value.lock().unwrap_or_else(|e| e.into_inner());
                *v = Some(self.result.take().unwrap_or(None));
                self.slot.ready.notify_all();
            }
        }
        let mut publish =
            Publish { owner: &self.inflight, key: Some(key), slot, result: None };
        let out = work();
        publish.result = Some(out.clone());
        drop(publish);
        out
    }

    /// Keys currently being computed (tests/benchmarks).
    pub fn in_flight(&self) -> usize {
        self.inflight.lock().map(|m| m.len()).unwrap_or(0)
    }
}

/// Counting semaphore (bounded concurrency for expensive renders).
pub struct Semaphore {
    permits: Mutex<usize>,
    freed: Condvar,
}

pub struct Permit<'a>(&'a Semaphore);

impl Semaphore {
    pub const fn new(permits: usize) -> Self {
        Semaphore { permits: Mutex::new(permits), freed: Condvar::new() }
    }

    pub fn acquire(&self) -> Permit<'_> {
        let mut p = self.permits.lock().unwrap_or_else(|e| e.into_inner());
        while *p == 0 {
            p = self.freed.wait(p).unwrap_or_else(|e| e.into_inner());
        }
        *p -= 1;
        Permit(self)
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        *self.0.permits.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        self.0.freed.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn single_flight_collapses_concurrent_misses() {
        let sf: Arc<SingleFlight<&'static str, u32>> = Arc::new(SingleFlight::default());
        let renders = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(16));
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let (sf, renders, barrier) = (sf.clone(), renders.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    sf.run("ext:txt", || {
                        renders.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(50));
                        Some(7)
                    })
                })
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), Some(7));
        }
        assert_eq!(renders.load(Ordering::SeqCst), 1, "one render for one key");
        assert_eq!(sf.in_flight(), 0);
    }

    #[test]
    fn single_flight_distinct_keys_run_independently_and_failures_propagate() {
        let sf: SingleFlight<u32, u32> = SingleFlight::default();
        assert_eq!(sf.run(1, || Some(1)), Some(1));
        assert_eq!(sf.run(2, || None), None);
        // Not memoized: a later call re-runs.
        assert_eq!(sf.run(2, || Some(3)), Some(3));
    }

    #[test]
    fn single_flight_leader_panic_releases_followers() {
        let sf: Arc<SingleFlight<u32, u32>> = Arc::new(SingleFlight::default());
        let sf2 = sf.clone();
        let leader = std::thread::spawn(move || {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                sf2.run(9, || {
                    std::thread::sleep(Duration::from_millis(50));
                    panic!("render blew up")
                })
            }));
        });
        std::thread::sleep(Duration::from_millis(10));
        let follower = {
            let sf = sf.clone();
            std::thread::spawn(move || sf.run(9, || Some(1)))
        };
        leader.join().unwrap();
        // Follower either joined the failed flight (None) or ran its own.
        let r = follower.join().unwrap();
        assert!(r.is_none() || r == Some(1));
        assert_eq!(sf.in_flight(), 0);
    }

    #[test]
    fn semaphore_bounds_concurrency() {
        let sem = Arc::new(Semaphore::new(3));
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..12)
            .map(|_| {
                let (sem, live, peak) = (sem.clone(), live.clone(), peak.clone());
                std::thread::spawn(move || {
                    let _p = sem.acquire();
                    let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(10));
                    live.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert!(peak.load(Ordering::SeqCst) <= 3);
    }

    #[test]
    fn pool_runs_jobs_on_bounded_threads() {
        let pool = WorkerPool::new("test-pool", 2);
        let (tx, rx) = mpsc::channel();
        for i in 0..20 {
            let tx = tx.clone();
            pool.execute(move || {
                let _ = tx.send((i, std::thread::current().name().map(str::to_string)));
            });
        }
        let mut names = std::collections::HashSet::new();
        for _ in 0..20 {
            let (_, n) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            names.insert(n.unwrap());
        }
        assert!(names.len() <= 2);
    }
}
