// Every credential Bane has, in one plain line each: the API keys page and the Keys guide in Docs say the same thing.
export const credentials: { name: string; line: string; where: string }[] = [
  { name: 'API key', line: 'Sends email and manages Bane from your server.', where: 'API keys → Create key' },
  { name: 'Inbound key', line: 'Reads and replies to mail at the addresses you pick, nothing else.', where: 'API keys → Create key → Inbound key' },
  { name: 'Inbox key', line: 'An inbound key for one agent inbox. Stops working when the inbox is deleted.', where: 'Connect an agent, or New agent inbox' },
  { name: 'Agent sign-in', line: 'OpenCode, Claude Code or another agent acting as you over MCP, with the access you approved.', where: 'API keys → Connected agents' },
  { name: 'Agent token', line: 'A key a signed-in agent makes for a script. Lasts a day at most and ends with the sign-in.', where: 'API keys → Connected agents' },
  { name: 'App password', line: 'Lets a mail app open a permanent inbox over IMAP or SMTP.', where: 'The API: createInboxAppPassword' },
]
