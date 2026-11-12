// Every credential Bane has, in one plain line each: the API keys page and the Keys guide in Docs say the same thing.
export const credentials: { name: string; line: string; where: string }[] = [
  { name: 'API key', line: 'Your server sends email and manages Bane with it.', where: 'API keys → Create key' },
  { name: 'Inbound key', line: 'Reads and replies to mail at receiving addresses you choose, nothing else.', where: 'API keys → Create key → Inbound key' },
  { name: 'Inbox key', line: 'An inbound key for one agent inbox. It stops working when the inbox is deleted.', where: 'Connect an agent, or New agent inbox' },
  { name: 'Agent sign-in', line: 'An agent such as OpenCode or Claude Code acting as you over MCP, with the access you approved in the browser.', where: 'API keys → Connected agents' },
  { name: 'Agent token', line: 'A short-lived key (a day at most) that a signed-in agent makes for a script. Revoking the sign-in revokes it too.', where: 'API keys → Connected agents' },
  { name: 'App password', line: 'Lets a mail app (IMAP or SMTP) open a permanent inbox.', where: 'The API: createInboxAppPassword' },
]
