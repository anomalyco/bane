import { useEffect, useLayoutEffect, useState, type MouseEvent } from 'react'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router'
import { ThemeToggle } from '../../components/ThemeToggle'
import { EmptyState } from '../../components/ui'
import { legalLinks } from '../../components/LegalLinks'
import terms from './content/terms.md'
import acceptableUse from './content/acceptable-use.md'
import privacy from './content/privacy.md'
import subprocessors from './content/subprocessors.md'
import './legal.css'
import { BaneWordmark } from '../../components/BaneLogo'
import { addresses } from '../../../../api/src/brand'

// Public pages, no sign-in: /legal and one page per document. The documents are Markdown in ./content, rendered to HTML
// when the dashboard builds (app/legal-markdown.ts).
const documents = { terms, 'acceptable-use': acceptableUse, privacy, subprocessors } as const
type Slug = keyof typeof documents
const isSlug = (value: string | undefined): value is Slug => value !== undefined && Object.hasOwn(documents, value)

const ENTITY = 'Anomaly Innovations, Inc.'
const ADDRESS = '2443 Fillmore St #380-6343, San Francisco, CA 94115, United States'
const contacts = [['Support and billing', addresses.support], ['Abuse reports', addresses.abuse], ['Privacy and data requests', addresses.privacy], ['Legal notices', addresses.legal]] as const

export function LegalPage() {
  const { doc } = useParams()
  const location = useLocation(), navigate = useNavigate()
  const current = isSlug(doc) ? documents[doc] : null
  const title = doc === undefined ? 'Legal' : current?.title ?? 'Page not found'
  useEffect(() => { document.title = `${title} · bane` }, [title])
  // A new document opens at its top, or at the section its link names.
  useLayoutEffect(() => {
    const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null
    if (target) target.scrollIntoView({ block: 'start' })
    else window.scrollTo(0, 0)
  }, [location.pathname, location.hash])
  // Links between the documents stay in the app; a section link on the same page scrolls natively.
  function follow(event: MouseEvent<HTMLElement>) {
    const link = (event.target as HTMLElement).closest('a')
    const href = link?.getAttribute('href')
    if (!link || !href?.startsWith('/') || link.target || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(href)
  }
  return <div className="legal-page">
    <header className="legal-header">
      <Link className="wordmark" to="/" aria-label="bane home"><BaneWordmark /></Link>
      <nav className="legal-switcher" aria-label="Legal documents">
        <NavLink to="/legal" end>Overview</NavLink>
        {legalLinks.map(([slug, label]) => <NavLink key={slug} to={`/legal/${slug}`}>{label}</NavLink>)}
      </nav>
      <ThemeToggle />
    </header>
    {doc === undefined ? <LegalIndex /> : current ? <LegalDocumentView key={doc} document={current} onFollow={follow} /> : <main className="legal-main"><EmptyState headingAs="h1" title="Page not found" action={<Link to="/legal">All legal documents</Link>} /></main>}
    <footer className="legal-footer">
      <p>{ENTITY} · {ADDRESS}</p>
      <nav aria-label="Legal contacts">{contacts.map(([label, address]) => <a key={address} href={`mailto:${address}`} title={label}>{address}</a>)}</nav>
    </footer>
  </div>
}

function LegalIndex() {
  return <main className="legal-main legal-index">
    <div className="legal-intro">
      <h1>Legal</h1>
      <p>Bane is provided by {ENTITY}. These are the terms and policies that apply to it.</p>
    </div>
    <ul className="legal-documents">
      {legalLinks.map(([slug]) => { const item = documents[slug]; return <li key={slug}>
        <Link to={`/legal/${slug}`}><strong>{item.title}</strong><span>{item.description}</span><span className="legal-dates">Last updated {item.updated}</span></Link>
      </li> })}
    </ul>
    <section className="legal-index-section" aria-labelledby="legal-dpa">
      <h2 id="legal-dpa">Data Processing Addendum</h2>
      <p>Available to business customers on request: email <a href={`mailto:${addresses.privacy}`}>{addresses.privacy}</a>.</p>
    </section>
    <section className="legal-index-section" aria-labelledby="legal-contact">
      <h2 id="legal-contact">Contact</h2>
      <p>{ENTITY}<br />{ADDRESS}</p>
      <dl className="legal-contacts">{contacts.map(([label, address]) => <div key={address}><dt>{label}</dt><dd><a href={`mailto:${address}`}>{address}</a></dd></div>)}</dl>
    </section>
  </main>
}

function LegalDocumentView({ document: item, onFollow }: { document: typeof terms; onFollow: (event: MouseEvent<HTMLElement>) => void }) {
  const sections = item.headings.filter(heading => heading.depth === 2)
  const active = useActiveSection(sections.map(section => section.id))
  const contents = (className: string, current: string | null) => <ol className={className}>{sections.map(section => <li key={section.id}><a href={`#${section.id}`} aria-current={current === section.id ? 'location' : undefined} dangerouslySetInnerHTML={{ __html: section.html }} /></li>)}</ol>
  return <div className="legal-layout">
    <nav className="legal-toc" aria-label="On this page">
      <p className="legal-eyebrow">On this page</p>
      {contents('legal-toc-list', active)}
    </nav>
    <main className="legal-main">
      <article className="legal-article" onClick={onFollow}>
        <header className="legal-intro">
          <h1>{item.title}</h1>
          <p className="legal-dates">Last updated {item.updated} · Effective {item.effective}</p>
        </header>
        <details className="legal-toc-inline">
          <summary>Contents</summary>
          {contents('legal-toc-list', null)}
        </details>
        <div className="legal-body" dangerouslySetInnerHTML={{ __html: item.html }} />
      </article>
    </main>
  </div>
}

// The section being read: the last heading above a line a quarter of the way down the window.
function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      const line = window.innerHeight / 4
      let current: string | null = null
      for (const id of ids) { const top = document.getElementById(id)?.getBoundingClientRect().top; if (top !== undefined && top <= line) current = id }
      setActive(current ?? ids[0] ?? null)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule) }
  }, [ids.join(' ')])
  return active
}
