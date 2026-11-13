// The legal pages (src/features/legal/content/*.md), rendered to HTML when the dashboard builds: a front matter block
// (title, description, updated, effective) and Markdown. Every heading gets a stable id from its words without the
// section number ("5.7 Refunds and credit expiry" is #refunds-and-credit-expiry, so renumbering never breaks a link)
// and a hover anchor; prose gets curly quotes and apostrophes; a table scrolls inside its own box on a phone.
// The source is ours and trusted, so the HTML is rendered as is.
import { Marked, type Tokens } from 'marked'

export type LegalHeading = { id: string; depth: number; html: string }
export type LegalDocument = { title: string; description: string; updated: string; effective: string; html: string; headings: LegalHeading[] }

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// Straight quotes to curly: an opening quote follows the start, a space or an opening bracket; anything else closes.
const smart = (text: string) => text.replace(/(^|[\s([{—-])"/g, '$1“').replace(/"/g, '”').replace(/(^|[\s([{—-])'/g, '$1‘').replace(/'/g, '’')
const plain = (text: string) => text.replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
const slug = (text: string) => plain(text).toLowerCase().replace(/^(\d+(\.\d+)*\.?|\([a-z]\))\s+/, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function frontMatter(source: string, file: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source)
  if (!match) throw new Error(`${file}: missing front matter`)
  const fields = Object.fromEntries(match[1]!.split('\n').map(line => { const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()] }))
  for (const key of ['title', 'description', 'updated', 'effective']) if (!fields[key]) throw new Error(`${file}: front matter needs ${key}`)
  return { fields: fields as Record<'title' | 'description' | 'updated' | 'effective', string>, body: source.slice(match[0].length) }
}

export function renderLegal(source: string, file: string): LegalDocument {
  const { fields, body } = frontMatter(source.replace(/\r\n/g, '\n'), file)
  const headings: LegalHeading[] = [], used = new Set<string>()
  const marked = new Marked({ gfm: true, renderer: {
    text(token: Tokens.Text | Tokens.Escape) { return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : 'escaped' in token && token.escaped ? token.text : escape(smart(token.text)) },
    heading({ tokens, depth, text }: Tokens.Heading) {
      const html = this.parser.parseInline(tokens)
      let id = slug(text) || 'section'
      for (let n = 2; used.has(id); n++) id = `${slug(text)}-${n}`
      used.add(id)
      headings.push({ id, depth, html })
      return `<h${depth} id="${id}">${html}<a class="legal-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`
    },
    table(token: Tokens.Table) {
      const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens)
      const head = `<tr>${token.header.map(c => `<th scope="col">${cell(c)}</th>`).join('')}</tr>`
      const rows = token.rows.map(row => `<tr>${row.map(cell).map(html => `<td>${html}</td>`).join('')}</tr>`).join('\n')
      return `<div class="legal-table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`
    },
    link({ href, tokens }: Tokens.Link) {
      const external = /^https?:/.test(href)
      return `<a href="${escape(href)}"${external ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`
    },
  } })
  const html = marked.parse(body, { async: false })
  if (headings.length === 0 || headings.some(h => h.depth === 1)) throw new Error(`${file}: use ## headings and below; the title comes from the front matter`)
  return { ...fields, html, headings }
}
