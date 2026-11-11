# Bane mail gateway

`python3 e2e.py --real` builds the gateway, launches an isolated Postgres, MinIO and Bane API with SES simulation, and runs the black-box gate plus SQL-budget and revocation checks. Add Bun and Node 24 to the prerequisites below. `python3 e2e.py` runs the same protocol scenarios on the memory adapter. `just e2e` also runs the deterministic unit and property tests. Use `cargo clippy --all-targets --locked -- -D warnings` for the lint gate. Run these from `gateway/`.

Requirements: stable Rust with edition 2024, Python 3.11+, OpenSSL 3, swaks, NeoMutt, git and Docker Desktop or OrbStack with `host.docker.internal` reaching Mac loopback. The harness pulls digest-pinned Dovecot and imaptest images and fetches the pinned upstream compliance scripts. It generates a fresh certificate, password and ports; no SES, cloud credentials, DNS or real email. A missing required client is a failure, not a skip.

## What the gate verifies

- Both implicit-TLS listeners and both STARTTLS upgrades, fresh EHLO after TLS, no pre-TLS auth, sender authorization in both the envelope and headers, alias-shared caps, and SMTP pipelining and dot transparency.
- Scripted client workflows, **not** runs of Apple Mail, Outlook, Thunderbird or iOS: SPECIAL-USE discovery, folder subscription, PEEK previews, partial bodies, UID sync/move/expunge, IDLE across concurrent sessions, and client APPEND after server-side Sent filing. Real clients are Python imaplib/smtplib, rust-imap, swaks and headless NeoMutt submission. The differential script checks message bytes and normalized observations on the gateway and a fresh Dovecot instance.
- Malformed MIME and 8-bit headers, oversized literal announcements, folder deletion/recreation during SELECT, incomplete pre-auth frames, and a 3-second concurrent imaptest stress run. The memory probe measures server-process RSS at 16 and 272 authenticated TLS IDLE sockets; it excludes kernel buffers, uses an empty folder, and is not Fargate sizing data.
- **Upstream vs Bane expectations:** the runner tries all 74 upstream groups and prints every skipped script and its missing capability. The design intentionally reports zero `RECENT` and never sets `\Recent`, unlike Dovecot rev1. The only tolerated upstream differences are ten specific commands in `select`, `copy` and `search-flags`. The runner re-executes those entire scripts with just their Recent expectations changed. Any other failure, diagnostic or false profile expectation fails the gate. `MAILGW_STRICT_IMAPTEST=1 python3 e2e.py 'imaptest scripts'` makes the unmodified upstream verdict binding. Logs are in `target/imaptest-{scripts,stress}.log`.
- Standalone parser fuzzing: `cargo install cargo-fuzz --locked`, then `cargo +nightly fuzz run wire -- -max_total_time=300 -print_final_stats=1`. If Darwin's ASan runtime hangs during loader initialization, use `cargo +nightly fuzz run --sanitizer none wire -- -max_total_time=300 -print_final_stats=1`; this still uses coverage-guided libFuzzer, without ASan.

## Scope and handoff

`core` has no sockets or timers: an IMAP or SMTP session consumes validated commands and returns reply octets and transport actions. `mailgw` owns TLS, deadlines, admission and a coalescing change signal. The memory fixture binds **only to loopback**, on 993/143 and 465/587 by default. `MAILGW_CERT`, `MAILGW_KEY` and `MAILGW_FIXTURE_PASSWORD` are required. IMAP stays off unless `MAILGW_IMAP_ENABLED=true`. This is a synthetic single-inbox adapter, not an authentication service.

The IMAP subset uses rev1 grammar, LITERAL+, SASL-IR, UIDPLUS, MOVE, IDLE, NAMESPACE, ID and SPECIAL-USE. It does **not** advertise full IMAP4rev2, UTF8=ACCEPT, CONDSTORE or QRESYNC. Before enabling rev2, cover its required extensions (notably ESEARCH, extended LIST, BINARY and UTF-8 mailbox handling) and run the rev2 suite. No client should be offered a capability just to pass discovery.

For the real API adapter, task environment, migration ordering, measured budgets and current limits, see [Phase 2](PHASE2.md).
