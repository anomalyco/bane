import type { App } from './core.js';

type Json = Record<string, any>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function resolve(document: Json, schema: Json | undefined, seen = new Set<string>()): Json {
  if (!schema) return {};
  if (typeof schema.$ref !== 'string') return schema;
  if (seen.has(schema.$ref)) return {};
  seen.add(schema.$ref);
  const [, , section, name] = schema.$ref.split('/');
  return resolve(document, document.components?.[section]?.[name], seen);
}

function sampleString(name: string, schema: Json): string {
  if (schema.const !== undefined) return String(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return String(schema.enum[0]);
  if (typeof schema.default === 'string') return schema.default;
  if (typeof schema.example === 'string') return schema.example;
  if (/^from$/i.test(name)) return 'sender@example.com';
  if (schema.format === 'email' || /^(?:to|email|replyTo)$/i.test(name)) return 'recipient@example.com';
  if (schema.format === 'date-time' || /(?:At|Date)$/i.test(name)) return '2026-09-18T19:00:00Z';
  if (schema.format === 'uri' || /url$/i.test(name)) return 'https://example.com/webhook';
  if (/region/i.test(name)) return 'us-east-1';
  if (/subject/i.test(name)) return 'Hello from Bane';
  if (/html/i.test(name)) return '<h1>Hello</h1><p>Your message is ready.</p>';
  if (/text|markdown|description|purpose/i.test(name)) return 'Your message is ready.';
  if (/name/i.test(name)) return 'Example';
  if (/filename/i.test(name)) return 'document.pdf';
  if (/contentType/i.test(name)) return 'application/pdf';
  if (/contentId/i.test(name)) return 'asset';
  if (/idempotency/i.test(name)) return 'request-123';
  if (/id$/i.test(name)) return `${name.replace(/Id$/i, '').toLowerCase() || 'resource'}_123`;
  if (schema.pattern?.includes('^[a-z0-9-]')) return 'example';
  return 'example';
}

function sample(document: Json, input: Json | undefined, name = 'value', depth = 0): any {
  if (depth > 8) return undefined;
  const schema = resolve(document, input);
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length) return sample(document, union[0], name, depth + 1);
  if (Array.isArray(schema.type)) {
    const type = schema.type.find((value: string) => value !== 'null');
    return sample(document, { ...schema, type }, name, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.type === 'string' || schema.format || schema.pattern) return sampleString(name, schema);
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? Number(schema.exclusiveMinimum) + 1 : 1);
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [sample(document, schema.items, name.replace(/s$/, ''), depth + 1)].filter(value => value !== undefined);
  if (schema.type === 'object' || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    return Object.fromEntries(Object.entries<Json>(schema.properties ?? {}).filter(([key, value]) => required.has(key) || value.default !== undefined).map(([key, value]) => [key, sample(document, value, key, depth + 1)]).filter(([, value]) => value !== undefined));
  }
  return undefined;
}

function parameters(document: Json, pathItem: Json, operation: Json, location: string) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map(parameter => resolve(document, parameter)).filter(parameter => parameter.in === location);
}

