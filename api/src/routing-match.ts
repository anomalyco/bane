/** Pure recipient matcher. Inputs contain only this envelope's hosts, owners and route references. */
type Route = { id: string; match: string; to: string[] | 'drop'; subaddresses?: boolean };
export type RoutingInput = {
  version: number;
  legacy: boolean;
  hosts: Record<string, { default: string; patterns: Route[] }> | null;
  exact: Record<string, Route> | null;
  owners: Record<string, { id: string; public: boolean }> | null;
  boxes: Record<string, { dmarc: boolean; created: string; expires: string | null }> | null;
  hooks: Record<string, string> | null;
};
// Consume literal segments in order, anchoring both ends. No backtracking or generated regex.
export function addressGlob(pattern: string, address: string) {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === address;
  const first = parts.shift()!,
    last = parts.pop()!;
  if (!address.startsWith(first) || !address.endsWith(last) || first.length + last.length > address.length) return false;
  let offset = first.length;
  for (const literal of parts) {
    const at = address.indexOf(literal, offset);
    if (at < 0) return false;
    offset = at + literal.length;
  }
  return offset <= address.length - last.length;
}
export function matchRouting(
  input: RoutingInput,
  addresses: string[],
  junk: boolean,
  dmarc: string,
  received: string,
  now = Date.now(),
) {
  const boxes = new Set<string>(),
    hooks = new Set<string>();
  const recipients = addresses.map((address) => {
    const host = input.hosts?.[address.split('@')[1]!],
      base = address.replace(/\+[^@]*@/, '@');
    const owner = (addr: string): Route | undefined => {
      const o = input.owners?.[addr];
      return o ? { id: o.id, match: addr, to: o.public ? [] : [o.id] } : undefined;
    };
    const exact = (addr: string) => input.exact?.[addr] ?? owner(addr);
    let route = exact(address),
      tier = 'exact';
    const baseRoute = address === base ? undefined : exact(base);
    const fallback = baseRoute?.subaddresses === false ? undefined : baseRoute;
    if (!route && input.legacy && fallback) {
      route = fallback;
      tier = 'subaddress';
    }
    if (!route) {
      route = host?.patterns.find((r) => !r.match.startsWith('*@') && addressGlob(r.match, address));
      tier = 'pattern';
    }
    if (!route) {
      route = fallback;
      tier = 'subaddress';
    }
    if (!route) {
      route = host?.patterns.find((r) => r.match.startsWith('*@') && addressGlob(r.match, address));
      tier = 'catchall';
    }
    if (!route) tier = 'default';
    const inboxes: string[] = [],
      webhooks: string[] = [],
      warnings: string[] = [];
    const refs = Array.isArray(route?.to) ? route.to : [];
    // requireDmarc belongs to the addressed inbox as well as any explicit inbox destinations.
    const owning = input.owners?.[address] ?? input.owners?.[base];
    const held = dmarc !== 'PASS' && ((owning && input.boxes?.[owning.id]?.dmarc) || refs.some((id) => input.boxes?.[id]?.dmarc));
    for (const id of refs) {
      const box = input.boxes?.[id],
        hook = input.hooks?.[id];
      if (
        box &&
        (!box.expires ||
          (Date.parse(box.created) <= Date.parse(received) && Date.parse(box.expires) > Math.max(now, Date.parse(received))))
      ) {
        if (boxes.has(id) || boxes.size < 10) {
          boxes.add(id);
          inboxes.push(id);
        } else warnings.push(`Inbox limit: ${id}`);
      } else if (hook) {
        if (!held && (!junk || hook === 'include')) {
          if (hooks.has(id) || hooks.size < 20) {
            hooks.add(id);
            webhooks.push(id);
          } else warnings.push(`Webhook limit: ${id}`);
        }
      } else warnings.push(`Destination unavailable: ${id}`);
    }
    return {
      address,
      route: route?.id ?? null,
      tier,
      default: host?.default === 'create_mailbox' ? 'create_address' : 'store',
      inboxes,
      webhooks,
      junk,
      dropped: route?.to === 'drop',
      warnings,
    };
  });
  return { version: input.version, recipients };
}
export type RoutingResult = ReturnType<typeof matchRouting>;
