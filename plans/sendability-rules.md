# Checking a message before sending

`POST /v1/emails/check` (`checkEmail` in SDK/MCP) accepts **one** draft, `{"emailId":"…"}` or `{"campaignId":"…"}`. A draft accepts a single From mailbox (`"Bane <billing@bane.mx>"` or bare address + `fromName`), optional `to`, `subject`, `html` and/or `text`, a `transactional` or `marketing` stream, optional headers (name → value) and optional attachment **metadata**. The response contains only diagnostics and measurements, never message HTML. Read permission suffices; stored content follows its existing workspace, sender, mailbox, and capability-redaction rules. Domain-scoped keys cannot obtain workspace reputation statistics. No fetching links, images, DNS, SES, attachment objects or Jev. No side effects on sending.

**Interpretation:** a high score means few observed problems, not a percentage chance of inbox placement. Six independent category scores start at 100. Subtract each triggered rule's category points **once**, floor at zero, then round the weighted average over nonzero category weights. A category with no workspace reputation evidence has weight zero; if no exact identity or actionable authentication evidence is available, authentication has weight zero. Unmeasured signals do not become failures. Grades follow Bane's sender grade cutoffs (A+ 95, A 90, B 80, C 70, D 60). This checker does not modify the workspace sender score, nor does a high total override a specific error such as exceeding the hosted screen limit.

## Rules

Points and thresholds below are Bane heuristics, **not** published spam-filter coefficients. The last column gives the reason for the check, not a claim that a provider implements this formula. [Google sender guidelines][G], [Yahoo sender requirements][Y], [DMARC][D], [SES][M], [CAN-SPAM][F] and [RFC 8058][U] give the relevant requirements.

### Authentication & domain (weight 20)