function sdkSample(document: Json, path: string, method: string, pathItem: Json, operation: Json): string {
  const options: Json = {};
  const pathParameters = parameters(document, pathItem, operation, 'path');
  const queryParameters = parameters(document, pathItem, operation, 'query').filter(parameter => parameter.required);
  const headerParameters = parameters(document, pathItem, operation, 'header').filter(parameter => parameter.required && parameter.name.toLowerCase() !== 'authorization');
  if (pathParameters.length) options.path = Object.fromEntries(pathParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  if (queryParameters.length) options.query = Object.fromEntries(queryParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  if (headerParameters.length) options.headers = Object.fromEntries(headerParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  if (bodySchema) {
    options.body = sample(document, bodySchema, 'body');
    const completeEmail = (email: Json) => ({ ...email, subject: email.subject ?? 'Hello from Bane', text: email.text ?? 'Your message is ready.' });
    if (operation.operationId === 'sendEmail') options.body = completeEmail(options.body);
    if (operation.operationId === 'sendEmailBatch') options.body.emails = options.body.emails.map(completeEmail);
  }
  const renderedOptions = Object.entries(options).map(([key, value]) => `  ${key}: ${JSON.stringify(value, null, 2).replaceAll('\n', '\n  ')},`).join('\n');
  if (operation.tags?.includes('Workspaces')) return `import { createClient } from '@banemx/sdk/client';\nimport { ${operation.operationId} } from '@banemx/sdk';\n\n// Run in the signed-in dashboard, on its own origin.\nconst client = createClient({ baseUrl: window.location.origin, credentials: 'same-origin' });\nconst result = await ${operation.operationId}({\n  client,\n${renderedOptions ? `${renderedOptions}\n` : ''}  throwOnError: true,\n});\nconsole.log(result.data);`;
  return `import { createClient } from '@banemx/sdk/client';\nimport { ${operation.operationId} } from '@banemx/sdk';\n\nconst client = createClient({\n  baseUrl: 'https://bane.mx',\n  auth: scheme => scheme.scheme === 'bearer'\n    ? process.env.BANE_API_KEY\n    : undefined,\n});\n\nconst result = await ${operation.operationId}({\n  client,\n${renderedOptions ? `${renderedOptions}\n` : ''}  throwOnError: true,\n});\n\nconsole.log(result.data);`;
}

function curlSample(document: Json, path: string, method: string, pathItem: Json, operation: Json): string {
  let target = path;
  for (const parameter of parameters(document, pathItem, operation, 'path')) target = target.replace(`{${parameter.name}}`, encodeURIComponent(String(sample(document, parameter.schema, parameter.name))));
  const query = parameters(document, pathItem, operation, 'query').filter(parameter => parameter.required).map(parameter => `${encodeURIComponent(parameter.name)}=${encodeURIComponent(String(sample(document, parameter.schema, parameter.name)))}`);
  if (query.length) target += `?${query.join('&')}`;
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  let body = bodySchema ? sample(document, bodySchema, 'body') : undefined;
  const completeEmail = (email: Json) => ({ ...email, subject: email.subject ?? 'Hello from Bane', text: email.text ?? 'Your message is ready.' });
  if (operation.operationId === 'sendEmail') body = completeEmail(body);
  if (operation.operationId === 'sendEmailBatch') body.emails = body.emails.map(completeEmail);
  const lines = [`curl --request ${method.toUpperCase()} \\`, `  --url 'https://bane.mx${target}' \\`, `  --header 'Authorization: Bearer $BANE_API_KEY'`];
  lines[2] = `  --header "Authorization: Bearer $BANE_API_KEY"`;
  if (operation.tags?.includes('Workspaces')) {
    lines[1] = `  --url "\${BANE_ORIGIN}${target}" \\`;
    lines[2] = `  --header "Origin: $BANE_ORIGIN" \\\n  --cookie "$BANE_COOKIE_JAR"`;
  }
  if (bodySchema) { lines[lines.length - 1] += ' \\'; lines.push(`  --header 'Content-Type: application/json' \\`, `  --data '${JSON.stringify(body, null, 2)}'`); }
  return lines.join('\n');
}

// The first five minutes, shared by /docs (x-quickstart), /docs.md and /llms.txt.
const quickstartCurl = `curl --request POST \\
  --url 'https://bane.mx/v1/emails/send' \\
  --header "Authorization: Bearer $BANE_API_KEY" \\
  --header 'Content-Type: application/json' \\
  --header 'Idempotency-Key: first-email' \\
  --data '{"from":"hello@acme.com","to":"you@acme.com","subject":"Hello from Bane","text":"It works."}'`;
export const quickstart: { title: string; text: string; code?: string }[] = [
  { title: 'Add and verify your domain', text: 'In the dashboard, open Domains and add it, or call POST /v1/domains with {"name":"acme.com"}. Publish the DNS records it returns at your DNS provider. Sending works once GET /v1/domains/{id} reports sending: "verified", usually within minutes of the records resolving. A domain whose records are still unproven after 72 hours is released.' },
  { title: 'Create an API key', text: 'In Settings → API keys. A Send only key restricted to your domain is enough to send; it can’t read logs, so add Read permission if your code should look up outcomes. Store it as BANE_API_KEY on your server and never ship it to a browser.' },
  { title: 'Send', text: '202 means queued, not delivered. Follow the outcome in the dashboard’s Logs, or with GET /v1/emails/{id} and a key that has Read permission (a Send only key gets 403). Leave out region: the sender domain decides it. To test without reaching a real inbox, send to success@simulator.amazonses.com (or bounce@, complaint@, ooto@ and suppressionlist@ the same domain). These addresses count against hosted sending limits.', code: quickstartCurl },
  { title: 'Receive (optional)', text: 'Publish the receiving MX record from the domain page. Hosted Bane suggests a free subdomain such as reply.<your domain>, so the domain’s existing mailboxes keep working. Create an address with POST /v1/inbound/addresses and subscribe to message.received with POST /v1/inbound/webhooks.' },
  { title: 'Reply', text: 'POST /v1/inbound/threads/{threadId}/reply answers the newest message from its receiving address and sets In-Reply-To and References.' },
];
// Getting started first; account and installation plumbing last.
const tagOrder = ['Emails', 'Domains', 'Inbound addresses', 'Inbound threads', 'Inbound webhooks', 'Inbound events', 'Inbound domains', 'Webhooks', 'Events', 'Metrics', 'Attachments', 'Templates', 'Campaigns', 'Audience', 'Consent', 'ApiKeys', 'Inbound keys', 'Settings', 'Regions', 'Workspaces', 'Auth'];
const tagRank = (tag: string) => { const index = tagOrder.indexOf(tag); return index === -1 ? tagOrder.length : index; };

export function createOpenApiDocument(app: App) {
  const document = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'Bane API', version: '0.1.0', description: 'Send, receive and reply to email on your own domains. 202 means queued, not delivered.' } }) as Json;
  document.info['x-quickstart'] = quickstart;
  const used = [...new Set(operationEntries(document).map(entry => entry.operation.tags?.[0] ?? 'API'))];
  document.tags = used.sort((a, b) => tagRank(a) - tagRank(b)).map(name => ({ name }));
  for (const [path, pathItem] of Object.entries<Json>(document.paths ?? {})) for (const method of METHODS) {
    const operation = pathItem[method];
    if (!operation?.operationId) continue;
    operation['x-codeSamples'] = [
      { lang: 'TypeScript', label: 'TypeScript SDK', source: sdkSample(document, path, method, pathItem, operation) },
      { lang: 'Shell', label: 'cURL', source: curlSample(document, path, method, pathItem, operation) },
    ];
  }
  return document;
}

