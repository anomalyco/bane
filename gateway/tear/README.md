# gateway/tear

Stateful property tests for the IMAP/SMTP gateway with [tear](https://github.com/anomalyco/tear)
(crate `statecheck`, pinned by git rev in `Cargo.toml`). Independent reference models predict
every step; the real code runs next to them in-process; the first difference is reported as a
JSON Pointer and the failing trace is shrunk to a replayable witness.

Standalone like `../fuzz`: not a member of the gateway workspace, not in its images. It
compiles the gateway's Remote store (`../mailgw/src/remote.rs` and its helpers) from source
through `#[path]` modules, so production code runs unchanged.

| Model | Product side |
|---|---|
| IMAP, Memory store (`src/model.rs`) | `Imap` sessions over `store::Memory`, with idle pushes on every store change |
| IMAP, Remote store (same model, `Backend::Remote`) | `Imap` over `remote::Store` and the shell seams `Store::imap`, `Store::wake`, `Api::notified`, `Hints`, talking signed HTTP to `src/fake_api.rs`, a deterministic fake of `POST /internal/v1/mail` (the phase-2 SQL semantics, snapshot pages of 2 rows) |
| SMTP submission (`src/smtp.rs`) | `Smtp` over the Memory `Sink` and over the Remote `Store` submitter, lines framed by the real `wire::Frame` |
| Conformance (`src/dovecot.rs`) | Dovecot 2.3.21 (the image `e2e.py` pins) and the gateway on the same traces; tear's campaign with Dovecot as `base` |

The edge-case checklist is at the top of `src/main.rs`; `ci` prints it with the counts that
reached each item.

## Run

```sh
cargo run --release -- ci                     # PR gate: ~17 s on a loaded M-series Mac
cargo run --release -- trace --remote deliver hint "A noop" fail-snapshot "A copy 1 Archive"
cargo run --release -- transcript transcripts/deleted-folder-copy.txt --remote
cargo run --release -- smtp-trace "A ehlo" "A auth" "A pipeline" "A body own"
```

`ci` replays every shrunk witness below, maps the two-session core exhaustively to depth 4
(49,369 edges), and runs seeded random walks over the Memory and Remote stores (shared
credential, two gateway processes, faults) and SMTP. Exit status 1 on any mismatch.

Deeper (nightly, or before a release; seeds rotate with `--seed`):

```sh
cargo run --release -- edges 5 --minimal                   # 465,250 edges, about 1 min
cargo run --release -- edges 4                             # full alphabet, 133,750 edges
cargo run --release -- edges 3 --remote                    # Remote with faults, 48,810 edges, 2 min
cargo run --release -- random 200000 40 --seed "$(date +%Y%m%d)"
cargo run --release -- random 20000 30 --remote --split --sessions 3 --seed "$(date +%Y%m%d)"
cargo run --release -- random 20000 30 --remote --shared-kid --sessions 3
cargo run --release -- random 300 30 --remote --bulk               # 1,000-UID batches, mid-command faults
cargo run --release -- random 5000 30 --remote --uploads --sessions 4 --shared-kid   # upload lanes
cargo run --release -- smtp 50000 40 && cargo run --release -- smtp 5000 40 --remote
cargo run --release -- dovecot 1000 25                     # Docker; about 5 min (amd64 emulation on a Mac)
```

`--bulk` adds 1,000-message deliveries and `COPY/MOVE 1:*`, so STORE, COPY, MOVE and EXPUNGE
run in several batches; with faults, a batch fails (`fail-batch`), the process dies after one
(`crash-batch`), another writer expunges between two (`race-batch`) or a response is lost
(`lose-response`). `--uploads` splits APPEND into `append-begin`/`append-end` so up to four
sessions hold upload reservations against the credential, inbox and workspace lanes; the
2 s reservation timeout runs on a paused clock. `--seconds N` bounds any run by time. `--no-silent`, `--no-faults`, `--no-folders` and
`--minimal` shrink the alphabet (the `.SILENT` control from the spike is `--no-silent`).

## Reading a failure

Each distinct mismatch is grouped by signature (`verb: /path`) and reduced with tear's
`minimizeTrace`. The report gives the witness, the original length and the failing step's
expected and observed values. Paste the witness into `trace` (with the same flags) to replay
it against any revision; add it to `REGRESSIONS` in `src/main.rs` once fixed. A client
transcript (synthetic or redacted, never real mail) replays with `transcript FILE`.

## Found so far

| Bug | Witness | Fix (commit subject) |
|---|---|---|
| `.SILENT` STORE swallowed another session's flag change (spike) | 6 steps | Report other sessions' flag changes after a .SILENT STORE |
| A committed COPY/MOVE/APPEND/STORE/EXPUNGE reported NO when the snapshot refresh after it failed | 5 steps | Report a committed mutation as done when the refresh after it fails |
| A refused APPEND (TRYCREATE) kept its spool and upload reservation; the credential's next APPEND could not get one | 3 steps | Release APPEND spool when command handling refuses its destination (upstream, concurrently); Test that a refused APPEND releases its upload reservation |
| A command whose update found the selected folder deleted sent `* BYE`, then a tagged OK, and kept the connection open | 4 steps | Close the session after a command whose update finds the folder gone |
| SMTP: a clock stepping back across midnight reopened the Memory sink's day and month caps | 13 steps | Keep SMTP cap windows from moving backwards on a clock step |
| `STORE 1:*`/`COPY 1:*` over 1,000 UIDs answered `NO [LIMIT]` ("mark all read", "select all → delete", "empty Trash"), and a plain EXPUNGE expunged a whole folder in one statement | 5 steps (`--bulk`) | Run large protocol mutations in 1,000-UID batches inside one command; Refresh each thread once per protocol mutation batch |

## Documented differences and limits

- Dovecot answers BAD for a sequence set naming messages that do not exist; Bane answers OK
  with no data. Dovecot answers OK (no-op) for EXPUNGE, MOVE and UID EXPUNGE under EXAMINE;
  Bane answers BAD. Both are left out of the conformance alphabet.
- COPY is not compared with Dovecot: Bane shares ordinary flags across copies by design.
- Dovecot 2.3.21 itself diverges from the model in one place (4-step witness: deliver,
  `B uid-store +deleted 1`, deliver, `A expunge`): an EXPUNGE that removes a message the
  session was never told about announces it with EXISTS but sends no EXPUNGE before the OK
  (RFC 3501 6.4.3), so the client keeps a deleted message until its next NOOP. The gateway
  follows the RFC here; 299 of 300 conformance traces match on Dovecot, all 300 on the gateway.
- A slot announced by EXISTS whose FETCH then finds it gone stays unknown to the client until
  the next update (RFC 2180 4.1); the model tracks those slots instead of expecting data.
- A COPY retried after a process crash runs on a new connection with a new ticket and copies
  again (at-least-once across a crash; IMAP has no client idempotency key). On the same
  connection, a retry replays every committed batch.
- A Remote EXPUNGE (and CLOSE) names the UIDs its snapshot holds; a message another session
  copied in, `\Deleted`, after that snapshot waits for the next EXPUNGE.
- Not reached: the 5 s store deadline and 1 s admission sleep (wall clock inside the
  adapter), 2048-row pages and 5000-UID batches (too slow per step; covered by e2e), two
  gateway versions at once.

## CI access to tear

tear is a private `anomalyco` repository. `.cargo/config.toml` makes cargo fetch with the git
CLI; the workflow rewrites the URL with the `TEAR_READ_TOKEN` secret (a read-only token for
`anomalyco/tear`). Until tear is published, that secret is required for the gateway job.
