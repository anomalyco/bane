import { useState } from 'react';
import { Link } from 'react-router';
import { Button, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Select, Tabs } from '../../components/ui';
import { useApi, useApiDef, useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context';
import { request } from '../../data/live';
import { queries } from '../../data/queries';
import { MutationError } from '../settings/shared';

type Route = { id: string; match: string; to: string[] | 'drop'; enabled: boolean };
export function RoutingPage() {
  const [tab, setTab] = useState('addresses'),
    [adding, add] = useState(false),
    [match, setMatch] = useState(''),
    [destination, choose] = useState('');
  const { canAdminister } = useWorkspaceAccess(),
    live = useApi().mode === 'live';
  const routes = useApiQuery(['mail-routes'], (_api, signal) => request<{ data: Route[] }>('/v1/routing/routes', { signal }), {
    enabled: canAdminister && live,
  });
  const boxes = useApiDef(queries.inboundAddressOptions(), { enabled: canAdminister }),
    hooks = useApiDef(queries.inboundWebhooks(), { enabled: canAdminister });
  const dests = [
    ...(boxes.data ?? []).map((b) => ({ id: b.id, name: b.address, type: 'Inbox', url: '/receiving/addresses/' + b.id })),
    ...(hooks.data ?? []).map((h) => ({
      id: h.id,
      name: h.description || new URL(h.url).host,
      type: h.paused ? 'Paused webhook' : 'Webhook',
      url: '/receiving/webhooks/' + h.id,
    })),
  ];
  const domains = useApiDef(queries.inboundDomains(), { enabled: canAdminister });
  const names = new Set((routes.data?.data ?? []).map((r) => r.match));
  const implicit = (boxes.data ?? []).flatMap((b) =>
    [b.address, ...b.aliases, ...b.rules]
      .filter((m) => !names.has(m))
      .map((m) => ({ id: b.id + ':' + m, match: m, to: [b.id], enabled: true, source: 'Address default' })),
  );
  const entries = [
    ...(routes.data?.data ?? []).map((r) => ({ ...r, source: 'Route' })),
    ...implicit,
    ...(domains.data ?? [])
      .filter((d) => d.status === 'active')
      .map((d) => ({
        id: d.id,
        match: 'Unmatched @' + d.name,
        to: [d.catchAll === 'store' ? 'Keep as unrouted' : 'Create address'],
        enabled: true,
        source: 'Domain default',
      })),
  ];
  const [testOpen, setTestOpen] = useState(false),
    [recipient, setRecipient] = useState('');
  const test = useApiMutation(
    (_api, address: string) =>
      request<{
        recipients: {
          tier: string;
          route: string | null;
          inboxes: string[];
          webhooks: string[];
          dropped: boolean;
          warnings: string[];
        }[];
      }>('/v1/routing/test', {
        method: 'POST',
        body: { envelope: { to: [address] }, verdicts: { spam: 'PASS', dmarc: 'PASS' } },
      }),
    undefined,
    false,
    false,
  );
  const save = useApiMutation(
    (_api, input: { match: string; to: string[] }) => request('/v1/routing/routes', { method: 'POST', body: input }),
    'Route created',
  );
  const failure = routes.error ?? boxes.error ?? hooks.error;
  return (
    <div className="stack inbound-stack">
      <PageHeader
        title="Routing"
        actions={
          canAdminister &&
          live && (
            <>
              <Button onClick={() => setTestOpen(true)}>Test routing</Button>
              <Button onClick={() => add(true)}>Add route</Button>
            </>
          )
        }
      />
      {!canAdminister ? (
        <p>Only workspace administrators can manage routing.</p>
      ) : (
        <>
          <Tabs
            label="Routing views"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: 'addresses', label: 'Addresses' },
              { value: 'destinations', label: 'Destinations' },
            ]}
          />
          {failure ? (
            <ErrorState
              error={failure}
              onRetry={() => {
                void routes.refetch();
                void boxes.refetch();
                void hooks.refetch();
              }}
            />
          ) : tab === 'destinations' ? (
            <DataTable
              rows={dests}
              rowKey={(r) => r.id}
              columns={[
                { key: 'name', label: 'Destination', render: (r) => <Link to={r.url}>{r.name}</Link> },
                { key: 'type', label: 'Type', render: (r) => r.type },
              ]}
              empty={
                <EmptyState title="No destinations" description="Create a receiving address or webhook to route mail to it." />
              }
            />
          ) : (
            <DataTable
              rows={entries}
              rowKey={(r) => r.id}
              columns={[
                { key: 'match', label: 'Recipient', render: (r) => r.match },
                {
                  key: 'to',
                  label: 'Destination',
                  render: (r) =>
                    r.to === 'drop'
                      ? 'Drop'
                      : r.to.map((id) => dests.find((d) => d.id === id)?.name ?? id).join(', ') || 'Keep as unrouted',
                },
                { key: 'state', label: 'Type', render: (r) => (r.enabled ? r.source : 'Disabled') },
              ]}
              empty={
                <EmptyState
                  title="No explicit routes"
                  description="An address already receives its own mail. Add a route to replace that default."
                />
              }
            />
          )}
        </>
      )}
      {testOpen && (
        <Dialog
          open
          onOpenChange={(v) => {
            setTestOpen(v);
            if (!v) test.reset();
          }}
          title="Test routing"
          footer={
            <Button disabled={!recipient.trim()} loading={test.isPending} onClick={() => test.mutate(recipient.trim())}>
              Test
            </Button>
          }
        >
          <Field label="Envelope recipient" hint="Preview clean mail with a DMARC pass. Nothing will be delivered.">
            <Input
              type="email"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                test.reset();
              }}
            />
          </Field>
          <MutationError error={test.error} />
          {test.data?.recipients.map((r) => (
            <p key={r.route ?? 'default'} aria-live="polite">
              {r.tier}:{' '}
              {r.dropped
                ? 'Drop'
                : r.inboxes
                    .concat(r.webhooks)
                    .map((id) => dests.find((d) => d.id === id)?.name ?? id)
                    .join(', ') || 'Domain policy or keep as unrouted'}{' '}
              {r.warnings.join('; ')}
            </p>
          ))}
        </Dialog>
      )}
      {adding && (
        <Dialog
          open
          onOpenChange={add}
          title="Add route"
          footer={
            <Button
              variant="primary"
              disabled={!match.trim()}
              loading={save.isPending}
              onClick={async () => {
                try {
                  await save.mutateAsync({ match: match.trim(), to: destination ? [destination] : [] });
                  setMatch('');
                  choose('');
                  add(false);
                  void routes.refetch();
                } catch {
                  /* shown inline */
                }
              }}
            >
              Create route
            </Button>
          }
        >
          <div className="stack">
            <Field label="Recipient" hint="Use an exact address, a local pattern like reply+*, or *@domain.">
              <Input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="support@example.com" />
            </Field>
            <Field label="Deliver to" hint="This replaces the address’s default inbox delivery.">
              <Select
                value={destination}
                onValueChange={choose}
                options={[{ value: '', label: 'Keep as unrouted' }, ...dests.map((d) => ({ value: d.id, label: d.name }))]}
              />
            </Field>
            <MutationError error={save.error} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
