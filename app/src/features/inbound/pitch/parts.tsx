import { Archive, AtSign, Ban, Bot, Clock, Forward, Hash, Inbox, MessageSquare, Plus, Asterisk, Webhook, ScrollText } from 'lucide-react'
import type { ReactNode } from 'react'
import { destKindLabel, type Dest, type DestKind, type Entry, type EntryKind } from './model'

const destIcons: Record<DestKind, typeof Inbox> = { inbox: Inbox, webhook: Webhook, slack: Hash, discord: MessageSquare, forward: Forward, keep: Archive, drop: Ban, create: Plus }
export function DestIcon({ kind, size = 14 }: { kind: DestKind; size?: number }) {
  const Icon = destIcons[kind]
  return <Icon className="pitch-icon" size={size} aria-hidden="true" />
}
const entryIcons: Partial<Record<EntryKind, typeof Inbox>> = { address: AtSign, temporary: Clock, agent: Bot, auto: Plus, pattern: Asterisk, catchall: Asterisk, route: AtSign }
export function EntryIcon({ kind, size = 14 }: { kind: EntryKind; size?: number }) {
  const Icon = entryIcons[kind] ?? AtSign
  return <Icon className="pitch-icon" size={size} aria-hidden="true" />
}
export const RitualIcon = ({ size = 14 }: { size?: number }) => <ScrollText className="pitch-icon" size={size} aria-hidden="true" />

/** An address or pattern with its host quieter, so a column of them reads by local part. */
export function Match({ value, host = true }: { value: string; host?: boolean }) {
  const at = value.lastIndexOf('@')
  const local = value.slice(0, at).split('*')
  // Wildcards stand out from the letters around them, so reply+*@ never reads as reply++@.
  return <span className="pitch-match" title={value}><span>{local.map((part, i) => <span key={i}>{i > 0 && <span className="pitch-wild">*</span>}{part}</span>)}</span>{host && <span className="pitch-match__host">{value.slice(at)}</span>}</span>
}

export function DestNames({ to, max = 3 }: { to: Dest[]; max?: number }) {
  if (!to.length) return <span className="muted">—</span>
  return <span className="pitch-dests">{to.slice(0, max).map(d => <span key={d.id} className="pitch-dest" data-muted={d.kind === 'keep' || d.kind === 'drop' || d.paused || undefined}><DestIcon kind={d.kind} size={13} /><span>{d.kind === 'inbox' ? 'Inbox' : d.name}{d.paused ? ' (paused)' : d.pending ? ' (unconfirmed)' : ''}</span></span>)}{to.length > max && <span className="muted">+{to.length - max}</span>}</span>
}

export function Chain({ keys, empty = '—' }: { keys: string[]; empty?: ReactNode }) {
  if (!keys.length) return <span className="muted">{empty}</span>
  return <span className="pitch-chain">{keys.map((k, i) => <span key={k}>{i > 0 && <span className="pitch-chain__then" aria-hidden="true">→</span>}<code>{k}</code></span>)}</span>
}

/** The one-line reading of an entry: "Mail to X runs Y, then goes to Z; Y can also send it to W." */
export function Sentence({ entry }: { entry: Entry }) {
  const name = (d: Dest) => d.kind === 'inbox' ? (d.id === entry.owner?.id ? 'its inbox' : `${d.name}’s inbox`) : d.kind === 'keep' ? 'kept without an inbox' : d.kind === 'drop' ? 'dropped' : d.kind === 'create' ? 'a new address per sender' : `${d.name} (${destKindLabel[d.kind]})`
  const join = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? 'nowhere'
  const routed = entry.to.filter(d => !entry.via[d.id]), extra = entry.to.filter(d => entry.via[d.id])
  const subject = entry.kind === 'catchall' ? <>Anything else at <strong>{entry.host}</strong></> : <>Mail to <strong>{entry.match}</strong>{entry.aliases.length > 0 && <> (and {entry.aliases.length === 1 ? entry.aliases[0] : `${entry.aliases.length} aliases`})</>}</>
  return <p className="pitch-sentence">{subject}{entry.rituals.length > 0 && <> runs <strong>{entry.rituals.join(' → ')}</strong>, then</>} {routed.some(d => d.kind === 'drop') ? 'is' : 'goes to'} <strong>{join(routed.map(name))}</strong>{extra.length > 0 && <>; {join([...new Set(extra.map(d => entry.via[d.id]!))])} can also send it to <strong>{join(extra.map(name))}</strong></>}.</p>
}
