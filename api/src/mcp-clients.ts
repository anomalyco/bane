/**
 * How each MCP client connects to Bane's hosted MCP server. One builder for createInboxConnection and the dashboard
 * (Docs and Connect an agent), so every place hands out the same config. No runtime imports: it ships to browsers.
 *
 * Shapes, as each client documents them:
 * - OpenCode (V2): `mcp.servers.<name>` with `type: "remote"`; `oauth: false` plus `headers` for a key, or an
 *   `oauth.scope` to request. https://opencode.ai/docs/mcp-servers
 * - Claude Code: `.mcp.json` `mcpServers.<name>` with `type: "http"`, or `claude mcp add --transport http`.
 * - Cursor: `.cursor/mcp.json` `mcpServers.<name>` with `url` and optional `headers`.
 */
export const mcpClients = ['opencode', 'claude', 'cursor', 'generic'] as const;
export type McpClient = typeof mcpClients[number];
export const mcpClientNames: Record<McpClient, string> = { opencode: 'OpenCode', claude: 'Claude Code', cursor: 'Cursor', generic: 'Other MCP client' };
/** Where the config goes, in the words each client uses. */
export const mcpClientFiles: Record<McpClient, string> = { opencode: 'opencode.json', claude: '.mcp.json', cursor: '.cursor/mcp.json', generic: 'your MCP client’s settings' };

/** The hosted MCP endpoint. Plain /mcp works for every client and grant; no query parameters to explain. */
export const mcpServerUrl = (publicUrl: string) => new URL('/mcp', publicUrl).href;

/** A bearer key (an inbox key) or OAuth, where the person approves in the browser; scope is what OpenCode asks for. */
export type McpAuth = { bearer: string } | { scope?: string };

export function mcpClientConfig(client: McpClient, url: string, auth: McpAuth): Record<string, unknown> {
  const headers = 'bearer' in auth ? { headers: { Authorization: `Bearer ${auth.bearer}` } } : {};
  if (client === 'opencode') {
    const oauth = 'bearer' in auth ? { oauth: false } : auth.scope ? { oauth: { scope: auth.scope } } : {};
    return { $schema: 'https://opencode.ai/config.json', mcp: { servers: { bane: { type: 'remote', url, ...oauth, ...headers } } } };
  }
  if (client === 'claude') return { mcpServers: { bane: { type: 'http', url, ...headers } } };
  if (client === 'cursor') return { mcpServers: { bane: { url, ...headers } } };
  return { url, ...headers };
}

/** Claude Code's one-line alternative to editing .mcp.json. */
export const claudeAddCommand = (url: string, bearer?: string) =>
  `claude mcp add --transport http bane ${url}${bearer ? ` --header "Authorization: Bearer ${bearer}"` : ''}`;

/** The steps after pasting the config, per client and sign-in. */
export function mcpClientSteps(client: McpClient, auth: 'key' | 'oauth'): string[] {
  const file = mcpClientFiles[client];
  if (client === 'opencode') return auth === 'key'
    ? [`Merge this into your project or global ${file}, keeping your other servers.`, 'OpenCode connects on save; /mcps shows bane as connected.']
    : [`Merge this into your project or global ${file}, keeping your other servers.`, 'In OpenCode, run /mcps, select bane and choose Sign in.', 'Approve the access in your browser. A dashboard session in that browser skips Google sign-in.'];
  if (client === 'claude') return auth === 'key'
    ? ['Run this in your project’s terminal. It adds bane to the project’s .mcp.json.', 'In Claude Code, run /mcp to check that bane is connected.']
    : ['Run this in your project’s terminal. It adds bane to the project’s .mcp.json.', 'In Claude Code, run /mcp, select bane and choose Authenticate.', 'Approve the access in your browser.'];
  if (client === 'cursor') return auth === 'key'
    ? [`Merge this into ${file} in your project, or ~/.cursor/mcp.json for every project.`, 'Cursor Settings → MCP shows bane as connected.']
    : [`Merge this into ${file} in your project, or ~/.cursor/mcp.json for every project.`, 'In Cursor Settings → MCP, sign in to bane and approve the access in your browser.'];
  return auth === 'key'
    ? ['Add a remote (Streamable HTTP) server with this URL and Authorization header.']
    : ['Add a remote (Streamable HTTP) server with this URL. Your client signs in with OAuth; approve the access in your browser.'];
}
