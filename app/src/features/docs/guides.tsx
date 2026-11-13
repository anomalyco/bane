// Guides: what Receiving, rituals, endpoints, agent inboxes, MCP and keys are, in plain words, before the API
// reference. The ritual reference is generated from api/src/ritual-schema.ts, the same source as the editor's
// completions, so it can't drift from what the compiler accepts.
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { CopyAction } from '../../components/motion'
import { builtins, ctxFields, emailFields, endpointPayloads, type Field } from '../../../../api/src/ritual-schema'
import { webhookSignatureGuide } from '../../../../api/src/webhook-signature-guide'
import { concepts } from '../inbound/concepts'
import { McpSetup } from './agent-setup'
import { credentials } from './credentials'
import { apiKeyEnv } from '../../../../api/src/brand'

export type Guide = { id: string; title: string; summary: string; body: () => ReactNode }

function Code({ children, label }: { children: string; label: string }) {
  return <div className="docs-quickstart-code"><pre className="docs-code" tabIndex={0} aria-label={label}><code>{children}</code></pre><CopyAction value={children} label={`Copy ${label}`} variant="ghost" size="sm" compact className="developer-copy-icon" /></div>
}
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
// Each section has an anchor (/docs/rituals#sender-lists); a # beside the heading shows on hover and focus.
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = slug(title)
  return <section id={id} className="docs-section"><h2><Link className="docs-anchor" to={{ hash: id }}>{title}</Link></h2>{children}</section>
}
function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return <div className="docs-table-scroll"><table className="docs-table"><thead><tr>{head.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>
}
/** email.* and ctx.* fields, one level of nesting deep, as the editor completes them. */
function fieldRows(prefix: string, fields: Record<string, Field>): ReactNode[][] {
  return Object.entries(fields).flatMap(([name, field]) => [
    [<code key="n">{`${prefix}.${name}`}</code>, field.doc],
    ...(field.type === 'object' && field.fields ? Object.entries(field.fields).map(([child, f]) => [<code key="n">{`${prefix}.${name}.${child}`}</code>, f.doc]) : []),
  ])
}

const ritualExample = `export default function route(email, ctx) {
  // Newsletters go to Junk: kept, but not sent anywhere.
  if (email.headers.has("list-unsubscribe") || email.flags.bulk) {
    junk("newsletter")
    return
  }
  // Refund requests get a label and a Slack post.
  const asks = omens(email, { refund: "Is the sender asking for a refund?" })
  if (asks.refund >= 0.7) {
    label("refund")
    endpoints.support({ text: \`Refund request from \${email.from.address}: \${email.subject}\` })
  }
}`

