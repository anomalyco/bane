/**
 * The Ritual language surface: email and ctx fields, built-ins, endpoint calls and templates.
 * Shared by the compiler, the API (typings, templates) and the dashboard editor, so it has no
 * runtime imports and ships to browsers.
 */

export type EndpointType = 'slack' | 'discord' | 'webhook' | 'forward';

/** A field of `email` or `ctx`. `record` means any string key (headers); `array` has `items`. */
export type Field = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'record';
  doc: string;
  nullable?: boolean;
  fields?: Record<string, Field>;
  items?: Field;
};
const s = (doc: string, nullable = false): Field => ({ type: 'string', doc, ...(nullable ? { nullable } : {}) });
const n = (doc: string): Field => ({ type: 'number', doc });
const b = (doc: string): Field => ({ type: 'boolean', doc });
const o = (doc: string, fields: Record<string, Field>): Field => ({ type: 'object', doc, fields });
const list = (doc: string, items: Field): Field => ({ type: 'array', doc, items });
const mailbox = o('A parsed address.', {
  name: s('Display name, if any. Unverified unless auth.fromVerified.', true),
  address: s('Lowercase email address.'),
  local: s('The part before @.'),
  domain: s('The part after @.'),
});
const attachment = o('Attachment metadata. Content is never available to a ritual.', {
  id: s('Attachment ID.'),
  filename: s('File name as sent.'),
  contentType: s('MIME type.'),
  size: n('Size in bytes.'),
  inline: b('True for inline parts such as embedded images.'),
  contentId: s('Content-ID for inline parts.', true),
  sha256: s('SHA-256 of the content.', true),
  isImage: b('True for image/* types.'),
  safe: b('True when the virus scan passed.'),
});

export const emailFields: Record<string, Field> = {
  id: s('Bane message ID (msg_…).'),
  messageId: s('The Message-ID header.', true),
  subject: s('Subject line.'),
  from: mailbox,
  to: list('To recipients.', mailbox),
  cc: list('Cc recipients.', mailbox),
  replyTo: list('Reply-To addresses.', mailbox),
  envelope: o('SMTP envelope.', { from: s('MAIL FROM.', true), to: list('RCPT TO addresses.', s('Recipient.')) }),
  date: s('The Date header (ISO 8601).', true),
  receivedAt: s('When Bane received it (ISO 8601).'),
  size: n('Raw size in bytes.'),
  headers: { type: 'record', doc: 'Headers by lowercase name. Prefer email.headers.get(name).', items: list('Values in order.', s('Header value.')) },
  text: s('Plain-text body.'),
  visibleText: s('Text a reader would see, with hidden content removed (64 KiB max).'),
  hiddenContent: b('True when the HTML hides text from readers.'),
  links: list('Visible links.', s('URL.')),
  html: s('Sanitized HTML body.', true),
  attachments: list('All attachments.', attachment),
  images: list('Image attachments.', attachment),
  auth: o('Sender authentication from SES.', {
    fromVerified: b('True when DMARC-aligned SPF or DKIM authenticates the From domain.'),
    spf: s('pass, fail, gray or none.'),
    dkim: s('pass, fail, gray or none.'),
    dmarc: s('pass, fail, gray or none.'),
  }),
  spam: o('Spam verdict.', { ses: s('SES spam verdict: pass, fail, gray or none.'), junk: b('True when Bane already marked it junk.'), reason: s('Why it is junk.', true) }),
  flags: o('Message traits.', {
    automated: b('Auto-generated or bulk mail.'),
    autoReply: b('Has Auto-Submitted.'),
    bulk: b('Has List-Id.'),
    listId: s('The List-Id header.', true),
    baneHops: n('Bane forwarding hops already taken.'),
  }),
  thread: o('Conversation.', {
    id: s('Thread ID.', true),
    isReply: b('True when it replies to an earlier message.'),
    inReplyTo: s('In-Reply-To Message-ID.', true),
    references: list('References Message-IDs.', s('Message-ID.')),
  }),
  parsed: b('False when the MIME could not be parsed; only headers are reliable.'),
  truncated: b('True when the stored body was cut at the size limit.'),
};
export const ctxFields: Record<string, Field> = {
  recipient: s('The address this run is for (one run per recipient).'),
  local: s('Local part of the recipient.'),
  host: s('Domain of the recipient.'),
  subaddress: s('Text after + in the local part.', true),
  route: o('The routing decision this ritual runs on.', { id: s('Route ID.', true), tier: s('exact, pattern, plus, catch-all or default.') }),
  defaults: list('Destinations routing already chose (inbox and webhook IDs).', s('Destination ID.')),
  junk: b('True when the message is junk so far.'),
  now: s('Receipt time (ISO 8601). Rituals have no clock.'),
};

