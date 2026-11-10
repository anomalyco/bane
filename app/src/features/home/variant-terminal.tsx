import { useState } from 'react'
import { Button } from '../../components/ui'
import { ThemeToggle } from '../../components/ThemeToggle'
import { CopyAction } from '../../components/motion'
import type { HomeProps } from '.'
import './variant-terminal.css'

// Direction 1: the page reads like a man page whose synopsis is a real request and its real response.
const samples = {
  curl: {
    label: 'curl',
    copy: `curl https://bane.mx/v1/emails/send \\
  -H "Authorization: Bearer $BANE_API_KEY" \\
  --json '{
    "from": "receipts@example.com",
    "to": "ada@example.net",
    "subject": "Your receipt",
    "text": "Thank you for your order."
  }'`,
  },
  typescript: {
    label: 'typescript',
    copy: `import { createClient } from 'banemx/client'
import { sendEmail } from 'banemx'

const client = createClient({
  baseUrl: 'https://bane.mx',
  auth: scheme => scheme.scheme === 'bearer'
    ? process.env.BANE_API_KEY
    : undefined,
})

const { data } = await sendEmail({
  client,
  body: {
    from: 'receipts@example.com',
    to: 'ada@example.net',
    subject: 'Your receipt',
    text: 'Thank you for your order.',
  },
  throwOnError: true,
})`,
  },
} as const
type Sample = keyof typeof samples

const commands = [
  ['POST', '/v1/domains', 'add the domain you send from'],
  ['POST', '/v1/emails/send', 'send one email'],
  ['POST', '/v1/emails/batch', 'send up to 100 in one request'],
  ['POST', '/v1/campaigns/{id}/send', 'send a campaign to a list'],
  ['POST', '/v1/inbound/addresses', 'receive mail at an address'],
  ['POST', '/v1/inbound/webhooks', 'hear about it as it arrives'],
  ['POST', '/v1/inbound/threads/{threadId}/reply', 'reply inside the conversation'],
  ['GET', '/v1/inbound/threads/{threadId}', 'read the whole conversation'],
] as const

// The prompt and line continuations are typed in faint ink so the command itself reads first.
function Request({ sample }: { sample: Sample }) {
  const lines = samples[sample].copy.split('\n')
  return <code>{lines.map((line, index) => {
    const continued = line.endsWith(' \\')
    const text = continued ? line.slice(0, -2) : line
    return <span className="vt-line" key={index}>{sample === 'curl' && index === 0 && <span className="vt-faint" aria-hidden="true">$ </span>}{sample === 'curl' && index > 0 && <span aria-hidden="true">{'  '}</span>}{text}{continued && <span className="vt-faint"> \</span>}{'\n'}</span>
  })}</code>
}

export function TerminalHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const [sample, setSample] = useState<Sample>('curl')
  return <div className="vt-page">
    <header className="vt-header">
      <a className="wordmark" href="/" aria-label="bane home"><span className="wordmark-square" aria-hidden="true" />bane</a>
      <nav className="vt-nav" aria-label="Site">
        <a href="/docs">docs</a>
        <a className="vt-hide-narrow" href="/openapi.json">openapi.json</a>
        <ThemeToggle />
        <button type="button" className="vt-link" disabled={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>sign in</button>
      </nav>
    </header>

    <main className="vt-main">
      <section className="vt-section" aria-labelledby="vt-name">
        <h2 className="vt-heading">Name</h2>
        <h1 id="vt-name" className="vt-title">bane <span className="vt-faint">-</span> send, receive, reply to and thread email</h1>
      </section>

      <section className="vt-section" aria-label="Request">
        <h2 className="vt-heading">Request</h2>
        <div className="vt-block">
          <div className="vt-toolbar">
            <div className="vt-switch" role="group" aria-label="Request format">
              {(Object.keys(samples) as Sample[]).map(key => <button key={key} type="button" aria-pressed={sample === key} className="vt-switch-option" onClick={() => setSample(key)}>{samples[key].label}</button>)}
            </div>
            <CopyAction value={samples[sample].copy} label="Copy request" variant="ghost" size="sm" className="vt-copy" />
          </div>
          <pre className="vt-code"><Request sample={sample} /></pre>
        </div>
      </section>

      <section className="vt-section" aria-label="Response">
        <h2 className="vt-heading">Response</h2>
        <pre className="vt-code vt-response"><code>
          <span className="vt-line"><span className="vt-text">202 Accepted</span>{'\n'}</span>
          <span className="vt-line">{'{\n'}</span>
          <span className="vt-line">{'  "id": "email_0c6f2b9e4d1a…",\n'}</span>
          <span className="vt-line">{'  "status": "queued",\n'}</span>
          <span className="vt-line">{'  "simulated": false\n'}</span>
          <span className="vt-line">{'}\n'}</span>
          <span className="vt-line vt-faint">{'# queued now; email.delivered follows'}</span>
        </code></pre>
      </section>

      <section className="vt-section" aria-label="Environment">
        <h2 className="vt-heading">Environment</h2>
        <div className="vt-env">
          <code className="vt-text">BANE_API_KEY</code>
          <span>Created in the dashboard. <Button variant="ghost" className="vt-action" loading={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Sign in with Google</Button></span>
          {notice && <div className="vt-notice">{notice}</div>}
        </div>
      </section>

      <section className="vt-section" aria-label="Endpoints">
        <h2 className="vt-heading">Endpoints</h2>
        <dl className="vt-commands">
          {commands.map(([method, path, line]) => <div key={path}>
            <dt><span className="vt-method">{method}</span><code className="vt-text">{path}</code></dt>
            <dd>{line}</dd>
          </div>)}
        </dl>
      </section>

      <section className="vt-section" aria-label="Install">
        <h2 className="vt-heading">Install</h2>
        <div className="vt-facts">
          <div><code className="vt-text">npm i banemx</code><span>typescript sdk</span></div>
          <div><code className="vt-text">https://bane.mx/mcp</code><span>mcp server for coding agents</span></div>
        </div>
      </section>

      <section className="vt-section" aria-label="Notes">
        <h2 className="vt-heading">Notes</h2>
        <p className="vt-notes">Sent through Amazon SES. Pay per email; no monthly plan.</p>
      </section>

      <section className="vt-section" aria-label="See also">
        <h2 className="vt-heading">See also</h2>
        <p className="vt-see"><a href="/docs">docs</a>, <a href="/openapi.json">openapi.json</a>, <a href="https://www.npmjs.com/package/banemx">banemx</a></p>
      </section>
    </main>

    <footer className="vt-footer"><span>bane.mx</span><span>BANE(1)</span></footer>
  </div>
}
