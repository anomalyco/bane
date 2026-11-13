import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

// UI notes for agents: the notes Bane staff leave on the dashboard (⌘-click in notes mode), their screenshots, and
// their status as they are fixed. It talks to the deployment's API with a UI notes key, which an operator makes on
// /operator/notes (Agent keys) for themself: it reads notes and sets status, PR link and resolution, nothing else, and
// stops working when it expires (at most 90 days), is revoked, or its operator loses the operator role.
//
//   BANE_URL=https://bane.mx BANE_UI_NOTES_KEY=bane_notes_… node --import tsx scripts/ui-notes.ts <command>
//
//   list [--status open,in_progress] [--kind bug,spacing] [--route /campaigns/:id/edit] [--json] [--screenshots DIR]
//       Every matching note, newest first. --screenshots saves each note's screenshot as DIR/<id>.<ext> and adds its
//       path to the JSON as screenshotPath (links expire after five minutes, so they are fetched right away).
//   get <id> [--json] [--screenshot PATH]
//   set-status <id> open|in_progress|fixed|wontfix [--pr URL] [--resolution TEXT]
//
// BANE_URL defaults to https://bane.mx; use https://dev.bane.mx (and a key made there) for dev.
type Note = { id: string; body: string; kind: string; severity: string | null; status: string; prUrl: string | null; resolution: string | null;
  page: { url: string; path: string; route: string }; element: { selector: string; component: string | null; text: string | null };
  screenshot: { url: string; contentType: string } | null; createdAt: string; [key: string]: unknown };
const STATUSES = ['open', 'in_progress', 'fixed', 'wontfix'];
const usage = 'Usage: ui-notes.ts list [--status S,…] [--kind K,…] [--route R] [--json] [--screenshots DIR] | get <id> [--json] [--screenshot PATH] | set-status <id> open|in_progress|fixed|wontfix [--pr URL] [--resolution TEXT]';

export async function uiNotes(args: string[], env: Record<string, string | undefined> = process.env, out: (line: string) => void = line => console.log(line)) {
  const base = (env.BANE_URL ?? 'https://bane.mx').replace(/\/$/, ''), key = env.BANE_UI_NOTES_KEY;
  if (!key || !/^bane_notes_[0-9a-f]{64}$/.test(key)) throw new Error('Set BANE_UI_NOTES_KEY to a UI notes key (make one on /operator/notes → Agent keys).');
  if (!/^https?:\/\/[^/]+$/.test(base)) throw new Error('Set BANE_URL to the deployment origin, such as https://bane.mx.');
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' });
    const data = await response.json().catch(() => null) as { error?: { code: string; message: string; requestId?: string } } | null;
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${data?.error?.code ?? ''} ${data?.error?.message ?? ''}${data?.error?.requestId ? ` (${data.error.requestId})` : ''}`.trim());
    return data as T;
  };
  const save = async (note: Note, path: string) => {
    if (!note.screenshot) return null;
    const response = await fetch(note.screenshot.url, { redirect: 'error' });
    if (!response.ok) throw new Error(`Screenshot of ${note.id}: ${response.status}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
    return path;
  };
  const extension = (note: Note) => ({ 'image/png': 'png', 'image/jpeg': 'jpg' } as Record<string, string>)[note.screenshot?.contentType ?? ''] ?? 'webp';
  const line = (note: Note) => `${note.id}  ${note.status.padEnd(11)} ${note.kind.padEnd(9)} ${(note.severity ?? '-').padEnd(6)} ${note.page.route}\n    ${note.body.replace(/\s+/g, ' ').slice(0, 160)}\n    ${note.element.component ? `${note.element.component} · ` : ''}${note.element.selector}${note.prUrl ? `\n    PR ${note.prUrl}` : ''}`;
  const { positionals: [command, ...rest], values } = parseArgs({ args, allowPositionals: true, options: {
    status: { type: 'string' }, kind: { type: 'string' }, route: { type: 'string' }, json: { type: 'boolean' }, screenshots: { type: 'string' }, screenshot: { type: 'string' }, pr: { type: 'string' }, resolution: { type: 'string' } } });

  if (command === 'list' && !rest.length) {
    const notes: (Note & { screenshotPath?: string | null })[] = [];
    for (let cursor: string | null = null, first = true; first || cursor; first = false) {
      const query = new URLSearchParams(Object.entries({ status: values.status, kind: values.kind, route: values.route, cursor: cursor ?? undefined, limit: '200' }).filter((entry): entry is [string, string] => Boolean(entry[1])));
      const page: { data: Note[]; nextCursor: string | null } = await api('GET', `/v1/operator/ui-notes?${query}`);
      notes.push(...page.data); cursor = page.nextCursor;
    }
    if (values.screenshots) for (const note of notes) note.screenshotPath = await save(note, join(values.screenshots, `${note.id}.${extension(note)}`));
    if (values.json) out(JSON.stringify(notes, null, 2));
    else out(notes.length ? notes.map(line).join('\n') : 'No notes.');
    return notes;
  }
  if (command === 'get' && rest.length === 1) {
    const note = await api<Note>('GET', `/v1/operator/ui-notes/${encodeURIComponent(rest[0]!)}`);
    const screenshotPath = values.screenshot ? await save(note, values.screenshot) : undefined;
    out(values.json ? JSON.stringify({ ...note, ...(screenshotPath !== undefined ? { screenshotPath } : {}) }, null, 2) : `${line(note)}${screenshotPath ? `\n    screenshot ${screenshotPath}` : values.screenshot ? '\n    no screenshot' : ''}`);
    return note;
  }
  if (command === 'set-status' && rest.length === 2 && STATUSES.includes(rest[1]!)) {
    const note = await api<Note>('PATCH', `/v1/operator/ui-notes/${encodeURIComponent(rest[0]!)}`, { status: rest[1], ...(values.pr ? { prUrl: values.pr } : {}), ...(values.resolution ? { resolution: values.resolution } : {}) });
    out(values.json ? JSON.stringify(note, null, 2) : line(note));
    return note;
  }
  throw new Error(usage);
}

if (import.meta.main) {
  try { await uiNotes(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
