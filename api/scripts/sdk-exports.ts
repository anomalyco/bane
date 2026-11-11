// The barrel is generated; add handwritten SDK helpers each time it is rebuilt.
import { appendFile } from 'node:fs/promises';
await appendFile(new URL('../../sdk/src/index.ts',import.meta.url),"export { waitForMessage, InboxWaitTimeout } from './inbox.js';\n");
