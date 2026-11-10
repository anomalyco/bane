import { writeFile } from 'node:fs/promises';
import { createOpenApiApp } from './app.js';
import { createOpenApiDocument } from './openapi-docs.js';
const document = createOpenApiDocument(await createOpenApiApp());
await writeFile(new URL('../openapi.json', import.meta.url), JSON.stringify(document, null, 2) + '\n');
console.log(`Generated OpenAPI for ${Object.keys(document.paths ?? {}).length} paths.`);
