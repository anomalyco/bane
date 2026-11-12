//! tear model check of admission and rate limits on the API and PostgreSQL: the reference model
//! (`model.rs`) predicts every step, the Bun host (`host.ts`) runs it on the real code over an
//! isolated database, and tear's conformance runner diffs the two.
//!
//!   cargo run --release -- ci                                  PR-sized run, exits 1 on any mismatch
//!   cargo run --release -- random [N] [LEN] [--profile recv|send|upload] [--cfg I] [--seed S] [--budget SECS]
//!   cargo run --release -- edges [DEPTH] [MAX_STATES] [--profile recv|send|upload] [--cfg I] [--budget SECS]
//!   cargo run --release -- boundaries                          bug witnesses and boundary traces only
//!   cargo run --release -- space [DEPTH] [--profile P]         graph size per depth (no database)
//!   cargo run --release -- trace [--profile P] [--cfg I] ACTION...
//!
//! Run from `api/tear/admission` with TEAR_DATABASE_URL set to a plain loopback URL of a
//! dedicated, migrated PostgreSQL database marked disposable (`../disposable.ts`).
//!
//! # Edge-case checklist
//!
//! Every item names the actions that reach it. W, V (and X on the receive side) hold their
//! statement's transaction open until a separate `commit` or `abort`; unprefixed actions are
//! autocommit requests. `coverage` in every report counts the traces that reached each item; [-]
//! items say why they are out of reach.
//!
//! ## Receive side: the hourly window and the ingest backlog (profile recv)
//! Two hosted workspaces A < B; recipients a and c (and h, x) are A's, b is B's, so `ab` is one
//! SNS message creating receipts in both, handled in workspace order.
//! - [x] r.dup-race: two notifications of the same new message in flight (`W accept m1 a`,
//!   `V accept m1 a`, `W commit`): the second waits on the window row, then finds the receipt
//!   and charges nothing. r.dup-race-abort: the first aborts, the second charges once.
//! - [x] r.reopen-race: a reopen (new recipients) of a message whose first notification is in flight.
//! - [x] r.new-race: two different new messages in flight serialize on the window row; the second
//!   sees the first's charge and its ingest job (backlog) after the commit.
//! - [x] r.multi: one message for both workspaces; r.release-race: the global release completes
//!   while a multi-workspace notification waits (`W accept m3 a`, `V accept m3 ab`, `X release`):
//!   the release skips the workspace whose rows are locked instead of waiting (it used to hold B's
//!   window while waiting on A's: a deadlock).
//! - [x] r.dup: SNS redelivery after commit (`accept m1 a` twice); r.reopen: added recipients
//!   re-queue a processed receipt without charging; r.reopen-held / r.reopen-failed: a budget hold
//!   stays held, a failed receipt is not reopened.
//! - [x] r.coalesce: a reopen while the receipt's ingest job is pending adds no job (the job reads
//!   the merged recipients when claimed); r.reopen-running: a reopen while the job runs is held
//!   (MAILBOX_RECEIVE_BACKLOG) until that job ends, since its claim lacks the new recipients;
//!   r.reopen-backlog: a receipt is held for the backlog; r.release-backlog: a later release admits
//!   it without charging the window again; r.stale-claim: the running job finds its claim stale and
//!   settles nothing, so no recipient is lost.
//! - [x] r.legacy-reopen: the previous Worker's route statement (`legacy-accept`, its reopen bound
//!   counted duplicates) reopens with the same result during old/new Worker overlap.
//! - [x] r.limit-exact / r.limit-over: the window reaches exactly `limit`, the next new message is
//!   held; r.limit-zero: limit 0 holds every message (cfg 3).
//! - [x] r.backlog-full: `backlog` active ingest jobs hold the next message; r.backlog-race: the
//!   job that fills it is committed while the next notification waits.
//! - [x] r.hour: the window resets in the next hour (`hour`).
//! - [x] r.release / r.release-again: a due budget hold is released into a later window, or stays
//!   held for another hour; r.release-expired / r.release-boundary: 71 hours old is released, 72 fails
//!   (`days` is 70 hours, then one or two `hour`); r.release-skip: a hold another transaction holds
//!   is skipped (SKIP LOCKED).
//! - [x] r.huge: 101 recipients fail the budget, exactly 100 are accepted (`x`, `h`); r.empty: no
//!   recipients routes nothing (`0`).
//! - [x] r.abort: a statement rolled back (crash before commit) charges nothing.
//!
//! Every ingest job enters through one insert check (mail_ingest_admit): one active job per
//! receipt, and at most `backlog` active jobs per workspace, whoever inserts it.
//! - [x] r.drain: a job's end (`done`, `fail`, `lose`) admits the workspace's backlog holds in
//!   queue order. r.stale-fail: a stale failure write finds the receipt held for its reopen and
//!   changes nothing. r.claim-race: a claim skips a job another statement holds locked.
//! - [x] r.recover / r.recover-full / r.recover-exhausted: lost-receipt recovery (`recover`)
//!   re-queues a pending receipt with no job, holds it when the backlog is full, and fails it
//!   after three passes.
//! - [x] r.replay / r.replay-race: held envelopes for an unrouted host (`stash`) replay through
//!   the same route statement, also while a normal reopen of the message is in flight; both take
//!   the window row before the receipt.
//! - [x] r.release-fair: a release that finds a workspace's rows locked moves the hold ten seconds
//!   back instead of retrying it first on every pass.
//!
//! ## Send side: hosted admission (profile send)
//! - [x] s.cap-exact / s.cap-over / s.cap-exceeds: the rolling 24-hour recipient cap reached
//!   exactly, by one more, and by a single request above the whole cap (`send K 3 t`).
//! - [x] s.marketing: marketing stops at the reserve while transactional mail still fits.
//! - [x] s.race-ws / s.race-sponsor / s.race-key: two admissions in flight on one workspace (keys
//!   1 and 3), on sibling workspaces sharing a sponsor (keys 1 and 2), and on one key; s.race-slot:
//!   the waiter sees the winner's charge and is refused at the last slot.
//! - [x] s.abort: an admission rolled back charges nothing; s.refund: suppressed, canceled and
//!   pre-SES rejected mail refunds exactly its admission hour, sent mail stays charged;
//!   s.refund-late: a refund after that hour left the window changes nothing.
//! - [x] s.window: usage still counts 23 hours later and expires at 24 (`h23`, `hour`).
//! - [x] s.idem-replay / s.idem-conflict / s.idem-race / s.idem-race-abort / s.idem-retry: a keyed
//!   retry replays without a second charge, a different body conflicts, a concurrent duplicate
//!   waits and replays (or admits after an abort), and a denied claim can be retried.
//! - [x] s.rate-exact / s.rate-minute: request `rate` is served and `rate + 1` refused, then the next
//!   minute resets the key's budget; GET /v1/me shares it (`me 1`).
//! - [x] s.pause / s.pause-race: a paused workspace is refused and admits after a resume; a pause
//!   racing an in-flight admission is ordered by the policy row lock.
//! - [x] s.override / s.override-race / s.override-solo: send_cap_override raises or lowers the cap,
//!   an operator change racing an admission applies to the one after it, and an override leaves
//!   the sponsor's shared usage. s.pending-cap: pending_cap_override reached exactly and by one.
//!   s.exempt: an exempt workspace has no recipient cap and leaves the sponsor.
//! - [x] s.tier: probation (first week), second-week and mature caps from clean history and age
//!   (`history`, `week`); s.tier-resume: a resume starts a new health epoch and drops the tier.
//! - [x] s.me: GET /v1/me shows the cap and usage admission charges against.
//! - [x] s.one-statement: every admission, refusal and replay is one database round trip
//!   (checked on every step, `statements` in each result).
//!
//! ## Stored-attachment quota reservations (profile upload)
//! Slots U1-U3 upload through POST /v1/attachments; the host's storage adapter suspends each R2
//! put until `Ux ok` or `Ux fail`, so steps land between reserve, put and finish.
//! - [x] u.quota-exact / u.quota-over: the quota filled exactly by reservations, then refused.
//! - [x] u.race: two uploads reserved and in flight at once.
//! - [x] u.idem-replay / u.idem-race / u.idem-conflict: a keyed retry after the first finished
//!   replays without a reservation; two attempts with one key in flight both reserve, the later
//!   one replays and refunds; a different body under the key conflicts and refunds.
//! - [x] u.fail: a failed R2 put refunds the reservation and queues the object's deletion.
//! - [x] u.expire / u.expire-late-put / u.expired-unswept: a reservation expires during the put and
//!   the sweeper takes it (UPLOAD_EXPIRED), also after its deletion job already ran; an expired but
//!   unswept reservation still finishes.
//! - [x] u.delete: deleting an attachment frees its quota and queues its object's deletion.
//! - [x] u.crash / u.tombstone: the put lands and the Worker dies before finish or refund (also
//!   what an older Worker's refund amounts to); the tombstone left by the reservation's end queues
//!   the object's deletion a day later (`day` runs the hourly cleanup) unless an attachment
//!   holds it. u.reconcile: an object no record owns (its put landed after the tombstone was
//!   spent) is found by listing storage and deleted once it is a day old.
//!
//! ## Out of reach, and why
//! - [-] Clock skew and boundaries inside a transaction: admission uses the transaction's now(),
//!   and the host moves time only between transactions by shifting stored timestamps.
//! - [-] Old and new Worker overlap is reached where a Worker-side change matters: `legacy-accept`
//!   runs the previous route statement, and `crash` stands in for the previous upload refund. The
//!   admission and release checks themselves are database functions and triggers.
//! - [-] SES and webhook failures: admission makes no external call (R2 put failures: u.fail). The
//!   receive byte reservation runs inside the ingest job after its S3 HEAD and is not driven here.
//! - [-] Lost ingest jobs (recoverMailReceipts) and the real job claim: `claim` and `done` are
//!   fixture steps with the store's settle fence.
//! - [-] Monthly caps: there are none; the hosted cap is a rolling 24 hours of UTC hour buckets.
//! - [-] The per-minute dispatch burst cap, the SES 24-hour quota and BYO limits: dispatch area.
//! - [-] Key revocation racing an admission, and grants: access area.
//!
//! # Properties (every step)
//! - Every result (status, error code, email labels, statements) and the committed view (receive
//!   window, receipts, backlog and jobs; hourly usage, mails, key budgets, pending depth,
//!   idempotency rows) equals the model's.
//! - Host safety, independent of the model: the window never exceeds its limit; the backlog
//!   counter equals its jobs and never exceeds the backlog, with at most one pending ingest job
//!   per receipt; live usage equals the recipients of the still-charged mail admitted in the
//!   window (refunds exact, nothing charged twice); stored-attachment usage equals its
//!   reservations plus attachments and never exceeds the quota; every stored object has an
//!   attachment, a reservation, a pending deletion or a tombstone.
mod fixture;
mod model;

