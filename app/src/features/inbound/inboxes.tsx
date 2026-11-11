import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Alert,
  Button,
  CopyButton,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  PageHeader,
  SectionHeader,
  StatusBadge,
} from '../../components/ui';
import { useApiDef, useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context';
import { queries } from '../../data/queries';
import { request } from '../../data/live';
import type { Inbox, InboxMessage, InboxMessageDetail, InboundKey } from '../../../../sdk/src/types.gen';
import { when } from './shared';

const base = '/v1/inboxes';
const route = '/receiving/inboxes';
function NewInbox({ close }: { close: () => void }) {
  const domains = useApiDef(queries.inboundDomains()),
    hosts = domains.data?.filter((d) => d.status === 'active').map((d) => d.dns[0]?.name ?? d.name) ?? [];
  const [sandbox, setSandbox] = useState(false),
    [domain, setDomain] = useState(''),
    [ttl, setTtl] = useState(86400),
    [key, setKey] = useState(true),
    [name, setName] = useState('');
  const make = useApiMutation(() =>
    request<Inbox & { credential?: { secret: string } }>(base, {
      method: 'POST',
      body: {
        type: sandbox ? 'sandbox' : 'ephemeral',
        domain: sandbox ? undefined : domain || hosts[0],
        name,
        ttlSeconds: ttl,
        ...(key ? { credential: { name: 'Agent', permissions: ['read', 'modify'] } } : {}),
      },
    }),
  );
  return (
    <Dialog
      open
      title={make.data ? 'Inbox created' : 'New inbox'}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={
        make.data ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <Button disabled={make.isPending || (!sandbox && !hosts.length)} onClick={() => make.mutate(undefined)}>
            Create inbox
          </Button>
        )
      }
    >
      {make.data ? (
        <div className="stack">
          <p>{make.data.address}</p>
          {make.data.credential && (
            <>
              <p>Copy this key now. It won’t be shown again.</p>
              <code className="settings-copy-cell">
                {make.data.credential.secret}
                <CopyButton value={make.data.credential.secret} label="Copy inbox key" />
              </code>
            </>
          )}
        </div>
      ) : (
        <div className="stack">
          <label>
            Name <input maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Sandbox
            (simulated mail only)
          </label>
          <label>
            Receiving host{' '}
            <select disabled={sandbox} value={domain || hosts[0] || ''} onChange={(e) => setDomain(e.target.value)}>
              {hosts.map((h) => (
                <option key={h}>{h}</option>
              ))}
            </select>
          </label>
          {!sandbox && !domains.isPending && !hosts.length && (
            <Alert tone="warning">
              Add a domain and publish its receiving MX record.{' '}
              {domains.data
                ?.flatMap((d) => d.dns)
                .map((r) => (
                  <code key={r.name}>
                    {r.name} MX {r.priority} {r.value}{' '}
                  </code>
                ))}
              <Link to="/domains">Open Domains</Link>
            </Alert>
          )}
          <label>
            Expires in{' '}
            <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {[
                [3600, '1 hour'],
                [86400, '24 hours'],
                [604800, '7 days'],
                [2592000, '30 days'],
              ].map(([t, label]) => (
                <option value={t} key={t}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={key} onChange={(e) => setKey(e.target.checked)} /> Create an inbox key
          </label>
          {make.error && <Alert tone="danger">{make.error.message}</Alert>}
        </div>
      )}
    </Dialog>
  );
}
export function AgentInboxesPage() {
  const nav = useNavigate(),
    { canAdminister } = useWorkspaceAccess(),
    [open, setOpen] = useState(false),
    [cursor, setCursor] = useState('');
  const boxes = useApiQuery(['agent-inboxes', cursor], (_, signal) =>
    request<{ data: Inbox[]; nextCursor: string | null }>(
      base + '?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      { signal },
    ),
  );
  return (
    <div className="stack inbound-stack">
      <PageHeader
        title="Agent inboxes"
        actions={canAdminister && <Button onClick={() => setOpen(true)}>New inbox</Button>}
      />
      {boxes.error ? (
        <ErrorState error={boxes.error} onRetry={() => void boxes.refetch()} />
      ) : (
        <DataTable
          loading={boxes.isPending}
          rows={boxes.data?.data ?? []}
          rowKey={(b) => b.id}
          onRowClick={(b) => nav(`${route}/${b.id}`)}
          empty={
            <EmptyState
              title="No agent inboxes"
              description="Create a temporary address on an active receiving host. If you don’t have one, add a domain and publish its MX record first."
              action={<Link to="/domains">Open Domains</Link>}
            />
          }
          columns={[
            {
              key: 'address',
              label: 'Address',
              render: (b) => (
                <div className="settings-cell-stack">
                  {b.address}
                  <span className="muted">{b.name}</span>
                </div>
              ),
            },
            { key: 'status', label: 'Status', render: (b) => <StatusBadge status={b.status} /> },
            { key: 'expires', label: 'Expires', render: (b) => when(b.expiresAt) },
            ...(['messages', 'held', 'unread'] as const).map((k) => ({
              key: k,
              label: k[0].toUpperCase() + k.slice(1),
              render: (b: Inbox) => b.usage[k],
            })),
          ]}
        />
      )}
      {cursor && <Button onClick={() => setCursor('')}>First page</Button>}
      {boxes.data?.nextCursor && <Button onClick={() => setCursor(boxes.data!.nextCursor!)}>Next page</Button>}
      {open && <NewInbox close={() => setOpen(false)} />}
    </div>
  );
}
export function AgentInboxPage() {
  const { id = '' } = useParams();
  return <InboxDetail key={id} id={id} />;
}
function InboxDetail({ id }: { id: string }) {
  const { canAdminister } = useWorkspaceAccess(),
    path = `${base}/${encodeURIComponent(id)}`,
    [confirm, setConfirm] = useState(false),
    [selected, select] = useState(''),
    [after, setAfter] = useState('0');
  const box = useApiQuery(['agent-inbox', id], (_, signal) => request<Inbox>(path, { signal })),
    list = useApiQuery(['agent-messages', id, after], (_, signal) =>
      request<{ data: InboxMessage[]; cursor: string; hasMore: boolean }>(
        `${path}/messages?include=held&after=${after}`,
        { signal },
      ),
    ),
    msg = useApiQuery(
      ['agent-message', id, selected],
      (_, signal) => request<InboxMessageDetail>(`${path}/messages/${selected}`, { signal }),
      { enabled: !!selected },
    );
  const keys = useApiQuery(
    ['agent-keys', id],
    (_, signal) => request<{ data: InboundKey[] }>('/v1/inbound/keys?limit=100', { signal }),
    { enabled: canAdminister },
  );
  const remove = useApiMutation(() => request(path, { method: 'DELETE' }), 'Inbox scheduled for deletion');
  const b = box.data;
  return (
    <div className="stack inbound-stack">
      <Link to={route}>Agent inboxes</Link>
      <PageHeader
        title={b?.name || b?.address || 'Inbox'}
        actions={
          canAdminister &&
          b?.status !== 'deleting' && (
            <Button onClick={() => (confirm ? remove.mutate(undefined) : setConfirm(true))} disabled={remove.isPending}>
              {confirm ? 'Confirm deletion' : 'Delete inbox'}
            </Button>
          )
        }
      />
      {confirm && !remove.isSuccess && (
        <Alert tone="warning">
          Deletion retires the address and removes its mail at the next sweep.{' '}
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
        </Alert>
      )}
      {remove.error && <Alert tone="danger">{remove.error.message}</Alert>}
      {box.error && <ErrorState error={box.error} onRetry={() => void box.refetch()} />}
      {b && (
        <>
          <p>
            {b.address} · {b.status} · Expires {new Date(b.expiresAt).toLocaleString()}
          </p>
          <p>
            {b.usage.messages} / {b.limits.messages} messages · {b.usage.bytes.toLocaleString()} bytes
          </p>
          {!!b.usage.held && (
            <Alert tone="warning">{b.usage.held} held. Held mail stays readable until the inbox is deleted.</Alert>
          )}
        </>
      )}
      <SectionHeader title="Messages" />
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          rows={list.data?.data ?? []}
          loading={list.isPending}
          rowKey={(m) => m.id}
          onRowClick={(m) => select(m.id)}
          empty={<EmptyState title="No messages yet" />}
          columns={[
            { key: 'from', label: 'From', render: (m) => m.from.address },
            { key: 'subject', label: 'Subject', render: (m) => m.subject || '(no subject)' },
            {
              key: 'status',
              label: 'Status',
              render: (m) => m.held || (m.simulated ? 'Simulated' : m.junk ? 'Junk' : m.read ? 'Read' : 'Unread'),
            },
            { key: 'date', label: 'Received', render: (m) => when(m.receivedAt) },
          ]}
        />
      )}
      {after !== '0' && <Button onClick={() => setAfter('0')}>First page</Button>}
      {list.data?.hasMore && <Button onClick={() => setAfter(list.data!.cursor)}>Next page</Button>}
      {selected && (
        <Dialog
          open
          title={msg.data?.subject || 'Message'}
          onOpenChange={(open) => {
            if (!open) select('');
          }}
        >
          {msg.error ? (
            <ErrorState error={msg.error} onRetry={() => void msg.refetch()} />
          ) : (
            msg.data && (
              <div className="stack">
                <p>{msg.data.from.address}</p>
                <p>
                  SPF {msg.data.auth.spf ?? '—'} · DKIM {msg.data.auth.dkim ?? '—'} · DMARC {msg.data.auth.dmarc ?? '—'}
                </p>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{msg.data.text}</pre>
                {msg.data.attachments.map((f) =>
                  f.url ? (
                    <a key={f.id} href={f.url} rel="noreferrer">
                      Download {f.filename}
                    </a>
                  ) : (
                    <span key={f.id}>{f.filename} · unavailable</span>
                  ),
                )}
              </div>
            )
          )}
        </Dialog>
      )}
      {canAdminister && (
        <>
          <SectionHeader title="Inbox keys" />
          {keys.error ? (
            <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
          ) : (
            <DataTable
              rows={(keys.data?.data ?? []).filter((k) => k.addressIds?.includes(id))}
              rowKey={(k) => k.id}
              columns={[
                { key: 'name', label: 'Name', render: (k) => k.name },
                { key: 'prefix', label: 'Prefix', render: (k) => k.prefix },
                { key: 'permissions', label: 'Permissions', render: (k) => k.permissions.join(', ') },
              ]}
              empty={<EmptyState title="No inbox keys" />}
            />
          )}
        </>
      )}
    </div>
  );
}
