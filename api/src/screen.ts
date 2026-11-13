import { ApiError, digest, type Runtime } from './core.js';
import type { EmailSnapshot } from './db/sending.js';
import { VISIBLE_WORDS } from './screened-html.js';
import { formattedSender } from './sending.js';

// Opt-in content screen for live transactional mail (`screen: true`): asks Jev, TypeSafe AI's decision
// model (directly or through OpenCode's inference gateway, per JEV_ENDPOINT), how likely a message is advertising smuggled into a transactional template (for example a
// gambling ad set as a workspace name in an invitation). The dispatcher decides what to do with the score.

const MAX_BODY = 8000;
const MAX_SCREEN_BYTES = 24 * 1024;
const MAX_CHUNKS = 4;
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const DEADLINE_MS = 500;
const QUESTIONS = {
  spam: {
    type: 'noul',
    instructions: 'For transactional mail, detect unsolicited advertising smuggled into a receipt, invitation or notification. For marketing, do not flag ordinary subscribed promotions: flag deceptive impersonation, credential theft, scams or unrelated malicious pitches.',
    criteria: {
      true: 'The message exists to advertise or lure the recipient to a third-party site, contact or offer unrelated to the sending service',
      false: 'A genuine transactional message: invitation, receipt, code, notification or similar, even if a name in it is unusual',
    },
  },
};

export type ScreenResult = { spam: number; model: string };
// Bulk invitations repeat identical content, so one verdict serves every copy for an hour.
// Insertion order is age order: the first key is always the oldest entry.
const cache = new Map<string, { expires: number; result: ScreenResult }>();
const flights=new WeakMap<Runtime['storage'],Map<string,Promise<ScreenResult>>>();

// The text as a reader sees it: compatibility forms folded, and the characters that draw nothing (format controls,
// combining marks, Hangul fillers and other default-ignorable code points) removed.
const normalize = (s: string) => s.normalize('NFKC').replace(/[\p{Cf}\p{Mn}\p{Default_Ignorable_Code_Point}]/gu, '');
function copy(s = '') {
  const sentences = normalize(s).split(/\n+|(?<=[.!?])\s+/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(sentences)].join(' ');
}
const tooLarge = () => new ApiError(422,'CONTENT_TOO_LARGE_TO_SCREEN','Shorten the message so Hosted sending can screen it.');
// Repeat link signals and a little preceding context in each window. Split on
// UTF-8 boundaries; a clean result is meaningful only after the last window.
function completeBodies(content: string, links: string) {
  const bytes = Buffer.from(content), prefix = links ? links+'\n' : '';
  if (bytes.length > MAX_SCREEN_BYTES || Buffer.byteLength(links) > 1000) throw tooLarge();
  const bodies: string[] = [], width = MAX_BODY - Buffer.byteLength(prefix);
  let start = 0;
  do {
    if (bodies.length === MAX_CHUNKS) throw tooLarge();
    let end = Math.min(bytes.length, start + width);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    bodies.push(prefix + bytes.toString('utf8', start, end));
    if (end === bytes.length) break;
    start = end - 256;
    while ((bytes[start]! & 0xc0) === 0x80) start--;
  } while (true);
  return bodies;
}
function host(value: string) {
  try { return new URL(value.startsWith('//') ? 'https:'+value : value).hostname.toLowerCase(); } catch { return ''; }
}
const INLINE=new Set(['a','abbr','b','bdi','bdo','big','cite','code','data','del','dfn','em','font','i','ins','kbd','label','mark','q','s','samp','small','span','strike','strong','sub','sup','time','tt','u','var','wbr','img','input','button','select','textarea','output','meter','progress','picture','source','svg','text','tspan','math','mi','mo','mn','ruby','rt','rp','nobr']);
/**
 * An HTML body as the screen reads it: the text a client lays out, every host it links or loads, anchors whose text
 * names another host than their href, and its links and images (for the support lint, src/deliverability.ts).
 */