/** Resolves a static path such as ['email','from','address'] to its field, or explains the miss. */
export function fieldAt(path: readonly string[]): { field: Field } | { missing: string; options: string[]; at: string } | null {
  const root = path[0] === 'email' ? emailFields : path[0] === 'ctx' ? ctxFields : null;
  if (!root) return null;
  let fields: Record<string, Field> | undefined = root, field: Field | undefined;
  for (let i = 1; i < path.length; i++) {
    const key = path[i]!;
    if (field?.type === 'record') { field = field.items; fields = field?.fields; continue; }
    if (field?.type === 'array') {
      if (/^\d+$/.test(key)) { field = field.items; fields = field?.fields; continue; }
      if (key === 'length') return { field: n('Number of items.') };
      return { missing: key, options: ['length', '[index]'], at: path.slice(0, i).join('.') };
    }
    if (field?.type === 'string') return key === 'length' ? { field: n('Number of characters.') } : { missing: key, options: ['length'], at: path.slice(0, i).join('.') };
    if (!fields || !Object.hasOwn(fields, key)) return { missing: key, options: Object.keys(fields ?? {}), at: path.slice(0, i).join('.') };
    field = fields[key]!;
    fields = field.fields;
  }
  return field ? { field } : null;
}

/** Closest candidate by edit distance, for "did you mean" hints. */
export function closest(word: string, options: readonly string[]): string | null {
  let best: string | null = null, score = Math.max(2, Math.floor(word.length / 3)) + 1;
  for (const option of options) {
    const d = distance(word.toLowerCase(), option.toLowerCase());
    if (d < score) { score = d; best = option; }
  }
  return best;
}
function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(prev[j]! + 1, next[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = next;
  }
  return prev[b.length]!;
}