| Rule ID | Severity | Points | Trigger and rationale |
|---|---|---:|---|
| auth-unknown | info | 0 | Incomplete cached From-domain evidence: cannot infer receiver authentication from an author-provided header. DMARC checks expire after 48 hours. |
| spf-policy | info | 3 | Recent placement observation found no single restrictive SPF policy at From. This is domain hygiene, **not** proof of SPF failure on the actual envelope. [RFC 7208](https://www.rfc-editor.org/rfc/rfc7208) |
| dkim | error | 45 | Exact sending identity is not verified or SES signing is not successful. [Google][G] |
| mail-from | warning | 8 | Default SES envelope is unaligned; DKIM can still pass DMARC. [SES][M] |
| spf-alignment | warning | 16 | A configured custom envelope lacks a confirmed aligned path (`dmarcView`, SES status and strict/relaxed mode). [DMARC][D] |
| dmarc | error | 40 | Missing/invalid effective policy or neither aligned path. [DMARC][D] |
| dmarc-monitor | info | 3 | Monitoring meets the bulk-sender minimum, but asks for no enforcement. [DMARC][D] |
| dmarc-reports | info | 2 | No aggregate mailto reporting destination. Visibility gap, not failed authentication. [DMARC][D] |
| young-domain | warning | 18 | Cached RDAP age (advanced since observation) <14 days. New senders have little reputation; do not substitute workspace or claim creation date. [Google][G], Outlook sample below |
| reply-domain | warning | 12 | Reply-To and From differ by registrable domain (including private suffixes); readers may not recognize where a reply is going. |

### Content (weight 33)

| Rule ID | Severity | Points | Trigger and rationale |
|---|---|---:|---|
| text-part | warning | 32 | HTML with no plain alternative: users of text-only clients lose the message. [RFC 2046 §5.1.4][A] |
| part-mismatch | warning | 52 | Below 25% Jaccard overlap of normalized, unique words in the two parts (`screenTextSignals`). Alternatives should represent the same information, not a short unrelated label. [RFC 2046][A], Outlook sample |
| image-ratio | warning | 20 | `screenedHtmlStats` uses the probation image-area allowance: 200×200 px free, then 25 readable words per 600×300. Essential information disappears with remote images blocked. |
| image-alt | info | 6 | Empty/missing image alternatives. Decorative images can legitimately have empty alt. [W3C image guidance](https://www.w3.org/WAI/tutorials/images/) |
| hidden-text | warning | 16 | Existing screen's hidden/very small or low-contrast words, or repeated invisible preheader padding. Ordinary short preheaders are not themselves a defect. [Google][G], Outlook sample |
| off-brand-links | warning | 25 | All web links lead outside the From brand's registrable domain. Does not penalize each third-party reference. Outlook sample |
| link-label | warning | 18 | Existing screen found a displayed hostname different from the anchor destination. [Google][G] |
| short-url | warning | 15 | Existing deliverability shortener list: obscured destinations reduce reader trust. [Google][G] |
| ip-link | warning | 20 | Literal IPv4/IPv6 host: recipient cannot recognize the destination brand. [SpamAssassin URI rules](https://github.com/apache/spamassassin/blob/trunk/rules/20_uri_tests.cf) |
| redirect | info | 5 | Known Bane tracking or an explicit nested URL in a query parameter; layered redirects obscure the destination. A static hint, not an HTTP redirect trace. |
| promotional-phrase | info | 4 | Only “no credit check”, “you are a winner”, “this is not spam”. Credit/prize/unsolicited-mail claims from Bane's existing phrase list, intentionally low weight. [FTC prize scam examples](https://consumer.ftc.gov/articles/fake-prize-sweepstakes-and-lottery-scams), [SpamAssassin body rules](https://github.com/apache/spamassassin/blob/trunk/rules/20_body_tests.cf) |
| shouting | warning | 8 | Subject ≥10 characters with >65% uppercase letters, repeated punctuation or ≥3 exclamation marks. Readability heuristic; not a blacklist. |
| subject | info | 6 | Empty, >90 Unicode code points, or >2 pictographs. Many inboxes truncate the subject; emoji-heavy subjects obscure the purpose. [Mailchimp subject-line guide](https://mailchimp.com/help/best-practices-for-email-subject-lines/) |
| form | warning | 12 | Embedded form: support varies or submission is disabled. [Can I email](https://www.caniemail.com/features/html-form/) |
| script | error | 30 | Embedded script: clients remove or disable executable content. Never execute it to inspect the email. |
| html-invalid | warning | 8 | parse5 reports a token/tree error during preview lint (missing doctype alone ignored). Clients can repair malformed documents differently. |
| attachments | info/error | 0/30 | Count metadata; flag SES-blocked file extensions and selected active MIME/archive types. Not a byte scan or proof a file is safe. [SES unsupported attachments](https://docs.aws.amazon.com/ses/latest/dg/mime-types.html) |

### Headers & compliance (weight 15)

| Rule ID | Severity | Points | Trigger and rationale |
|---|---|---:|---|
| display-name | warning | 30 | No recognizable From name. One of the consistent differences in the Outlook sample. [Google][G] |
| message-id | warning | 15 | Supplied Message-ID is not a single bracketed identifier. SES normally adds one; omission on a draft is not failure. [RFC 5322 §3.6.4][H] |
| date | warning | 15 | Supplied Date is unparseable or over a day in the future. Transport normally supplies it. [RFC 5322 §3.6.1][H] |
| unsubscribe-header | error | 30 | Marketing only: no HTTPS unsubscribe target. A mailto-only header is insufficient for one-click. [Google][G], [Yahoo][Y], [RFC 8058][U] |
| unsubscribe-post | error | 20 | Marketing only: absent/invalid one-click POST declaration. [RFC 8058][U] |
| unsubscribe-link | error | 25 | Marketing only: no recognizable opt-out/preferences link. Separate from one-click headers. [CAN-SPAM][F], [Google][G] |
| postal-address | warning | 18 | Marketing only: no recognizable postal address. English street/PO-box heuristic, not a legal or international address validator. [CAN-SPAM][F] |

Pasted marketing drafts are checked **as supplied**. Campaign checks render a base copy before per-recipient substitution and credit the opt-out headers/link Bane adds. Sent structured messages use their retained visible copy. These are not reconstructions of the MIME as received; raw-only or unavailable bodies return an error rather than scoring a blank message.

### Size & limits (weight 12)

| Rule ID | Severity | Points | Trigger and rationale |
|---|---|---:|---|
| gmail-clip | warning | 45 | ≥102,400 bytes **HTML**, before final tracking/encoding. Approximate Gmail clipping line, not the total MIME size. [Gmail clipping observations](https://github.com/hteumeuleu/email-bugs/issues/41) |
| screen-bytes | info/warning/error | 0/20/100 | Always reports exact submitted (or known probation-rewritten) UTF-8 bytes, limit 24,576 and signed remaining bytes. Warning under 10% headroom, error above limit. Uses `screen.ts`'s text projection incl. visible HTML, alt/title and plain alternative. This does not run the classifier or guarantee other screening budgets pass. |
| mime-size | info/error | 0/100 | Reports Bane admission's conservative MIME estimate, including base64, line folding and header reserve. Above the 16 MiB application cap is an error. Not a captured on-wire byte count. |

### Rendering (weight 5)

| Rule ID | Severity | Points | Trigger and rationale |
|---|---|---:|---|
| client-support | warning | 0–100 | Reuse the preview `lint()` and its vendored Can I email matrix. Sum the affected open share per client **once**, taking its worst issue (unsupported ×1, partial/unknown ×0.25), round; report the highest-reach feature and affected clients. |

[Litmus October 2026 opens](https://www.litmus.com/email-client-market-share): Apple 75.84%, Gmail 17.02%, Outlook desktop 3.49%, Yahoo/AOL 2.25%, Outlook web 0.31%, Samsung 0.01%. Split family share among modeled variants; neither variant mix nor Apple human-open share is known. Unmodeled clients aren't extrapolated. This category measures rendering risk, **not** junk placement.

### Reputation & pattern (weight 15)

| Rule ID | Severity | Points | Trigger and rationale |
|---|---|---:|---|
| shared-pool | info | 0 | Actual Hosted binding: reputation on shared SES IPs is not solely under the sender's control. No assumption a trusted pool means a dedicated IP. |
| warmup | warning | 22 | Workspace sender score is not graded yet. Hosted reads persisted standing; self-hosted/BYO reads the sender-score projection, cached for 60 seconds. [Bane sending limits][B] |
| sender-band | warning | 30 | Graded workspace score <80 (below B). [Bane sender standing][B] |
| bounce-rate | error | 35 | Last seven UTC dates, >2% hard bounces/accepted, at least two bounces. Same rate line as the support deliverability diagnostics. |
| complaint-rate | error | 45 | Last seven UTC dates, ≥0.1% complaints/accepted, at least two complaints. Distinct from Gmail's own recipient-level metric. [Google][G] |
| burst | warning | 30 | Campaign eligible audience (frozen total for a launch), capped by requested pacing, exceeds effective daily allowance, or the hourly marketing allowance during warm-up. Estimate, not a claim that all recipients arrive at once. [Bane limits][B], [Google][G] |

## Calibration: same sender, different message

Reproduce offline: `cd api && node --import tsx scripts/calibrate-sendability.ts`. Use the 16 submitted `emailPreviewCorpus` HTML fixtures with the original Outlook investigation's bare render-test From, numbered subject and `Synthetic render test: <title>` text. Hold the four-day-old domain, verified DKIM, unaligned default SES MAIL FROM, `p=reject` without `rua`, probation pool and warm-up context fixed **also for both controls**. No hypothetical campaign recipient count, known bounce problem or failed authentication was supplied. Controls were scored, **not** sent.

| Fixture | Score | Distinguishing content/header/size warnings or errors |
|---|---:|---|
| 01 Basic typography | 61 | Part mismatch, off-brand links, no display name |
| 02 Table layout | 69 | Part mismatch, no display name |
| 03 Grid and flex | 63 | Part mismatch, hidden text, no display name |
| 04 Responsive media queries | 64 | Part mismatch, hidden text, no display name |
| 05 Web fonts | 68 | Part mismatch, no display name |
| 06 Background images | 69 | Part mismatch, no display name |
| 07 Buttons | 60 | Part mismatch, off-brand links, no display name |
| 08 Dark mode support | 66 | Part mismatch, no display name |
| 09 Long message — **not delivered** | 57 | Part mismatch, no display name, Gmail clipping and hosted screened-text limit |
| 10 Images and sizing | 61 | Part mismatch, off-brand links, no display name |
| 11 Style block selectors | 68 | Part mismatch, no display name |
| 12 Typography details | 67 | Part mismatch, no display name |
| 13 Positioning and overflow | 67 | Part mismatch, no display name |
| 14 Interactive and embedded content | 54 | Part mismatch, off-brand links, form, no display name |
| 15 Receipt | 54 | Part mismatch, hidden padding, off-brand links, no display name |
| 16 Newsletter | 61 | Part mismatch, off-brand links, no display name |
| Control: November subscription receipt | **91** | None |
| Control: opt-in November newsletter | **91** | None |

All 15 delivered fixtures landed in Outlook Junk; those same fixtures scored **54–69**, at least 22 points below both controls. The observed receipt passed SPF, DKIM, DMARC and composite authentication, had BCL 0, and received SCL 5/6. The text mismatch, unbranded links, unknown sender and burst are plausible explanations, **not a Microsoft per-rule attribution**. The screen stopped fixture 09 before delivery. This is one sender and two mailbox destinations, not an out-of-sample placement study.

Performance sample: warm local `workerd`, authenticated HTTP POST through the real Worker, Hyperdrive against isolated tmpfs PostgreSQL on loopback, one short multipart receipt: **16.5 ms p95** (40 sequential timed requests after five warm-ups, November 13). Not an edge-region SLA; large HTML, audience counts, cold starts and remote DB latency need separate monitoring.

[G]: https://support.google.com/a/answer/81126
[Y]: https://senders.yahooinc.com/best-practices/
[D]: https://www.rfc-editor.org/rfc/rfc9989
[A]: https://www.rfc-editor.org/rfc/rfc2046#section-5.1.4
[M]: https://docs.aws.amazon.com/ses/latest/dg/mail-from.html
[H]: https://www.rfc-editor.org/rfc/rfc5322
[U]: https://www.rfc-editor.org/rfc/rfc8058
[F]: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
[B]: ../docs/sending-limits.md