export async function readHtml(html: string) {
  const { boundedHtmlFragment } = await import('./bounded-html.js');
  if (html.length>512*1024) throw tooLarge();
  const fragment=boundedHtmlFragment(html,'fragment',{clients:true});
  if (!fragment) throw tooLarge();
  const hosts=new Set<string>(), mismatches=new Set<string>(), links:string[]=[], images:{ alt: boolean }[]=[];
  // Text as a client lays it out: inline runs stay one word, block elements end the line, and text a client shows
  // beside the flow (alt, title) follows on its own lines, as does a table row whose cells hold short pieces read
  // glued, the way a recipient reads a word laid out across adjacent cells.
  const lines:string[]=[], aside:string[]=[], rows:string[][]=[]; let line='';
  const flush=()=>{ if(line.trim()) lines.push(line); line=''; };
  const walk=(node:typeof fragment.childNodes[number], anchor:string)=>{
    if ('value' in node) {
      line+=node.value;
      if(anchor) for(const word of normalize(node.value).split(/\s+/)) {
        if(!word.includes('.') || word.length>2048)continue;
        const label=host(word.includes('://')?word:'https://'+word);
        if(label && label!==anchor) mismatches.add(`${label} → ${anchor}`);
      }
      return;
    }
    const children='childNodes' in node ? node.childNodes : [];
    if (!('tagName' in node)) { for (const child of children) walk(child,anchor); return; }
    const tag=node.tagName;
    if (['style','script','template','head','title','xml'].includes(tag)) return;
    let display='';
    for (const a of node.attrs) {
      if (['href','src','srcset','background','action','style'].includes(a.name)) {
        for(const m of normalize(a.value).matchAll(/(?:https?:)?\/\/[^\s,)'"<>]+/gi)) { const h=host(m[0]); if(h) hosts.add(h); }
        if(tag==='a' && a.name==='href') { anchor=host(normalize(a.value)); links.push(normalize(a.value)); }
      }
      if (a.name==='style') display=/(?:^|;)\s*display\s*:\s*([a-z-]+)/i.exec(a.value)?.[1]?.toLowerCase() ?? '';
      if (['alt','title'].includes(a.name) && a.value.trim()) aside.push(a.value);
    }
    if (tag==='img') images.push({ alt: node.attrs.some(a=>a.name==='alt' && !!a.value.trim()) });
    const inline=display ? display.startsWith('inline') : INLINE.has(tag);
    if (!inline) flush();
    const start=lines.length;
    if (tag==='tr') rows.push([]);
    for (const child of children) walk(child,anchor);
    if (!inline) flush();
    if (tag==='td' || tag==='th') rows[rows.length-1]?.push(lines.slice(start).join(' '));
    if (tag==='tr') { const cells=rows.pop()!; if (cells.length>1 && cells.some(cell=>cell.trim() && cell.trim().length<=4)) aside.push(cells.join('')); }
  };
  for (const child of fragment.childNodes) walk(child,'');
  flush();
  return { text: [...lines,...aside].join('\n'), hosts, mismatches, links, images };
}
async function body(snapshot: EmailSnapshot) {
  // Preserve order and repetitions in mandatory input; deduplicating sentences
  // could change the meaning or make an over-limit message appear to fit.
  const project=(s='')=>normalize(s).replace(/\s+/g,' ').trim();
  const plain=project(snapshot.text), raw=project(snapshot.raw);
  let rendered='', hosts=new Set<string>(), mismatches=new Set<string>();
  if (snapshot.html) {
    const read=await readHtml(snapshot.html);
    rendered=project(read.text); hosts=read.hosts; mismatches=read.mismatches;
  }
  const signals=[...mismatches,...hosts];
  if(signals.length>60) throw tooLarge();
  const links=signals.join('\n');
  const words=(v:string)=>new Set(v.toLowerCase().match(VISIBLE_WORDS));
  function overlap(text:string, html:string) {
    const a=words(text), b=words(html), common=[...a].filter(w=>b.has(w)).length;
    return a.size && b.size ? common/(a.size+b.size-common) : undefined;
  }
  return { bodies:completeBodies([rendered,plain,raw].filter(Boolean).join('\n'),links), textHtmlOverlap:overlap(plain,rendered) };
}
export async function jevQuestions(endpoint:string,apiKey:string,model:string,state:unknown,questions:unknown,deadline:number):Promise<unknown> {
  // The deadline includes reading the response body. Never retry inside a send lease.
  let response: Response;
  try {
    response = await fetch(endpoint, {
      // Never follow a redirect: the key and the message body go only to the configured endpoint. Workers
      // reject redirect: 'error', so use 'manual'; a 3xx is not ok and counts as unavailable below.
      method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(deadline),
    });
  } catch {
    throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier could not be reached.', undefined, true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', `The content classifier failed with HTTP ${response.status}.`, undefined, true);
  }
  const reader=response.body?.getReader(); if(!reader)return null;
  const chunks:Uint8Array[]=[];let bytes=0;for(;;){const {value,done}=await reader.read();if(done)break;if((bytes+=value.length)>32768){await reader.cancel();return null}chunks.push(value)}
  try{return JSON.parse(Buffer.concat(chunks).toString())}catch{return null}
}
async function evaluate(endpoint: string, apiKey: string, model: string, state: unknown): Promise<ScreenResult> {
  const parsed = await jevQuestions(endpoint,apiKey,model,state,QUESTIONS,DEADLINE_MS) as { model?: unknown; answers?: { spam?: { noul?: unknown } } } | null;
  const spam = parsed?.answers?.spam?.noul;
  if (typeof spam !== 'number' || !Number.isFinite(spam) || spam<0 || spam>1) throw new ApiError(503, 'CONTENT_SCREEN_UNAVAILABLE', 'The content classifier returned no valid spam score.', undefined, true);
  return { spam, model: typeof parsed?.model === 'string' ? parsed.model : model };
}

/** Spam probability for one snapshot, or null when the installation has no classifier configured. */
export async function screenSnapshot(runtime: Runtime, snapshot: EmailSnapshot, required=false): Promise<ScreenResult | null> {
  const settings = runtime.config.screen;
  if (!settings) return null;
  const from = formattedSender(snapshot.from, snapshot.fromName);
  const recipients=snapshot.to.length+snapshot.cc.length+snapshot.bcc.length;
  const key = await digest(JSON.stringify([runtime.config.workspaceId,settings.endpoint,settings.model,required,from,snapshot.kind,snapshot.subject,snapshot.text,snapshot.html,snapshot.raw,recipients]));
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.result;
  if (hit) cache.delete(key);
  // Concurrent copies share one request; failures are not cached so the next copy retries.
  let pending=flights.get(runtime.storage);if(!pending){pending=new Map();flights.set(runtime.storage,pending);}
  const existing=pending.get(key);if(existing)return existing;
  const lookup=body(snapshot).then(async ({bodies,textHtmlOverlap})=>{
    const sender=copy(from), subject=copy(snapshot.subject);
    let highest: ScreenResult | undefined;
    for (const body of bodies) {
      const result=await evaluate(settings.endpoint,settings.apiKey,settings.model,{email:{from:required?sender:sender.slice(0,100),kind:snapshot.kind,subject:required?subject:subject.slice(0,200),body},signals:{recipients,textHtmlOverlap}});
      if (!highest || result.spam>highest.spam) highest=result;
    }
    return highest!;
  });pending.set(key,lookup);
  try{const result=await lookup;cache.set(key,{expires:now+TTL_MS,result});
    while(cache.size>MAX_ENTRIES)cache.delete(cache.keys().next().value!);return result;
  }finally{pending.delete(key);}
}
