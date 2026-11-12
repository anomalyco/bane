// What @react-email/editor imports as "react-email" (vite.config.ts points only the editor's own imports here).
// The editor reads `import * as ReactEmailComponents from "react-email"` to look up code-block themes, and that
// namespace import keeps every react-email export in the bundle: the Tailwind compiler, Markdown, css-tree. Bane
// saves through its own block serializer (block-content.ts) and never calls the editor's HTML export, so the
// composer needs only the components below; the export path (render, Prettier, html-to-text) loads on first use.
// Code-block themes then fall back to the editor's default theme, which only that unused export reads.
import { createElement, forwardRef, type CSSProperties, type HTMLAttributes } from 'react'
export { Body, Button, Column, Container, Head, Heading, Hr, Html, Img, Link, Preview, Row, Section } from 'react-email'

type Render = typeof import('@react-email/render')
const exporter = () => import('@react-email/render')
export const render: Render['render'] = async (...args) => (await exporter()).render(...args)
export const pretty: Render['pretty'] = async (...args) => (await exporter()).pretty(...args)
// The editor awaits this alongside pretty(), so returning a promise is compatible.
export const toPlainText = (async (...args: Parameters<Render['toPlainText']>) => (await exporter()).toPlainText(...args)) as unknown as Render['toPlainText']

// react-email's CodeBlock bundles Prism with every language (about 600 KB) to colour code in exported HTML. Bane's
// serializer sends code blocks as plain <pre><code>, so the editor's (unused) export renders them the same way.
type CodeBlockProps = { code: string; language?: string; theme?: { base?: CSSProperties }; fontFamily?: string; lineNumbers?: boolean } & HTMLAttributes<HTMLPreElement>
export const CodeBlock = forwardRef<HTMLPreElement, CodeBlockProps>(({ code, theme, style, fontFamily, lineNumbers: _lineNumbers, language: _language, ...rest }, ref) =>
  createElement('pre', { ...rest, ref, style: { ...theme?.base, width: '100%', ...style } }, createElement('code', { style: fontFamily ? { fontFamily } : undefined }, code)))
