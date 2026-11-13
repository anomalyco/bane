/**
 * The installation's canonical address, for every example and connection URL the dashboard and Docs hand out (curl,
 * SDK, agent prompt, MCP setup). It comes from the server's PUBLIC_URL, through /v1/me when signed in and /health
 * otherwise, never from the page's own address: a proxy or default virtual host can serve the same dashboard under a
 * Host an attacker chose, and a copied example would then send an API key there. Unknown is null (callers wait).
 * Demo mode has no server; its examples are illustrative and use the page.
 *
 * `foreign` is true when the page is open somewhere other than that address; Docs then refuses to show examples.
 */
export function canonicalOrigin({ identity, instance, demo, page }: { identity?: string | null; instance?: string | null; demo: boolean; page: string }): { origin: string | null; foreign: boolean } {
  if (demo) return { origin: page, foreign: false }
  const origin = originOf(identity) ?? originOf(instance)
  return { origin, foreign: origin !== null && origin !== originOf(page) }
}

/** An http(s) origin from a server-supplied value, or null for anything else. */
export function originOf(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch { return null }
}
