# Gateway verification

## PR #45, after merging dev through #55 (2026-11-12, Apple Silicon)

| Gate | Result |
| --- | --- |
| Full API acceptance, both isolated CI shards | 339 passed, 0 failed, 6 skipped. Admission: 1 SQL statement; ingest: 2–3. |
| `python3 e2e.py --real` (disposable PostgreSQL + MinIO) | 18 passed, 0 failed. Cold/cached LOGIN 1/0; SELECT 1; selected FLAGS, header and body PEEK 0; two-session IDLE refresh 1. |
| Gateway tear `ci` | 483,357 steps, 0 mismatches, 0 errors. The inbox tear delete/subscribe race also matched PostgreSQL. |
| Rust | Format and Clippy clean; 27 unit/property tests passed. Nightly `wire` fuzz without ASan: 191,330 executions in 21 s, 0 crashes. |

The imaptest script runner has a separate fixture session cap for short-lived connections through the Docker proxy; admission and account fairness are tested separately. The real-store gate retains the upstream `\Recent` comparison below. Neither the run nor its database budgets measure hosted Fargate or Worker performance.

## First-slice verification (2026-11-11, Apple Silicon)

`cargo clippy --all-targets --locked -- -D warnings` clean; `cargo test --locked` 8/8, including two proptests. `python3 e2e.py` 11/11. No hosted services or real mail were used.

The combined IMAP/SMTP parser fuzz target completed **9,758,170 executions in 301 seconds**, zero crashes, peak RSS 33 MiB. Command: `cargo +nightly-2025-12-26 fuzz run --sanitizer none wire -- -max_total_time=300 -rss_limit_mb=1500 -print_final_stats=1`. The default address sanitizer stalled during Darwin runtime initialization before reaching the target; the completed run used libFuzzer coverage instrumentation, not ASan.

Unmodified Dovecot imaptest: **32 passed, 3 failed, 39 skipped** out of 74 groups; 450/460 base commands and 26/26 extension commands passed. The three failures were `select`, `copy` and `search-flags`: Dovecot expects recent messages, while Bane’s design specifies zero recent. The same three groups against that policy passed **80/80 commands**. This is not an unqualified rev1 or rev2 compliance claim.

The stress run used three clients for three seconds (seed 17): 1,010 logins/selections, 34 appends, 6,070 fetches and 5,950 NOOPs; no protocol diagnostics. Separately, the same scripted session on Dovecot 2.3 and the gateway returned matching normalized observations, including exact message bytes. The idle probe measured **16.6 KiB per additional TLS IDLE session**: 11,152 KiB server RSS at 16 sessions, 15,392 KiB at 272. This is a debug build with an empty folder; kernel and client memory are excluded.

## Skipped upstream scripts

Each script declares a capability not advertised by the first slice. The harness computes and prints this ledger from the actual capabilities and pinned script headers, and checks the count against imaptest.

| Missing capability | Script names |
|---|---|
| BINARY | `append-binary`, `fetch-binary-mime`, `fetch-binary-mime-base64`, `fetch-binary-mime-qp` |
| CATENATE / MULTIAPPEND | `catenate`, `catenate-multiappend` (both), `multiappend` |
| ESEARCH / CONDSTORE / ESORT | `esearch`, `esearch-condstore` (ESEARCH + CONDSTORE), `esort` |
| LIST-EXTENDED | `listext` |
| NOTIFY + QRESYNC | `notify` |
| CONTEXT=SEARCH | `search-context-update`, `search-context-update2`, `search-context-update3`, `search-partial` |
| SORT | `sort-addresses`, `sort-arrival`, `sort-date`, `sort-size`, `sort-subject` |
| SORT=DISPLAY / CONTEXT=SORT | `sort-display-from`, `sort-display-to` (DISPLAY); `sort-partial` (CONTEXT) |
| THREAD=REFERENCES | `thread`, `thread2`, `thread3`, `thread4`, `thread5`, `thread6`, `thread7`, `thread8` |
| THREAD=ORDEREDSUBJECT | `thread-orderedsubject`, `thread-orderedsubject2` |
| UIDBATCHES | `uidbatches`, `uidbatches-empty` |
| URLAUTH | `urlauth`, `urlauth2`, `urlauth-binary` (also requires URLAUTH=BINARY) |
