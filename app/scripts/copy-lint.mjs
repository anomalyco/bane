// Copy lint: every user-visible string in app/src (JSX text, text props, toasts, errors and copy constants), with its
// file and line, checked against Bane's copy rules (RULES below): words per element type, sentence length, reading
// grade, filler, hedging, passive voice, one term per concept (GLOSSARY, from the copy pass), sentence case, numerals,
// descriptions that restate their label, and strings duplicated across a feature.
//
// A ratchet, not a cliff: copy-baseline.json lists today's findings per file and rule. Only a finding that isn't in
// it fails; a fixed one leaves it on the next local run (the baseline only ever shrinks unless you pass
// --update-baseline). CI (CI=true) never writes it.
//
// From app/: bun run copy-lint                        lint, and drop fixed findings from the baseline
//            bun run copy-lint --update-baseline      accept every current finding (a deliberate exception)
//            node scripts/copy-lint.mjs --all [rule]  print every finding, baseline included, worst files first
//            node scripts/copy-lint.mjs --json        findings as JSON (check-premerge.ts reads it)
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..'), src = join(app, 'src');
const BASELINE = join(app, 'scripts/copy-baseline.json');

// Content that isn't dashboard copy: the legal documents and docs (their own review), the signed-out home, demo and
// seed data, the scripted support conversation, logos and the email preview's CSS.
const SKIP = /^(features\/(legal|docs|home)\/|data\/(mock|seed)\.ts$|features\/support\/demo\.ts$|components\/(BaneLogo|AnomalyLogo|EmailPreview)\.tsx$)/;

// Words and sentences per element type. Sentences are counted on the whole string; words exclude code.
const LIMITS = {
  heading: { words: 6, why: 'A heading names the thing; the page says the rest.' },
  label: { words: 4, why: 'Buttons, tabs, links and menu items are read in one glance.' },
  field: { words: 6, why: 'A field label names the value; the hint under it explains.' },
  option: { words: 10, why: 'A checkbox, switch or choice reads as one short line; put the detail in a hint.' },
  placeholder: { words: 5, why: 'A placeholder disappears on the first keystroke: an example, not instructions.' },
  helper: { words: 14, why: 'Helper text under a field is read while typing: one short line.' },
  description: { words: 14, sentences: 1, why: 'A page, section or dialog description is one short sentence; details belong where they apply.' },
  tooltip: { words: 20, why: 'A tooltip is a footnote, not documentation.' },
  toast: { words: 10, why: 'A toast is gone in 6 seconds: say what happened.' },
  empty: { words: 20, sentences: 2, why: 'An empty state is 2 short sentences at most: what goes here and how to add it.' },
  confirm: { words: 30, sentences: 3, why: 'A confirmation states the consequence and whether it can be undone, nothing more.' },
  error: { words: 20, sentences: 2, why: 'An error says what went wrong and what to do, in one line.' },
  alert: { words: 30, sentences: 2, why: 'A banner or alert is scanned, not read.' },
  body: { words: 40, sentences: 3, why: 'A paragraph in an app is a few short sentences; anything longer is docs.' },
  a11y: { words: 10, why: 'A screen reader reads accessible names on every focus.' },
};
const NOUN = { heading: 'a heading', label: 'a button or link', field: 'a field label', option: 'a choice', placeholder: 'a placeholder', helper: 'helper text', description: 'a description', tooltip: 'a tooltip', toast: 'a toast', empty: 'an empty state', confirm: 'a confirmation', error: 'an error', alert: 'an alert', body: 'a paragraph', a11y: 'an accessible name' };
const SENTENCE_WORDS = 20, GRADE = 8, GRADE_MIN_WORDS = 12;

