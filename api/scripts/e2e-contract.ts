import { readFileSync } from 'node:fs';
import { dereference, validate, type Schema } from '@cfworker/json-schema';

type Operation = { operationId: string; responses: Record<string, {content?: Record<string,{schema?: Schema}>}> };
const doc: {components: {schemas: Record<string,Schema>}; paths: Record<string,Record<string,Operation>>} = JSON.parse(readFileSync(new URL('../openapi.json',import.meta.url),'utf8'));
const operations = new Map(Object.values(doc.paths).flatMap(path => Object.values(path).filter(op=>op.operationId).map(op=>[op.operationId,op] as const)));
export const contract = new Set(operations.keys());
// Index only schema objects, not OpenAPI metadata, at their actual JSON pointers.
const lookup: Record<string,Schema | boolean> = Object.create(null);
for (const [name,schema] of Object.entries(doc.components.schemas)) dereference(schema,lookup,undefined,`/components/schemas/${name}`);
for (const [name,op] of operations) for (const [status,res] of Object.entries(op.responses)) {
  for (const [mime,m] of Object.entries(res.content ?? {})) if (m.schema) dereference(m.schema,lookup,undefined,`/responses/${name}/${status}/${encodeURIComponent(mime)}`);
}
export function assertResponse(op: string, status: number, contentType: string | null, payload: unknown) {
  const spec = operations.get(op)?.responses[status];
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  const schema = mime && spec?.content?.[mime]?.schema;
  if (!schema) throw new Error(`${op}: undocumented response HTTP ${status} ${mime ?? '(no Content-Type)'}`);
  const result = validate(payload,schema,'2020-12',lookup);
  if (!result.valid) {
    // Never log response data (keys, receipts, signed URLs). Schema locations are sufficient.
    const error = result.errors.at(-1)!;
    throw new Error(`${op}: HTTP ${status} violates schema at ${error.instanceLocation} (${error.keywordLocation})`);
  }
}
