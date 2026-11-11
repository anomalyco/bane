import {Link} from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { Button, Field, Input, PageHeader, Select, Textarea } from '../../components/ui';
import { request } from '../../data/live';
import { useApiDef, useWorkspaceAccess } from '../../data/context';
import { queries } from '../../data/queries';
import type { GetRitualsResponse, TestRitualsResponse } from '../../../../sdk/src/types.gen';
import { ritualTemplates } from '../../../../api/src/ritual-schema';

const templates = Object.fromEntries(ritualTemplates.map(t => [t.name, t]));
const sourceFor = (name: string) => templates[name]?.source() ?? ritualTemplates[0]!.source();
type Completion = { label: string; detail: string; info: string; apply?: string; type: string };
function Editor({ value, change, symbols }: { value: string; change: (s: string) => void; symbols: Completion[] }) {
  const parent = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    callback = useRef(change),names=useRef(symbols);names.current=symbols;
  callback.current = change;
  useEffect(() => {
    const v = new EditorView({
      parent: parent.current!,
      doc: value,
      extensions: [
        basicSetup,
        javascript(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Ritual source' }),
        autocompletion({
          override: [
            (ctx) => {
              const word = ctx.matchBefore(/[\w.]+/);
              return word
                ? { from: word.from, options: names.current.map((c) => ({ label: c.label, type: c.type, detail: c.detail, info: c.info, apply: c.apply })) }
                : null;
            },
          ],
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) callback.current(u.state.doc.toString());
        }),
      ],
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  return <div className="ritual-editor" ref={parent} />;
}
export function RitualsPage() {
  const { canAdminister } = useWorkspaceAccess(),
    addresses = useApiDef(queries.inboundAddressOptions(), { enabled: canAdminister });
  const [saved, setSaved] = useState<GetRitualsResponse | null>(null),
    [key, setKey] = useState('triage'),
    [source, setSource] = useState(sourceFor('Junk newsletters')),
    [binding, setBinding] = useState(''),
    [next, setNext] = useState(false),
    [template, setTemplate] = useState('Junk newsletters'),
    [mode, setMode] = useState('mime'),
    [sample, setSample] = useState(''),
    [result, setResult] = useState<TestRitualsResponse | null>(null),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    [domains, setDomains] = useState(''),[symbols,setSymbols]=useState<Completion[]>([]);
  const [bindings, setBindings] = useState<NonNullable<GetRitualsResponse['config']['attachments']>>([]);
  const path = '/v1/rituals';
  useEffect(() => {
    if (!canAdminister) return;
    const ac = new AbortController();
    request<{ completions: Completion[] }>('/v1/rituals/typings', { signal: ac.signal }).then(({ completions }) => setSymbols(completions)).catch(() => {});
    request<GetRitualsResponse>(path, { signal: ac.signal })
      .then((s) => {
        setSaved(s);
        setBindings(s.config.attachments ?? []);
        setDomains((s.config.evaluateDomains ?? []).join(', '));
        if (s.config.rituals?.[0]) {
          setKey(s.config.rituals[0].key);
          setSource(s.config.rituals[0].source);
        }
      })
      .catch((e) => {
        if (!ac.signal.aborted) setNotice(e.message);
      });
    return () => ac.abort();
  }, [canAdminister]);
  async function run(test: boolean) {
    if (!saved) return;
    setPending(true);
    setNotice('');
    setResult(null);
    try {
      const config = {
        ...saved.config,
        rituals: [...(saved.config.rituals ?? []).filter((h) => h.key !== key), { key, source }],
        attachments: bindings,
        evaluateDomains: domains
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      };
      if (test) {
        setResult(await request<TestRitualsResponse>(path + '/test', { method: 'POST', body: { config, [mode]: sample } }));
      } else {
        setSaved(await request<GetRitualsResponse>(path, { method: 'PUT', body: config, ifMatch: saved.version }));
        setNotice('Ritual and attachments saved.');
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="stack inbound-stack">
      <PageHeader title="Rituals" backTo="/receiving" actions={<Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/endpoints">Manage endpoints</Link>}/>
      {!canAdminister ? (
        <p>Only workspace owners and admins can manage Rituals.</p>
      ) : (
        <>
          <p className="muted">Run a ritual when mail reaches an inbox or address. Endpoints must already exist.</p>
          {notice && <p role="status">{notice}</p>}
          {saved && (
            <>
              <Field label="Saved rituals">
                <Select
                  value={(saved.config.rituals ?? []).some((h) => h.key === key) ? key : ''}
                  options={[
                    { label: 'New ritual', value: '' },
                    ...(saved.config.rituals ?? []).map((h) => ({ label: h.key, value: h.key })),
                  ]}
                  onValueChange={(v) => {
                    const h = (saved.config.rituals ?? []).find((h) => h.key === v);
                    setKey(h?.key ?? '');
                    setSource(h?.source ?? sourceFor(template));
                    setResult(null);
                  }}
                />
              </Field>
              <Field label="Ritual key">
                <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="triage" />
              </Field>
              <Field label="Start from a template">
                <Select
                  value={template}
                  options={ritualTemplates.map((t) => ({ label: t.name, value: t.name }))}
                  onValueChange={(v) => {
                    setTemplate(v);
                    setSource(sourceFor(v));
                  }}
                />
              </Field>
              <Editor symbols={symbols} value={source} change={setSource} />
              <h2>Attachments</h2>
              <p className="muted">
                Order matters. The first ritual to take an action stops the chain unless Continue is set.
              </p>
              {bindings.map((b, i) => (
                <div className="ritual-binding" key={`${b.target}/${b.ritual}`}>
                  <code>
                    {i + 1}. {b.ritual} → {b.target}
                  </code>
                  <span>{b.continue ? 'Continue' : 'First match'}</span>
                  <Button
                    disabled={!i}
                    onClick={() => {
                      const a = [...bindings];
                      [a[i], a[i - 1]] = [a[i - 1]!, a[i]!];
                      setBindings(a);
                    }}
                  >
                    Move up
                  </Button>
                  <Button onClick={() => setBindings(bindings.filter((_, n) => i !== n))}>Detach</Button>
                </div>
              ))}
              <Field label="Attach this ritual to">
                <Select
                  value={binding}
                  onValueChange={setBinding}
                  options={(addresses.data ?? []).flatMap((a) => [
                    { label: `Inbox · ${a.address}`, value: a.id },
                    ...[a.address, ...a.aliases].map((address) => ({ label: `Address · ${address}`, value: address })),
                  ])}
                />
              </Field>
              <label>
                <input type="checkbox" checked={next} onChange={(e) => setNext(e.target.checked)} /> Continue after a match
              </label>
              <div>
                <Button
                  disabled={!binding || !key || bindings.some((b) => b.target === binding && b.ritual === key)}
                  onClick={() => setBindings([...bindings, { ritual: key, target: binding, continue: next }])}
                >
                  Attach
                </Button>
              </div>
              <Field
                label="Domains opted in to classification"
                hint="Comma-separated receiving hosts. Leave empty to keep mail out of Jev."
              >
                <Input value={domains} onChange={(e) => setDomains(e.target.value)} />
              </Field>
              <div>
                <Button variant="primary" disabled={pending || !key} onClick={() => void run(false)}>
                  Save changes
                </Button>
              </div>
              <h2>Dry run</h2>
              <Field label="Email source">
                <Select
                  value={mode}
                  options={[
                    { label: 'Pasted MIME', value: 'mime' },
                    { label: 'Stored message ID', value: 'messageId' },
                  ]}
                  onValueChange={(v) => {
                    setMode(v);
                    setSample('');
                    setResult(null);
                  }}
                />
              </Field>
              <Textarea
                aria-label="Test email"
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                placeholder={mode === 'mime' ? 'Paste headers, a blank line, then the body.' : 'msg_…'}
              />
              <div>
                <Button disabled={pending || !sample} onClick={() => void run(true)}>
                  Run against this email
                </Button>
              </div>
              {result && (
                <section aria-live="polite">
                  <h3>Trace · {result.steps} steps</h3>
                  {result.trace.map((r, i) => (
                    <details key={i} open>
                      <summary>
                        {String(r.kind)} · {String(r.key)} · {String(r.steps)} steps
                      </summary>
                      <pre>{JSON.stringify(r, null, 2)}</pre>
                    </details>
                  ))}
                  <h3>Resulting deliveries</h3>
                  <pre>{JSON.stringify(result.recipients, null, 2)}</pre>
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
