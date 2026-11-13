import { addresses, hostedHosts, productName, repositoryUrl, supportHost } from '../../api/src/brand.js'
// The output gate (design §4.4.4): every final chat message and every email reply passes it before it is stored or
// sent. It trips on anything the customer must never receive from support: other people's addresses, IDs or names
// outside the grant, credentials, internal hosts, staff names or pieces of the system prompt. A tripped chat message is
// replaced and a ticket filed; a tripped email reply is held and a ticket filed.


export type GateScope = {
  /** The customer's own address(es); the support address is always allowed. */
  emails: string[];
  /** Workspace and domain IDs and names the grant covers. */
  allowedIds: string[];
  allowedNames: string[];
  /** Strings that only exist in the system prompt (a few distinctive phrases). */
  promptFragments: string[];
  supportAddress: string;
  /** Email: links must point here (a URL elsewhere holds the reply). The chat panel enforces this itself. */
  linkOrigins?: readonly string[];
};
export type GateResult = { ok: true } | { ok: false; reasons: string[] };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_PREFIX = /\b(?:nm_support_|nm_mbx_|nm_agent_|nm_notes_|nm_|bane_support_|bane_ops_|bane_mbx_|bane_agent_|os_agent_|whsec_|sk-ant-|bane_)[A-Za-z0-9_-]{8,}/; // bane_/os_: remove after rename cleanup
const LONG_HEX = /\b[0-9a-f]{40,}\b/i;
const LONG_B64 = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{60,}={0,2}(?![A-Za-z0-9+/])/;
const INTERNAL_HOST = /\b(?:[a-z0-9-]+\.)*(?:internal|invalid|local|svc\.cluster\.local|workers\.dev|psdb\.cloud|amazonaws\.com|hyperdrive\.local)\b/i;
const INTERNAL_ID = /\b(?:ws|sgr|sho|dom|wh|key|mbk|usr|conv|tkt)_[0-9a-z]{16,}\b/g;
/** People and systems the agent never names: Nightmail staff, internal tools. */
const STAFF = /\b(?:Ryan Vogel|thdxr|R44VC0RP|Dax Raad|PlanetScale|Hyperdrive|platform_operators|support_grants|supportGate|operatorGate|SupportPlatform)\b/i;
const FENCE = /<\/?untrusted>|<customer>|<\/customer>|<context>|<\/context>/i;

export function gate(text: string, scope: GateScope): GateResult {
  const reasons: string[] = [];
  const allowedEmails = new Set([...scope.emails, scope.supportAddress, addresses.abuse, addresses.support].map(e => e.toLowerCase()));
  for (const email of text.match(EMAIL) ?? []) if (!allowedEmails.has(email.toLowerCase()) && !/^(?:dmarc|postmaster|bounces?)@/i.test(email) && !isExample(email)) reasons.push('email address outside the conversation');
  if (SECRET_PREFIX.test(text)) reasons.push('credential-shaped string');
  if (LONG_HEX.test(text) || LONG_B64.test(text.replace(/v=DKIM1[^`\n]*/g, ''))) reasons.push('long opaque string');
  if (INTERNAL_HOST.test(text)) reasons.push('internal hostname');
  const allowedIds = new Set(scope.allowedIds);
  for (const id of text.match(INTERNAL_ID) ?? []) if (!allowedIds.has(id)) reasons.push('ID outside the grant');
  if (STAFF.test(text)) reasons.push('internal name');
  if (FENCE.test(text)) reasons.push('harness markup');
  if (scope.linkOrigins) {
    for (const url of text.match(/\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi) ?? []) {
      const ok = /^https:\/\//i.test(url) && scope.linkOrigins.some(origin => url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`));
      if (!ok) { reasons.push(`link outside ${productName}`); break; }
    }
  }
  const lower = text.toLowerCase();
  for (const fragment of scope.promptFragments) if (fragment.length >= 24 && lower.includes(fragment.toLowerCase())) { reasons.push('system prompt text'); break; }
  return reasons.length ? { ok: false, reasons: [...new Set(reasons)] } : { ok: true };
}

/** Placeholder addresses used in DNS advice ("rua=mailto:dmarc@your-domain.com") are fine. */
function isExample(email: string) { return /@(?:example\.(?:com|org|net)|your-?domain\.com|yourdomain\.com)$/i.test(email); }

/** Links the panel may render; others are shown as text. The panel enforces this too (support/PROTOCOL.md §4.2). */
export const LINK_ORIGINS = [...hostedHosts.flatMap(host => [`https://${host}`, `https://${supportHost(host)}`]), repositoryUrl];

/** Plain text for email: Markdown emphasis and code fences removed, links kept as bare URLs. */
export function plainText(markdown: string) {
  return markdown
    .replace(/```[a-z]*\n([\s\S]*?)```/g, (_, code: string) => code.trimEnd().split('\n').map(line => `    ${line}`).join('\n'))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, label: string, href: string) => label === href ? href : `${label} (${href})`)
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
