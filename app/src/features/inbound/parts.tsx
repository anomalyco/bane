import { Archive, Asterisk, AtSign, Ban, Bot, Clock, Forward, Hash, Inbox, MessageSquare, Plus, ScrollText, Webhook } from 'lucide-react'
import type { ReactNode } from 'react'
import { outcomes } from './concepts'
import { PrivateAddress, useMasked } from '../../components/PrivateAddress'
import { isMailbox } from '../../lib/private-address'
import { typeLabel, type RouteEntry, type Target, type TargetType } from './overview'

const targetIcons: Record<TargetType, typeof Inbox> = { inbox: Inbox, webhook: Webhook, slack: Hash, discord: MessageSquare, forward: Forward, store: Archive, drop: Ban, create_address: Plus }
export function TargetIcon({ type, size = 14 }: { type: TargetType; size?: number }) {
  const Icon = targetIcons[type]
  return <Icon className="rcv-icon" size={size} aria-hidden="true" />
}
export function RouteIcon({ entry, size = 14 }: { entry: Pick<RouteEntry, 'kind' | 'address'>; size?: number }) {
  const Icon = entry.kind === 'inbox' ? Bot : entry.kind === 'pattern' || entry.kind === 'catch_all' ? Asterisk : entry.address?.origin === 'auto' ? Plus : entry.address?.expiresAt ? Clock : AtSign
  return <Icon className="rcv-icon" size={size} aria-hidden="true" />
}
export const RitualIcon = ({ size = 14 }: { size?: number }) => <ScrollText className="rcv-icon" size={size} aria-hidden="true" />

const wild = (text: string) => text.split('*').map((part, i) => <span key={i}>{i > 0 && <span className="rcv-wild">*</span>}{part}</span>)
/** An address or pattern, host quieter so a column of them reads by local part; wildcards stand out so reply+*@ never reads as reply++@.
 * Mailbox addresses and patterns are masked like every address (lib/private-address.ts); *@host and hosts stay readable. */
export function Match({ value, host = true }: { value: string; host?: boolean }) {
  const at = value.lastIndexOf('@'), local = at < 0 ? value : value.slice(0, at), domain = host && at >= 0 ? value.slice(at) : ''
  if (!isMailbox(value)) return <span className="rcv-match" title={value}><span className="rcv-match__local">{wild(local)}</span>{domain && <span className="rcv-match__host">{domain}</span>}</span>
  return <MaskedMatch local={local} domain={domain} />
}
// The masked form holds the first two characters of the local part; the rest and the host arrive when it is revealed.
function MaskedMatch({ local, domain }: { local: string; domain: string }) {
  const masked = useMasked(local + domain), shown = [...local].slice(0, 2).join('')
  return <span {...masked.root} className="rcv-match private-address">
    <span ref={masked.box} className="private-address__value">{masked.revealed
      ? <><span className="rcv-match__local">{wild(local)}</span>{domain && <span className="rcv-match__host">{domain}</span>}</>
      : <>{wild(shown)}<span className="private-address__rest" aria-hidden="true" /></>}</span>
  </span>
}

export const targetName = (t: Target, ownId?: string | null) => t.type === 'inbox' ? (t.id === ownId ? 'Inbox' : `${t.name} inbox`) : t.type in outcomes ? outcomes[t.type as keyof typeof outcomes] : t.name
/** Where a route's mail goes, the first few by name; total is the complete list's size when to is only part of it. */
export function Targets({ to, ownId, max = 3, total = to.length }: { to: Target[]; ownId?: string | null; max?: number; total?: number }) {
  if (!to.length) return <span className="muted">—</span>
  return <span className="rcv-targets">{to.slice(0, max).map(t => <span key={`${t.type}:${t.id}`} className="rcv-target" data-muted={t.type === 'store' || t.type === 'drop' || t.status === 'paused' || undefined}
    title={`${typeLabel[t.type]}${t.via ? ` · sent by the ${t.via} ritual, for the mail it chooses` : ''}`}>
    <TargetIcon type={t.type} size={13} /><span>{t.type === 'inbox' && t.id !== ownId ? <><PrivateAddress value={t.name} /> inbox</> : <PrivateAddress value={targetName(t, ownId)} />}</span>{t.via && <span className="rcv-via">via {t.via}</span>}
  </span>)}{total > Math.min(max, to.length) && <span className="muted">+{total - Math.min(max, to.length)}</span>}</span>
}

export function Chain({ keys, empty }: { keys: string[]; empty?: ReactNode }) {
  if (!keys.length) return <>{empty ?? <span className="muted">—</span>}</>
  return <span className="rcv-chain">{keys.map((k, i) => <span key={k}>{i > 0 && <span className="rcv-chain__then" aria-hidden="true">→</span>}<code>{k}</code></span>)}</span>
}

/** One plain line about a concept, with an example in code type. */
export function ConceptLine({ line, example }: { line: string; example?: string }) {
  return <p className="rcv-concept"><span>{line}</span>{example && <code>{example}</code>}</p>
}
