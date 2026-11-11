# First-slice verification (2026-11-11, Apple Silicon)

`cargo clippy --all-targets --locked -- -D warnings` clean; `cargo test --locked` 8/8, including two proptests. `python3 e2e.py` 11/11. No hosted services or real mail were used.

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
