**Make a workspace the tenant.** One person may belong to several workspaces with different roles. The dashboard delegates sign-in to its configured OIDC issuer. See the [current identity and migration guide](../../../api/README.md#dashboard-sign-in).

## Membership and permissions

Bane owns users, sessions, memberships and invitations. Workspace roles apply equally to dashboard and delegated requests.

**Default role matrix** — permissions apply only in granted environments. Owner includes Admin; “metadata” excludes bodies, recipients, raw headers, attachments and secrets.

| Resource | Admin | Developer | Campaign editor | Viewer |
|---|---|---|---|---|
| Sending domains; transactional email | Manage domains; read/send | Inspect domains, send from assigned domains, inspect delivery metadata | Use assigned senders for campaigns | Domain status and delivery metadata |
| API keys; inbound keys | Issue, rotate, revoke within grant ceiling | No durable key administration | — | — |
| Contacts, lists, segments | Manage/import/export | — | Manage audiences; no bulk export | Aggregate counts |
| Campaigns; templates | Manage, approve and send | Edit/test templates | Edit templates; draft and test campaigns; no live release | Status and metrics |
| Outbound/inbound webhooks | Manage destinations and signing-key rotation | Inspect scoped delivery status, no payloads | — | — |
| Inbound addresses; threads | Configure addresses; read/modify/reply | No inbox by default | No inbox by default | No inbox by default |
| Settings, AWS connection, members | Routine settings, connection status, audit; invite/manage lower roles | — | — | — |

**Owner only:** ownership changes, admin appointments, SSO enforcement, AWS connection changes and workspace deletion; never expose stored AWS credentials. Provide an independent **inbox operator grant**: `read`, `modify` and/or `send` for named addresses, without domain administration. Likewise make live campaign release a separate grant.

Today sender restrictions include subdomains and **are not a read-isolation boundary** ([api/README.md:173](/api/README.md#L173)). Preserve sender inheritance only for identities verified to belong to this tenant. Filter domain-scoped reads separately; deny workspace-wide datasets where no safe filter exists. Address grants constrain thread projections, events, attachments and reply identities—not just the inbox list. Represent `all`, `selected` and `none` explicitly: an empty intersection must never become unrestricted.

## Resolving authority

1. **Session:** Put the workspace in the dashboard URL and each API request. The switcher lists current memberships; active organization remembers the landing choice only. Recheck membership and assurance for the explicit target. Switching tabs must not retarget a pending send or change a key’s workspace.
2. **API and inbound keys:** Resolve a nonrevoked secret hash to its stored workspace, environment and grants; reject conflicting request selectors. Keep durable keys workspace-owned, with creator attribution, so removing an employee does not unexpectedly stop production. Existing key rows already carry workspace/environment; inbound keys are live-only with address IDs and `read/send/modify` ([db/core.ts:3–22](/api/src/db/core.ts#L3), [mailbox.ts:26–64](/api/src/mailbox.ts#L26)). Require explicit opt-in for “all current and future addresses.”
3. **MCP and temporary agent tokens:** Bind each consent to one workspace, membership, client, environment and resource/action ceiling. At use and refresh, intersect consent with **current** membership; intersect child tokens again. No durable credential creation by agents. Preserve existing signature, expiry, revocation and dispatch-time checks; retain the child credential ID for attribution. Scope grant listing/revocation too: today those queries are installation-wide ([mcp-auth.ts:68–91, 353–372](/api/src/mcp-auth.ts#L353), [agent-token.ts:5–31](/api/src/agent-token.ts#L5), [sending.ts:1266–1287](/api/src/sending.ts#L1266)).
4. **Invitations:** Send via OpenSend from a platform-owned transactional workspace, independent of customer SES setup. Bind a single-use, expiring invitation to workspace, normalized email, role, scopes and inviter. Set `requireEmailVerificationOnInvitation: true`; recheck inviter authority at acceptance. Never put invite secrets or OTPs in customer-visible mail logs.
5. **Audit:** Append successful admin changes transactionally; record denied sensitive attempts separately. Include time, workspace/environment, actor and credential/grant IDs, action, target, redacted before/after, outcome and request ID. Cover invitations, membership/scopes, ownership, SSO/MFA policy, credentials, domains, webhook destinations, AWS changes and live release. Never record tokens, codes or message contents.

## Competitive difference and open decisions

[Resend](https://resend.com/docs/dashboard/settings/team) supports switching teams, but documents Admin/Member roles and no team-wide MFA requirement. MX can offer an enforced MFA policy and a genuine metadata-only viewer. [Postmark](https://postmarkapp.com/support/article/1071-how-do-i-set-a-users-permissions) offers assigned-server admins/viewers; MX can delegate **one support address** without exposing other mail on the server. [SendGrid](https://www.twilio.com/docs/sendgrid/ui/account-and-settings/teammate-permissions) already offers fine-grained feature permissions and [subuser isolation](https://www.twilio.com/docs/sendgrid/api-reference/teammates). The concrete MX advantage is granting an agent `reply` on one address without creating a subaccount, with revocation inherited from the approving member.

**Open decisions:** Auto-create a personal workspace? **Only on explicit creation**; invitees should land directly in the inviting workspace. Permit multiple owners? **Yes**, but transactionally forbid removing or demoting the last one. Import `default`? **Only by explicit operator mapping** to a named workspace and owner; never infer ownership from the first public login.
