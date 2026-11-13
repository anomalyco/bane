import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { MAX_RULES, withFileRules } from './asset-headers.ts'
import { renderLegal } from './legal-markdown.ts'

// @react-email/editor's own "react-email" imports resolve to a slim shim (src/features/campaigns/react-email-shim.ts
// explains why); everything else, the shim included, gets the real package.
const reactEmailShim = fileURLToPath(new URL('./src/features/campaigns/react-email-shim.ts', import.meta.url))
const slimReactEmail: Plugin = {
  name: 'bane:slim-react-email', enforce: 'pre',
  resolveId(source, importer) { return source === 'react-email' && importer?.includes('/node_modules/@react-email/editor/') ? reactEmailShim : null },
}

// dist/_headers for Cloudflare: public/_headers, then a cache rule for each built file under assets/ and each font
// (asset-headers.ts explains why they are listed by name). The files every page loads come first, because past
// Cloudflare's rule limit the rest only revalidate.
const fileHeaders = (): Plugin => {
  let publicDir = '', outDir = ''
  return {
    name: 'bane:file-headers', apply: 'build',
    configResolved(config) { publicDir = config.publicDir; outDir = resolve(config.root, config.build.outDir) },
    writeBundle(_options, bundle) {
      const first = new Set<string>()
      const add = (name: string) => {
        const file = bundle[name]
        if (first.has(name) || !file) return
        first.add(name)
        if (file.type === 'chunk') for (const dependency of [...file.imports, ...file.viteMetadata?.importedCss ?? []]) add(dependency)
      }
      for (const file of Object.values(bundle)) if (file.type === 'chunk' && file.isEntry) add(file.fileName)
      const fonts = readdirSync(resolve(publicDir, 'fonts')).sort().map(name => `fonts/${name}`)
      const { headers, uncached } = withFileRules(readFileSync(resolve(publicDir, '_headers'), 'utf8'), [...first, ...fonts, ...Object.keys(bundle).sort()])
      writeFileSync(resolve(outDir, '_headers'), headers)
      if (uncached.length) this.warn(`${uncached.length} files have no cache rule and revalidate on every load (Cloudflare reads ${MAX_RULES} rules, and a rule needs a plain file name): ${uncached.join(', ')}`)
    },
  }
}

// The legal pages' Markdown becomes { title, description, updated, effective, html, headings } at build time
// (legal-markdown.ts), so the page ships HTML and no Markdown parser.
const legalMarkdown: Plugin = {
  name: 'bane:legal-markdown',
  transform(source, id) {
    if (!id.endsWith('.md')) return null
    return { code: `export default ${JSON.stringify(renderLegal(source, id))}`, map: null }
  },
}

// The commit a build was made from, recorded with each UI note (features/ui-notes). Only that lazy chunk reads it.
const buildSha = (() => {
  const named = process.env.BANE_BUILD_SHA ?? process.env.GITHUB_SHA
  if (named) return named.slice(0, 12)
  try { return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return 'unknown' }
})()

// Link-preview images need an absolute URL: the deploy sets VITE_PUBLIC_URL per stage; other builds name bane.mx.
const publicOrigin: Plugin = {
  name: 'bane:public-origin',
  transformIndexHtml: html => html.replaceAll('%BANE_ORIGIN%', (process.env.VITE_PUBLIC_URL || 'https://bane.mx').replace(/\/$/, '')),
}

export default defineConfig({
  define: { __BANE_BUILD__: JSON.stringify(buildSha) },
  plugins: [slimReactEmail, legalMarkdown, react(), fileHeaders(), publicOrigin],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: Object.fromEntries(['/v1', '/api/auth', '/mcp', '/.well-known', '/unsubscribe', '/health', '/openapi.json'].map(path => [path, {target: 'http://127.0.0.1:8793', changeOrigin: false}])),
  },
})
