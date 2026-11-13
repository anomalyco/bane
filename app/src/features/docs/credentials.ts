// Every credential Nightmail has, in one plain line each: the API keys page and the Keys guide in Docs say the same thing.
export const credentials: { name: string; line: string; where: string }[] = [
  { name: 'API key', line: 'Your server, a script or an agent uses it: the whole workspace, sending only, or just chosen addresses or one inbox.', where: 'API keys → Create key' },
  { name: 'Agent token', line: 'An agent such as OpenCode or Claude Code signed in as you over MCP, and the short-lived tokens it makes. Revoking it revokes them all.', where: 'Create key → Agent token' },
  { name: 'App password', line: 'Lets a mail app (IMAP or SMTP) open a persistent inbox.', where: 'Create key → App password' },
]
