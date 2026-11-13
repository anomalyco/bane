import { Button } from '../../components/ui'
import { ThemeToggle } from '../../components/ThemeToggle'
import type { HomeProps } from '.'
import './variant-editorial.css'
import { BaneWordmark } from '../../components/BaneLogo'
import { hostedDomain, sdkPackage } from '../../../../api/src/brand'

// Direction 2: one narrow column, four sentences, one verb each. Every fragment is a real SDK export.
const verbs = [
  ['Send', 'email from your domain.', 'sendEmail()'],
  ['Receive', 'it at any address.', 'createInboundAddress()'],
  ['Reply', 'from the same address.', 'replyToInboundThread()'],
  ['Thread', 'it into one conversation.', 'getInboundThread()'],
] as const

export function EditorialHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  return <div className="ve-page">
    <header className="ve-header">
      <a className="wordmark" href="/" aria-label="bane home"><BaneWordmark /></a>
      <nav className="ve-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <button type="button" className="ve-link" disabled={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Sign in</button>
        <ThemeToggle />
      </nav>
    </header>

    <main className="ve-main">
      <h1 className="sr-only">Send, receive, reply to and thread email with bane</h1>
      <ol className="ve-verbs">
        {verbs.map(([verb, rest, code]) => <li key={verb}>
          <p className="ve-sentence"><span className="ve-verb">{verb}</span> {rest}</p>
          <code className="ve-code">{code}</code>
        </li>)}
      </ol>

      <div className="ve-close">
        <p>An API, a TypeScript SDK and an MCP server for coding agents.<br />On Amazon SES. Pay per email.</p>
        <code className="ve-install">npm i {sdkPackage}</code>
        <div className="ve-actions">
          <Button variant="ghost" className="ve-action" loading={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Sign in with OIDC</Button>
          <a className="ve-secondary" href="/docs">Read the docs</a>
        </div>
        {notice}
      </div>
    </main>

    <footer className="ve-footer">
      <span>{hostedDomain}</span>
      <nav aria-label="Developer links"><a href="/openapi.json">openapi.json</a><a href={`https://www.npmjs.com/package/${sdkPackage}`}>npm</a></nav>
    </footer>
  </div>
}