/** Built-in calls. Arity is [min, max]. Everything else is a compile error. */
export const builtins: Record<string, { args: [number, number]; signature: string; doc: string; action?: boolean }> = {
  block: { args: [0, 1], signature: 'block(reason?: string)', doc: 'Reject this message for this recipient. Nothing is stored or delivered.', action: true },
  drop: { args: [0, 1], signature: 'drop(reason?: string)', doc: 'Discard this message for this recipient without storing it.', action: true },
  junk: { args: [0, 1], signature: 'junk(reason?: string)', doc: 'Store it as junk: kept, but not delivered to webhooks without junk include.', action: true },
  allow: { args: [0, 0], signature: 'allow()', doc: 'Clear the junk flag. Ignored unless the sender is authenticated (email.auth.fromVerified).', action: true },
  label: { args: [1, 1], signature: 'label(name: string)', doc: 'Add a label to the stored message (up to 10).', action: true },
  'inbox.deliver': { args: [1, 1], signature: 'inbox.deliver(key: string)', doc: 'Also deliver to the inbox with this key.', action: true },
  omens: { args: [2, 2], signature: 'omens(email, { name: "question" })', doc: 'Ask Jev each question once per message. Returns a 0–1 score per name, or a boolean for type "boolean". Questions must be literal text.' },
  'lists.has': { args: [2, 2], signature: 'lists.has(list: string, value: string)', doc: 'True when the sender list contains the address, or "@domain" covers it.' },
  'addr.matches': { args: [2, 2], signature: 'addr.matches(address: string, pattern: string)', doc: 'Glob match on an address: "*@example.com", "billing+*@acme.io".' },
  'text.snippet': { args: [2, 2], signature: 'text.snippet(text: string, maxChars: number)', doc: 'The first maxChars characters (at most 4,096).' },
  'email.headers.get': { args: [1, 1], signature: 'email.headers.get(name: string)', doc: 'First value of a header, or null.' },
  'email.headers.getAll': { args: [1, 1], signature: 'email.headers.getAll(name: string)', doc: 'Every value of a header, in order.' },
  'email.headers.has': { args: [1, 1], signature: 'email.headers.has(name: string)', doc: 'True when the header is present.' },
};
/** Methods callable on strings. Regex literals support only .test(). */
export const stringMethods: Record<string, { args: [number, number]; signature: string }> = {
  includes: { args: [1, 1], signature: 'text.includes(part)' },
  startsWith: { args: [1, 1], signature: 'text.startsWith(prefix)' },
  endsWith: { args: [1, 1], signature: 'text.endsWith(suffix)' },
  toLowerCase: { args: [0, 0], signature: 'text.toLowerCase()' },
  toUpperCase: { args: [0, 0], signature: 'text.toUpperCase()' },
  trim: { args: [0, 0], signature: 'text.trim()' },
};

/** What each endpoint type accepts. The compiler checks literal payloads against this at save time. */
export const endpointPayloads: Record<EndpointType, { args: [number, number]; fields: string[] | null; signature: (name: string) => string; doc: string }> = {
  slack: { args: [1, 1], fields: ['text'], signature: name => `endpoints.${name}({ text })`, doc: 'Posts plain text to a Slack incoming webhook. Mentions and link previews are off.' },
  discord: { args: [1, 1], fields: ['content'], signature: name => `endpoints.${name}({ content })`, doc: 'Posts plain text to a Discord webhook. Mentions are off.' },
  webhook: { args: [0, 1], fields: null, signature: name => `endpoints.${name}(payload?)`, doc: 'Posts a signed JSON event. With a payload, data.ritualBody carries your record.' },
  forward: { args: [0, 0], fields: [], signature: name => `endpoints.${name}()`, doc: 'Forwards the message as text from the receiving address. The recipient must have confirmed.' },
};

export type RitualWorkspace = {
  endpoints: { name: string; type: EndpointType; status: string }[];
  inboxes: string[];
  lists: string[];
};
const ident = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);
export const endpointCall = (name: string) => (ident(name) ? `endpoints.${name}` : `endpoints[${JSON.stringify(name)}]`);
const union = (values: string[]) => (values.length ? values.map(v => JSON.stringify(v)).join(' | ') : 'never');

const named = new Map<Field, string>([[mailbox, 'Mailbox'], [attachment, 'Attachment']]);
function tsType(field: Field, indent: string): string {
  const nullable = field.nullable ? ' | null' : '';
  if (named.has(field)) return named.get(field)! + nullable;
  if (field.type === 'array') return `${tsType(field.items!, indent)}[]`;
  if (field.type === 'record') return `Record<string, ${tsType(field.items!, indent)}>`;
  if (field.type === 'object') return `{\n${tsFields(field.fields!, indent + '  ')}${indent}}${nullable}`;
  return field.type + nullable;
}
function tsFields(fields: Record<string, Field>, indent: string, skip: string[] = []) {
  return Object.entries(fields).filter(([name]) => !skip.includes(name)).map(([name, field]) => `${indent}/** ${field.doc} */\n${indent}${name}: ${tsType(field, indent)};\n`).join('');
}

