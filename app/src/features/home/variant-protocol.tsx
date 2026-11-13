import { useEffect, useState, type CSSProperties } from 'react'
import { Button } from '../../components/ui'
import { ThemeToggle } from '../../components/ThemeToggle'
import type { HomeProps } from '.'
import './variant-protocol.css'
import { BaneWordmark } from '../../components/BaneLogo'

// Direction 3: one conversation as a sequence diagram. The four verbs are its legend; the brand square is the message.
type Lane = 0 | 1 | 2
type Verb = 'send' | 'receive' | 'reply' | 'thread'
type Step = { from: Lane; to: Lane; label: string; short?: string; note?: string; verb: Verb }
const lanes = [['your app', 'server'], ['bane', 'Amazon SES'], ['inbox', 'ada@example.net']] as const
const steps: Step[] = [
  { from: 0, to: 1, label: 'POST /v1/emails/send', short: 'sendEmail()', verb: 'send' },
  { from: 1, to: 0, label: '202 queued', note: 'email_0c6f…', verb: 'send' },
  { from: 1, to: 2, label: 'Your receipt', verb: 'send' },
  { from: 1, to: 0, label: 'email.delivered', verb: 'send' },
  { from: 2, to: 1, label: 'Re: Your receipt', verb: 'receive' },
  { from: 1, to: 0, label: 'message.received', note: 'thr_5d0b…', verb: 'receive' },
  { from: 0, to: 1, label: 'POST /v1/inbound/threads/thr_5d0b…/reply', short: 'replyToInboundThread()', verb: 'reply' },
  { from: 1, to: 2, label: 'Re: Your receipt', note: 'In-Reply-To set', verb: 'reply' },
  { from: 0, to: 1, label: 'GET /v1/inbound/threads/thr_5d0b…', short: 'getInboundThread()', verb: 'thread' },
  { from: 1, to: 0, label: '200', short: '200 · 2 messages', note: '2 messages', verb: 'thread' },
]
const verbs: { verb: Verb; word: string; rows: number }[] = (['send', 'receive', 'reply', 'thread'] as const).map(verb => ({ verb, word: `${verb[0].toUpperCase()}${verb.slice(1)}.`, rows: steps.filter(step => step.verb === verb).length }))
const stepDuration = 1700, finalHold = 3600

const prefersStill = () => matchMedia('(prefers-reduced-motion: reduce)').matches
// Advances one step at a time and loops. With reduced motion the whole conversation is shown at rest.
function useStep() {
  const [still] = useState(prefersStill)
  const [step, setStep] = useState(() => still ? steps.length : 0)
  useEffect(() => {
    if (still) return
    const timer = window.setTimeout(() => setStep(current => (current + 1) % steps.length), step === steps.length - 1 ? finalHold : stepDuration)
    return () => window.clearTimeout(timer)
  }, [step, still])
  return { step, still }
}

export function ProtocolHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const { step, still } = useStep()
  const activeVerb = steps[step]?.verb
  const verbState = (verb: Verb) => still || verb === activeVerb ? 'on' : 'off'
  return <div className="vp-page">
    <header className="vp-header">
      <a className="wordmark" href="/" aria-label="bane home"><BaneWordmark /></a>
      <nav className="vp-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
        <button type="button" className="vp-link" disabled={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Sign in</button>
      </nav>
    </header>

    <main className="vp-main">
      <h1 className="sr-only">Send, receive, reply to and thread email with bane</h1>
      <p className="vp-strip" aria-hidden="true">{verbs.map(({ verb, word }) => <span key={verb} data-state={verbState(verb)}>{word}</span>)}</p>

      <figure className="vp-figure" data-step={step}>
        <div className="vp-verbs" aria-hidden="true">
          {verbs.map(({ verb, word, rows }) => <div key={verb} style={{ height: `calc(${rows} * var(--vp-row))` }} data-state={verbState(verb)}>{word}</div>)}
        </div>
        <div className="vp-track">
          <div className="vp-lane-lines" aria-hidden="true"><i /><i /><i /></div>
          <div className="vp-lane-heads" aria-hidden="true">{lanes.map(([name, note]) => <span key={name}><b>{name}</b>{note}</span>)}</div>
          <ol className="vp-steps" aria-label="One conversation, step by step">
            {steps.map((item, index) => {
              const state = still || index < step ? 'done' : index === step ? 'active' : 'todo'
              const direction = item.to > item.from ? 'right' : 'left'
              const start = Math.min(item.from, item.to), span = Math.abs(item.to - item.from)
              return <li key={index} data-state={state} data-direction={direction} style={{ '--vp-from': item.from, '--vp-start': start, '--vp-span': span } as CSSProperties}>
                <span className="sr-only">{lanes[item.from][0]} to {lanes[item.to][0]}: </span>
                <span className="vp-label">
                  <span className={item.short ? 'vp-long' : undefined}>{item.label}</span>
                  {item.short && <span className="vp-short" aria-hidden="true">{item.short}</span>}
                  {item.note && <span className="vp-note">{item.note}</span>}
                </span>
                <span className="vp-arrow" aria-hidden="true">{state === 'active' && <span className="vp-runner" />}</span>
              </li>
            })}
          </ol>
        </div>
      </figure>

      <div className="vp-foot">
        <p>One API on Amazon SES, with a TypeScript SDK and an MCP server for coding agents.<br />Pay per email.</p>
        <div className="vp-actions">
          <Button variant="ghost" className="vp-action" loading={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Sign in with OIDC</Button>
          <a className="vp-secondary" href="/docs">Read the docs</a>
          <code className="vp-install">npm i @banemx/sdk</code>
        </div>
        {notice}
      </div>
    </main>

    <footer className="vp-footer">
      <span>bane.mx</span>
      <nav aria-label="Developer links"><a href="/openapi.json">openapi.json</a><a href="https://www.npmjs.com/package/@banemx/sdk">npm</a><a href="/docs">docs</a></nav>
    </footer>
  </div>
}
