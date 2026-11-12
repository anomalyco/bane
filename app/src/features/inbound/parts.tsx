import { Archive, Asterisk, AtSign, Ban, Bot, Clock, Forward, Hash, Inbox, MessageSquare, Plus, ScrollText, Webhook } from 'lucide-react'
import type { ReactNode } from 'react'
import { outcomes } from './concepts'
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

/** An address or pattern, host quieter so a column of them reads by local part; wildcards stand out so reply+*@ never reads as reply++@. */
export function Match({ value, host = true }: { value: string; host?: boolean }) {
  const at = value.lastIndexOf('@')
  const local = (at < 0 ? value : value.slice(0, at)).split('*')
  return <span className="rcv-match" title={value}><span className="rcv-match__local">{local.map((part, i) => <span key={i}>{i > 0 && <span className="rcv-wild">*</span>}{part}</span>)}</span>{host && at >= 0 && <span className="rcv-match__host">{value.slice(at)}</span>}</span>
}

export const targetName = (t: Target, ownId?: string | null) => t.type === 'inbox' ? (t.id === ownId ? 'Inbox' : `${t.name} inbox`) : t.type in outcomes ? outcomes[t.type as keyof typeof outcomes] : t.name
export function Targets({ to, ownId, max = 3 }: { to: Target[]; ownId?: string | null; max?: number }) {
  if (!to.length) return <span className="muted">—</span>
  return <span className="rcv-targets">{to.slice(0, max).map(t => <span key={`${t.type}:${t.id}`} className="rcv-target" data-muted={t.type === 'store' || t.type === 'drop' || t.status === 'paused' || undefined}
    title={`${typeLabel[t.type]}${t.via ? ` · sent by the ${t.via} ritual, for the mail it chooses` : ''}`}>
    <TargetIcon type={t.type} size={13} /><span>{targetName(t, ownId)}</span>{t.via && <span className="rcv-via">via {t.via}</span>}
  </span>)}{to.length > max && <span className="muted">+{to.length - max}</span>}</span>
}

export function Chain({ keys, empty }: { keys: string[]; empty?: ReactNode }) {
  if (!keys.length) return <>{empty ?? <span className="muted">—</span>}</>
  return <span className="rcv-chain">{keys.map((k, i) => <span key={k}>{i > 0 && <span className="rcv-chain__then" aria-hidden="true">→</span>}<code>{k}</code></span>)}</span>
}

/** One plain line about a concept, with an example in code type. */
export function ConceptLine({ line, example }: { line: string; example?: string }) {
  return <p className="rcv-concept"><span>{line}</span>{example && <code>{example}</code>}</p>
}
