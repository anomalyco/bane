import assert from 'node:assert/strict';
import { createOpenApiApp } from '../src/app.js';
import { createLlmsText, createMarkdownDocs, createOpenApiDocument, createTagMarkdownDocs, tagSlug } from '../src/openapi-docs.js';

// Agents load these files whole, so each must fit comfortably in a model's context. The reference is split by tag
// (/docs/tags/<slug>.md) under the /docs.md index; a tag that outgrows its cap should be split into smaller tags.
const INDEX_LIMIT = 128 * 1024, TAG_LIMIT = 128 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const document = createOpenApiDocument(await createOpenApiApp());
const operations = Object.values(document.paths).flatMap(path => Object.values(path as Record<string, any>)).filter(operation => operation?.operationId);
const llms = createLlmsText(document);
const index = createMarkdownDocs(document)!;
assert.match(llms, /Markdown API reference index: \/docs\.md/);
assert.match(llms, /OpenAPI 3\.1 definition: \/openapi\.json/);
assert.ok(bytes(llms) < INDEX_LIMIT, `llms.txt is ${bytes(llms)} bytes; it must remain below ${INDEX_LIMIT}.`);
assert.ok(bytes(index) < INDEX_LIMIT, `/docs.md is ${bytes(index)} bytes; it must remain below ${INDEX_LIMIT}.`);
const tags = [...new Set(operations.map(operation => (operation.tags?.[0] ?? 'API') as string))];
const slugs = new Set<string>();
let largest = 0;
for (const tag of tags) {
  const slug = tagSlug(tag), path = `/docs/tags/${slug}.md`;
  assert.ok(!slugs.has(slug), `Tags share the slug ${slug}.`); slugs.add(slug);
  assert.ok(llms.includes(path) && index.includes(`(${path})`), `${tag} is missing from llms.txt or /docs.md.`);
  const page = createTagMarkdownDocs(document, slug)!;
  assert.ok(page, `${path} is missing.`);
  assert.ok(bytes(page) < TAG_LIMIT, `${path} is ${bytes(page)} bytes; it must remain below ${TAG_LIMIT}. Split the tag.`);
  largest = Math.max(largest, bytes(page));
}
for (const operation of operations) {
  const id = operation.operationId as string;
  const path = `/docs/operations/${id}.md`;
  assert.ok(llms.includes(path) && index.includes(`(${path})`), `${id} is missing from llms.txt or /docs.md.`);
  assert.ok(createTagMarkdownDocs(document, tagSlug(operation.tags?.[0] ?? 'API'))?.includes(`Operation ID: \`${id}\``), `${id} is missing from its tag reference.`);
  const focused = createMarkdownDocs(document, id);
  assert.ok(focused?.includes(`Operation ID: \`${id}\``), `${id} focused Markdown is missing its identity.`);
  assert.ok(focused?.includes('### TypeScript SDK') && focused.includes('### cURL'), `${id} focused Markdown is missing code examples.`);
  assert.ok(!focused?.includes('[object Object]'), `${id} focused Markdown contains an unserialized value.`);
}
assert.equal(createMarkdownDocs(document, 'missingOperation'), null);
assert.equal(createTagMarkdownDocs(document, 'missing-tag'), null);
console.log(`Verified llms.txt (${bytes(llms)} B), /docs.md (${bytes(index)} B), ${tags.length} tag references (largest ${largest} B) and ${operations.length} focused Markdown operation pages.`);