use fixture::Host;
use model::{Model, Recv, Send, Upload, alphabet, split};
use serde_json::{Value, json};
use statecheck::{Error, Host as TearHost, R, conformance, search};
use std::{collections::BTreeMap, time::Instant};

const PROPERTY: &str = "bane.admission";

/// Trace configurations per profile.
fn cfgs(profile: &str) -> Vec<Value> {
    if profile == "upload" {
        return vec![json!({"room": 2}), json!({"room": 1})];
    }
    if profile == "recv" {
        // Per-workspace [message limit, backlog] for A and B.
        vec![
            json!({"limits": [[2, 2], [2, 2]]}),
            json!({"limits": [[1, 5], [5, 1]]}),
            json!({"limits": [[3, 1], [3, 1]]}),
            json!({"limits": [[0, 5], [1, 1]]}),
        ]
    } else {
        vec![
            json!({"caps": [2, 3, 5], "headroom": 50, "rate": 4}),
            json!({"caps": [1, 2, 4], "headroom": 0, "rate": 2}),
        ]
    }
}
fn initial(profile: &str, cfg: &Value) -> Model {
    let n = |k: &str| cfg[k].as_i64().unwrap_or(0);
    if profile == "upload" {
        return Model::Upload(Upload::initial(n("room")));
    }
    if profile == "recv" {
        let l = |i: usize, j: usize| cfg["limits"][i][j].as_i64().unwrap_or(0);
        Model::Recv(Recv::initial([(l(0, 0), l(0, 1)), (l(1, 0), l(1, 1))]))
    } else {
        let caps: Vec<i64> = cfg["caps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect();
        Model::Send(Send::initial(
            [caps[0], caps[1], caps[2]],
            n("headroom"),
            n("rate"),
        ))
    }
}

/// Shortest witnesses of the bugs this model found, replayed on every `ci` run: (profile, cfg, actions).
const REGRESSIONS: &[(&str, usize, &[&str])] = &[
    // A. Two notifications of one new message in flight charged the hourly window twice.
    (
        "recv",
        0,
        &["W accept m1 a", "V accept m1 a", "W commit", "V commit"],
    ),
    // A. ... and the second charged for a receipt the first had failed (101 recipients).
    (
        "recv",
        1,
        &["W accept m1 x", "V accept m1 ac", "W commit", "V commit"],
    ),
    // B. A notification waiting on the window row admitted past a full backlog (backlog 1).
    (
        "recv",
        2,
        &["W accept m1 a", "V accept m2 a", "W commit", "V commit"],
    ),
    // B. ... and so did a release pass behind an admission (now it skips the locked workspace).
    (
        "recv",
        2,
        &[
            "accept m1 a",
            "accept m2 a",
            "claim A m1",
            "done A m1",
            "hour",
            "W accept m3 a",
            "V release",
            "W commit",
            "V commit",
        ],
    ),
    // C. A reopen was refused when the old and new recipient lists summed past 200 with duplicates.
    ("recv", 2, &["accept m1 h", "accept m1 x"]),
    // D. A put that outlasted its swept reservation left its object with no owner and no deletion.
    (
        "upload",
        0,
        &["U1 upload", "expire", "sweep", "purge", "U1 ok"],
    ),
    // Review P1. A reopen queued another ingest job past the backlog (2 jobs, backlog 1); one
    // arriving while the job runs is held and released later without a second charge.
    ("recv", 2, &["accept m1 a", "accept m1 ac"]),
    (
        "recv",
        2,
        &[
            "accept m1 a",
            "claim A m1",
            "accept m1 ac",
            "done A m1",
            "hour",
            "release",
            "claim A m1",
            "done A m1",
        ],
    ),
    // Review P2. The global release held B's window row while it waited on A's, behind an
    // admission that then needed B's: a deadlock. It now skips the locked workspace.
    (
        "recv",
        1,
        &[
            "accept m1 b",
            "accept m2 b",
            "hour",
            "accept m1 a",
            "accept m2 a",
            "hour",
            "W accept m3 a",
            "V accept m3 ab",
            "X release",
            "W commit",
            "X commit",
            "V commit",
        ],
    ),
    // Review P2. The previous Worker's route refused 100 known recipients plus one new.
    (
        "recv",
        0,
        &[
            "accept m1 h",
            "claim A m1",
            "done A m1",
            "legacy-accept m1 x",
        ],
    ),
    // Review P2. A late put whose Worker died after the sweep's deletion ran left an orphan; a
    // tombstone now queues its deletion a day later.
    (
        "upload",
        0,
        &[
            "U1 upload",
            "expire",
            "sweep",
            "purge",
            "U1 crash",
            "day",
            "sweep",
            "purge",
        ],
    ),
    // Recheck R1. Lost-receipt recovery queued a job past the backlog (2 active, backlog 1).
    (
        "recv",
        2,
        &[
            "accept m1 a",
            "claim A m1",
            "lose A m1",
            "accept m2 a",
            "recover",
        ],
    ),
    // Recheck R2. A reopen behind a running job queued a second job; the running job's stale
    // failure then failed the reopened receipt. Now the reopen is held and survives the failure.
    (
        "recv",
        0,
        &["accept m1 a", "claim A m1", "accept m1 ac", "fail A m1"],
    ),
    // Recheck R3. The held-envelope replay and a normal reopen locked receipt then window and
    // window then receipt; every route statement now takes the window row first.
    (
        "recv",
        0,
        &["accept m3 a", "W accept m2 a", "X accept m3 ac"],
    ),
    // Recheck R4. A hold in a busy workspace stayed first in line (and uncounted) on every
    // release; it now moves ten seconds back and counts as scanned.
    (
        "recv",
        1,
        &[
            "accept m1 a",
            "accept m2 a",
            "hour",
            "W accept m3 a",
            "release",
        ],
    ),
    // Recheck R5. A put landing after its tombstone was spent left an object no record owned;
    // storage reconciliation deletes it a day later.
    (
        "upload",
        0,
        &[
            "U1 upload",
            "expire",
            "sweep",
            "purge",
            "day",
            "purge",
            "U1 crash",
            "day",
        ],
    ),
];

/// Deterministic traces that reach the rare checklist items exactly at their boundaries.
const BOUNDARIES: &[(&str, usize, &[&str])] = &[
    // Lost-receipt recovery re-queues a receipt whose job ended without settling it, and fails it on
    // the fourth pass.
    (
        "recv",
        0,
        &["accept m1 a", "claim A m1", "lose A m1", "recover"],
    ),
    (
        "recv",
        0,
        &[
            "accept m1 a",
            "claim A m1",
            "lose A m1",
            "recover",
            "claim A m1",
            "lose A m1",
            "recover",
            "claim A m1",
            "lose A m1",
            "recover",
            "claim A m1",
            "lose A m1",
            "recover",
        ],
    ),
    // The next hour's window admits again; a due hold is released at 71 hours and fails at 72.
    (
        "recv",
        1,
        &["accept m1 a", "accept m2 a", "hour", "accept m3 a"],
    ),
    (
        "recv",
        1,
        &["accept m1 a", "accept m2 a", "days", "hour", "release"],
    ),
    (
        "recv",
        1,
        &[
            "accept m1 a",
            "accept m2 a",
            "days",
            "hour",
            "hour",
            "release",
        ],
    ),
    (
        "recv",
        1,
        &[
            "accept m1 a",
            "accept m2 a",
            "hour",
            "accept m3 a",
            "release",
            "hour",
            "release",
        ],
    ),
    (
        "recv",
        0,
        &[
            "accept m1 a",
            "accept m2 a",
            "accept m3 a",
            "hour",
            "W accept m2 ab",
            "release",
            "W commit",
        ],
    ),
    // An operator change in flight keeps the clean history recorded meanwhile (second-week cap 3).
    (
        "send",
        0,
        &[
            "V limits 1 default 1",
            "history 1 900",
            "V commit",
            "week",
            "send 1 3 t",
        ],
    ),
    // Warm-up tiers: probation, second week (100 clean, 7 days) and mature (1,000, 14 days); a
    // resume starts a new health epoch.
    (
        "send",
        0,
        &["history 1 100", "send 1 3 t", "week", "send 1 3 t"],
    ),
    (
        "send",
        0,
        &[
            "history 1 900",
            "history 1 100",
            "week",
            "week",
            "send 1 3 t",
            "send 1 2 t",
            "send 1 1 t",
        ],
    ),
    (
        "send",
        0,
        &["history 1 100", "week", "pause 1", "resume 1", "send 1 3 t"],
    ),
    // The rolling window: 23 hours later still counts, 24 does not; a late refund changes nothing.
    (
        "send",
        0,
        &[
            "send 1 2 t",
            "h23",
            "send 1 1 t",
            "hour",
            "send 1 1 t",
            "outcome e1 canceled",
        ],
    ),
    (
        "send",
        1,
        &["send 1 1 t", "me 1", "send 1 1 t", "minute", "send 1 1 t"],
    ),
    (
        "send",
        0,
        &[
            "limits 1 default 1",
            "send 1 1 t",
            "send 1 1 t",
            "outcome e1 sent",
            "send 1 1 t",
            "batch 1",
        ],
    ),
    (
        "send",
        0,
        &[
            "idem 1 k1",
            "idem 1 k1",
            "idem-other 1 k1",
            "pause 1",
            "idem 1 k1",
        ],
    ),
    (
        "send",
        0,
        &["W idem 1 k1", "V idem 1 k1", "W commit", "V commit"],
    ),
    (
        "send",
        0,
        &["W idem 1 k1", "V idem 1 k1", "W abort", "V commit"],
    ),
    (
        "send",
        0,
        &[
            "send 2 2 t",
            "limits 1 2 default",
            "send 1 2 t",
            "exempt 2 on",
            "send 2 3 t",
        ],
    ),
    (
        "send",
        0,
        &[
            "send 1 1 t",
            "W send 3 1 t",
            "V send 2 1 t",
            "W commit",
            "V commit",
        ],
    ),
    (
        "upload",
        0,
        &[
            "U1 upload k1",
            "U2 upload k1",
            "U1 ok",
            "U2 ok",
            "U3 upload k1",
        ],
    ),
    (
        "upload",
        0,
        &[
            "U1 upload",
            "expire",
            "U1 ok",
            "U2 upload",
            "U2 fail",
            "delete a1",
        ],
    ),
    (
        "upload",
        1,
        &["U1 upload", "U2 upload", "U1 ok", "U2 upload-other k1"],
    ),
];

fn model(v: &Value) -> R<Model> {
    serde_json::from_value(v.clone()).map_err(|e| Error::new(e.to_string()))
}
fn label(v: &Value) -> R<String> {
    v.as_str()
        .map(String::from)
        .ok_or_else(|| Error::new(format!("unknown action {v}")))
}

/// Conformance host: the model predicts each step, the Bun host runs it on the real API.
struct Check {
    profile: String,
    cfg: Value,
    host: Host,
    fixtures: u64,
}
impl TearHost for Check {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        Ok(match name {
            "id" => json!(PROPERTY),
            "initial" => json!(initial(&self.profile, &self.cfg)),
            "enabled" => json!(model(&args[0])?.enabled(&label(&args[1])?)),
            "step" => {
                let mut m = model(&args[0])?;
                let (r, woke) = m.step(&label(&args[1])?);
                json!({"expected": {"r": r, "woke": woke, "view": m.view(), "safety": []}, "state": m})
            }
            "open" => {
                self.host.reset(&self.profile, &self.cfg)?;
                self.fixtures += 1;
                Value::Null
            }
            "act" => self.host.act(args[1].as_str().unwrap_or_default())?,
            "close" => Value::Null,
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

/// Model-only host for tear's breadth-first state mapping.
struct Space {
    labels: Vec<String>,
}
impl TearHost for Space {
    fn call(&mut self, name: &str, args: Value) -> R<Value> {
        let mut m = model(&args[0])?;
        Ok(match name {
            "actions" => json!(
                self.labels
                    .iter()
                    .filter(|l| m.enabled(l))
                    .collect::<Vec<_>>()
            ),
            "step" => {
                m.step(&label(&args[1])?);
                json!(m)
            }
            _ => return Err(Error::new(format!("unknown callback {name}"))),
        })
    }
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9e3779b97f4a7c15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}

/// Relative weight of an action in random walks: keep admissions and commits frequent, operator
/// changes and the passage of time rare.
fn weight(label: &str) -> u64 {
    let (conn, words) = split(label);
    let held = conn.is_some();
    match words[0] {
        "commit" => 40,
        "abort" => 8,
        "accept" | "send" => {
            if held {
                6
            } else {
                4
            }
        }
        "release" | "done" => 6,
        "idem" | "idem-other" | "batch" => 3,
        "limits" | "exempt" | "pause" | "resume" => 1,
        "hour" => 3,
        "days" | "h23" | "week" | "minute" => 2,
        "history" | "me" => 2,
        "outcome" => 3,
        "upload" | "upload-other" => 5,
        "ok" => 6,
        "fail" => 2,
        "expire" | "sweep" | "purge" | "delete" => 2,
        _ => 2,
    }
}

fn walk(seed: u64, len: usize, labels: &[String], init: &Model) -> Vec<String> {
    let mut x = seed;
    let mut m = init.clone();
    let mut out = vec![];
    for _ in 0..len {
        let enabled: Vec<&String> = labels.iter().filter(|l| m.enabled(l)).collect();
        if enabled.is_empty() {
            break;
        }
        let total: u64 = enabled.iter().map(|l| weight(l)).sum();
        let mut pick = splitmix(&mut x) % total;
        let label = enabled
            .iter()
            .find(|l| {
                let w = weight(l);
                if pick < w {
                    true
                } else {
                    pick -= w;
                    false
                }
            })
            .unwrap();
        m.step(label);
        out.push((*label).clone());
    }
    out
}

/// Group key: the action verb plus the mismatch path (digits elided), or the safety message.
fn signature(run: &Value) -> String {
    let index = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
    let step = &run["steps"][index];
    let (_, words) = split(step["action"].as_str().unwrap_or_default());
    let verb = words.first().copied().unwrap_or_default();
    let path = run["mismatch"]["path"].as_str().unwrap_or_default();
    let detail = if path.starts_with("/safety") {
        step["observed"]["safety"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    } else {
        path.to_owned()
    };
    let detail: String = detail
        .chars()
        .map(|c| if c.is_ascii_digit() { '#' } else { c })
        .collect();
    format!("{verb}: {detail}")
}

fn focus(step: &Value, path: &str) -> Value {
    let mut parts = path.split('/').skip(1);
    let key = parts.next().unwrap_or_default();
    let sub = parts.next();
    let pick = |v: &Value| match sub {
        Some(s) if key == "view" => v[key][s].clone(),
        _ => v[key].clone(),
    };
    json!({"action": step["action"], "expected": pick(&step["expected"]), "observed": pick(&step["observed"])})
}

/// Checklist items one trace reached, from its actions and observations.
fn reached(profile: &str, cfg: &Value, steps: &[Value]) -> Vec<&'static str> {
    let mut hit: Vec<&'static str> = vec![];
    let mut add = |id: &'static str| {
        if !hit.contains(&id) {
            hit.push(id)
        }
    };
    let mut open: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut blocked: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut seen: Vec<Vec<String>> = vec![];
    let mut uploads: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut time = false;
    for (i, step) in steps.iter().enumerate() {
        let action = step["action"].as_str().unwrap_or_default();
        let (conn, words) = split(action);
        let words: Vec<String> = words.iter().map(|s| s.to_string()).collect();
        let o = &step["observed"];
        let r = &o["r"];
        let view = &o["view"];
        let rs = r.as_str().unwrap_or_default();
        // Results of statements finishing at this step: the action itself and any it woke.
        let mut finished: Vec<(Vec<String>, Value, bool)> = vec![];
        if let Some(c) = conn {
            if words[0] == "commit" || words[0] == "abort" {
                for (w, v) in o["woke"].as_object().into_iter().flatten() {
                    if let Some(b) = blocked.remove(w) {
                        let mut tag = b.clone();
                        tag.push(if words[0] == "commit" {
                            "after-commit".into()
                        } else {
                            "after-abort".into()
                        });
                        tag.push(open.get(c).map(|x| x.join(" ")).unwrap_or_default());
                        finished.push((tag, v.clone(), true));
                    }
                }
                open.remove(c);
            } else {
                open.insert(c.to_owned(), words.clone());
                if rs == "blocked" {
                    blocked.insert(c.to_owned(), words.clone());
                } else {
                    finished.push((words.clone(), r.clone(), false));
                }
            }
        } else {
            finished.push((words.clone(), r.clone(), false));
        }
        if profile == "upload" {
            let room = cfg["room"].as_i64().unwrap_or(0);
            if view["used"].as_i64() == Some(room) {
                add("u.quota-exact");
            }
            if rs == "413:STORED_ATTACHMENT_LIMIT_EXCEEDED" {
                add("u.quota-over");
            }
            if view["reservations"].as_i64().unwrap_or(0) >= 2 && uploads.len() >= 2 {
                add("u.race");
            }
            let slot = conn.unwrap_or_default().to_owned();
            if words[0].starts_with("upload") {
                uploads.insert(slot.clone(), words.clone());
            }
            if words[0] == "ok" || words[0] == "fail" {
                let started = uploads.remove(&slot).unwrap_or_default();
                let keyed = started.get(1).is_some();
                if words[0] == "fail" {
                    add("u.fail");
                }
                if keyed
                    && rs.starts_with('a')
                    && seen.iter().any(|w| {
                        w.first().is_some_and(|v| v == "published")
                            && w.get(1).map(String::as_str) == Some(rs)
                    })
                {
                    add("u.idem-race");
                }
                if rs == "503:UPLOAD_EXPIRED" {
                    add("u.expire");
                    if seen.iter().any(|w| w[0] == "purge-after-sweep") {
                        add("u.expire-late-put");
                    }
                }
                if rs.starts_with('a') {
                    if seen.iter().any(|w| w[0] == "expire") {
                        add("u.expired-unswept");
                    }
                    seen.push(vec!["published".into(), rs.into()]);
                }
            }
            if words[0].starts_with("upload") && rs.starts_with('a') {
                add("u.idem-replay");
            }
            if rs == "409:IDEMPOTENCY_CONFLICT" {
                add("u.idem-conflict");
            }
            if words[0] == "delete" && rs == "ok" {
                add("u.delete");
            }
            if words[0] == "crash" {
                add("u.crash");
                seen.push(vec!["crashed".into()]);
            }
            if words[0] == "day" {
                seen.push(vec!["day".into()]);
            }
            // `day` runs the hourly cleanup too.
            if (words[0] == "sweep" || words[0] == "day")
                && seen.iter().any(|w| w[0] == "day")
                && seen.iter().any(|w| w[0] == "crashed")
            {
                add("u.tombstone");
            }
            if words[0] == "day" && i > 0 {
                // Storage reconciliation queued a deletion no record asked for.
                let prev = &steps[i - 1]["observed"]["view"];
                if prev["tombstones"].as_i64() == Some(0)
                    && prev["reservations"].as_i64() == Some(0)
                    && view["deletes"].as_i64().unwrap_or(0) > prev["deletes"].as_i64().unwrap_or(0)
                {
                    add("u.reconcile");
                }
            }
            if words[0] == "sweep" {
                seen.push(vec!["swept".into()]);
            }
            if words[0] == "purge" && seen.iter().any(|w| w[0] == "swept") {
                seen.push(vec!["purge-after-sweep".into()]);
            }
            if words[0] == "expire" {
                seen.push(vec!["expire".into()]);
            }
            continue;
        }
        if profile == "recv" {
            let lim = |x: usize| {
                (
                    cfg["limits"][x][0].as_i64().unwrap_or(0),
                    cfg["limits"][x][1].as_i64().unwrap_or(0),
                )
            };
            let wsv = |x: usize| &view[["A", "B"][x]];
            if words[0] == "abort" {
                add("r.abort");
            }
            for x in 0..2 {
                let (limit, backlog) = lim(x);
                let v = wsv(x);
                if limit > 0 && v["window"].as_i64() == Some(limit) {
                    add("r.limit-exact");
                }
                for (_, r) in v["receipts"].as_object().into_iter().flatten() {
                    match r[4].as_str() {
                        Some("MAILBOX_RECEIVE_BACKLOG") => add("r.reopen-backlog"),
                        Some("MAILBOX_BUDGET_HOLD_EXPIRED") => add("r.release-expired"),
                        _ => {}
                    }
                }
                let _ = backlog;
            }
            let any_blocked = !blocked.is_empty();
            for (w, v, woke) in &finished {
                let verb = w[0].as_str();
                if verb == "accept" || verb == "legacy-accept" {
                    let (m, rset) = (w[1].as_str(), w[2].as_str());
                    let touched: Vec<usize> = (0..2)
                        .filter(|x| {
                            if *x == 1 {
                                rset.contains('b')
                            } else {
                                rset != "0" && rset != "b"
                            }
                        })
                        .collect();
                    if touched.len() == 2
                        && (v["queued"].as_i64().unwrap_or(0) == 2
                            || touched.iter().all(|x| !wsv(*x)["receipts"][m].is_null()))
                    {
                        add("r.multi");
                    }
                    if *woke {
                        let holder = w.last().cloned().unwrap_or_default();
                        let after_abort = w.iter().any(|s| s == "after-abort");
                        if holder.contains("accept ") && holder.split(' ').nth(1) == Some(m) {
                            if holder.split(' ').nth(2) == Some(rset) {
                                add(if after_abort {
                                    "r.dup-race-abort"
                                } else {
                                    "r.dup-race"
                                });
                            } else {
                                add("r.reopen-race");
                            }
                        } else if holder.contains("accept ") {
                            add("r.new-race");
                            if v["queued"] == json!(0)
                                && touched.iter().any(|x| {
                                    wsv(*x)["active"].as_i64() >= Some(lim(*x).1)
                                        && wsv(*x)["receipts"][m].is_null()
                                })
                            {
                                add("r.backlog-race");
                            }
                        }
                    }
                    if rset == "x" && wsv(0)["receipts"][m][0] == "failed" {
                        add("r.huge");
                    }
                    if rset == "h" && v["queued"].as_i64() >= Some(1) {
                        add("r.huge");
                    }
                    if rset == "0" {
                        add("r.empty");
                    }
                    for &x in &touched {
                        let wv = wsv(x);
                        let receipt = &wv["receipts"][m];
                        let tag = ["A", "B"][x];
                        let known = seen.iter().any(|s| {
                            s.len() > 2
                                && s[0].ends_with("accept")
                                && s[1] == m
                                && s.get(3).map(String::as_str) == Some(tag)
                        });
                        if known
                            && v["queued"] == json!(0)
                            && seen
                                .iter()
                                .any(|s| s[0].ends_with("accept") && s[1] == m && s[2] == rset)
                        {
                            add("r.dup");
                        }
                        if known
                            && receipt[0] == "held"
                            && receipt[4] == "MAILBOX_RECEIVE_BACKLOG"
                            && wv["jobs"][m][1].as_i64() > Some(0)
                        {
                            add("r.reopen-running");
                        }
                        if known && v["queued"].as_i64() >= Some(1) {
                            add("r.reopen");
                            if verb == "legacy-accept" {
                                add("r.legacy-reopen");
                            }
                        }
                        if known
                            && v["queued"] == json!(0)
                            && receipt[0] == "pending"
                            && wv["jobs"][m][0] == json!(1)
                            && seen
                                .iter()
                                .any(|s| s[0].ends_with("accept") && s[1] == m && s[2] != rset)
                        {
                            add("r.coalesce");
                        }
                        if known
                            && receipt[0] == "held"
                            && seen
                                .iter()
                                .any(|s| s[0].ends_with("accept") && s[1] == m && s[2] != rset)
                        {
                            add("r.reopen-held");
                        }
                        if known && receipt[0] == "failed" && rset != "x" {
                            add("r.reopen-failed");
                        }
                        if !known && receipt[0] == "held" {
                            let (limit, backlog) = lim(x);
                            if limit <= 0 {
                                add("r.limit-zero");
                            } else if wv["active"].as_i64() >= Some(backlog) {
                                add("r.backlog-full");
                            } else {
                                add("r.limit-over");
                            }
                        }
                        if !known && time && v["queued"].as_i64() >= Some(1) {
                            add("r.hour");
                        }
                    }
                    for &x in &touched {
                        let mut tag = w.clone();
                        tag.truncate(3);
                        tag.push(["A", "B"][x].into());
                        seen.push(tag);
                    }
                }
                if verb == "release" {
                    // The global release completed while another statement waited.
                    if any_blocked {
                        add("r.release-race");
                    }
                    if v.as_i64().unwrap_or(0) > 0 {
                        for x in 0..2 {
                            let rs = wsv(x)["receipts"].as_object().cloned().unwrap_or_default();
                            if rs.values().any(|r| r[0] == "pending") {
                                add("r.release");
                            }
                            if rs
                                .values()
                                .any(|r| r[0] == "held" && r[2].as_i64().is_some())
                            {
                                add("r.release-again");
                            }
                        }
                    }
                    if !open.is_empty()
                        && open.values().any(|o| o[0].ends_with("accept"))
                        && (0..2).any(|x| {
                            wsv(x)["receipts"]
                                .as_object()
                                .is_some_and(|r| r.values().any(|r| r[0] == "held"))
                        })
                    {
                        add("r.release-skip");
                    }
                    if seen
                        .iter()
                        .any(|s| s.len() > 2 && s[0] == "accept" && s[2] == "ac")
                    {
                        seen.push(vec!["release-after-reopen".into()]);
                    }
                }
                if verb == "done" && v == &json!(0) {
                    add("r.stale-claim");
                }
                let prev = if i > 0 {
                    &steps[i - 1]["observed"]["view"]
                } else {
                    &Value::Null
                };
                let held_backlog = |vw: &Value, x: usize| -> Vec<String> {
                    vw[["A", "B"][x]]["receipts"]
                        .as_object()
                        .map(|r| {
                            r.iter()
                                .filter(|(_, r)| {
                                    r[0] == "held" && r[4] == "MAILBOX_RECEIVE_BACKLOG"
                                })
                                .map(|(m, _)| m.clone())
                                .collect()
                        })
                        .unwrap_or_default()
                };
                if ["done", "fail", "lose"].contains(&verb) {
                    let x = if w[1] == "A" { 0 } else { 1 };
                    if held_backlog(prev, x)
                        .iter()
                        .any(|m| wsv(x)["receipts"][m][0] == "pending")
                    {
                        add("r.drain");
                    }
                    // The receipt was held for a reopen while this job ran (the job end then drains it).
                    if verb == "fail"
                        && v == &json!(0)
                        && prev[["A", "B"][x]]["receipts"][w[2].as_str()][0] == "held"
                    {
                        add("r.stale-fail");
                    }
                }
                if verb == "claim" && v == &json!(0) {
                    add("r.claim-race");
                }
                if verb == "recover" && v.as_i64().unwrap_or(0) > 0 {
                    for x in 0..2 {
                        for (m, r) in wsv(x)["receipts"].as_object().into_iter().flatten() {
                            if r[4] == "MAILBOX_RECOVERY_EXHAUSTED" {
                                add("r.recover-exhausted");
                            } else if r[4] == "MAILBOX_RECEIVE_BACKLOG"
                                && !held_backlog(prev, x).contains(m)
                            {
                                add("r.recover-full");
                            } else if r[0] == "pending"
                                && wsv(x)["jobs"][m][0] == json!(1)
                                && prev[["A", "B"][x]]["jobs"][m].is_null()
                            {
                                add("r.recover");
                            }
                        }
                    }
                }
                if verb == "replay" && v.as_i64().unwrap_or(0) > 0 {
                    add(if *woke { "r.replay-race" } else { "r.replay" });
                }
                if verb == "release" {
                    // A hold the pass could not reach moved behind the others, still this hour.
                    for x in 0..2 {
                        for (m, r) in wsv(x)["receipts"].as_object().into_iter().flatten() {
                            let before = &prev[["A", "B"][x]]["receipts"][m];
                            if r[0] == "held"
                                && r[3] == json!(false)
                                && before[3] == json!(true)
                                && r[2] == before[2]
                            {
                                add("r.release-fair");
                            }
                        }
                    }
                }
                if verb != "accept" && verb != "legacy-accept" {
                    seen.push(w.clone());
                }
            }
            if words[0] == "hour" {
                time = true;
            }
            // Effects of held statements show at their commit.
            if words[0] == "commit" || conn.is_none() {
                for x in 0..2 {
                    let rs = wsv(x)["receipts"].as_object().cloned().unwrap_or_default();
                    if seen.iter().any(|w| w[0] == "release")
                        && seen.iter().any(|w| w[0] == "days")
                        && rs.values().any(|r| r[0] == "pending" && r[4].is_null())
                        && time
                    {
                        add("r.release-boundary");
                    }
                    let prior = steps[..i].iter().any(|s| {
                        s["observed"]["view"][["A", "B"][x]]["receipts"]
                            .as_object()
                            .is_some_and(|r| r.values().any(|r| r[4] == "MAILBOX_RECEIVE_BACKLOG"))
                    });
                    if prior
                        && seen.iter().any(|w| w[0] == "release")
                        && rs.values().any(|r| r[0] == "pending" && r[4].is_null())
                    {
                        add("r.release-backlog");
                    }
                }
            }
            if words[0] == "days" {
                seen.push(vec!["days".into()]);
            }
        } else {
            let all_one = finished.iter().all(|(w, v, _)| {
                !["send", "batch", "idem", "idem-other"].contains(&w[0].as_str())
                    || v["statements"] == json!(1)
            });
            if all_one && finished.iter().any(|(w, _, _)| w[0] == "send") {
                add("s.one-statement");
            }
            for (w, v, woke) in &finished {
                let e = v["error"].as_str().unwrap_or_default();
                let admitted = v["ok"].is_array();
                let verb = w[0].as_str();
                if ["send", "batch", "idem"].contains(&verb) {
                    if e == "429:SEND_LIMIT_REACHED" {
                        add("s.cap-over");
                        if verb == "send" && w[2] == "3" {
                            add("s.cap-exceeds");
                        }
                        if w.get(3).map(String::as_str) == Some("m") {
                            add("s.marketing");
                        }
                    }
                    if e == "429:REQUEST_RATE_LIMITED" {
                        add("s.rate-exact");
                    }
                    if e == "429:PENDING_EMAIL_LIMIT_EXCEEDED" {
                        add("s.pending-cap");
                    }
                    if e == "409:HOSTED_SENDING_PAUSED" {
                        add("s.pause");
                    }
                    if *woke {
                        let holder = w.last().cloned().unwrap_or_default();
                        let hk = holder.split(' ').nth(1).unwrap_or_default().to_owned();
                        let ws_of = |k: &str| if k == "2" { "2" } else { "1" };
                        if ["send", "batch", "idem", "idem-other"]
                            .contains(&holder.split(' ').next().unwrap_or_default())
                        {
                            if hk == w[1] {
                                add("s.race-key");
                            } else if ws_of(&hk) == ws_of(&w[1]) {
                                add("s.race-ws");
                            } else {
                                add("s.race-sponsor");
                            }
                            if e == "429:SEND_LIMIT_REACHED"
                                && w.iter().any(|s| s == "after-commit")
                            {
                                add("s.race-slot");
                            }
                            if verb == "idem" && holder.starts_with("idem ") {
                                add(if w.iter().any(|s| s == "after-abort") {
                                    "s.idem-race-abort"
                                } else {
                                    "s.idem-race"
                                });
                            }
                        } else if ["limits", "exempt"]
                            .contains(&holder.split(' ').next().unwrap_or_default())
                        {
                            add("s.override-race");
                        } else if ["pause", "resume"]
                            .contains(&holder.split(' ').next().unwrap_or_default())
                        {
                            add("s.pause-race");
                        }
                    }
                }
                if verb == "idem" {
                    let prior = seen
                        .iter()
                        .filter(|s| s[0] == "idem" && s.get(1) == w.get(1))
                        .count();
                    if admitted && prior > 0 {
                        if seen.iter().any(|s| s[0] == "idem-replayed") {
                            add("s.idem-replay");
                        }
                        if steps[..i].iter().any(|s| {
                            s["observed"]["r"]["error"]
                                .as_str()
                                .is_some_and(|x| x.starts_with("4"))
                                && s["action"].as_str().is_some_and(|a| a.contains("idem "))
                        }) {
                            add("s.idem-retry");
                        }
                    }
                    if admitted
                        && seen.iter().any(|s| s[0] == "pause")
                        && view["mails"].as_object().is_some_and(|m| m.len() == 1)
                    {
                        add("s.idem-replay-paused");
                    }
                }
                if verb == "send"
                    && e == "429:SEND_LIMIT_REACHED"
                    && seen.iter().any(|s| s[0] == "resume")
                    && seen.iter().any(|s| s[0] == "history")
                {
                    add("s.tier-resume");
                }
                if ["send", "batch"].contains(&verb)
                    && e != "429:REQUEST_RATE_LIMITED"
                    && seen.iter().any(|s| s[0] == "minute")
                    && steps[..i]
                        .iter()
                        .any(|s| s["observed"]["r"]["error"] == json!("429:REQUEST_RATE_LIMITED"))
                {
                    add("s.rate-minute");
                }
                if verb == "idem-other" && e == "409:IDEMPOTENCY_CONFLICT" {
                    add("s.idem-conflict");
                }
                if verb == "me" && v["cap"].is_number() {
                    add("s.me");
                }
                if admitted && ["send", "batch"].contains(&verb) {
                    if seen.iter().any(|s| s[0] == "limits" && s[2] != "default") {
                        add("s.override");
                    }
                    if seen.iter().any(|s| s[0] == "exempt" && s[2] == "on") {
                        add("s.exempt");
                    }
                    if seen.iter().any(|s| s[0] == "history") && seen.iter().any(|s| s[0] == "week")
                    {
                        add("s.tier");
                    }
                    if seen
                        .iter()
                        .any(|s| s[0] == "limits" && s[1] == w[1] && s[2] != "default")
                        && view["usage"].as_object().is_some_and(|u| u.len() == 2)
                    {
                        add("s.override-solo");
                    }
                    if seen.iter().any(|s| s[0] == "h23") {
                        add("s.window");
                    }
                }
                if verb == "outcome" && v == &json!(1) {
                    add("s.refund");
                    if seen.iter().any(|s| s[0] == "h23") && seen.iter().any(|s| s[0] == "hour") {
                        add("s.refund-late");
                    }
                }
                if verb == "abort" {
                    add("s.abort");
                }
                let mut tag = w.clone();
                if verb == "idem"
                    && admitted
                    && seen.iter().any(|s| s[0] == "idem" && s.get(1) == w.get(1))
                {
                    tag = vec!["idem-replayed".into()];
                    seen.push(w.clone());
                }
                seen.push(tag);
            }
            if conn.is_some() && words[0] == "abort" {
                add("s.abort");
            }
        }
    }
    hit
}

fn campaign(
    name: &str,
    traces: Vec<(usize, Vec<String>)>,
    profile: &str,
    replays: u64,
    budget: Option<Instant>,
) -> R<Value> {
    let start = Instant::now();
    let cfgs = cfgs(profile);
    let mut checks: Vec<Check> = vec![];
    let host = Host::spawn()?;
    checks.push(Check {
        profile: profile.into(),
        cfg: cfgs[0].clone(),
        host,
        fixtures: 0,
    });
    let check = &mut checks[0];
    let (mut matched, mut steps, mut errors, mut run_count) = (0u64, 0u64, vec![], 0u64);
    let mut groups: BTreeMap<String, (u64, usize, Vec<String>)> = BTreeMap::new();
    let mut coverage: BTreeMap<String, u64> = BTreeMap::new();
    for (ci, trace) in traces {
        if budget.is_some_and(|b| Instant::now() > b) {
            break;
        }
        check.cfg = cfgs[ci].clone();
        let run = conformance::dispatch("runTrace", &json!({"actions": trace}), check)?;
        run_count += 1;
        let observed = run["steps"].as_array().cloned().unwrap_or_default();
        steps += observed.len() as u64;
        for id in reached(profile, &cfgs[ci], &observed) {
            *coverage.entry(id.to_owned()).or_default() += 1;
        }
        match run["status"].as_str() {
            Some("match") => matched += 1,
            Some("mismatch") => {
                let g = groups.entry(signature(&run)).or_insert((0, ci, trace.clone()));
                g.0 += 1;
                if trace.len() < g.2.len() {
                    g.1 = ci;
                    g.2 = trace;
                }
            }
            _ => errors.push(json!({"cfg": ci, "actions": trace, "status": run["status"], "error": run["error"]})),
        }
    }
    let checked = start.elapsed();
    let mut witnesses = vec![];
    for (sig, (count, ci, trace)) in &groups {
        check.cfg = cfgs[*ci].clone();
        let reduced = conformance::dispatch(
            "minimizeTrace",
            &json!({"actions": trace, "options": {"maxReplays": replays}}),
            check,
        )?;
        let outcome = &reduced["outcome"];
        let path = outcome["mismatch"]["path"].as_str().unwrap_or_default();
        let last = outcome["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
        witnesses.push(json!({
            "signature": sig, "traces": count, "cfg": ci, "originalLength": trace.len(),
            "reduction": reduced["status"], "replays": reduced["replays"],
            "length": reduced["actions"].as_array().map_or(0, Vec::len),
            "actions": reduced["actions"], "path": path,
            "failingStep": focus(&outcome["steps"][last], path),
        }));
    }
    Ok(json!({
        "campaign": name, "profile": profile, "traces": run_count, "matched": matched,
        "mismatched": groups.values().map(|g| g.0).sum::<u64>(), "errors": errors,
        "steps": steps, "fixtures": check.fixtures,
        "checkMs": checked.as_millis() as u64, "totalMs": start.elapsed().as_millis() as u64,
        "coverage": coverage, "witnesses": witnesses,
    }))
}

fn edges(
    profile: &str,
    cfg: &Value,
    depth: u64,
    max_states: u64,
    core: bool,
) -> R<(Value, Vec<Vec<String>>)> {
    let start = Instant::now();
    let mut space = Space {
        labels: alphabet(profile, core),
    };
    let graph = search::map_states(
        &json!(initial(profile, cfg)),
        &json!({"maxDepth": depth, "maxStates": max_states}),
        &mut space,
    )?;
    let nodes = graph["nodes"].as_array().map_or(0, Vec::len);
    let edges = graph["edges"].as_array().cloned().unwrap_or_default();
    // Nodes are numbered in discovery order, so each node's first incoming edge is its BFS parent.
    let mut parent: Vec<Option<(usize, String)>> = vec![None; nodes];
    for e in &edges {
        let (from, to) = (
            e["from"].as_u64().unwrap_or(0) as usize,
            e["to"].as_u64().unwrap_or(0) as usize,
        );
        if to != 0 && parent[to].is_none() {
            parent[to] = Some((from, e["action"].as_str().unwrap_or_default().to_owned()));
        }
    }
    let path = |mut n: usize| {
        let mut out = vec![];
        while let Some((p, a)) = &parent[n] {
            out.push(a.clone());
            n = *p;
        }
        out.reverse();
        out
    };
    let traces = edges
        .iter()
        .map(|e| {
            let mut t = path(e["from"].as_u64().unwrap_or(0) as usize);
            t.push(e["action"].as_str().unwrap_or_default().to_owned());
            t
        })
        .collect();
    let info = json!({"graph": graph["status"], "states": nodes, "edges": edges.len(), "maxDepth": depth, "mapMs": start.elapsed().as_millis() as u64});
    Ok((info, traces))
}

/// Every checklist item the model's actions can reach (see the module comment).
const CHECKLIST: &[&str] = &[
    "r.dup-race",
    "r.dup-race-abort",
    "r.reopen-race",
    "r.new-race",
    "r.dup",
    "r.reopen",
    "r.reopen-held",
    "r.reopen-failed",
    "r.limit-exact",
    "r.limit-over",
    "r.limit-zero",
    "r.backlog-full",
    "r.backlog-race",
    "r.hour",
    "r.release",
    "r.release-again",
    "r.release-expired",
    "r.release-boundary",
    "r.release-skip",
    "r.release-race",
    "r.release-backlog",
    "r.multi",
    "r.coalesce",
    "r.reopen-backlog",
    "r.reopen-running",
    "r.stale-claim",
    "r.legacy-reopen",
    "r.drain",
    "r.stale-fail",
    "r.claim-race",
    "r.recover",
    "r.recover-full",
    "r.recover-exhausted",
    "r.replay",
    "r.replay-race",
    "r.release-fair",
    "r.huge",
    "r.empty",
    "r.abort",
    "s.cap-over",
    "s.cap-exceeds",
    "s.marketing",
    "s.race-ws",
    "s.race-sponsor",
    "s.race-key",
    "s.race-slot",
    "s.abort",
    "s.refund",
    "s.refund-late",
    "s.window",
    "s.idem-replay",
    "s.idem-conflict",
    "s.idem-race",
    "s.idem-race-abort",
    "s.idem-retry",
    "s.idem-replay-paused",
    "s.rate-exact",
    "s.rate-minute",
    "s.pause",
    "s.pause-race",
    "s.override",
    "s.override-race",
    "s.override-solo",
    "s.pending-cap",
    "s.exempt",
    "s.tier",
    "s.tier-resume",
    "s.me",
    "s.one-statement",
    "u.quota-exact",
    "u.quota-over",
    "u.race",
    "u.idem-race",
    "u.idem-replay",
    "u.idem-conflict",
    "u.fail",
    "u.expire",
    "u.expire-late-put",
    "u.expired-unswept",
    "u.delete",
    "u.crash",
    "u.tombstone",
    "u.reconcile",
];
fn checklist(runs: &[Value]) -> Value {
    let mut hits: BTreeMap<String, u64> = BTreeMap::new();
    for r in runs {
        for (k, v) in r["coverage"].as_object().into_iter().flatten() {
            *hits.entry(k.clone()).or_default() += v.as_u64().unwrap_or(0);
        }
    }
    let missing: Vec<&&str> = CHECKLIST
        .iter()
        .filter(|c| !hits.contains_key(**c))
        .collect();
    json!({"reached": hits.len(), "of": CHECKLIST.len(), "missing": missing, "traces": hits})
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn failed(r: &Value) -> bool {
    r["mismatched"].as_u64().is_some_and(|n| n > 0)
        || r["errors"].as_array().is_some_and(|e| !e.is_empty())
}

fn main() -> R<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flags = ["--profile", "--cfg", "--seed", "--replays", "--budget"];
    let profile = flag(&args, "--profile").unwrap_or_else(|| "recv".into());
    let cfg_index: Option<usize> = flag(&args, "--cfg").and_then(|s| s.parse().ok());
    let seed: u64 = flag(&args, "--seed")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let replays: u64 = flag(&args, "--replays")
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let budget_secs: Option<u64> = flag(&args, "--budget").and_then(|s| s.parse().ok());
    let positional: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|(i, a)| *i > 0 && !a.starts_with("--") && !flags.contains(&args[i - 1].as_str()))
        .map(|(_, a)| a)
        .collect();
    let nums: Vec<u64> = positional.iter().filter_map(|a| a.parse().ok()).collect();
    let deadline = budget_secs.map(|s| Instant::now() + std::time::Duration::from_secs(s));
    let report = match args.first().map(String::as_str) {
        Some("trace") => {
            let cfg = cfg_index.unwrap_or(0);
            let mut check = Check {
                profile: profile.clone(),
                cfg: cfgs(&profile)[cfg].clone(),
                host: Host::spawn()?,
                fixtures: 0,
            };
            let actions: Vec<&String> = positional.clone();
            let run = conformance::dispatch("runTrace", &json!({"actions": actions}), &mut check)?;
            let path = run["mismatch"]["path"].as_str().unwrap_or_default();
            let at = run["mismatch"]["index"].as_u64().unwrap_or(0) as usize;
            let observed = run["steps"].as_array().cloned().unwrap_or_default();
            json!({"status": run["status"], "mismatch": run["mismatch"], "error": run["error"], "disabled": run["disabled"],
                "reached": reached(&profile, &cfgs(&profile)[cfg], &observed),
                "failingStep": if path.is_empty() { Value::Null } else { focus(&run["steps"][at], path) },
                "steps": if std::env::var("TEAR_STEPS").is_ok() { run["steps"].clone() } else { Value::Null }})
        }
        Some("space") => {
            let mut out = vec![];
            for d in 1..=nums.first().copied().unwrap_or(4) {
                let (info, traces) = edges(
                    &profile,
                    &cfgs(&profile)[cfg_index.unwrap_or(0)],
                    d,
                    2_000_000,
                    true,
                )?;
                let steps: usize = traces.iter().map(Vec::len).sum();
                out.push(json!({"depth": d, "model": info, "traceSteps": steps}));
            }
            json!(out)
        }
        Some("edges") => {
            let (depth, max) = (
                nums.first().copied().unwrap_or(3),
                nums.get(1).copied().unwrap_or(200_000),
            );
            let ci = cfg_index.unwrap_or(0);
            let (info, traces) = edges(&profile, &cfgs(&profile)[ci], depth, max, true)?;
            let mut r = campaign(
                "edge coverage (core alphabet)",
                traces.into_iter().map(|t| (ci, t)).collect(),
                &profile,
                replays,
                deadline,
            )?;
            r["model"] = info;
            r
        }
        Some("ci") => {
            // PR budget: under a minute after the build. Bug witnesses and boundary traces, then
            // per profile every edge of the core alphabet to a small depth and seeded random walks
            // over the full alphabet and every configuration. `--seed` rotates the walks.
            let start = Instant::now();
            let mut runs = vec![];
            for p in ["recv", "send", "upload"] {
                let traces = REGRESSIONS
                    .iter()
                    .chain(BOUNDARIES)
                    .filter(|(q, _, _)| *q == p)
                    .map(|(_, ci, a)| (*ci, a.iter().map(|s| s.to_string()).collect()))
                    .collect();
                runs.push(campaign(
                    &format!("{p}: bug witnesses and boundaries"),
                    traces,
                    p,
                    replays,
                    None,
                )?);
            }
            for (p, depth, walks, len) in [
                ("recv", 2, 160, 24),
                ("send", 1, 220, 24),
                ("upload", 3, 160, 20),
            ] {
                let (info, traces) = edges(p, &cfgs(p)[0], depth, 200_000, true)?;
                let mut e = campaign(
                    &format!("{p}: edges depth {depth}"),
                    traces.into_iter().map(|t| (0, t)).collect(),
                    p,
                    replays,
                    None,
                )?;
                e["model"] = info;
                runs.push(e);
                let labels = alphabet(p, false);
                let n = cfgs(p).len();
                let traces = (0..walks)
                    .map(|s| {
                        let ci = (s as usize) % n;
                        (ci, walk(seed + s, len, &labels, &initial(p, &cfgs(p)[ci])))
                    })
                    .collect();
                runs.push(campaign(
                    &format!("{p}: random walks (seed {seed})"),
                    traces,
                    p,
                    replays,
                    None,
                )?);
            }
            let bad = runs.iter().any(failed);
            let report = json!({"runs": runs, "checklist": checklist(&runs), "totalMs": start.elapsed().as_millis() as u64});
            println!(
                "{}",
                serde_json::to_string_pretty(&report).unwrap_or_default()
            );
            if bad {
                std::process::exit(1);
            }
            return Ok(());
        }
        Some("boundaries") => {
            let mut runs = vec![];
            for p in ["recv", "send", "upload"] {
                let traces = REGRESSIONS
                    .iter()
                    .chain(BOUNDARIES)
                    .filter(|(q, _, _)| *q == p)
                    .map(|(_, ci, a)| (*ci, a.iter().map(|s| s.to_string()).collect()))
                    .collect();
                runs.push(campaign(
                    &format!("{p}: bug witnesses and boundaries"),
                    traces,
                    p,
                    replays,
                    None,
                )?);
            }
            let bad = runs.iter().any(failed);
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({"runs": runs, "checklist": checklist(&runs)}))
                    .unwrap_or_default()
            );
            if bad {
                std::process::exit(1);
            }
            return Ok(());
        }
        _ => {
            let (n, len) = (
                nums.first().copied().unwrap_or(200),
                nums.get(1).copied().unwrap_or(30),
            );
            let labels = alphabet(&profile, false);
            let all = cfgs(&profile);
            let traces = (0..n)
                .map(|s| {
                    let ci = cfg_index.unwrap_or((s as usize) % all.len());
                    (
                        ci,
                        walk(
                            seed + s,
                            len as usize,
                            &labels,
                            &initial(&profile, &all[ci]),
                        ),
                    )
                })
                .collect();
            campaign(
                &format!("random walks (seed {seed})"),
                traces,
                &profile,
                replays,
                deadline,
            )?
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&report).unwrap_or_default()
    );
    let bad = failed(&report) || report["status"].as_str().is_some_and(|s| s != "match");
    if bad {
        std::process::exit(1);
    }
    Ok(())
}
