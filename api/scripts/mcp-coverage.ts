/** Regenerates docs/mcp-coverage.md from the hosted MCP catalog. The acceptance suite fails when the file is stale. */
import { writeFile } from 'node:fs/promises';
import { createOpenApiApp } from '../src/app.js';
import { buildMcpCatalog, coverageMarkdown } from '../src/mcp-catalog.js';

const app = await createOpenApiApp();
const spec = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'Bane API', version: '0.1.0' } });
const markdown = coverageMarkdown(buildMcpCatalog(app), spec as Record<string, unknown>);
if (markdown.includes('UNCOVERED')) {
  console.error(markdown.split('\n').filter(line => line.includes('UNCOVERED')).join('\n'));
  process.exit(1);
}
await writeFile(new URL('../../docs/mcp-coverage.md', import.meta.url), markdown);