// One name per concept (the copy pass's glossary). `not` matches the names to replace.
const GLOSSARY = [
  { use: 'workspace', not: /\btenants?\b/i },
  { use: 'Hosted mail, or your AWS account', not: /\b(BYO(A|AWS)?|bring[- ]your[- ]own(?: AWS)?|shared (connection|pool|sending|account))\b/i },
  { use: 'daily limit (SES quota only for an AWS account’s own quota)', not: /(?<!SES (daily |sending )?)\b(quotas?|sending limits?|(daily|sending|send) caps?)\b/i },
  { use: 'sender score', not: /\b(reputation|health) scores?\b/i },
  { use: 'balance, add credit', not: /\b(funds|top[- ]?ups?|wallet)\b/i },
  { use: 'address (receiving address when ambiguous)', not: /\binbound address(es)?\b|(?<!(current|existing|other|your own) )\bmailbox(es)?\b(?! (providers?|hosted))/i },
  { use: 'agent inbox', not: /\b(sandbox mailbox|temp(orary)? inbox|disposable inbox|throwaway inbox)\b/i },
  { use: 'endpoint (or route, ritual, omen: the API’s names)', not: /\b(destinations?|AI questions?)\b/i, in: /^features\/inbound\// },
  { use: 'webhook', not: /\bcallbacks?\b/i },
  { use: 'suppressed', not: /\b(blacklist(ed)?|blocklist(ed)?)\b/i },
  { use: 'subscribed', not: /\b(opted[- ]in|opt[- ]in)\b/i },
  { use: 'owners and admins', not: /\b(administrators?|managers?)\b/i },
];

const FILLER = [
  [/\b(this|that|it|which) (lets|allows|enables) you( to)?\b/i, 'lead with what it does'],
  [/\b(lets|allows|enables) you to\b/i, 'say what it does'],
  [/\bin order to\b/i, '“to”'], [/\bnote that\b/i, 'drop it'], [/\bplease\b/i, 'drop it'], [/\bsimply\b/i, 'drop it'],
  [/\bjust\b(?! now)/i, 'drop it'], [/\beasily\b/i, 'drop it'], [/\bbasically\b/i, 'drop it'], [/\bactually\b/i, 'drop it'],
  [/\breally\b/i, 'drop it'], [/\bvery\b/i, 'drop it'], [/\b(make|be) sure (to|that|you)\b/i, 'say the step'], [/\bfeel free\b/i, 'drop it'],
  [/\bat this time\b/i, '“now”, or drop it'], [/\bsuccessfully\b/i, 'drop it'], [/\bkeep in mind\b/i, 'drop it'],
  [/\bit(’|')?s (important|worth noting)\b/i, 'drop it'], [/\bprior to\b/i, '“before”'], [/\butili[sz]e\b/i, '“use”'],
  [/\bdue to the fact\b/i, '“because”'], [/\ba (number|variety) of\b/i, '“some”, or the number'], [/\bin the event that\b/i, '“if”'],
  [/\bwhether or not\b/i, '“whether”'],
];
const HEDGES = /\b(might want to|may want to|perhaps|possibly|should be able to|it seems|seems to|somewhat|probably|hopefully|try to)\b/i;
// A form of “to be” and a past participle followed by its agent (“is sent by Bane”): “Bane sends” is shorter. Impersonal
// “it is recommended” and its kin too.
const PARTICIPLE = '(?:\\w+ed|known|shown|sent|taken|given|made|done|seen|kept|held|written|built|set|put|read|run|left|lost|found|paid|told|hidden|chosen|frozen|broken|spoken|driven|drawn|grown|bound|caught)';
const PASSIVE = new RegExp(`\\b(?:is|are|was|were|be|been|being|gets|got)\\s+(?:\\w+ly\\s+)?${PARTICIPLE}\\s+by\\s+(?!default\\b|hand\\b|email\\b|date\\b|name\\b|the (day|hour|month|minute)\\b|\\d)\\w+|\\bit(?:’|')?s?\\s*(?:is\\s+)?(?:recommended|required|advised|suggested)\\s+(?:that|to)\\b`, 'i');
const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|thousand)\b(?!-)|\bone (more |extra )?(second|minute|hour|day|week|month|year)s?\b/i;
// Words that keep their capital inside a sentence-case label: names, brands, formats, page names and months.
const PROPER = new Set(('Bane Nightmail Amazon SES AWS Anomaly Slack Discord Stripe Google GitHub Gmail Outlook Yahoo Hotmail iCloud Microsoft Apple Cloudflare Hosted ' +
  'Test Live OpenCode Claude Cursor Zapier JavaScript TypeScript Markdown Node Docker Visa Mastercard I OK Inbox Overview Logs Receiving Campaigns ' +
  'Templates Audience Contacts Lists Segments Domains Settings Docs Operator Billing Members Webhooks Activity Help Trace Rituals Routes Endpoints Omens ' +
  'Jev Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December ' +
  'Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Mon Tue Wed Thu Fri Sat Sun').split(' '));
const STOP = new Set('a an and are as at be by for from has have in into is it its of on or that the their this to was were will with you your'.split(' '));

export const RULES = {
  ...Object.fromEntries(Object.entries(LIMITS).map(([kind, { why }]) => [`length/${kind}`, why])),
  'sentence-length': `Sentences over ${SENTENCE_WORDS} words get skimmed past; split or cut them.`,
  grade: `Reading grade (Flesch–Kincaid) over ${GRADE}: shorter words and sentences read faster, even for engineers.`,
  filler: 'Words that add length but no meaning (“This lets you”, “simply”, “please”).',
  hedge: 'Hedging makes the reader wonder whether it’s true: say what happens.',
  passive: 'Passive voice with its agent named (“is sent by Bane”): the active form (“Bane sends”) is shorter.',
  glossary: 'One name per concept: the reader shouldn’t wonder whether two words mean two things.',
  'sentence-case': 'Labels and headings use sentence case: capitalize the first word and names only.',
  numerals: 'Numbers as digits: “3 days”, not “three days”; digits are scannable.',
  restate: 'A description that repeats its own heading or label tells the reader nothing new.',
  duplicate: 'The same sentence in two places of one feature drifts apart; say it once (a shared constant) or cut one.',
  typography: 'Curly quotes and apostrophes, and the single ellipsis character.',
};

// ---------------------------------------------------------------- extraction
const require = createRequire(join(app, 'package.json'));
const { parse } = require('@babel/parser');

const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'br', 'cite', 'code', 'em', 'i', 'kbd', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'wbr', 'Link', 'NavLink', 'PrivateAddress', 'AddressText', 'Code', 'Kbd']);
const CODE = new Set(['code', 'kbd', 'pre', 'Code', 'Kbd', 'SecretCode']);
// Inline children with one of these classes are their own line (a label's hint under it), not part of the sentence.
const OWN_LINE = /hint|caption|help|error/;
const HEADING_COMPONENTS = /^(PageHeader|SectionHeader|Dialog|ConfirmDialog|EmptyState|Alert|Sheet|ActionSheet|DropdownMenu|Section|Card|Panel|Step|Disclosure)$/;
const PROP_KIND = {
  title: name => HEADING_COMPONENTS.test(name) ? 'heading' : 'tooltip',
  heading: 'heading', emptyTitle: 'heading', confirmLabel: 'label', actionLabel: 'label', submitLabel: 'label',
  label: name => /^(Checkbox|Switch|Radio\w*|Choice\w*|Option\w*)$/.test(name) ? 'option' : name === 'Field' ? 'field' : /^(IconButton|DropdownMenu|Tabs|CopyButton)$/.test(name) ? 'a11y' : 'label',
  'aria-label': 'a11y', 'aria-description': 'a11y', alt: 'a11y', placeholder: 'placeholder',
  description: name => name === 'ConfirmDialog' ? 'confirm' : name === 'EmptyState' ? 'empty' : 'description', emptyDescription: 'empty',
  hint: 'helper', note: 'helper', help: 'helper', caption: 'helper', detail: 'helper', summary: 'helper', subtitle: 'helper',
  tooltip: 'tooltip', tip: 'tooltip', message: 'alert', error: 'error', fallback: 'error', body: 'body',
};
const KEY_KIND = {
  title: 'heading', heading: 'heading', label: 'option', description: 'description', line: 'description', hint: 'helper', help: 'helper',
  note: 'helper', detail: 'helper', caption: 'helper', summary: 'body', body: 'body', text: 'body', explanation: 'body', message: 'error',
  error: 'error', empty: 'empty', tooltip: 'tooltip', tip: 'tooltip', placeholder: 'placeholder', toast: 'toast', confirm: 'confirm',
};
const CALL_KIND = { toast: 'toast', setError: 'error', setFormError: 'error', setNotice: 'alert', setMessage: 'alert', setStatus: 'alert', confirm: 'confirm', alert: 'alert', Error: 'error' };
const PH = '…';