function title(value: string) { return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').map((word, index) => /^mcp$/i.test(word) ? 'MCP' : index === 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()).join(' '); }
function markdownText(value: unknown) { return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim(); }
function schemaType(document: Json, input: Json): string {
  const schema = resolve(document, input);
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map((value: Json) => schemaType(document, value)).join(' or ');
  if (Array.isArray(schema.type)) return schema.type.join(' or ');
  if (schema.type === 'array') return `${schemaType(document, schema.items)}[]`;
  return schema.type ?? (schema.properties ? 'object' : 'value');
}
function schemaMarkdown(document: Json, input: Json | undefined, heading: string): string {
  if (!input) return '';
  const schema = resolve(document, input);
  const properties = Object.entries<Json>(schema.properties ?? {});
  const description = schema.description ? `\n${schema.description}\n` : '';
  if (!properties.length) return `### ${heading}\n${description}\nType: \`${schemaType(document, schema)}\`\n`;
  const required = new Set(schema.required ?? []);
  const rows = properties.map(([name, property]) => `| \`${name}\` | ${schemaType(document, property)} | ${required.has(name) ? 'yes' : 'no'} | ${markdownText(resolve(document, property).description)} |`).join('\n');
  return `### ${heading}\n${description}\n| Field | Type | Required | Description |\n| --- | --- | --- | --- |\n${rows}\n`;
}
function operationEntries(document: Json) {
  const result: Array<{ path: string; method: string; pathItem: Json; operation: Json }> = [];
  for (const [path, pathItem] of Object.entries<Json>(document.paths ?? {})) for (const method of METHODS) if (pathItem[method]?.operationId) result.push({ path, method, pathItem, operation: pathItem[method] });
  return result;
}
function operationMarkdown(document: Json, entry: ReturnType<typeof operationEntries>[number]) {
  const { path, method, pathItem, operation } = entry;
  const params = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((parameter: Json) => resolve(document, parameter));
  const parameterRows = params.length ? `### Parameters\n\n| Name | In | Type | Required | Description |\n| --- | --- | --- | --- | --- |\n${params.map((parameter: Json) => `| \`${parameter.name}\` | ${parameter.in} | ${schemaType(document, parameter.schema)} | ${parameter.required ? 'yes' : 'no'} | ${markdownText(parameter.description)} |`).join('\n')}\n` : '';
  const body = operation.requestBody?.content?.['application/json']?.schema;
  const responseRows = Object.entries<Json>(operation.responses ?? {}).map(([status, response]) => `| \`${status}\` | ${markdownText(response.description)} | ${response.content?.['application/json']?.schema ? schemaType(document, response.content['application/json'].schema) : '—'} |`).join('\n');
  const samples = Object.fromEntries((operation['x-codeSamples'] ?? []).map((item: Json) => [item.lang, item.source]));
  return `## ${title(operation.operationId)}\n\n\`${method.toUpperCase()} ${path}\`\n\n${operation.description ?? ''}\n\nOperation ID: \`${operation.operationId}\`\n\n${parameterRows}\n${schemaMarkdown(document, body, 'Request body')}\n### TypeScript SDK\n\n\`\`\`ts\n${samples.TypeScript ?? ''}\n\`\`\`\n\n### cURL\n\n\`\`\`sh\n${samples.Shell ?? ''}\n\`\`\`\n\n### Responses\n\n| Status | Description | Schema |\n| --- | --- | --- |\n${responseRows}\n`;
}

