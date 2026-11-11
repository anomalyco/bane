# Rituals

A ritual is reusable routing code. An endpoint is a separately configured function. Create `webhook:crm`, `slack:billing`, `discord:team` or a verified `forward:team` before using it in code. A named inbox is called with `inbox.deliver("support")`. Use quoted property syntax for hyphenated names: `webhook["support-hook"]({subject:email.subject})`.

```js
export default function route(email, ctx) {
  const result = omens(email, { refund: {prompt: "Is the sender requesting a refund?", type: "boolean", threshold: 0.7} })
  if (result.refund) {
    label("refund")
    webhook.crm({subject:email.subject, sender:email.from.address, recipient:ctx.recipient})
  }
}
```

Save with `rituals_create`, attach with `rituals_attach`, and preview with `rituals_dry_run` (`body.mime` or `body.messageId`). Dry runs roll back candidate configuration, do not send mail or contact Jev, and use stored scores or explicit overrides keyed by prompt. An unmatched ritual continues; a matched ritual stops unless the binding sets `continue:true`. Blocking, allowing and junking are ordinary ritual actions. Scores are ordinary data. No review action or queue. Format and API examples are also available in the generated OpenAPI document under **Rituals**.

The VM has no ambient clock, randomness, host functions or I/O. It accepts one default function, local constants, record and array literals, templates, branches, limited string operations and RE2 `.test`. Compile errors include source locations. Limits: 50,000 steps per run, 250,000 per message, 32 actions per run, 64 KiB per action and 256 KiB of output per message. A failed run contributes no actions. `TYPESAFE_API_KEY`, `JEV_ENDPOINT` and `JEV_MODEL` configure the classifier. Only opted-in hosts/routes send bounded evidence to it; questions are static and the reply schema is closed. Missing scores default to zero/false. The MVP accepts ten unique questions per batched call.

External deliveries have a durable snapshot, an attempt limit, an ID stable across retries, and per-endpoint pacing. An HTTP 429/5xx consumes an attempt; the retry waits for both exponential backoff with jitter and Retry-After. No response from a non-idempotent endpoint is unknown, not success. Unless timeout retries were explicitly enabled, a pre-send fence prevents automatic reposting after an ambiguous request or interrupted worker. A webhook can explicitly declare idempotency support; it then receives `Idempotency-Key`. Forward admission deduplicates by message and endpoint inside the outbound transaction. Local deliver/label/junk/drop decisions commit in the durable ingest job rather than separate jobs that could expose the message before its final disposition.

Forwarding uses the permanent receiving inbox as the rewritten sender. The verification link expires after 24 hours; the recipient must explicitly confirm from a verified Bane login for that address. A GET alone never approves. Incoming Bane-loop tokens block a forward, including forged tokens; automated/unparsed/unsafe mail is never forwarded. Forwarded content is bounded plain text, not the original MIME with attachments.

**Next:** inbound Guard-to-ritual importer, richer connector messages, additional connectors, per-host compiled plan partitioning and full low-level MCP parity. No review queue is planned in the corrected MVP.
