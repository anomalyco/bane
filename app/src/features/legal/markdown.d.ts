// Markdown files are rendered at build time by the bane:legal-markdown plugin (app/legal-markdown.ts).
declare module '*.md' {
  const document: import('../../../legal-markdown').LegalDocument
  export default document
}
