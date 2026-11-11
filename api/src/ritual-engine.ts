/** Serializable instructions, not JavaScript. Only the compiler touches the parser; the VM never calls a function obtained from a value. */
import { parse, type AnyNode as N } from 'acorn';
import { RE2JS } from 're2js';
import { addressGlob } from './routing-match.js';

export const RUN_STEPS = 50_000,
  MESSAGE_STEPS = 250_000,
  BODY_BYTES = 65536,
  MESSAGE_BYTES = 4 * BODY_BYTES;
export type Omen = {
  prompt: string;
  type: 'score' | 'boolean';
  threshold: number;
  onError: number | boolean | 'defer';
};
type I = { op: string; l: number; k?: string; v?: string | number | boolean | null; a?: I[] };
export type RitualIR = { v: 1; root: I; refs: string[]; omens: Record<string, Omen> };
export type Intent = { op: string; ref?: string; body?: unknown; value?: string };
import { actionKinds as actions } from './ritual-schema.js';
const own = (o: object, k: string) => Object.hasOwn(o, k);
const reserved = (k: string) => ['__proto__', 'constructor', 'prototype'].includes(k);
const patterns = new Map<string, RE2JS>();
function regex(pattern: string, flags: string) {
  const key = flags + '\n' + pattern;
  let re = patterns.get(key);
  if (!re) {
    re = RE2JS.compile(
      pattern,
      (flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0) |
        (flags.includes('m') ? RE2JS.MULTILINE : 0) |
        (flags.includes('s') ? RE2JS.DOTALL : 0),
    );
    if (re.programSize() > 512) throw Error('Regex program exceeds 512 instructions');
    if (patterns.size >= 64) patterns.delete(patterns.keys().next().value!);
    patterns.set(key, re);
  }
  return re;
}
const path = (n: N): string =>
  n.type === 'Identifier'
    ? n.name
    : n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier'
      ? path(n.object) + '.' + n.property.name
      : '';
