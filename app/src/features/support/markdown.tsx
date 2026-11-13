import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router'

// The agent's restricted Markdown (support/PROTOCOL.md §4.2): paragraphs, **bold**, `code`, fenced code, numbered and
// bulleted lists, and links. Built as React elements, never HTML. Links render only to Bane's own sites and repository;
// any other URL stays plain text. While a message streams, an unclosed ** or ` styles the text so far instead of
// flashing the marker.
type Block = { type: 'p'; text: string } | { type: 'ul' | 'ol'; items: string[]; start: number } | { type: 'code'; text: string }

const ITEM = /^\s{0,3}(?:([-*•])|(\d{1,3})[.)])\s+(.*)$/
function blocks(source: string): Block[] {
  const out: Block[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = () => { if (paragraph.length) out.push({ type: 'p', text: paragraph.join('\n') }); paragraph = [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i])
      out.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      flush()
      const type = item[1] ? 'ul' : 'ol'
      const last = out.at(-1)
      // Items of one kind join a list, across blank lines too; anything else between them starts a new one.
      if (last && last.type === type) last.items.push(item[3])
      else out.push({ type, items: [item[3]], start: Number(item[2] ?? 1) })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const last = out.at(-1)
    // A wrapped list item continues on an indented line.
    if (!paragraph.length && last && last.type !== 'p' && last.type !== 'code' && /^\s{2,}\S/.test(line)) { last.items[last.items.length - 1] += ` ${line.trim()}`; continue }
    paragraph.push(line)
  }
  flush()
  return out
}

const SITES = new Set(['bane.mx', 'dev.bane.mx', 'support.bane.mx', 'support.dev.bane.mx'])
export function allowedLink(href: string): URL | null {
  let url: URL
  try { url = new URL(href) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (SITES.has(url.hostname)) return url
  return url.hostname === 'github.com' && /^\/anomalyco\/bane(?:[/?#]|$)/.test(url.pathname + url.search) ? url : null
}
function LinkTo({ url, children }: { url: URL; children: ReactNode }) {
  // A link into this dashboard navigates in place, so the conversation stays open beside it.
  if (url.origin === window.location.origin) return <Link to={url.pathname + url.search + url.hash}>{children}</Link>
  return <a href={url.href} target="_blank" rel="noopener noreferrer">{children}</a>
}

const CLOSED = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"’])/g
const OPEN = /`([^`\n]+)$|\*\*([^*\n]+)$/
function inline(text: string, streaming: boolean, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0, n = 0
  const plain = (value: string) => value.split('\n').forEach((line, index) => { if (index) out.push(<br key={`${key}b${n++}`} />); if (line) out.push(line) })
  for (const match of text.matchAll(CLOSED)) {
    plain(text.slice(at, match.index))
    at = match.index + match[0].length
    const k = `${key}${n++}`
    if (match[1] !== undefined) out.push(<code key={k}>{match[1]}</code>)
    else if (match[2] !== undefined) out.push(<strong key={k}>{inline(match[2], false, k)}</strong>)
    else if (match[3] !== undefined) { const url = allowedLink(match[4]); out.push(url ? <LinkTo key={k} url={url}>{match[3]}</LinkTo> : <Fragment key={k}>{match[3]} ({match[4]})</Fragment>) }
    else { const url = allowedLink(match[5]); out.push(url ? <LinkTo key={k} url={url}>{match[5]}</LinkTo> : match[5]) }
  }
  const rest = text.slice(at)
  const open = streaming ? OPEN.exec(rest) : null
  if (open) {
    plain(rest.slice(0, open.index))
    out.push(open[1] !== undefined ? <code key={`${key}o`}>{open[1]}</code> : <strong key={`${key}o`}>{open[2]}</strong>)
  } else plain(rest)
  return out
}

/** The message as blocks. `tail` (the streaming caret) goes at the end of the last block's text. */
export function Markdown({ text, streaming = false, tail }: { text: string; streaming?: boolean; tail?: ReactNode }) {
  const list = blocks(text)
  if (!list.length) return tail ? <p>{tail}</p> : null
  return <>{list.map((block, index) => {
    const end = index === list.length - 1 ? tail : null
    if (block.type === 'code') return <pre key={index}><code>{block.text}</code>{end}</pre>
    if (block.type === 'p') return <p key={index}>{inline(block.text, streaming && index === list.length - 1)}{end}</p>
    const items = block.items.map((item, i) => <li key={i}>{inline(item, streaming && !!end && i === block.items.length - 1)}{i === block.items.length - 1 ? end : null}</li>)
    return block.type === 'ul' ? <ul key={index}>{items}</ul> : <ol key={index} start={block.start === 1 ? undefined : block.start}>{items}</ol>
  })}</>
}