/** TypeScript declarations for editors and agents, generated from the workspace's endpoints, inboxes and lists. */
export function ritualTypings(workspace: RitualWorkspace): string {
  const endpointLines = workspace.endpoints.map(e => {
    const p = endpointPayloads[e.type];
    const param = e.type === 'slack' ? 'message: { text: string }' : e.type === 'discord' ? 'message: { content: string }' : e.type === 'webhook' ? 'payload?: Record<string, unknown>' : '';
    return `  /** ${e.type} · ${e.status}. ${p.doc} */\n  ${ident(e.name) ? e.name : JSON.stringify(e.name)}(${param}): void;\n`;
  }).join('');
  const fn = (name: string) => builtins[name]!;
  return `// Ritual declarations. Rituals are a deterministic subset of JavaScript: one default
// function, const bindings, if/else, ternaries, templates and the calls below. No loops,
// clock, randomness or network access. Reference: docs/rituals.md.

export default function route(email: Email, ctx: RitualContext): void;

interface Mailbox {
${tsFields(mailbox.fields!, '  ')}}
interface Attachment {
${tsFields(attachment.fields!, '  ')}}
interface Email {
${tsFields(emailFields, '  ', ['headers'])}  /** ${emailFields.headers!.doc} */
  headers: Record<string, string[]> & {
    /** ${fn('email.headers.get').doc} */
    get(name: string): string | null;
    /** ${fn('email.headers.getAll').doc} */
    getAll(name: string): string[];
    /** ${fn('email.headers.has').doc} */
    has(name: string): boolean;
  };
}
interface RitualContext {
${tsFields(ctxFields, '  ')}}

/** Endpoints configured in this workspace. Call them by name; type decides the payload. */
declare const endpoints: {
${endpointLines}};
declare const inbox: {
  /** ${fn('inbox.deliver').doc} */
  deliver(key: ${union(workspace.inboxes)}): void;
};
declare const lists: {
  /** ${fn('lists.has').doc} */
  has(list: ${union(workspace.lists)}, value: string): boolean;
};
declare const addr: {
  /** ${fn('addr.matches').doc} */
  matches(address: string, pattern: string): boolean;
};
declare const text: {
  /** ${fn('text.snippet').doc} */
  snippet(text: string, maxChars: number): string;
};
${['block', 'drop', 'junk'].map(name => `/** ${fn(name).doc} */\ndeclare function ${name}(reason?: string): void;\n`).join('')}/** ${fn('allow').doc} */
declare function allow(): void;
/** ${fn('label').doc} */
declare function label(name: string): void;
type Omen = string | { prompt: string; type?: "score" | "boolean"; threshold?: number; onError?: number | boolean | "defer" };
/** ${fn('omens').doc} */
declare function omens<T extends Record<string, Omen>>(email: Email, questions: T): { [K in keyof T]: T[K] extends { type: "boolean" } ? boolean : number };
`;
}

