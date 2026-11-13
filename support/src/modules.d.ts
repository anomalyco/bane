// Markdown is bundled as text (wrangler "rules": Text for **/*.md): the system prompt and the voice guide.
declare module '*.md' {
  const text: string;
  export default text;
}
