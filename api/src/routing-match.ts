/** Pure recipient matcher shared by ingest and dry runs. The claim reads only this envelope's hosts, owners and destinations. */
export type RouteTarget = string[] | 'drop';
type Route = { id: string | null; match: string; to: RouteTarget; subaddresses?: boolean };
export type RoutingInput = {
  grants?:string[];
  programs?:import('./ritual-pipeline.js').Programs|null;
  version: number;
  legacy: boolean;
  hosts: Record<string, { default: string; patterns: Route[] }> | null;
  exact: Record<string, Route> | null;
  owners: Record<string, { id: string; public: boolean }> | null;
  boxes: Record<string, { dmarc: boolean; created: string; expires: string | null; deleteAfter?: string | null }> | null;
  hooks: Record<string, string> | null;
};
/** Why a recipient went where it did, most specific first. `address` is an inbox's own address or alias, which needs no route. */
export const ROUTE_TIERS = ['exact', 'address', 'pattern', 'subaddress', 'catchall', 'default'] as const;
export type RouteTier = (typeof ROUTE_TIERS)[number];
export const MESSAGE_INBOX_LIMIT = 10;
export const MESSAGE_WEBHOOK_LIMIT = 20;
export const plusBase = (address: string) => address.replace(/\+[^@]*@/, '@');

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

type Resolved = { tier: RouteTier; route: Route | null; to: RouteTarget };
function resolve(input: RoutingInput, address: string): Resolved {
  const host = input.hosts?.[address.split('@')[1]!],
    base = plusBase(address);
  const at = (addr: string): Resolved | undefined => {
    const route = input.exact?.[addr],
      owner = input.owners?.[addr];
    if (route) return { tier: 'exact', route, to: route.to };
    // A send-only public address never receives.
    if (owner) return { tier: 'address', route: null, to: owner.public ? [] : [owner.id] };
  };
  const pattern = (catchAll: boolean) => {
    const route = host?.patterns.find((r) => r.match.startsWith('*@') === catchAll && addressGlob(r.match, address));
    return route && { tier: catchAll ? ('catchall' as const) : ('pattern' as const), route, to: route.to };
  };
  const exact = at(address);
  if (exact) return exact;
  const parent = address === base ? undefined : at(base);
  const subaddress = parent && parent.route?.subaddresses !== false ? { ...parent, tier: 'subaddress' as const } : undefined;
  // Workspaces whose address patterns predate routing keep the plus base ahead of local patterns.
  if (input.legacy && subaddress) return subaddress;
  return pattern(false) ?? subaddress ?? pattern(true) ?? { tier: 'default', route: null, to: [] };
}

export function matchRouting(input: RoutingInput, addresses: string[], messageJunk: boolean, dmarc: string, received: string, now = Date.now(), changes?:Record<string,import('./ritual-pipeline.js').RitualDecision>) {
  const extraInboxes = new Set<string>(),
    webhooks = new Set<string>(),
    at = Date.parse(received);
  const receives = (box: NonNullable<RoutingInput['boxes']>[string]) =>
    box.deleteAfter ? Date.parse(box.deleteAfter) > now : !box.expires || (Date.parse(box.created) <= at && Date.parse(box.expires) > Math.max(now, at));
  const recipients = addresses.map((address) => {
    const { tier, route, to } = resolve(input, address);
    const decision=changes?.[address],junk=decision?.junk??messageJunk;
    const dropped=to==='drop'||!!decision?.dropped;
    const refs = dropped ? [] : [...new Set([...to,...decision?.refs??[]])],
      mine = { inboxes: [] as string[], webhooks: [] as string[] },
      warnings: string[] = [...decision?.warnings??[]];
    // Each message reaches a bounded number of destinations across all of its recipients.
    let limited=false;
    const take = (kind: 'inboxes' | 'webhooks', id: string) => {
      // An implicit address (including its aliases, wildcard rules and plus base) is not fan-out.
      if(kind==='inboxes' && ((!route?.id && Array.isArray(to)&&to.includes(id)) || id===owner?.id)){mine.inboxes.push(id);return;}
      const [seen, limit] = kind === 'inboxes' ? [extraInboxes, MESSAGE_INBOX_LIMIT] : [webhooks, MESSAGE_WEBHOOK_LIMIT];
      if (!seen.has(id) && seen.size >= limit) {limited=true;warnings.push(`${id} skipped: fan-out is limited to ${limit} extra ${kind}.`);return;}
      seen.add(id);
      mine[kind].push(id);
    };
    // requireDmarc on the addressed inbox, or on any inbox destination, holds this recipient's webhooks.
    const owner = input.owners?.[address] ?? input.owners?.[plusBase(address)];
    const held = dmarc !== 'PASS' && [owner?.id, ...refs].some((id) => id && input.boxes?.[id]?.dmarc);
    for (const id of refs) {
      const box = input.boxes?.[id],
        hook = input.hooks?.[id];
      if (box && receives(box)) take('inboxes', id);
      else if (hook && held) warnings.push(`${id} skipped: an inbox on this route requires DMARC to pass.`);
      else if (hook && junk && hook !== 'include') warnings.push(`${id} skipped: the message is junk and this webhook's junk setting is skip.`);
      else if (hook) take('webhooks', id);
      else warnings.push(`${id} is unavailable: it was deleted, has expired or is paused.`);
    }
    return {
      address,
      tier,
      route: route?.id ?? null,
      ...mine,
      ...(limited?{limited:true as const}:{}),
      ...(tier==='default' && input.exact?.[plusBase(address)]?.subaddresses===false ? {skipBase:true as const}:{}),
      dropped,
      ...(decision?{labels:decision.labels,actions:Object.fromEntries(mine.webhooks.filter(id=>decision.actions[id]).map(id=>[id,decision.actions[id]])),bodies:Object.fromEntries(mine.webhooks.filter(id=>Object.hasOwn(decision.bodies,id)).map(id=>[id,decision.bodies[id]])),added:mine.inboxes.filter(id=>decision.refs.includes(id)&&!(Array.isArray(to)&&to.includes(id)))}:{}),
      junk,
      domainDefault: input.hosts?.[address.split('@')[1]!]?.default === 'create_mailbox' ? ('create_address' as const) : ('store' as const),
      warnings,
    };
  });
  return { version: input.version, recipients,...(input.grants?.length?{grants:input.grants}:{}) };
}
export type RoutingResult = ReturnType<typeof matchRouting>;