function diagnostic(n: N, msg: string): never {
  throw Error(`Line ${n.loc?.start.line ?? 1}, column ${(n.loc?.start.column ?? 0) + 1}: ${msg}`);
}
function str(n: N) {
  if (n.type !== 'Literal' || typeof n.value !== 'string') diagnostic(n, 'Expected a string literal.');
  return n.value;
}
function props(n: N) {
  if (n.type !== 'ObjectExpression') diagnostic(n, 'Expected a literal record.');
  return n.properties.map((p) => {
    if (p.type !== 'Property' || p.kind !== 'init' || p.computed || p.method) diagnostic(p, 'Use plain literal keys.');
    const k = p.key.type === 'Identifier' ? p.key.name : str(p.key);
    if (reserved(k)) diagnostic(p, 'Reserved property.');
    return [k, p.value] as const;
  });
}
const refPattern = /^(inbox|webhook|slack|discord|forward):[a-z0-9][a-z0-9_-]{0,63}$/;
export function compileRitual(source: string): RitualIR {
  if (
    Buffer.byteLength(source) > 65536 ||
    /hooks\.slack\.com\/services\/|discord\.com\/api\/webhooks\/|\b(?:ghp_|xox[bap]-|sk_live_)/i.test(source)
  )
    throw Error('Line 1, column 1: Source exceeds 64 KiB or contains a credential.');
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true });
  } catch (e) {
    const loc = (e as { loc?: { line: number; column: number } }).loc;
    throw Error(
      `Line ${loc?.line ?? 1}, column ${(loc?.column ?? 0) + 1}: ${e instanceof Error ? e.message : 'Invalid syntax'}`,
    );
  }
  const refs = new Set<string>(),
    omens: Record<string, Omen> = Object.create(null),
    globals = new Map<string, N>();
  let entry: N | undefined;
  for (const n of ast.body) {
    if (n.type === 'ExportDefaultDeclaration' && n.declaration.type === 'FunctionDeclaration' && !entry)
      entry = n.declaration;
    else if (n.type === 'VariableDeclaration' && n.kind === 'const') {
      for (const d of n.declarations) {
        if (d.id.type !== 'Identifier' || !d.init) diagnostic(d, 'Expected const name = literal omens.');
        globals.set(d.id.name, d.init);
      }
    } else diagnostic(n, 'Export one default function (email, ctx).');
  }
  if (
    !entry ||
    entry.type !== 'FunctionDeclaration' ||
    entry.async ||
    entry.generator ||
    !entry.params.length ||
    entry.params.some((p, i) => p.type !== 'Identifier' || p.name !== ['email', 'ctx'][i])
  )
    diagnostic(ast, 'Export default function route(email, ctx).');
  function compile(n: N, env: Set<string>, depth = 0): I {
    if (depth > 64) diagnostic(n, 'Nesting exceeds 64 levels.');
    const ir = (op: string, k?: string, a?: I[], v?: I['v']): I => ({
      op,
      l: n.loc!.start.line,
      ...(k === undefined ? {} : { k }),
      ...(a ? { a } : {}),
      ...(v === undefined ? {} : { v }),
    });
    const sub = (x: N) => compile(x, env, depth + 1);
    switch (n.type) {
      case 'BlockStatement': {
        const names = new Set(env);
        return ir(
          'block',
          undefined,
          n.body.map((s) => compile(s, names, depth + 1)),
        );
      }
      case 'ReturnStatement':
        return ir('return', undefined, n.argument ? [sub(n.argument)] : []);
      case 'ExpressionStatement':
        return sub(n.expression);
      case 'VariableDeclaration': {
        if (n.kind !== 'const' || n.declarations.length !== 1) diagnostic(n, 'Use one const binding.');
        const d = n.declarations[0];
        if (d.id.type !== 'Identifier' || !d.init || env.has(d.id.name) || reserved(d.id.name) || globals.has(d.id.name))
          diagnostic(d, 'Use a fresh const name.');
        const val = sub(d.init);
        env.add(d.id.name);
        return ir('bind', d.id.name, [val]);
      }
      case 'IfStatement': {
        return ir('if', undefined, [
          sub(n.test),
          compile(n.consequent, new Set(env), depth + 1),
          ...(n.alternate ? [sub(n.alternate)] : []),
        ]);
      }
      case 'Identifier':
        if (!env.has(n.name)) diagnostic(n, `Unknown binding ${n.name}.`);
        return ir('load', n.name);
      case 'Literal':
        if (
          n.value === null ||
          (['number', 'string', 'boolean'].includes(typeof n.value) &&
            !(typeof n.value === 'number' && !Number.isFinite(n.value)))
        )
          return ir('literal', undefined, undefined, n.value as I['v']);
        return diagnostic(n, 'Use literal text or addr.matches(), not a JavaScript regex.');
      case 'MemberExpression': {
        const k = n.computed
          ? n.property.type === 'Literal' && typeof n.property.value === 'number'
            ? String(n.property.value)
            : str(n.property)
          : path(n.property);
        if (!k || reserved(k)) diagnostic(n, 'Use a literal property name.');
        return ir('get', k, [sub(n.object)]);
      }
      case 'ChainExpression':
        return sub(n.expression);
      case 'ArrayExpression':
        return ir(
          'array',
          undefined,
          n.elements.map((x) => (x ? sub(x) : diagnostic(n, 'No array holes.'))),
        );
      case 'ObjectExpression':
        return ir(
          'record',
          undefined,
          props(n).map(([k, x]) => ir('field', k, [sub(x)])),
        );
      case 'TemplateLiteral':
        return ir(
          'template',
          undefined,
          n.quasis.flatMap((q, i) => [
            ir('literal', undefined, undefined, q.value.cooked ?? ''),
            ...(n.expressions[i] ? [sub(n.expressions[i])] : []),
          ]),
        );
      case 'UnaryExpression':
        if (n.operator === '!') return ir('not', undefined, [sub(n.argument)]);
        break;
      case 'LogicalExpression':
      case 'BinaryExpression':
        if (['&&', '||', '??', '===', '!==', '>', '<', '>=', '<=', '+'].includes(n.operator))
          return ir('binary', n.operator, [sub(n.left), sub(n.right)]);
        break;
      case 'ConditionalExpression':
        return ir('if', undefined, [sub(n.test), sub(n.consequent), sub(n.alternate)]);
      case 'CallExpression': {
        const name = path(n.callee),
          args = n.arguments;
        if (
          n.callee.type === 'MemberExpression' &&
          !n.callee.computed &&
          path(n.callee.property) === 'test' &&
          n.callee.object.type === 'Literal' &&
          n.callee.object.regex
        ) {
          const { pattern, flags } = n.callee.object.regex;
          if (args.length !== 1 || pattern.length > 256 || /[^imsu]/.test(flags) || /[{}]/.test(pattern))
            diagnostic(n, 'Use a short literal RE2 pattern without counted repeats.');
          try {
            regex(pattern, flags);
          } catch {
            diagnostic(n, 'Unsupported RE2 pattern.');
          }
          return ir('regex', flags, [sub(args[0])], pattern);
        }
        if (name === 'omens') {
          if (args.length !== 2 || path(args[0]) !== 'email') diagnostic(n, 'Use omens(email, literalOmens).');
          const defs = props(globals.get(path(args[1])) ?? args[1]);
          for (const [key, val] of defs) {
            if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(key) || reserved(key)) diagnostic(val, 'Invalid omen name.');
            const opts =
              val.type === 'Literal'
                ? { prompt: str(val) }
                : Object.fromEntries(
                    props(val).map(([k, v]) => {
                      if (!['prompt', 'type', 'threshold', 'onError'].includes(k) || v.type !== 'Literal')
                        diagnostic(v, 'Expected literal omen options.');
                      return [k, v.value];
                    }),
                  );
            const { prompt, type = 'score', threshold = 0.5, onError = type === 'score' ? 0 : false } = opts;
            if (
              typeof prompt !== 'string' ||
              prompt.length < 8 ||
              prompt.length > 500 ||
              (type !== 'score' && type !== 'boolean') ||
              typeof threshold !== 'number' ||
              threshold < 0.05 ||
              threshold > 0.95 ||
              !(
                onError === 'defer' ||
                (type === 'boolean'
                  ? typeof onError === 'boolean'
                  : typeof onError === 'number' && onError >= 0 && onError <= 1)
              )
            )
              diagnostic(val, 'Invalid prompt, type, threshold or onError.');
            const ev: Omen = { prompt, type, threshold, onError: onError as Omen['onError'] };
            if (omens[key] && JSON.stringify(omens[key]) !== JSON.stringify(ev))
              diagnostic(val, 'Conflicting omen name.');
            omens[key] = ev;
          }
          return ir(
            'scores',
            undefined,
            defs.map(([k]) => ir('key', k)),
          );
        }
        // Endpoint selection is syntax, never evaluated data. A quoted property also supports existing keys with hyphens.
        const call=n.callee;
        if(call.type==='MemberExpression' && call.object.type==='Identifier' && ['slack','discord','webhook','forward'].includes(call.object.name)) {
          const kind=call.object.name, key=call.computed?str(call.property):path(call.property), ref=`${kind}:${key}`;
          if(!refPattern.test(ref)||reserved(key))diagnostic(n,'Use a configured endpoint name.');
          if(kind==='forward'?args.length!==0:kind==='webhook'?args.length>1:args.length!==1)diagnostic(n,'Wrong number of endpoint arguments.');
          if((kind==='slack'||kind==='discord') && args[0].type==='ObjectExpression'){const fields=props(args[0]);if(fields.length!==1||fields[0][0]!== (kind==='slack'?'text':'content'))diagnostic(n,kind==='slack'?'Expected {text}.':'Expected {content}.');}
          refs.add(ref);return ir('action',kind==='forward'?'email.forward':kind==='webhook'?'webhook.send':`${kind}.post`,[ir('literal',undefined,undefined,ref),...args.map(sub)]);
        }
        if(name==='inbox.deliver'){if(args.length!==1)diagnostic(n,'Use one literal endpoint key.');const ref=(name==='inbox.deliver'?'inbox:':'')+str(args[0]);if(!refPattern.test(ref))diagnostic(n,'Use a configured endpoint key, not an address or URL.');refs.add(ref);return ir('action',name,[ir('literal',undefined,undefined,ref)]);}
        if(own(actions,name)&&!actions[name]){if(args.length>(name==='allow'?0:1))diagnostic(n,'Too many action arguments.');return ir('action',name,args.map(sub));}
        if (
          [
            'lists.has',
            'addr.matches',
            'email.headers.get',
            'email.headers.has',
            'email.headers.getAll',
            'text.snippet',
          ].includes(name)
        ) {
          if (args.length !== (name.startsWith('email.headers.') ? 1 : 2)) diagnostic(n, 'Wrong argument count.');
          return ir('builtin', name, args.map(sub));
        }
        if (
          n.callee.type === 'MemberExpression' &&
          !n.callee.computed &&
          n.callee.property.type === 'Identifier' &&
          ['includes', 'startsWith', 'endsWith', 'toLowerCase'].includes(n.callee.property.name)
        )
          return ir('builtin', n.callee.property.name, [sub(n.callee.object), ...args.map(sub)]);
        diagnostic(n, 'Unknown call. Only named Ritual built-ins may be called.');
      }
    }
    return diagnostic(n, `Unsupported ${n.type}.`);
  }
  const root = compile(entry.body, new Set(['email', 'ctx']));
  if(Object.keys(omens).length>10)diagnostic(entry,'Limit: 10 omens.');
  const ir = { v: 1 as const, root, refs: [...refs], omens };
  if (Buffer.byteLength(JSON.stringify(ir)) > 131072) diagnostic(entry, 'Compiled ritual exceeds 128 KiB.');
  return ir;
}