export type Completion = { label: string; type: 'function' | 'property' | 'variable' | 'keyword'; detail: string; info: string; apply?: string };
/** Editor completions: the same facts as the typings, flattened for CodeMirror. */
export function ritualCompletions(workspace: RitualWorkspace): Completion[] {
  const out: Completion[] = [];
  const walk = (prefix: string, fields: Record<string, Field>) => {
    for (const [name, field] of Object.entries(fields)) {
      const label = `${prefix}.${name}`;
      out.push({ label, type: 'property', detail: field.type === 'object' ? 'object' : tsType(field, '').replace(/\s+/g, ' '), info: field.doc });
      if (field.type === 'object') walk(label, field.fields!);
      if (field.type === 'array' && field.items?.type === 'object') walk(`${label}[0]`, field.items.fields!);
    }
  };
  walk('email', emailFields);
  walk('ctx', ctxFields);
  for (const [name, fn] of Object.entries(builtins)) out.push({ label: name, type: 'function', detail: fn.signature, info: fn.doc, apply: fn.signature.replace(/\(.*$/, '(') });
  for (const e of workspace.endpoints) {
    const p = endpointPayloads[e.type];
    out.push({ label: endpointCall(e.name), type: 'function', detail: `${e.type} · ${e.status}`, info: `${p.signature(e.name)} — ${p.doc}`, apply: `${endpointCall(e.name)}(${e.type === 'slack' ? '{ text: `` }' : e.type === 'discord' ? '{ content: `` }' : ''})` });
  }
  for (const key of workspace.inboxes) out.push({ label: `inbox.deliver(${JSON.stringify(key)})`, type: 'function', detail: 'inbox', info: `Deliver to the inbox ${key}.` });
  for (const name of workspace.lists) out.push({ label: `lists.has(${JSON.stringify(name)}, email.from.address)`, type: 'function', detail: 'sender list', info: `True when ${name} contains the sender.` });
  return out;
}

export type RitualTemplate = { id: string; name: string; description: string; needs?: EndpointType; source: (endpoint?: string) => string };
const wrap = (body: string) => `export default function route(email, ctx) {\n${body.trim().split('\n').map(line => (line ? '  ' + line : line)).join('\n')}\n}\n`;
/** Starting points. Each one compiles; endpoint templates take the name of an endpoint of the right type. */
export const ritualTemplates: RitualTemplate[] = [
  {
    id: 'slack-summary', name: 'Post to Slack', needs: 'slack',
    description: 'Post the sender and subject of authenticated mail to a Slack channel.',
    source: (name = 'support') => wrap(`
if (!email.auth.fromVerified) return
${endpointCall(name)}({ text: \`New mail from \${email.from.address}: \${email.subject}\` })`),
  },
  {
    id: 'discord-alert', name: 'Alert on Discord', needs: 'discord',
    description: 'Post urgent-looking subjects to a Discord channel.',
    source: (name = 'alerts') => wrap(`
if (/urgent|outage|down/i.test(email.subject)) {
  ${endpointCall(name)}({ content: \`\${email.from.address}: \${email.subject}\` })
}`),
  },
  {
    id: 'json-webhook', name: 'Send JSON to a webhook', needs: 'webhook',
    description: 'Reshape the message into the record your service expects.',
    source: (name = 'crm') => wrap(`
${endpointCall(name)}({
  sender: email.from.address,
  verified: email.auth.fromVerified,
  subject: email.subject,
  preview: text.snippet(email.visibleText, 280),
  recipient: ctx.recipient,
})`),
  },
  {
    id: 'forward-team', name: 'Forward to a team address', needs: 'forward',
    description: 'Forward authenticated, non-bulk mail to a confirmed address.',
    source: (name = 'team') => wrap(`
if (email.auth.fromVerified && !email.flags.bulk) ${endpointCall(name)}()`),
  },
  {
    id: 'junk-newsletters', name: 'Junk newsletters',
    description: 'Store bulk mail with List-Unsubscribe as junk.',
    source: () => wrap(`
if (email.headers.has("list-unsubscribe") || email.flags.bulk) junk("newsletter")`),
  },
  {
    id: 'refund-omen', name: 'Label refund requests',
    description: 'Ask Jev whether the sender wants a refund, then label it. Needs omens enabled for the domain.',
    source: () => wrap(`
const result = omens(email, { refund: "Is the sender asking for a refund?" })
if (result.refund >= 0.7) label("refund")`),
  },
  {
    id: 'block-domain', name: 'Block a domain',
    description: 'Reject everything from one sending domain.',
    source: () => wrap(`
if (email.from.domain === "spam.example") block("blocked domain")`),
  },
  {
    id: 'vip-allow-list', name: 'Always accept VIP senders',
    description: 'Clear junk for authenticated senders on the vip list and label them.',
    source: () => wrap(`
if (lists.has("vip", email.from.address)) {
  allow()
  label("vip")
}`),
  },
  {
    id: 'junk-failed-dmarc', name: 'Junk failed DMARC',
    description: 'Store mail whose From domain failed DMARC as junk.',
    source: () => wrap(`
if (email.auth.dmarc === "fail") junk("DMARC failed")`),
  },
];