const tagName = el => { const n = el.openingElement.name; return n.type === 'JSXIdentifier' ? n.name : n.type === 'JSXMemberExpression' ? n.property.name : ''; };
const attr = (el, name) => el.openingElement.attributes.find(a => a.type === 'JSXAttribute' && a.name.name === name);
const classOf = el => { const v = attr(el, 'className')?.value; return v?.type === 'StringLiteral' ? v.value : v?.expression?.type === 'StringLiteral' ? v.expression.value : v?.expression?.type === 'TemplateLiteral' ? v.expression.quasis.map(q => q.value.cooked).join(' ') : ''; };
const clean = s => s.replace(/\s+/g, ' ').trim();
const letters = s => /[A-Za-z]{2,}/.test(s.replaceAll(PH, ''));
// The brand module's productName (and its lowercase form) is the product's name, not a placeholder.
const brandName = e => e.type === 'Identifier' && e.name === 'productName' ? 'Nightmail'
  : e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && e.callee.object.type === 'Identifier' && e.callee.object.name === 'productName' ? 'nightmail' : null;
const templateText = t => t.quasis.map((q, i) => (q.value.cooked ?? '') + (i < t.expressions.length ? brandName(t.expressions[i]) ?? PH : '')).join('');
// Strings that aren't prose: identifiers, paths, URLs, selectors, CSS, markup, code.
const codeLike = s => /^(https?:|mailto:|\/|#|\.|[a-z][\w-]*:)/.test(s) || /[{};=<>]|=>|\(\)|\$\{/.test(s) || /^[\w.@+-]+$/.test(s) && !/^[A-Z][a-z]+$/.test(s);
const sentenceLike = s => /^[A-Z“"‘(]/.test(s) && / /.test(s) && words(s) >= 4 && !codeLike(s) && /[a-z]/.test(s);
const mergeable = c => c.type === 'JSXElement' && INLINE.has(tagName(c)) && !CODE.has(tagName(c)) && !OWN_LINE.test(classOf(c));

// An element's text as one run: its text, string expressions, inline children (consumed into the run) and code as “…”.
function flatten(children, consume) {
  let text = '';
  for (const c of children) {
    if (c.type === 'JSXText') text += c.value;
    else if (c.type === 'JSXExpressionContainer') {
      const e = c.expression;
      if (e.type === 'StringLiteral') text += e.value;
      else if (e.type === 'TemplateLiteral') text += templateText(e);
      else if (e.type !== 'JSXEmptyExpression') text += brandName(e) ?? PH;
    } else if (c.type === 'JSXFragment') text += flatten(c.children, consume);
    else if (c.type === 'JSXElement') {
      if (CODE.has(tagName(c))) text += ` ${PH} `;
      else if (mergeable(c)) { consume?.add(c); text += flatten(c.children, consume); }
      else text += ' ';
    }
  }
  return text;
}
const isText = c => c.type === 'JSXText' && /[A-Za-z]{2,}/.test(c.value) || c.type === 'JSXExpressionContainer' && (c.expression.type === 'StringLiteral' && letters(c.expression.value) || c.expression.type === 'TemplateLiteral' && letters(templateText(c.expression)));
const kids = el => el.children.flatMap(c => c.type === 'JSXFragment' ? kids(c) : [c]);

// What a run of text is: by class first (a hint, an error, a title), then tag, then the prop it sits in, then a muted
// paragraph (a description) or plain body text.
function textKind(el, hint) {
  const name = tagName(el), cls = classOf(el);
  if (/hint|caption|help/.test(cls) || name === 'small') return 'helper';
  if (/error/.test(cls) || attr(el, 'role')?.value?.value === 'alert') return 'error';
  if (/^h[1-6]$/.test(name) || /__title\b|-title\b/.test(cls)) return 'heading';
  if (/__(body|desc|description)\b|-(body|desc|description|lead)\b/.test(cls)) return 'description';
  if (/__(foot|meta|price)\b|-(foot|meta|price)\b/.test(cls)) return 'helper';
  if (/^(legend|label)$/.test(name) || /__label\b/.test(cls)) return hint === 'option' ? 'option' : 'field';
  if (/^(button|Button|a|Link|NavLink|th|summary|Tab)$/.test(name)) return 'label';
  if (name === 'option') return 'option';
  if (name === 'Alert') return 'alert';
  if (hint) return hint;
  if (name === 'p' && /\bmuted\b|intro|lede|description|explain|note|copy/.test(cls)) return 'description';
  return 'body';
}

export function extract(file, code) {
  let ast;
  try { ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true }); } catch (error) { return [{ file, line: 1, kind: 'error', text: '', parseError: error.message }]; }
  const items = [], seen = new Set(), consumed = new Set();
  const emit = (node, kind, text, extra = {}) => {
    if (seen.has(node)) return; seen.add(node);
    text = clean(text);
    if (!letters(text)) return;
    items.push({ file, line: node.loc.start.line, kind, text, ...extra });
  };
  // The strings a prop's or call's value can show: literals, both branches of a condition, the right side of &&/??.
  // JSX values are walked as elements instead, with the prop's kind as their hint.
  const values = (e, out = []) => {
    if (!e) return out;
    if (e.type === 'StringLiteral') out.push([e, e.value]);
    else if (e.type === 'TemplateLiteral') out.push([e, templateText(e)]);
    else if (e.type === 'ConditionalExpression') { values(e.consequent, out); values(e.alternate, out); }
    else if (e.type === 'LogicalExpression') { if (e.operator !== '&&') values(e.left, out); values(e.right, out); }
    else if (e.type === 'TSAsExpression' || e.type === 'ParenthesizedExpression') values(e.expression, out);
    return out;
  };
  const visit = (node, parent, hint, owner) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration': case 'ExportAllDeclaration': case 'TSTypeAliasDeclaration': case 'TSInterfaceDeclaration': case 'TSTypeAnnotation': case 'TSLiteralType':
        return;
      case 'JSXElement': {
        const name = tagName(node);
        if (CODE.has(name) || name === 'style' || name === 'svg' || name === 'script') return;
        // An element with text of its own is one run, inline children included; without, each child speaks for itself.
        if (!consumed.has(node) && kids(node).some(isText)) emit(node, textKind(node, hint), flatten(node.children, consumed), { tag: name, element: owner });
        for (const a of node.openingElement.attributes) {
          if (a.type !== 'JSXAttribute' || !a.value) continue;
          const kindFor = PROP_KIND[a.name.name];
          if (!kindFor) { visit(a.value, a, hint, owner); continue; }
          const kind = typeof kindFor === 'function' ? kindFor(name) : kindFor;
          const v = a.value.type === 'JSXExpressionContainer' ? a.value.expression : a.value;
          for (const [n, text] of values(v)) if (!codeLike(clean(text))) emit(n, kind, text, { tag: name, prop: a.name.name, element: node });
          visit(a.value, a, kind, node);
        }
        // Children inherit the hint unless this element is itself a kind of text.
        const childHint = /^(button|Button|a|Link|NavLink)$/.test(name) ? 'label' : /^(label|legend)$/.test(name) ? (hint === 'option' ? 'option' : 'field') : /^(p|h[1-6]|li|td|th|Alert)$/.test(name) ? undefined : hint;
        for (const c of node.children) visit(c, node, childHint, owner);
        return;
      }
      case 'CallExpression': case 'NewExpression': {
        const callee = node.callee.type === 'Identifier' ? node.callee.name : node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier' ? node.callee.property.name : '';
        if (callee === 'log' || node.callee.type === 'MemberExpression' && node.callee.object.name === 'console') return;
        const kind = CALL_KIND[callee];
        if (kind && node.arguments[0]) for (const [n, text] of values(node.arguments[0])) {
          const t = clean(text);
          if (callee === 'Error' && !sentenceLike(t)) continue;
          if (!codeLike(t)) emit(n, kind, text);
        }
        break;
      }
      case 'ObjectProperty': {
        const key = node.key.type === 'Identifier' ? node.key.name : node.key.type === 'StringLiteral' ? node.key.value : null;
        const kind = KEY_KIND[key];
        if (kind) for (const [n, text] of values(node.value)) { const t = clean(text); if (!codeLike(t) && (kind === 'option' || kind === 'heading' ? /[A-Za-z]/.test(t) && !/^[a-z_]+$/.test(t) : / /.test(t))) emit(n, kind, text, { prop: key }); }
        if (kind && (node.value.type === 'JSXElement' || node.value.type === 'JSXFragment')) { visit(node.value, node, kind, owner); return; }
        break;
      }
      case 'StringLiteral': case 'TemplateLiteral': {
        if (parent?.type === 'JSXAttribute' || parent?.type === 'TaggedTemplateExpression' || parent?.type === 'ObjectProperty' && parent.key === node) break;
        const text = clean(node.type === 'StringLiteral' ? node.value : templateText(node));
        if (sentenceLike(text) && /[.!?…:]$|\s\S+\s\S+\s\S+\s\S+\s/.test(text)) emit(node, 'body', text);
        break;
      }
    }
    for (const key in node) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key.endsWith('Comments')) continue;
      const child = node[key];
      if (Array.isArray(child)) for (const c of child) visit(c, node, hint, owner);
      else if (child && typeof child.type === 'string') visit(child, node, hint, owner);
    }
  };
  visit(ast.program, null, undefined, null);
  return items;
}