// Refuse a large output before JSON.stringify, including repeated references to the same subtree.
function weigh(v: unknown, charge: (n: number) => void, depth = 0) {
  if (depth > 64) throw Error('Output nesting limit');
  charge(1);
  if (typeof v === 'string') charge(v.length);
  else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      charge(k.length + 1);
      weigh((v as Record<string, unknown>)[k], charge, depth + 1);
    }
  }
}
export function runRitual(
  ir: RitualIR,
  email: Record<string, unknown>,
  ctx: Record<string, unknown>,
  scores: Record<string, number | boolean>,
  lists: Record<string, string[]> = {},
  limit = RUN_STEPS,
) {
  const intents: Intent[] = [],
    trace: number[] = [],
    vars = new Map<string, unknown>([
      ['email', email],
      ['ctx', ctx],
    ]);
  let steps = 0,
    bytes = 0,
    returned = false,
    line = 0;
  function tick(n = 1) {
    steps += n;
    if (steps > Math.min(limit, RUN_STEPS)) throw Error('Step budget exceeded');
  }
  const scalar = (v: unknown) => {
    if (v != null && typeof v === 'object') throw Error('Expected a scalar');
    return String(v ?? '');
  };
  function visit(i: I): any {
    tick();
    line = i.l;
    const a = i.a ?? [],
      k = i.k ?? '',
      x = () => visit(a[0]),
      y = () => visit(a[1]);
    switch (i.op) {
      case 'literal':
        return i.v;
      case 'load':
        return vars.get(k);
      case 'get': {
        const o = x();
        return o != null && Object.hasOwn(o, k) && !reserved(k) ? o[k] : undefined;
      }
      case 'bind':
        vars.set(k, x());
        return;
      case 'return':
        if (a.length) x();
        returned = true;
        return;
      case 'block':
        for (const s of a) {
          if (returned) break;
          if (trace.length < 128) trace.push(s.l);
          visit(s);
        }
        return;
      case 'if':
        return x() ? y() : a[2] ? visit(a[2]) : undefined;
      case 'not':
        return !x();
      case 'array':
        return a.map(visit);
      case 'record':
        return Object.assign(Object.create(null), Object.fromEntries(a.map((f) => [f.k!, visit(f.a![0])])));
      case 'template': {
        let out = '';
        for (const e of a) {
          const s = scalar(visit(e));
          tick(Math.ceil(s.length / 32));
          if (out.length + s.length > BODY_BYTES) throw Error('String limit');
          out += s;
        }
        return out;
      }
      case 'binary': {
        const v = x();
        if (k === '&&') return v && y();
        if (k === '||') return v || y();
        if (k === '??') return v ?? y();
        const w = y();
        if (typeof v === 'string' || typeof w === 'string')
          tick(Math.ceil(((typeof v === 'string' ? v.length : 0) + (typeof w === 'string' ? w.length : 0)) / 32));
        if (k === '===') return v === w;
        if (k === '!==') return v !== w;
        if (typeof v === 'object' || typeof w === 'object') throw Error('Expected scalars');
        if (k === '+') {
          if (typeof v === 'number' && typeof w === 'number') return v + w;
          const s = scalar(v) + scalar(w);
          if (s.length > BODY_BYTES) throw Error('String limit');
          return s;
        }
        return k === '>' ? v > w : k === '<' ? v < w : k === '>=' ? v >= w : v <= w;
      }
      case 'scores':
        return Object.fromEntries(a.map((e) => [e.k!, scores[e.k!]]));
      case 'regex': {
        const s = x();
        if (typeof s !== 'string' || s.length > 65536) throw Error('Regex input exceeds 64 Ki characters');
        const re = regex(String(i.v), k);
        tick(Math.ceil(((s.length + 1) * re.programSize()) / 16));
        return re.test(s);
      }
      case 'builtin': {
        const [v, w] = a.map(visit);
        if (typeof v !== 'string') throw Error('Expected text');
        tick(Math.ceil((v.length + (typeof w === 'string' ? w.length : 0)) / 32));
        if (k === 'lists.has') {
          const entries = Object.hasOwn(lists, v) ? lists[v] : [];
          tick(entries.length);
          return typeof w === 'string' && entries.some((e) => e === w || (e.startsWith('@') && w.endsWith(e)));
        }
        if (k.startsWith('email.headers.')) {
          const h = email.headers as Record<string, string[]>;
          const all = h && own(h, v.toLowerCase()) ? h[v.toLowerCase()] : [];
          return k.endsWith('.has') ? all.length > 0 : k.endsWith('.get') ? (all[0] ?? null) : all;
        }
        if (k === 'addr.matches') return typeof w === 'string' && w.length <= 254 && v.length <= 320 && addressGlob(w, v);
        if (k === 'text.snippet') return v.slice(0, Math.max(0, Math.min(Number(w) || 0, 4096)));
        if (k === 'toLowerCase') return v.toLowerCase();
        if (typeof w !== 'string') throw Error('Expected text');
        return k === 'includes' ? v.includes(w) : k === 'startsWith' ? v.startsWith(w) : v.endsWith(w);
      }
      case 'action': {
        if (intents.length >= 32) throw Error('Action budget exceeded');
        const args = a.map(visit),
          ref = actions[k] ? args[0] : undefined;
        if (ref && !ir.refs.includes(ref)) throw Error('Undeclared endpoint');
        if (k === 'allow' && !(email.auth as { fromVerified: boolean })?.fromVerified) return;
        let size = 0;
        for (const val of args) {
          weigh(val, (n) => {
            size += n;
            if (size > BODY_BYTES) throw Error('Output budget exceeded');
          });
        }
        tick(Math.ceil(size / 32));
        const b = Buffer.byteLength(JSON.stringify(args));
        if (b > BODY_BYTES || (bytes += b) > MESSAGE_BYTES) throw Error('Output budget exceeded');
        intents.push({
          op: k,
          ...(ref
            ? { ref, ...(args.length > 1 ? { body: args[1] } : {}) }
            : args.length
              ? { value: scalar(args[0]).slice(0, 128) }
              : {}),
        });
        return;
      }
      default:
        throw Error('Invalid instruction');
    }
  }
  try {
    visit(ir.root);
    return { intents, steps, bytes, trace, error: null };
  } catch (e) {
    return {
      intents: [] as Intent[],
      steps,
      bytes: 0,
      trace,
      error: `Line ${line}: ${e instanceof Error ? e.message : 'Ritual failed'}`,
    };
  }
}