export const guides: Guide[] = [
  {
    id: 'receiving', title: 'Receiving', summary: 'How mail reaches your domain and where it goes: addresses, routes, rituals and endpoints.',
    body: () => <>
      <Section title="What happens to an email">
        <p>Mail sent to one of your addresses arrives at Bane through your domain’s receiving MX record. Bane finds the address’s <strong>route</strong>, runs its <strong>rituals</strong>, then delivers it: to the address’s Inbox, and to any <strong>endpoints</strong> its route or rituals name. You read it in Receiving → Inbox, over the API or from an agent.</p>
        <Table head={['Word', 'What it is', 'Example']} rows={[
          ['Address', 'An email address that receives mail. It keeps its own threads in the Inbox.', <code key="e">support@acme.com</code>],
          ['Route', concepts.routes.line, <code key="e">{concepts.routes.example}</code>],
          ['Ritual', concepts.rituals.line, concepts.rituals.example],
          ['Endpoint', concepts.endpoints.line, <code key="e">{concepts.endpoints.example}</code>],
          ['Catch-all', 'What happens to mail for an address that doesn’t exist on the domain: store it, or create an address for it.', <code key="e">*@acme.com</code>],
          ['Agent inbox', 'An expiring address that an agent or a test creates and reads.', <Link key="e" to="/docs/inboxes">Agent inboxes</Link>],
        ]} />
      </Section>
      <Section title="Where your domain receives: reply.yourdomain or the domain itself">
        <p>Receiving needs an MX record, and a domain can only send its mail to one place. So Bane suggests a free subdomain, usually <code>reply.yourdomain.com</code>: addresses there, such as <code>support@reply.yourdomain.com</code>, come to Bane, while mail to <code>yourdomain.com</code> itself keeps going to your current mailboxes.</p>
        <p>Bane receives on the domain itself only when its MX record already points to Bane, or when you choose it on the domain’s page. Choosing the root moves all of the domain’s mail to Bane, so the page asks first. Onboarding and the domain’s page always show the host Bane chose, with the reason.</p>
      </Section>
      <Section title="Set it up">
        <ol className="docs-steps">
          <li>Open <Link to="/domains">Domains</Link>, choose the domain and publish its <strong>Receiving</strong> MX record at your DNS provider. Bane turns receiving on once it resolves.</li>
          <li>In <Link to="/receiving">Receiving</Link>, choose <strong>New address</strong>, for example <code>support@reply.yourdomain.com</code>.</li>
          <li>Send it a test email. It shows up in Receiving → Inbox within seconds.</li>
          <li>Optional: add an <Link to="/docs/endpoints">endpoint</Link> (Slack, a webhook…) and a <Link to="/docs/rituals">ritual</Link> that decides which mail goes there.</li>
        </ol>
      </Section>
      <Section title="Over the API">
        <p>Create an address with <Link to="/docs/api/createInboundAddress">createInboundAddress</Link>, list conversations with <Link to="/docs/api/listInboundThreads">listInboundThreads</Link> and reply with <Link to="/docs/api/replyToInboundThread">replyToInboundThread</Link>. To get each message as it arrives, subscribe a URL to <code>message.received</code> with <Link to="/docs/api/createInboundWebhook">createInboundWebhook</Link>.</p>
      </Section>
    </>,
  },
  {
    id: 'rituals', title: 'Rituals and omens', summary: 'Short scripts that label, filter and forward mail, and the questions they can ask Bane’s AI.',
    body: () => <>
      <Section title="What a ritual is">
        <p>A ritual is a short script that runs on every email sent to the addresses it’s attached to. It reads the email and decides what happens: junk it, label it, post it to Slack, send it to a webhook, forward it. It can’t do anything else: no loops, no clock, no network calls of its own, so it always finishes and does the same thing for the same email.</p>
        <Code label="ritual example">{ritualExample}</Code>
        <p>Write one in <Link to="/receiving/rituals?new=1">Receiving → Rituals → New ritual</Link>. The editor checks it as you type and completes <code>email.</code>, <code>ctx.</code> and your endpoint names. <strong>Try it on an email</strong> runs your draft on a real or sample email without saving or sending anything. <strong>Save</strong> (⌘S) keeps the script; the bar at the bottom of the page says whether there are unsaved changes, and leaving asks first.</p>
      </Section>
      <Section title="Where it runs">
        <p>A ritual runs only on mail to the addresses it’s attached to. Attach it in the editor’s <strong>Runs on</strong> section or from an address’s page; attaching, detaching and reordering save at once. Up to three rituals run on an address, in order. The first one that acts stops the rest, unless its <strong>Run the next one too</strong> is on.</p>
      </Section>
      <Section title="What it can do">
        <Table head={['Call', 'What it does']} rows={Object.values(builtins).map(b => [<code key="c">{b.signature}</code>, b.doc.replace('Jev', 'Bane’s AI')])} />
        <Table head={['Endpoint call', 'What it does']} rows={Object.entries(endpointPayloads).map(([type, p]) => [<code key="c">{p.signature(type === 'webhook' ? 'crm' : type === 'forward' ? 'team' : type === 'discord' ? 'alerts' : 'support')}</code>, p.doc])} />
      </Section>
      <Section title="What it can read">
        <p>The email, as <code>email</code>, and the run, as <code>ctx</code>. Everything sender-supplied is untrusted: check <code>email.auth.fromVerified</code> before trusting who it’s from.</p>
        <Table head={['Field', 'Meaning']} rows={[...fieldRows('email', emailFields), ...fieldRows('ctx', ctxFields)]} />
      </Section>
      <Section title="Omens: questions for Bane’s AI">
        <p>{concepts.omens.line} Ask with <code>omens(email, {'{'} name: "question" {'}'})</code>; each name comes back as a score you compare, like <code>asks.refund &gt;= 0.7</code>. One request per email answers every question in every ritual. In the API and its docs, that AI is called Jev.</p>
        <p>Bane’s AI only reads mail at the receiving hosts you list under <strong>Omens can read mail at</strong> in the ritual editor. Everywhere else, and in Try it and Trace, an omen gives its default answer instead; in Try it you set each answer with a slider to see what the ritual would do.</p>
      </Section>
      <Section title="Sender lists">
        <p>Named lists of senders, edited below the ritual: <code>vip: ceo@example.com, @partner.example</code>. Check one with <code>lists.has("vip", email.from.address)</code>; <code>@domain</code> covers everyone at that domain.</p>
      </Section>
    </>,
  },
  {
    id: 'endpoints', title: 'Endpoints and routes', summary: 'Where mail can go besides the Inbox, and the difference between a route and a ritual.',
    body: () => <>
      <Section title="Endpoints">
        <p>{concepts.endpoints.line} Create them in <Link to="/receiving?tab=endpoints">Receiving → Endpoints</Link>; each has a name rituals call it by. Send a test from its ⋯ menu.</p>
        <Table head={['Type', 'Call it as', 'Notes']} rows={[
          ['Slack', <code key="c">{endpointPayloads.slack.signature('support')}</code>, 'An incoming webhook URL from Slack. Stored encrypted; mentions and link previews are off.'],
          ['Discord', <code key="c">{endpointPayloads.discord.signature('alerts')}</code>, 'A webhook URL from Discord. Stored encrypted; mentions are off.'],
          ['Webhook', <code key="c">{endpointPayloads.webhook.signature('crm')}</code>, 'Signed JSON to your HTTPS URL; the signing secret is shown once. Without a payload it gets the whole message event.'],
          ['Forward', <code key="c">{endpointPayloads.forward.signature('team')}</code>, 'Forwards the email to another address once its owner confirms by email.'],
        ]} />
      </Section>
      <Section title="Routes or rituals?">
        <p>A <strong>route</strong> sends every message for an address, whole, to inboxes and webhooks. Every address has one: by default, its own Inbox. Edit it from the address’s page (<strong>Add a route</strong>) or from a route row.</p>
        <p>A <strong>ritual</strong> chooses: which mail, and what to send. Slack, Discord and forwards are only sent by rituals, because a channel post needs a message written for it. If a ritual calls a webhook the route also delivers to, with a payload of its own, that webhook gets the ritual’s payload instead of the whole message, once per message.</p>
      </Section>
      <Section title="Catch-all">
        <p>Mail for an address that doesn’t exist on the domain follows the domain’s catch-all, set on its page in <Link to="/domains">Domains</Link>: store it without an inbox, or create an address for each new recipient. A <code>*@domain</code> route takes precedence.</p>
      </Section>
    </>,
  },
  {
    id: 'inboxes', title: 'Agent inboxes', summary: 'Expiring addresses that agents and end-to-end tests create, wait on and read.',
    body: () => <>
      <Section title="What an agent inbox is">
        <p>A random, unguessable address on your receiving domain that lives for a set time: an hour to 30 days. Agents and tests use them to receive sign-up codes, magic links and replies, then throw them away. A <strong>sandbox</strong> inbox has a made-up address that never gets real mail: you send it test mail yourself, so it works before any DNS is set up.</p>
        <Table head={['Stage', 'What happens']} rows={[
          ['Active', 'Mail is delivered: it shows on the inbox’s page, to waiting agents and to webhooks.'],
          ['Expired', 'For one more day, new mail is kept but held: stored and listed, not delivered.'],
          ['Deleted', 'The inbox, its mail and its keys are erased.'],
        ]} />
        <p>Past its limit (200 messages or 25 MiB by default) new mail is held the same way. Bane pulls one-time codes and links out of each message. An inbox can reply only to people who wrote to it, if replies were allowed when it was created.</p>
      </Section>
      <Section title="Create one">
        <p>In <Link to="/receiving/inboxes">Receiving → Agent inboxes → New agent inbox</Link>, or with <Link to="/docs/api/createInbox">createInbox</Link>. Tick <strong>Create an API key for this inbox</strong> to get a key that reads only this inbox, with a ready setup for OpenCode, Claude Code or Cursor. Later, <strong>Connect an agent</strong> on the inbox’s page makes another one.</p>
        <Code label="create inbox example">{`curl --request POST "$BANE/v1/inboxes" \\\n  --header "Authorization: Bearer $${apiKeyEnv}" \\\n  --header 'Content-Type: application/json' \\\n  --data '{"name":"Sign-up test","ttlSeconds":3600,"credential":{"name":"Sign-up test key","permissions":["read"]}}'`}</Code>
        <p>Then wait for mail with <Link to="/docs/api/listInboxMessages">listInboxMessages</Link> (or the MCP tool <code>waitForMessage</code>), and delete the inbox with <Link to="/docs/api/deleteInbox">deleteInbox</Link> when you’re done.</p>
      </Section>
    </>,
  },
  {
    id: 'mcp', title: 'Connect an agent (MCP)', summary: 'Let OpenCode, Claude Code or Cursor work with Bane, as you or with one inbox.',
    body: () => <>
      <Section title="Two ways to connect">
        <Table head={['', 'What the agent can reach', 'Set up']} rows={[
          [<strong key="a">Sign in as you</strong>, 'What you approve in the browser: read, send or full access. It signs in with your Anomaly account (Google); choose its workspace and receiving tools in Settings → Account.', 'The config below, then sign in from your client.'],
          [<strong key="b">One agent inbox</strong>, 'Only that inbox, with an API key for it: read its mail and, if allowed, reply. Nothing else in the workspace.', <Link key="c" to="/api-keys?connect=1">Connect an agent</Link>],
        ]} />
        <p>Both are listed in <Link to="/api-keys">API keys</Link>: an agent signed in as you as an <strong>agent token</strong>, with the short-lived tokens it made, and an inbox’s key as an <strong>API key</strong>. Revoke either there, or an inbox’s key from its page.</p>
      </Section>
      <McpSetup chooseAccess />
    </>,
  },
  {
    id: 'keys', title: 'Keys and tokens', summary: 'API keys, agent tokens and app passwords.',
    body: () => <>
      <Section title="Which one do I need?">
        <Table head={['Credential', 'What it does', 'Where']} rows={credentials.map(c => [<strong key="n">{c.name}</strong>, c.line, c.where])} />
        <p>Keys are shown once when they’re made. Store them on your server, never in a browser. Revoke any of them in <Link to="/api-keys">API keys</Link>.</p>
      </Section>
    </>,
  },
  {
    // The same words and code as /docs.md and /llms.txt (api/src/webhook-signature-guide.ts).
    id: webhookSignatureGuide.id, title: webhookSignatureGuide.title, summary: webhookSignatureGuide.summary,
    body: () => <Section title="Check the Webhook-Signature header">
      <p>{webhookSignatureGuide.text}</p>
      <Code label="webhook signature check">{webhookSignatureGuide.code}</Code>
      <p>Find each webhook’s secret in <Link to="/settings#webhooks">Settings → Webhooks</Link>, and for inbound webhooks in <Link to="/receiving/webhooks">Receiving → Webhooks</Link>.</p>
    </Section>,
  },
]
