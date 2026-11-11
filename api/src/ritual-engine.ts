/** Serializable instructions, not JavaScript. Only the compiler touches the parser; the VM never calls a function obtained from a value. */
import { parse, type AnyNode as N } from 'acorn';
import { RE2JS } from 're2js';
import { addressGlob } from './routing-match.js';
import { builtins, closest, fieldAt, stringMethods } from './ritual-schema.js';

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
/** One endpoint call in the source. Checked against the endpoint's type when the ritual is saved. */
export type CallSite = { ref: string; line: number; column: number; args: number; fields: string[] | null };
export type ListSite = { name: string; line: number; column: number };
export type RitualIR = { v: 1; root: I; refs: string[]; omens: Record<string, Omen>; sites?: CallSite[]; lists?: ListSite[] };
export type Intent = { op: string; ref?: string; body?: unknown; value?: string };
export type Diagnostic = { line: number; column: number; endLine: number; endColumn: number; message: string; hint?: string; ritual?: string };

/** A compile error with a source position. `message` keeps the "Line L, column C:" form. */
export class RitualError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(`Line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}${diagnostic.hint ? ` ${diagnostic.hint}` : ''}`);
  }
}
/** Actions whose first argument names a destination resolved at save time. */
const REF_ACTIONS = new Set(['inbox.deliver', 'endpoint']);
const ACTIONS = new Set(Object.entries(builtins).filter(([, b]) => b.action).map(([name]) => name));
const LEGACY_ENDPOINTS = new Set(['slack', 'discord', 'webhook', 'forward']);
const own = (o: object, k: string) => Object.hasOwn(o, k);
const reserved = (k: string) => ['__proto__', 'constructor', 'prototype'].includes(k);
const patterns = new Map<string, RE2JS>();
function regex(pattern: string, flags: string, charge?: (n:number)=>void) {
  const key = flags + '\n' + pattern;
  let re = patterns.get(key);
  if (!re) {
    charge?.(200);
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
/** Static member path: email.from.address → ['email','from','address']; anything dynamic → null. */
function staticPath(n: N): string[] | null {
  const path:string[]=[];
  for (;;) {
    if (path.length>64) diagnostic(n,'Nesting exceeds 64 levels.');
    if(n.type==='Identifier')return [...path,n.name].reverse();
    if(n.type==='ChainExpression'){n=n.expression;continue;}
    if(n.type!=='MemberExpression')return null;
    if(!n.computed && n.property.type==='Identifier')path.push(n.property.name);
    else if(n.computed && n.property.type==='Literal' && ['string','number'].includes(typeof n.property.value))path.push(String(n.property.value));
    else return null;
    n=n.object;
  }
}
const dotted = (n: N) => staticPath(n)?.join('.') ?? '';
function diagnostic(n: N, message: string, hint?: string): never {
  throw new RitualError({
    line: n.loc?.start.line ?? 1,
    column: (n.loc?.start.column ?? 0) + 1,
    endLine: n.loc?.end.line ?? n.loc?.start.line ?? 1,
    endColumn: (n.loc?.end.column ?? n.loc?.start.column ?? 0) + 1,
    message,
    ...(hint ? { hint } : {}),
  });
}
function str(n: N, what = 'a string literal') {
  if (n.type !== 'Literal' || typeof n.value !== 'string') diagnostic(n, `Expected ${what}.`, 'Write the text in quotes; it cannot come from the email.');
  return n.value;
}
function props(n: N) {
  if (n.type !== 'ObjectExpression') diagnostic(n, 'Expected a literal record such as { name: "question" }.');
  return n.properties.map(p => {
    if (p.type !== 'Property' || p.kind !== 'init' || p.computed || p.method) diagnostic(p, 'Use plain literal keys.', 'Spread, computed keys and methods are not available.');
    const k = p.key.type === 'Identifier' ? p.key.name : str(p.key);
    if (reserved(k)) diagnostic(p, `${k} is a reserved property name.`);
    return [k, p.value] as const;
  });
}
const callable = ['block', 'drop', 'junk', 'allow', 'label', 'inbox.deliver', 'endpoints.<name>', 'omens', 'lists.has', 'addr.matches', 'text.snippet', 'email.headers.get', 'email.headers.has', 'email.headers.getAll'];
const UNSUPPORTED: Record<string, string> = {
  ForStatement: 'Loops are not available; a ritual runs once per recipient within a fixed step budget.',
  ForOfStatement: 'Loops are not available; a ritual runs once per recipient within a fixed step budget.',
  ForInStatement: 'Loops are not available; a ritual runs once per recipient within a fixed step budget.',
  WhileStatement: 'Loops are not available; a ritual runs once per recipient within a fixed step budget.',
  DoWhileStatement: 'Loops are not available; a ritual runs once per recipient within a fixed step budget.',
  FunctionDeclaration: 'Only the default export may be a function.',
  FunctionExpression: 'Only the default export may be a function.',
  ArrowFunctionExpression: 'Only the default export may be a function.',
  AssignmentExpression: 'Bindings cannot change. Declare a new const instead.',
  UpdateExpression: 'Bindings cannot change. Declare a new const instead.',
  TryStatement: 'try/catch is not available. A failed ritual takes no actions and records a ritual-error label.',
  ThrowStatement: 'throw is not available. Call block(), drop() or junk() instead.',
  NewExpression: 'Constructors are not available.',
  AwaitExpression: 'Rituals are synchronous; endpoint calls are queued and delivered after the ritual returns.',
  SwitchStatement: 'Use if / else if instead of switch.',
  SpreadElement: 'Spread is not available. List the fields you want.',
  SequenceExpression: 'Write one expression per statement.',
};

export function compileRitual(source: string): RitualIR {
  if (Buffer.byteLength(source) > 65536) throw new RitualError({ line: 1, column: 1, endLine: 1, endColumn: 1, message: 'Source exceeds 64 KiB.' });
  const secret = /hooks\.slack\.com\/services\/|discord\.com\/api\/webhooks\/|\b(?:ghp_|xox[bap]-|sk_live_)/i.exec(source);
  if (secret) {
    const before = source.slice(0, secret.index).split('\n');
    throw new RitualError({ line: before.length, column: before.at(-1)!.length + 1, endLine: before.length, endColumn: before.at(-1)!.length + 1 + secret[0].length, message: 'The source contains a credential or webhook URL.', hint: 'Create an endpoint with the URL and call it by name: endpoints.<name>(…).' });
  }
  let ast, tokens=0, work=8192;
  try {
    ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true, onToken(t){
      if (++tokens>8192 || (t.type.label==='name' && t.end-t.start>64)) throw new RitualError({line:t.loc!.start.line,column:t.loc!.start.column+1,endLine:t.loc!.end.line,endColumn:t.loc!.end.column+1,message:tokens>8192?'Compile token budget exceeded.':'Identifiers are limited to 64 characters.'});
    }});
  } catch (e) {
    if(e instanceof RitualError)throw e;
    const loc = (e as { loc?: { line: number; column: number } }).loc;
    const message = (e instanceof Error ? e.message : 'Invalid syntax').replace(/\s*\(\d+:\d+\)$/, '');
    throw new RitualError({ line: loc?.line ?? 1, column: (loc?.column ?? 0) + 1, endLine: loc?.line ?? 1, endColumn: (loc?.column ?? 0) + 2, message: `Syntax error: ${message}.` });
  }
  const refs = new Set<string>(),
    sites: CallSite[] = [],
    lists: ListSite[] = [],
    omens: Record<string, Omen> = Object.create(null),
    globals = new Map<string, N>(),
    omenBindings = new Map<string, string[]>();
  let entry: N | undefined;
  for (const n of ast.body) {
    if (n.type === 'ExportDefaultDeclaration' && n.declaration.type === 'FunctionDeclaration' && !entry) entry = n.declaration;
    else if (n.type === 'VariableDeclaration' && n.kind === 'const') {
      for (const d of n.declarations) {
        if (d.id.type !== 'Identifier' || !d.init || d.init.type !== 'ObjectExpression') diagnostic(d, 'Top-level constants may only hold literal omen questions.', 'Example: const QUESTIONS = { refund: "Is this a refund request?" }');
        globals.set(d.id.name, d.init);
      }
    } else if (n.type === 'ExportDefaultDeclaration' && entry) diagnostic(n, 'Export only one default function.');
    else diagnostic(n, 'A ritual exports one default function: export default function route(email, ctx) { … }');
  }
  if (!entry || entry.type !== 'FunctionDeclaration')
    diagnostic(ast, 'Missing the entry point.', 'Start with: export default function route(email, ctx) { … }');
  if (entry.async || entry.generator) diagnostic(entry, 'The entry point must be a plain function, not async or a generator.');
  if (!entry.params.length || entry.params.length > 2 || entry.params.some((p, i) => p.type !== 'Identifier' || p.name !== ['email', 'ctx'][i]))
    diagnostic(entry.params[0] ?? entry, 'Name the parameters (email, ctx).', 'Example: export default function route(email, ctx) { … }');
  const arity = (n: N, name: string, args: N[], [min, max]: [number, number], signature: string) => {
    if (args.length < min || args.length > max) diagnostic(n, `${name}() takes ${min === max ? min : `${min}–${max}`} argument${max === 1 ? '' : 's'}; got ${args.length}.`, `Signature: ${signature}`);
  };
  function compile(n: N, env: Set<string>, depth = 0): I {
    if ((work-=1+(n.type==='BlockStatement'||n.type==='IfStatement'?env.size:0))<0)diagnostic(n,'Compile work budget exceeded.');
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
        return ir('block', undefined, n.body.map(s => compile(s, names, depth + 1)));
      }
      case 'EmptyStatement':
        return ir('block', undefined, []);
      case 'ReturnStatement':
        return ir('return', undefined, n.argument ? [sub(n.argument)] : []);
      case 'ExpressionStatement':
        return sub(n.expression);
      case 'VariableDeclaration': {
        if (n.kind !== 'const') diagnostic(n, `Use const, not ${n.kind}.`, 'Bindings cannot change after they are declared.');
        if (n.declarations.length !== 1) diagnostic(n, 'Declare one const per statement.');
        const d = n.declarations[0]!;
        if (d.id.type !== 'Identifier') diagnostic(d.id, 'Destructuring is not available. Bind a name, then read fields from it.');
        if (!d.init) diagnostic(d, `const ${d.id.name} needs a value.`);
        if (env.has(d.id.name) || globals.has(d.id.name)) diagnostic(d.id, `${d.id.name} is already defined.`, 'Choose a new name.');
        if (reserved(d.id.name)) diagnostic(d.id, `${d.id.name} is a reserved name.`);
        const val = sub(d.init);
        if (d.init.type === 'CallExpression' && dotted(d.init.callee) === 'omens') omenBindings.set(d.id.name, val.a!.map(x => x.k!));
        env.add(d.id.name);
        return ir('bind', d.id.name, [val]);
      }
      case 'IfStatement':
        return ir('if', undefined, [sub(n.test), compile(n.consequent, new Set(env), depth + 1), ...(n.alternate ? [sub(n.alternate)] : [])]);
      case 'Identifier': {
        if (env.has(n.name)) return ir('load', n.name);
        if (n.name === 'undefined') return ir('literal', undefined, undefined, null);
        const known = [...env, 'email', 'ctx'];
        const guess = closest(n.name, known);
        if (['endpoints', 'inbox', 'lists', 'addr', 'text'].includes(n.name)) diagnostic(n, `${n.name} is only available as a call, such as ${n.name === 'endpoints' ? 'endpoints.<name>(…)' : builtins[Object.keys(builtins).find(k => k.startsWith(n.name + '.'))!]!.signature}.`);
        diagnostic(n, `Unknown name ${n.name}.`, guess ? `Did you mean ${guess}?` : 'Available: email, ctx and your const bindings.');
      }
      // falls through (diagnostic never returns)
      case 'Literal':
        if ('regex' in n && n.regex) diagnostic(n, 'A regex literal can only be used with .test(text).', 'Example: /refund/i.test(email.subject). For addresses, use addr.matches(address, "*@example.com").');
        if ('bigint' in n && n.bigint) diagnostic(n, 'BigInt literals are not available.');
        if (n.value === null || (['number', 'string', 'boolean'].includes(typeof n.value) && !(typeof n.value === 'number' && !Number.isFinite(n.value))))
          return ir('literal', undefined, undefined, n.value as I['v']);
        return diagnostic(n, 'A regex literal can only be used with .test(text).', 'Example: /refund/i.test(email.subject). For addresses, use addr.matches(address, "*@example.com").');
      case 'MemberExpression': {
        const k = n.computed
          ? n.property.type === 'Literal' && (typeof n.property.value === 'number' || typeof n.property.value === 'string')
            ? String(n.property.value)
            : diagnostic(n.property, 'Use a literal property name or index.', 'Computed lookups like value[key] are not available.')
          : n.property.type === 'Identifier' ? n.property.name : '';
        if (!k || reserved(k)) diagnostic(n.property, 'Use a literal property name.');
        const path = staticPath(n);
        if (path && (path[0] === 'email' || path[0] === 'ctx')) {
          const found = fieldAt(path);
          if (found && 'missing' in found) {
            const guess = closest(found.missing, found.options);
            diagnostic(n.property, `${found.at} has no field ${found.missing}.`, guess ? `Did you mean ${found.at}.${guess}?` : `Fields: ${found.options.slice(0, 12).join(', ')}.`);
          }
        }
        if (path && path.length === 2 && omenBindings.has(path[0]!) && !omenBindings.get(path[0]!)!.includes(path[1]!)) {
          const names = omenBindings.get(path[0]!)!, guess = closest(path[1]!, names);
          diagnostic(n.property, `${path[0]} has no omen named ${path[1]}.`, guess ? `Did you mean ${path[0]}.${guess}?` : `Omens: ${names.join(', ')}.`);
        }
        return ir('get', k, [sub(n.object)]);
      }
      case 'ChainExpression':
        return sub(n.expression);
      case 'ArrayExpression':
        return ir('array', undefined, n.elements.map(x => (x ? sub(x) : diagnostic(n, 'Arrays cannot have holes.'))));
      case 'ObjectExpression':
        return ir('record', undefined, props(n).map(([k, x]) => ir('field', k, [sub(x)])));
      case 'TemplateLiteral':
        return ir('template', undefined, n.quasis.flatMap((q, i) => [ir('literal', undefined, undefined, q.value.cooked ?? ''), ...(n.expressions[i] ? [sub(n.expressions[i]!)] : [])]));
      case 'UnaryExpression':
        if (n.operator === '!') return ir('not', undefined, [sub(n.argument)]);
        if (n.operator === '-' && n.argument.type === 'Literal' && typeof n.argument.value === 'number') return ir('literal', undefined, undefined, -n.argument.value);
        return diagnostic(n, `The ${n.operator} operator is not available.`, 'Use !, comparisons, && and ||.');
      case 'LogicalExpression':
      case 'BinaryExpression':
        if (['&&', '||', '??', '===', '!==', '>', '<', '>=', '<=', '+'].includes(n.operator)) return ir('binary', n.operator, [sub(n.left as N), sub(n.right)]);
        if (n.operator === '==' || n.operator === '!=') diagnostic(n, `Use ${n.operator}= instead of ${n.operator}.`, 'Loose equality is not available.');
        return diagnostic(n, `The ${n.operator} operator is not available.`, 'Available: === !== < <= > >= + && || ??');
      case 'ConditionalExpression':
        return ir('if', undefined, [sub(n.test), sub(n.consequent), sub(n.alternate)]);
      case 'CallExpression':
        return call(n, env, ir, sub);
    }
    return diagnostic(n, UNSUPPORTED[n.type] ?? `${n.type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} is not available in rituals.`);
  }
  function call(n: Extract<N, { type: 'CallExpression' }>, env: Set<string>, ir: (op: string, k?: string, a?: I[], v?: I['v']) => I, sub: (x: N) => I): I {
    const callee = n.callee as N, args = n.arguments as N[];
    for (const arg of args) if (arg.type === 'SpreadElement') diagnostic(arg, UNSUPPORTED.SpreadElement!);
    const name = dotted(callee);
    // /pattern/flags.test(text)
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'test' && callee.object.type === 'Literal' && 'regex' in callee.object && callee.object.regex) {
      const { pattern, flags } = callee.object.regex;
      if (args.length !== 1) diagnostic(n, '.test() takes one argument: the text to search.');
      if (pattern.length > 256 || /[^imsu]/.test(flags) || /[{}]/.test(pattern)) diagnostic(callee.object, 'Use a short RE2 pattern with flags i, m, s or u and no counted repeats such as {2,5}.');
      try { regex(pattern, flags); } catch { diagnostic(callee.object, 'This pattern is not supported by RE2.', 'Lookarounds and backreferences are not available.'); }
      return ir('regex', flags, [sub(args[0]!)], pattern);
    }
    // endpoints.<name>(payload?) — the endpoint is syntax, resolved and type-checked when the ritual is saved.
    if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'endpoints') {
      const endpoint = callee.computed ? str(callee.property as N, 'a literal endpoint name') : callee.property.type === 'Identifier' ? callee.property.name : '';
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(endpoint) || reserved(endpoint)) diagnostic(callee.property as N, 'Endpoint names use lowercase letters, digits and hyphens.', 'Hyphenated names are called with quotes: endpoints["support-hook"](…).');
      if (args.length > 1) diagnostic(n, `endpoints.${endpoint}() takes at most one payload argument.`);
      const ref = `endpoint:${endpoint}`;
      refs.add(ref);
      sites.push({ ref, line: n.loc!.start.line, column: n.loc!.start.column + 1, args: args.length, fields: args[0]?.type === 'ObjectExpression' ? props(args[0]).map(([k]) => k) : null });
      return ir('action', 'endpoint', [ir('literal', undefined, undefined, ref), ...args.map(sub)]);
    }
    if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && LEGACY_ENDPOINTS.has(callee.object.name) && !env.has(callee.object.name)) {
      const endpoint = callee.computed ? (callee.property.type === 'Literal' ? String(callee.property.value) : '<name>') : callee.property.type === 'Identifier' ? callee.property.name : '<name>';
      diagnostic(callee, `Endpoints are called by name, whatever their type.`, `Write endpoints.${endpoint}(${callee.object.name === 'slack' ? '{ text }' : callee.object.name === 'discord' ? '{ content }' : callee.object.name === 'webhook' ? 'payload' : ''}).`);
    }
    if (name === 'inbox.deliver') {
      arity(n, name, args, builtins[name]!.args, builtins[name]!.signature);
      const key = str(args[0]!, 'a literal inbox key');
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) diagnostic(args[0]!, 'Use the inbox key, not an address or URL.', 'Find keys with listInboundAddresses or in the typings.');
      const ref = `inbox:${key}`;
      refs.add(ref);
      sites.push({ ref, line: args[0]!.loc!.start.line, column: args[0]!.loc!.start.column + 1, args: 1, fields: null });
      return ir('action', name, [ir('literal', undefined, undefined, ref)]);
    }
    if (name === 'omens') {
      arity(n, name, args, builtins.omens!.args, builtins.omens!.signature);
      if (dotted(args[0]!) !== 'email') diagnostic(args[0]!, 'The first argument to omens() is email.');
      const defs = props(args[1]!.type === 'Identifier' ? globals.get(args[1]!.name) ?? diagnostic(args[1]!, `Unknown omen set ${args[1]!.name}.`, 'Declare it at the top level as a literal const.') : args[1]!);
      if (!defs.length) diagnostic(args[1]!, 'Ask at least one question.');
      for (const [key, val] of defs) {
        if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(key)) diagnostic(val, `Omen name ${key} must start with a lowercase letter and use letters, digits or _.`);
        const opts: Record<string, unknown> =
          val.type === 'Literal'
            ? { prompt: str(val, 'a literal question') }
            : Object.fromEntries(props(val).map(([k, v]) => {
                if (!['prompt', 'type', 'threshold', 'onError'].includes(k)) diagnostic(v, `Unknown omen option ${k}.`, 'Options: prompt, type, threshold, onError.');
                if (v.type !== 'Literal') diagnostic(v, `Omen option ${k} must be a literal.`, 'Questions are fixed so the email cannot change what is asked.');
                return [k, v.value];
              }));
        const { prompt, type = 'score', threshold = 0.5, onError = type === 'score' ? 0 : false } = opts;
        if (typeof prompt !== 'string' || prompt.length < 8 || prompt.length > 500) diagnostic(val, 'An omen question needs 8–500 characters.');
        if (type !== 'score' && type !== 'boolean') diagnostic(val, 'Omen type is "score" or "boolean".');
        if (typeof threshold !== 'number' || threshold < 0.05 || threshold > 0.95) diagnostic(val, 'Omen threshold is a number from 0.05 to 0.95.');
        if (!(onError === 'defer' || (type === 'boolean' ? typeof onError === 'boolean' : typeof onError === 'number' && onError >= 0 && onError <= 1)))
          diagnostic(val, type === 'boolean' ? 'onError for a boolean omen is true, false or "defer".' : 'onError for a score omen is a number from 0 to 1, or "defer".');
        const ev: Omen = { prompt, type, threshold, onError: onError as Omen['onError'] };
        if (omens[key] && JSON.stringify(omens[key]) !== JSON.stringify(ev)) diagnostic(val, `Omen ${key} is already defined with a different question or options.`);
        omens[key] = ev;
      }
      return ir('scores', undefined, defs.map(([k]) => ir('key', k)));
    }
    if (name === 'lists.has') {
      arity(n, name, args, builtins[name]!.args, builtins[name]!.signature);
      const list = str(args[0]!, 'a literal list name').replace(/^list:/, '');
      lists.push({ name: list, line: args[0]!.loc!.start.line, column: args[0]!.loc!.start.column + 1 });
      return ir('builtin', name, [ir('literal', undefined, undefined, list), sub(args[1]!)]);
    }
    if (own(builtins, name)) {
      const b = builtins[name]!;
      arity(n, name, args, b.args, b.signature);
      if (name === 'label' && args[0]!.type === 'Literal' && !/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(String(args[0]!.value))) diagnostic(args[0]!, 'Labels use letters, digits, :, - and _ (up to 64).');
      return ir(ACTIONS.has(name) ? 'action' : 'builtin', name, args.map(sub));
    }
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && own(stringMethods, callee.property.name)) {
      const m = stringMethods[callee.property.name]!;
      arity(n, callee.property.name, args, m.args, m.signature);
      return ir('builtin', callee.property.name, [sub(callee.object as N), ...args.map(sub)]);
    }
    const namespace = callee.type === 'MemberExpression' ? dotted(callee.object as N) : '';
    if (['inbox', 'lists', 'addr', 'text', 'email.headers'].includes(namespace)) {
      const options = Object.keys(builtins).filter(k => k.startsWith(namespace + '.')), guess = closest(name, options);
      diagnostic(callee, `Unknown function ${name}().`, guess ? `Did you mean ${guess}()?` : `Available: ${options.join(', ')}.`);
    }
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
      const method = callee.property.name, guess = closest(method, Object.keys(stringMethods));
      diagnostic(callee.property, `${method}() is not available.`, guess ? `Did you mean ${guess}()?` : `Text methods: ${Object.keys(stringMethods).join(', ')}.`);
    }
    const guess = closest(name || '?', callable);
    diagnostic(callee, `Unknown function ${name || 'call'}().`, guess ? `Did you mean ${guess}()?` : `Rituals can call ${callable.join(', ')}.`);
  }
  const root = compile(entry.body, new Set(['email', 'ctx']));
  if (Object.keys(omens).length > 10) diagnostic(entry, 'A ritual can ask at most 10 omens.');
  const ir: RitualIR = { v: 1, root, refs: [...refs], omens, sites, lists };
  if (Buffer.byteLength(JSON.stringify(ir)) > 131072) diagnostic(entry, 'The compiled ritual exceeds 128 KiB.');
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
      x = () => visit(a[0]!),
      y = () => visit(a[1]!);
    switch (i.op) {
      case 'literal':
        return i.v;
      case 'load':
        return vars.get(k);
      case 'get': {
        const o = x();
        if (typeof o === 'string' && k === 'length') return o.length;
        return o != null && typeof o === 'object' && Object.hasOwn(o, k) && !reserved(k) ? o[k] : undefined;
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
        return Object.assign(Object.create(null), Object.fromEntries(a.map(f => [f.k!, visit(f.a![0]!)])));
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
        return Object.fromEntries(a.map(e => [e.k!, scores[e.k!]]));
      case 'regex': {
        const s = x();
        if (typeof s !== 'string') throw Error('Regex expected text');
        const input=s.slice(0,BODY_BYTES), re=regex(String(i.v), k,tick);
        tick(Math.ceil((input.length+1)/32));
        return re.test(input);
      }
      case 'builtin': {
        const [v, w] = a.map(node=>{const value=visit(node);return typeof value==='string'?value.slice(0,BODY_BYTES):value;});
        if (typeof v !== 'string') throw Error(`${k}() expected text`);
        tick(Math.ceil((v.length + (typeof w === 'string' ? w.length : 0)) / 32));
        if (k === 'lists.has') {
          const entries = Object.hasOwn(lists, v) ? lists[v]! : [];
          tick(entries.length);
          const value = typeof w === 'string' ? w.toLowerCase() : '';
          return !!value && entries.some(e => e === value || (e.startsWith('@') && value.endsWith(e)));
        }
        if (k.startsWith('email.headers.')) {
          const h = email.headers as Record<string, string[]>;
          const all = h && own(h, v.toLowerCase()) ? h[v.toLowerCase()]! : [];
          return k.endsWith('.has') ? all.length > 0 : k.endsWith('.get') ? (all[0] ?? null) : all;
        }
        if (k === 'addr.matches') return typeof w === 'string' && w.length <= 254 && v.length <= 320 && addressGlob(w.toLowerCase(), v.toLowerCase());
        if (k === 'text.snippet') return v.slice(0, Math.max(0, Math.min(Number(w) || 0, 4096)));
        if (k === 'toLowerCase') return v.toLowerCase();
        if (k === 'toUpperCase') return v.toUpperCase();
        if (k === 'trim') return v.trim();
        if (typeof w !== 'string') throw Error(`${k}() expected text`);
        return k === 'includes' ? v.includes(w) : k === 'startsWith' ? v.startsWith(w) : v.endsWith(w);
      }
      case 'action': {
        if (intents.length >= 32) throw Error('Action budget exceeded');
        const args = a.map(visit),
          ref = REF_ACTIONS.has(k) ? args[0] : undefined;
        if(k==='label'&&(typeof args[0]!=='string'||!/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(args[0])))throw Error('Invalid label');
        if (ref && !ir.refs.includes(ref)) throw Error('Undeclared endpoint');
        if (k === 'allow' && !(email.auth as { fromVerified: boolean })?.fromVerified) return;
        let size = 0;
        for (const val of args) {
          weigh(val, n => {
            size += n;
            if (size > BODY_BYTES) throw Error('Output budget exceeded');
          });
        }
        tick(Math.ceil(size / 32));
        const b = Buffer.byteLength(JSON.stringify(args));
        if (b > BODY_BYTES || (bytes += b) > MESSAGE_BYTES) throw Error('Output budget exceeded');
        intents.push({
          op: k,
          ...(ref ? { ref, ...(args.length > 1 ? { body: args[1] } : {}) } : args.length ? { value: scalar(args[0]).slice(0, 128) } : {}),
        });
        return;
      }
      default:
        throw Error('Invalid instruction');
    }
  }
  try {
    if(ir.v!==1)throw Error('Unsupported ritual instruction version');
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