// ---------------------------------------------------------------- measures
// The product's name reads as one neutral word, so renaming it (Bane → Nightmail) never changes a measure.
const BRAND = /\b(bane|nightmail)\b/gi;
const prose = text => text.replaceAll(PH, 'X').replace(BRAND, 'X').replace(/\b[\w.-]+@[\w.-]+\b/g, 'X').replace(/https?:\/\/\S+/g, 'X');
export const words = text => (prose(text).match(/[A-Za-z0-9X][^\s]*/g) ?? []).filter(w => /[A-Za-z0-9]/.test(w)).length;
export const sentences = text => prose(text).replace(/\b(e\.g|i\.e|etc|vs|approx|incl)\./gi, '$1').split(/(?<=[.!?])\s+(?=["“‘(]?[A-Z0-9])/).map(s => s.trim()).filter(s => words(s) > 0);
function syllables(word) {
  if (/[0-9]/.test(word) || /^[A-Z]{2,}s?$/.test(word) || word === 'X') return 1;
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, (w.match(/[aeiouy]{1,2}/g) ?? []).length);
}
export function grade(text) {
  const list = sentences(text), all = list.flatMap(s => prose(s).match(/[A-Za-z0-9X][\w’'-]*/g) ?? []);
  if (!all.length) return 0;
  return 0.39 * (all.length / list.length) + 11.8 * (all.reduce((n, w) => n + syllables(w), 0) / all.length) - 15.59;
}
const contentWords = text => clean(prose(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ')).split(' ').filter(w => w && !STOP.has(w) && w !== 'x');
const stem = w => w.replace(/(ies|es|s|ed|ing)$/, '');

// ---------------------------------------------------------------- rules
function check(item) {
  const found = [], add = (rule, message, term) => found.push({ rule, message, term });
  const { kind, text } = item, n = words(text), list = sentences(text);
  const limit = LIMITS[kind] ?? LIMITS.body;
  const noun = NOUN[kind] ?? kind;
  if (n > limit.words) add(`length/${kind}`, `${n} words; ${noun} has at most ${limit.words}`);
  else if (limit.sentences && list.length > limit.sentences) add(`length/${kind}`, `${list.length} sentences; ${noun} has at most ${limit.sentences}`);
  const long = list.map(words).filter(w => w > SENTENCE_WORDS);
  if (long.length) add('sentence-length', `a ${Math.max(...long)}-word sentence (at most ${SENTENCE_WORDS})`);
  if (n >= GRADE_MIN_WORDS) { const g = grade(text); if (g > GRADE) add('grade', `reading grade ${g.toFixed(1)} (target ${GRADE} or below)`); }
  const plain = prose(text);
  for (const [pattern, fix] of FILLER) { const m = plain.match(pattern); if (m) add('filler', `“${m[0]}”: ${fix}`, m[0].toLowerCase()); }
  const hedge = plain.match(HEDGES); if (hedge) add('hedge', `“${hedge[0]}”`, hedge[0].toLowerCase());
  const passive = plain.match(PASSIVE); if (passive) add('passive', `“${passive[0]}”: name the actor first`, passive[0].toLowerCase());
  for (const g of GLOSSARY) { const m = (!g.in || g.in.test(item.file)) && plain.match(g.not); if (m) add('glossary', `“${m[0]}”: use ${g.use}`, m[0].toLowerCase()); }
  const number = plain.match(NUMBER_WORDS); if (number && kind !== 'a11y') add('numerals', `“${number[0]}”: use digits`, number[0].toLowerCase());
  if (['heading', 'label', 'field', 'placeholder'].includes(kind) && !/@/.test(text)) {
    const tokens = text.replace(/[“"‘][^”"’]*[”"’]/g, ' ').split(/\s+/).filter(Boolean);
    const caps = tokens.slice(1).filter((t, i) => {
      const w = t.replace(/^[^A-Za-z]+|[^A-Za-z0-9]+$/g, '');
      // A capital after a sentence break or a name (Apple Mail, Stripe Checkout, Claude Code) is fine.
      return /^[A-Z][a-z]+$/.test(w) && !PROPER.has(w) && !/[.:!?·—–|/(]$/.test(tokens[i]) && !PROPER.has(tokens[i].replace(/[^A-Za-z]/g, ''));
    });
    if (caps.length) add('sentence-case', `“${caps.join(' ')}” in a ${kind}: sentence case`, caps.join(' ').toLowerCase());
  }
  if (/\.\.\./.test(text)) add('typography', '“...”: use “…”', '...');
  else if (/[A-Za-z]'[a-z]/.test(text) && kind !== 'a11y') add('typography', 'straight apostrophe: use ’', "'");
  else if (/(^|\s)"[^"]+"/.test(text)) add('typography', 'straight quotes: use “ ”', '"');
  return found;
}

// A description or hint on the same element as its title or label, or a paragraph right under its heading, that repeats it.
function restates(label, description) {
  const l = contentWords(label).map(stem), d = contentWords(description).map(stem);
  if (!l.length || !d.length) return false;
  const lead = d.slice(0, l.length).join(' ') === l.join(' ');
  return lead && (l.length >= 2 || l[0].length >= 4) || l.length >= 2 && l.every(w => d.includes(w)) && d.length <= l.length + 3;
}
function relations(items) {
  const found = [];
  const byElement = new Map();
  for (const item of items) if (item.element) (byElement.get(item.element) ?? byElement.set(item.element, []).get(item.element)).push(item);
  for (const group of byElement.values()) {
    const labels = group.filter(i => i.kind === 'heading' || i.kind === 'label'), details = group.filter(i => ['description', 'helper', 'empty', 'confirm'].includes(i.kind));
    for (const d of details) for (const l of labels) if (restates(l.text, d.text)) found.push({ item: d, rule: 'restate', message: `repeats its ${l.prop ?? 'label'} “${l.text}”`, term: l.text.toLowerCase() });
  }
  // A heading followed directly by a paragraph in the same file (the next item, within 3 lines).
  for (let i = 1; i < items.length; i++) {
    const h = items[i - 1], p = items[i];
    if (h.kind === 'heading' && !h.prop && ['description', 'body'].includes(p.kind) && !p.prop && p.line - h.line <= 3 && restates(h.text, p.text)) found.push({ item: p, rule: 'restate', message: `repeats the heading “${h.text}”`, term: h.text.toLowerCase() });
  }
  return found;
}
function duplicates(items) {
  const found = [], groups = new Map();
  const area = file => file.split('/').slice(0, file.startsWith('features/') ? 2 : 1).join('/');
  for (const item of items) {
    if (words(item.text) < 5 || item.kind === 'a11y') continue;
    const key = `${area(item.file)}|${clean(item.text.toLowerCase())}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(item);
  }
  for (const group of groups.values()) {
    const places = [...new Map(group.map(i => [`${i.file}:${i.line}`, i])).values()];
    if (places.length < 2) continue;
    for (const item of places.slice(1)) found.push({ item, rule: 'duplicate', message: `also at ${places[0].file}:${places[0].line}`, term: 'dup' });
  }
  return found;
}

export function lint() {
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|mts)$/.test(name) && !name.endsWith('.d.ts')) files.push(p); } };
  walk(src);
  const items = [], findings = [];
  for (const path of files.sort()) {
    const file = relative(src, path);
    if (SKIP.test(file)) continue;
    const list = extract(file, readFileSync(path, 'utf8'));
    items.push(...list);
    for (const item of list) for (const f of check(item)) findings.push({ ...f, item });
    findings.push(...relations(list));
  }
  findings.push(...duplicates(items));
  return {
    items,
    findings: findings.map(({ item, rule, message, term }) => ({ file: `app/src/${item.file}`, line: item.line, kind: item.kind, rule, message, text: item.text, key: findingKey(rule, item.text, term) }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule)),
  };
}
// A finding is known by its rule, file and the start of its text, with the product's name as “brand”; when the text
// changed, by its rule, file and line (compare below). So a line moved by an unrelated edit, or a string edited in
// place (a rename), is still the same finding.
const findingKey = (rule, text, term) => clean(text.toLowerCase()).replace(BRAND, 'brand').slice(0, 60) + (term && !rule.startsWith('length') && rule !== 'grade' && rule !== 'sentence-length' ? ` ⟨${term.replace(BRAND, 'brand')}⟩` : '');

// ---------------------------------------------------------------- ratchet
function readBaseline() { try { return JSON.parse(readFileSync(BASELINE, 'utf8')).findings ?? {}; } catch { return {}; } }
// Entries are “<line>: <key>”, per file and rule.
function writeBaseline(findings) {
  const byFile = {};
  for (const f of findings) ((byFile[f.file] ??= {})[f.rule] ??= []).push(`${f.line}: ${f.key}`);
  const sorted = Object.fromEntries(Object.keys(byFile).sort().map(file => [file, Object.fromEntries(Object.keys(byFile[file]).sort().map(rule => [rule, byFile[file][rule].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b))]))]));
  writeFileSync(BASELINE, JSON.stringify({ about: 'Copy lint findings accepted so far (app/scripts/copy-lint.mjs), as “line: text” per file and rule. Only new ones fail; fix one and the next local run removes it. Regenerate with: bun run copy-lint --update-baseline', findings: sorted }, null, 1) + '\n');
}
// A finding is in the baseline when its file and rule list its key (text) or, failing that, its line: a string edited
// in place keeps its line, and a string moved by other edits keeps its key. New means neither is left to match.
export function compare(findings, baseline = readBaseline()) {
  const entries = [];
  for (const [file, rules] of Object.entries(baseline)) for (const [rule, list] of Object.entries(rules)) for (const entry of list) {
    const m = /^(\d+): ([^]*)$/.exec(entry);
    entries.push({ file, rule, line: m ? Number(m[1]) : null, key: m ? m[2] : entry, used: false });
  }
  const pool = new Map();
  for (const e of entries) (pool.get(`${e.file}|${e.rule}`) ?? pool.set(`${e.file}|${e.rule}`, []).get(`${e.file}|${e.rule}`)).push(e);
  const take = (f, same) => { const e = (pool.get(`${f.file}|${f.rule}`) ?? []).find(e => !e.used && same(e)); if (e) e.used = true; return Boolean(e); };
  const unmatched = findings.filter(f => !take(f, e => e.key === f.key));
  const fresh = unmatched.filter(f => !take(f, e => e.line === f.line));
  const known = findings.filter(f => !fresh.includes(f));
  const fixed = entries.filter(e => !e.used).map(({ file, rule, key, line }) => ({ file, rule, key, line, count: 1 }));
  return { fresh, known, fixed };
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), ci = Boolean(process.env.CI);
  const { items, findings } = lint();
  const { fresh, known, fixed } = compare(findings);
  if (args.includes('--json')) { console.log(JSON.stringify({ rules: RULES, fresh, fixed, total: findings.length })); process.exit(0); }
  const line = f => `${f.file}:${f.line}  ${f.rule}  ${f.message}\n    “${f.text.length > 160 ? f.text.slice(0, 157) + '…' : f.text}”`;
  if (args.includes('--all')) {
    const only = args[args.indexOf('--all') + 1];
    const shown = findings.filter(f => !only || only.startsWith('-') || f.rule === only || f.rule.startsWith(only + '/'));
    const perFile = new Map();
    for (const f of shown) perFile.set(f.file, (perFile.get(f.file) ?? 0) + 1);
    for (const f of shown.sort((a, b) => perFile.get(b.file) - perFile.get(a.file) || a.file.localeCompare(b.file) || a.line - b.line)) console.log(line(f));
  }
  const perRule = {};
  for (const f of findings) (perRule[f.rule] ??= { total: 0, fresh: 0 }).total++;
  for (const f of fresh) perRule[f.rule].fresh++;
  const wordCount = items.reduce((n, i) => n + words(i.text), 0);
  const md = [
    `### Copy lint: ${fresh.length ? `❌ ${fresh.length} new finding${fresh.length === 1 ? '' : 's'}` : '✅ no new findings'}`,
    '',
    `${items.length} strings, ${wordCount} words in app/src; ${findings.length} findings, ${known.length} of them in the baseline${fixed.length ? `, ${fixed.reduce((n, f) => n + f.count, 0)} fixed` : ''}. Rules and limits: app/scripts/copy-lint.mjs; fixing: app/scripts/copy-fix.md.`,
    '',
    '| Rule | Findings | New | Why |', '| --- | --: | --: | --- |',
    ...Object.keys(RULES).filter(r => perRule[r]).map(r => `| \`${r}\` | ${perRule[r].total} | ${perRule[r].fresh || ''} | ${RULES[r]} |`),
  ];
  if (fresh.length) md.push('', '#### New findings', '', ...fresh.map(f => `- \`${f.file}:${f.line}\` **${f.rule}**: ${f.message} — “${f.text.slice(0, 120)}”`));
  if (fresh.length) {
    console.log('\nNew findings (not in app/scripts/copy-baseline.json):\n');
    for (const f of fresh) console.log(line(f));
    if (ci) for (const f of fresh) console.log(`::error file=${f.file},line=${f.line},title=Copy lint: ${f.rule}::${f.message}. ${RULES[f.rule]}`);
    console.log('\nFix them (app/scripts/copy-fix.md), or accept a deliberate exception with: bun run copy-lint --update-baseline');
  }
  console.log('\n' + md.slice(0, 3).join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
  if (args.includes('--update-baseline')) { writeBaseline(findings); console.log(`Baseline: ${findings.length} findings written to app/scripts/copy-baseline.json.`); process.exit(0); }
  // Only a clean run lowers the baseline: with new findings around, a “fixed” one is more likely the same string edited.
  if (fixed.length && !fresh.length) {
    if (ci) console.log(`${fixed.length} baseline entries are fixed: run bun run copy-lint locally to drop them from the baseline.`);
    else { writeBaseline(known); console.log(`Baseline: dropped ${fixed.reduce((n, f) => n + f.count, 0)} fixed findings.`); }
  }
  process.exit(fresh.length ? 1 : 0);
}
