import { useState } from 'react'
import { Download } from 'lucide-react'
import { Field, SectionHeader, Select, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { usePublicOrigin } from '../../data/context'
import type { Domain } from '../../data/types'
import { recordsFor } from '../settings/domain-records'
import './developer.css'

// The canonical public origin from /v1/me; the page origin stands in for demo mode.
function receivingMx(domain: Domain) {
  const record = recordsFor(domain, 'receiving').find(row => row.type === 'MX')
  const match = record?.value.match(/^(\d+)\s+(\S+)$/)
  return record ? { name: record.name, host: match ? match[2] : record.value, priority: match ? match[1] : '10' } : null
}

// domain is undefined when the reader is signed out and the workspace's domains are unknown.
export function agentPrompt({ origin, domain, email, multiTenant }: { origin: string; domain: Domain | null | undefined; email: string | null; multiTenant: boolean }) {
  const lines = [
    'Set up Bane email in this project.',
    '',
    `- API base URL: ${origin}`,
    `- Read the docs first: ${origin}/llms.txt (agent-readable index) and ${origin}/docs.md (full API reference).`,
    `- Install the TypeScript SDK: npm i @banemx/sdk. Create the client with createClient from '@banemx/sdk/client' (baseUrl ${origin}) and call it from server code only.`,
    '- Auth: bearer API key from the BANE_API_KEY environment variable. Never hardcode it or ship it to a browser.',
  ]
  if (domain === undefined) {
    lines.push('- Sending domain: use a verified domain from Domains in the Bane dashboard. Ask me which one before sending.')
    return lines.join('\n')
  }
  if (!domain) {
    lines.push('- Sending domain: none yet. Ask me to add one under Domains in the Bane dashboard before sending.')
    return lines.join('\n')
  }
  const verified = domain.status === 'verified'
  const to = email ?? 'an address I control (ask me which)'
  lines.push(
    `- Sending domain: ${domain.name} (${multiTenant ? '' : `region ${domain.regionId}, `}status: ${verified ? 'verified' : 'pending; its DNS records verify automatically, and sending works once verified'}).`,
    `- Send a test email from hello@${domain.name} to ${to} with sendEmail (POST /v1/emails/send)${multiTenant ? '' : `, region "${domain.regionId}"`} and an Idempotency-Key header. 202 means queued, not delivered.`,
  )
  const mx = receivingMx(domain)
  // Hosted suggests reply.<domain>; never tell an agent to change the root MX, which would move the domain's existing mail.
  if (mx) lines.push(multiTenant
    ? `- Receiving (optional, only if I ask for it): add an MX record on ${mx.name} pointing to ${mx.host} (priority ${mx.priority}); receiving turns on automatically once it resolves.${mx.name === domain.name ? '' : ` Don't change the MX records of ${domain.name} itself: that would move its existing mailboxes to Bane.`}`
    : `- Receiving: enable it with POST /v1/inbound/domains/${domain.id}/enable, then point the MX record for ${mx.name} to ${mx.host} (priority ${mx.priority}).`)
  lines.push('- Inbound mail arrives as message.received webhooks (subscribe with POST /v1/inbound/webhooks); fetch full messages with GET /v1/inbound/messages/{messageId}.')
  return lines.join('\n')
}

// A data URL needs no object URL to revoke, so the download can't race the cleanup.
function downloadText(name: string, text: string) {
  Object.assign(document.createElement('a'), { href: `data:text/plain;charset=utf-8,${encodeURIComponent(text + '\n')}`, download: name }).click()
}

// A null prompt is still loading: the section keeps its place and its actions stay hidden.
export function AgentPrompt({ prompt }: { prompt: string | null }) {
  return <section id="agent-prompt" className="section stack developer-section" aria-label="Agent prompt" aria-busy={prompt === null || undefined}>
    <SectionHeader title="Agent prompt" actions={<span className="developer-icon-actions" data-pending={prompt === null || undefined} inert={prompt === null}>
      <button type="button" className="ui-button ui-button--ghost ui-button--sm developer-copy-icon" aria-label="Download agent prompt as .txt" title="Download as .txt" onClick={() => downloadText('bane-agent-prompt.txt', prompt ?? '')}><Download size={14} aria-hidden="true" /></button>
      <CopyAction value={prompt ?? ''} label="Copy agent prompt" variant="ghost" size="sm" compact className="developer-copy-icon" />
    </span>} />
    <p className="muted developer-copy">Paste this into your coding agent, or download it as a .txt file for it to read. It has this workspace’s real values; the API key stays in your environment.</p>
    <pre className="developer-code developer-code--wrap" tabIndex={0} aria-label="Agent prompt"><code>{prompt ?? ''}</code></pre>
  </section>
}

const accessOptions = [
  { value: 'read', label: 'Read only', scope: 'bane:read offline_access', hint: 'Read data without sending email.' },
  { value: 'manage', label: 'Full access', scope: 'bane:read bane:send bane:manage offline_access', hint: 'Includes sending email and changing configuration.' },
]
const clients = [{ value: 'opencode', label: 'OpenCode' }, { value: 'claude', label: 'Claude Code' }, { value: 'cursor', label: 'Cursor' }]

// The hosted MCP server and per-client setup. Without chooseAccess, OpenCode requests full access.
export function McpSetup({ chooseAccess = false }: { chooseAccess?: boolean }) {
  const [client, setClient] = useState('opencode')
  const [access, setAccess] = useState(chooseAccess ? 'read' : 'manage')
  const selected = accessOptions.find(option => option.value === access) ?? accessOptions[0]
  const serverUrl = new URL('/mcp', usePublicOrigin()).href
  const snippets: Record<string, string> = {
    claude: `claude mcp add --transport http bane ${serverUrl}`,
    cursor: JSON.stringify({ mcpServers: { bane: { url: serverUrl } } }, null, 2),
    opencode: JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { bane: { type: 'remote', url: serverUrl, oauth: { scope: selected.scope } } } } }, null, 2),
  }
  const snippet = snippets[client]
  const label = clients.find(item => item.value === client)!.label
  return <section id="mcp" className="section stack developer-section" aria-label="MCP server">
    <SectionHeader title="MCP server" />
    <div className="developer-url"><code>{serverUrl}</code><CopyAction value={serverUrl} label="Copy MCP URL" variant="ghost" size="sm" compact className="developer-copy-icon" /></div>
    <p className="muted developer-copy">Add this URL as a remote HTTP server in your MCP client. Authorization uses your dashboard’s Google login; no API key or local MCP process is needed.</p>
    <div className="developer-client-bar">
      <Tabs label="MCP client" value={client} onValueChange={setClient} items={clients} />
      <CopyAction key={`${client}-${access}`} value={snippet} label={`Copy ${label} setup`} variant="ghost" size="sm" compact className="developer-copy-icon" />
    </div>
    {/* Every client's setup is laid out in one cell, so switching tabs never changes the section's height. */}
    <div className="developer-client-panels">{clients.map(({ value, label: name }) => <div key={value} className="stack developer-client-panel" data-active={value === client || undefined} inert={value !== client}>
      {value === 'opencode' && chooseAccess && <div className="developer-access">
        <Field label="Requested access" htmlFor="developer-mcp-access" hint={selected.hint}>
          <Select id="developer-mcp-access" value={access} onValueChange={setAccess} options={accessOptions} />
        </Field>
      </div>}
      <pre className={value === 'claude' ? 'developer-code developer-code--wrap' : 'developer-code'} tabIndex={0} aria-label={`${name} setup`}><code>{snippets[value]}</code></pre>
      {value === 'opencode' ? <ol className="developer-steps">
        <li>Merge this entry into your project or global <code>opencode.json</code>. Keep your existing servers and settings.</li>
        <li>Open <code>/mcps</code>, select <strong>bane</strong>, then choose <strong>Sign in</strong>.</li>
        <li>Approve the requested access in your browser. A dashboard session in that browser profile skips Google sign-in.</li>
      </ol> : value === 'claude' ? <ol className="developer-steps">
        <li>Run this in your project’s terminal.</li>
        <li>In Claude Code, run <code>/mcp</code>, select <strong>bane</strong>, then choose <strong>Authenticate</strong>.</li>
      </ol> : <ol className="developer-steps">
        <li>Merge this into <code>.cursor/mcp.json</code> in your project, or <code>~/.cursor/mcp.json</code> for every project.</li>
        <li>In Cursor Settings, open <strong>MCP</strong> and sign in to <strong>bane</strong>.</li>
      </ol>}
      {value !== 'opencode' && <p className="muted developer-copy">{name} signs in with read access. Your code sends with the SDK and API key.</p>}
      {value === 'opencode' && chooseAccess && <p className="muted developer-copy">Changing access only updates the configuration above; reconnect and authorize again to apply it.</p>}
    </div>)}</div>
  </section>
}
