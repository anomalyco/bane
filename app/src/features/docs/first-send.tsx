import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { Alert, Button, ErrorText, SectionHeader, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { useApi, useApiQuery, useSession } from '../../data/context'
import { request } from '../../data/live'
import type { Domain } from '../../data/types'
import { usePublicOrigin } from './agent-setup'
import './developer.css'

const simulator = ['success', 'bounce', 'complaint'].map(local => `${local}@simulator.amazonses.com`)

// The first send, filled in with this workspace's values. `apiKey` is the just-created secret, or null for
// the environment variable. Region is left out on purpose: the sender domain decides it.
export function sendSnippets({ origin, apiKey, from, to }: { origin: string; apiKey: string | null; from: string; to: string }) {
  const body = { from, to, subject: 'Hello from Bane', text: 'It works.' }
  const header = apiKey ? `"Authorization: Bearer ${apiKey}"` : '"Authorization: Bearer $BANE_API_KEY"'
  return {
    curl: `curl --request POST \\\n  --url '${origin}/v1/emails/send' \\\n  --header ${header} \\\n  --header 'Content-Type: application/json' \\\n  --header 'Idempotency-Key: first-email' \\\n  --data '${JSON.stringify(body)}'`,
    sdk: `import { createClient } from '@banemx/sdk/client'\nimport { sendEmail } from '@banemx/sdk'\n\nconst client = createClient({ baseUrl: '${origin}', auth: scheme => scheme.scheme === 'bearer' ? process.env.BANE_API_KEY : undefined })\nconst { data } = await sendEmail({ client, headers: { 'Idempotency-Key': 'first-email' }, throwOnError: true,\n  body: { from: '${from}', to: '${to}', subject: 'Hello from Bane', text: 'It works.' } })\nconsole.log(data.id) // 202: queued, not delivered yet`,
  }
}

const languages = [{ value: 'curl', label: 'cURL' }, { value: 'sdk', label: 'TypeScript' }]

// Sends a clearly labelled test from hello@<domain> to the signed-in user's own address, through the public send API.
export function TestSend({ domain, onSent }: { domain: Domain; onSent?: (id: string) => void }) {
  const identity = useSession()?.identity
  const to = identity?.email
  const from = `hello@${domain.name}`
  const verified = domain.status === 'verified'
  const test = useMutation({ mutationFn: () => request<{ id: string; status: string; simulated?: boolean }>('/v1/emails/send', { method: 'POST', idempotencyKey: crypto.randomUUID(),
    body: { from, to: [to], subject: 'Test email from Bane', text: `This is a test email from the Bane dashboard, sent from ${from}. You can reply to it or ignore it.` } }),
    onSuccess: data => onSent?.(data.id) })
  if (!to) return null
  return <>
    <div className="first-send-test">
      <Button loading={test.isPending} disabled={!verified || test.isSuccess} onClick={() => test.mutate()}><Send size={14} aria-hidden />Send a test email</Button>
      <span className="muted" role="status">{test.isSuccess ? <>Test email queued to {to}{test.data.simulated ? ' (simulated)' : ''}. <Link to={`/logs/${encodeURIComponent(test.data.id)}`}>View in Logs</Link></> : verified ? `From ${from} to ${to}.` : `Available once ${domain.name} is verified.`}</span>
    </div>
    {test.error ? <Alert tone="danger"><ErrorText error={test.error} /></Alert> : null}
  </>
}

/** Copyable curl and SDK examples plus a test send from the dashboard. Sending needs a verified domain. */
export function FirstSend({ domain, apiKey = null, title = 'Send your first email', testButton = true }: { domain: Domain | null; apiKey?: string | null; title?: string; testButton?: boolean }) {
  const origin = usePublicOrigin()
  const identity = useSession()?.identity
  const demo = useApi().mode === 'demo'
  const [language, setLanguage] = useState('curl')
  const to = identity?.email ?? 'you@example.com'
  const from = `hello@${domain?.name ?? 'acme.com'}`
  const snippets = sendSnippets({ origin, apiKey, from, to })
  return <section className="section stack developer-section" aria-label={title}>
    <SectionHeader title={title} />
    <div className="developer-client-bar">
      <Tabs label="Example language" value={language} onValueChange={setLanguage} items={languages} />
      <CopyAction key={language} value={snippets[language as 'curl' | 'sdk']} label={`Copy ${language === 'curl' ? 'cURL' : 'TypeScript'} example`} variant="ghost" size="sm" compact className="developer-copy-icon" />
    </div>
    <div className="developer-client-panels">{languages.map(item => <pre key={item.value} className="developer-code developer-client-panel" tabIndex={0} aria-label={`${item.label} example`} data-active={item.value === language || undefined} inert={item.value !== language}><code>{snippets[item.value as 'curl' | 'sdk']}</code></pre>)}</div>
    <p className="muted developer-copy">To test each outcome without a real inbox, send to {simulator.map((address, index) => <span key={address}>{index > 0 && (index === simulator.length - 1 ? ' or ' : ', ')}<code>{address}</code></span>)}. They don’t count against your sending limit.</p>
    {testButton && !demo && domain && <TestSend domain={domain} />}
  </section>
}

// Shown with a newly created API key: the same examples with that key and the workspace's first verified domain.
export function KeySendExample({ apiKey }: { apiKey: string }) {
  const domains = useApiQuery(['domains', 'key-example'], (api, signal) => api.domains.list({ page: 1, pageSize: 10, refresh: false }, signal))
  const items = domains.data?.items ?? []
  return <FirstSend domain={items.find(domain => domain.status === 'verified') ?? items[0] ?? null} apiKey={apiKey} title="Send with this key" testButton={false} />
}
