# Receiving routes: phase 1 design summary

SES has one catch-all rule. Nightmail admits mail by verified receiving host, then chooses one route per envelope recipient: exact route or address, local pattern, plus-address base, host catch-all, then domain default. A route can deliver to inboxes and webhooks, keep mail unassigned, or drop it. New domains keep unmatched mail. Installing routing does not switch existing workspaces away from legacy address matching.

The queue claim reads the plan; the existing store statement rechecks destinations, writes memberships and unrouted records, and queues webhook fan-out. Native and inbound-compatible callbacks are rendered and signed at delivery. Only administrators can create these durable subscriptions. Cap skips leave an unrouted record even when some destinations received the message.

The API, SDK, MCP read/test tools and dashboard use the same matcher. The workspace version and an optional `If-Match` protect concurrent edits. Route history is retained for up to one year and 256 versions. A restore is a new version, not a reversal of message delivery or webhook credentials.

See [measured DB budgets and integration limits](receiving-measurements.md#route-enabled-receiving-phase-1). Rules, groups and forwards are later phases.
