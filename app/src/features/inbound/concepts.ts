import { productName } from '../../../../api/src/brand'
// The words Receiving uses, in one place. docs/receiving.md says the same thing in the same words; change both together.
// Names follow the API: routes, rituals, endpoints, catch-all (catchAll), store.

export const concepts = {
  routes: {
    title: 'Routes',
    line: 'Every address that receives mail, and where its mail goes.',
    example: 'support@acme.com → triage → Inbox, Slack support',
  },
  rituals: {
    title: 'Rituals',
    line: 'Short scripts that run on a route’s mail: label it, filter it, or send it on.',
    example: 'If the subject mentions a refund, label it and post it to Slack.',
  },
  endpoints: {
    title: 'Endpoints',
    line: 'Named places mail can be sent: Slack, Discord, a webhook or a forward.',
    example: 'endpoints.support({ text: email.subject })',
  },
  trace: {
    title: 'Trace',
    line: 'Run an email through your routes and rituals to see what would happen. Nothing is sent or saved.',
  },
  // Jev is the AI model behind omens. The API and its docs keep the name; the dashboard says what it does.
  omens: {
    title: 'Omens',
    line: `Questions a ritual asks ${productName}’s AI about an email. Each answer is a score from 0 to 1.`,
    example: 'omens(email, { refund: "Is the sender asking for a refund?" })',
  },
} as const

// Where each concept is explained in full: the guides in Docs.
export const guides = {
  receiving: '/docs/receiving',
  rituals: '/docs/rituals',
  endpoints: '/docs/endpoints',
  inboxes: '/docs/inboxes',
  mcp: '/docs/mcp',
  keys: '/docs/keys',
} as const

export type KindFilter = 'all' | 'address' | 'pattern' | 'catch_all' | 'inbox' | 'auto'
export const kinds: Record<KindFilter, { label: string; line: string; example?: string }> = {
  all: { label: 'All', line: concepts.routes.line, example: concepts.routes.example },
  address: { label: 'Addresses', line: 'An address keeps its own threads in the Inbox. A route can send its mail somewhere else instead.', example: 'support@acme.com' },
  pattern: { label: 'Patterns', line: 'A pattern catches many addresses with *.', example: 'reply+*@acme.com catches reply+4821@acme.com' },
  catch_all: { label: 'Catch-alls', line: 'What happens to mail for an address that doesn’t exist.', example: '*@acme.com' },
  inbox: { label: 'Agent inboxes', line: 'Expiring addresses that agents and tests create and read over the API or MCP.' },
  auto: { label: 'Auto-created', line: 'Addresses a catch-all created for new recipients.' },
}

// What a row is, in a few words, under its address.
export const kindNote = {
  route: 'No inbox of its own',
  pattern: 'Pattern',
  catch_all: 'Catch-all',
  inbox: 'Agent inbox',
  auto: 'Created by the catch-all',
} as const

export const outcomes = {
  store: 'Stored, no inbox',
  drop: 'Dropped',
  create_address: 'New address per recipient',
} as const

// The three steps on an address's page, and what to say when a step is empty.
export const steps = {
  route: { title: 'Route', line: 'Mail sent to these addresses.' },
  rituals: { title: 'Rituals', line: 'Run in order on every message.', empty: 'No ritual yet' },
  goesTo: { title: 'Goes to', line: 'Where the mail ends up.', empty: 'Only its inbox' },
} as const

export const catchAllSetting = {
  title: 'Catch-all',
  line: 'What happens to mail for an address that doesn’t exist on this domain.',
  options: { store: 'Store it, no inbox', create_address: 'Create an address' },
} as const