// Tag groups in the document's tag order, operations in path order within each.
function grouped(document: Json, entries: ReturnType<typeof operationEntries>) {
  const tagOf = (entry: ReturnType<typeof operationEntries>[number]) => entry.operation.tags?.[0] ?? 'API';
  const order: string[] = (document.tags ?? []).map((tag: Json) => tag.name);
  const rank = (tag: string) => { const index = order.indexOf(tag); return index === -1 ? order.length : index; };
  const tags = [...new Set(entries.map(tagOf))].sort((a, b) => rank(a) - rank(b));
  return tags.map(tag => ({ tag, entries: entries.filter(entry => tagOf(entry) === tag) }));
}
function quickstartMarkdown() {
  return `## Quickstart\n\n${quickstart.map((step, index) => `${index + 1}. **${step.title}.** ${step.text}${step.code ? `\n\n   \`\`\`sh\n${step.code.split('\n').map(line => `   ${line}`).join('\n')}\n   \`\`\`` : ''}`).join('\n')}\n\n`;
}

export function createMarkdownDocs(document: Json, operationId?: string): string | null {
  const entries = operationEntries(document);
  const selected = operationId ? entries.filter(entry => entry.operation.operationId === operationId) : entries;
  if (operationId && !selected.length) return null;
  const intro = `# Bane API\n\n${document.info?.description ?? ''}\n\n- [Interactive documentation](/docs)\n- [OpenAPI 3.1 JSON](/openapi.json)\n- [Agent index](/llms.txt)\n- TypeScript package: \`@banemx/sdk\`\n\n`;
  if (operationId) return `${intro}[All operations](/docs.md)\n\n${operationMarkdown(document, selected[0])}`;
  const groups = grouped(document, entries);
  const index = groups.map(({ tag, entries }) => `## ${tag}\n\n${entries.map(entry => `- [${title(entry.operation.operationId)}](/docs/operations/${entry.operation.operationId}.md) — \`${entry.method.toUpperCase()} ${entry.path}\``).join('\n')}`).join('\n\n');
  return `${intro}${quickstartMarkdown()}${index}\n\n${groups.flatMap(group => group.entries).map(entry => operationMarkdown(document, entry)).join('\n---\n\n')}`;
}

export function createLlmsText(document: Json): string {
  const entries = grouped(document, operationEntries(document)).flatMap(group => group.entries);
  return `# Bane\n\nBane is an email API on Amazon SES: send, receive and reply on your own domains.\n\n${quickstartMarkdown()}## Canonical documentation\n\n- Full Markdown API reference: /docs.md\n- Interactive API reference: /docs\n- OpenAPI 3.1 definition: /openapi.json\n- TypeScript SDK: https://www.npmjs.com/package/@banemx/sdk\n- MCP endpoint: /mcp\n\n## Focused operation documentation\n\n${entries.map(entry => `- ${title(entry.operation.operationId)}: /docs/operations/${entry.operation.operationId}.md`).join('\n')}\n`;
}
