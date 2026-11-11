import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, ConfirmDialog, ErrorState, FieldSkeleton, SectionHeader, SkeletonText, StatusBadge } from '../../components/ui'
import { useApiMutation, useApiDef, useSession } from '../../data/context'
import { queries } from '../../data/queries'
import { connectionApi, connectionKindLabel, useConnectionCache } from '../../data/connections'
import type { ConnectionKind } from '../../data/types'
import { limitSummary, useSendingLimit } from '../overview/setup'

export function SendingConnection() {
  const connection = useApiDef(queries.connection())
  const disconnect = useApiMutation(() => connectionApi.remove(), 'Disconnected', true)
  const [confirming, setConfirming] = useState(false)
  const sync = useConnectionCache()
  const current = connection.data
  // /v1/me already names the connection, so its facts hold their place while the details load.
  const summary = useSession()?.identity?.connection
  const limit = useSendingLimit()
  return <section id="sending" className="section stack settings-group">
    <SectionHeader title="Sending" actions={current ? <Button variant="danger" onClick={() => setConfirming(true)}>Disconnect</Button> : connection.isPending && summary ? <Button variant="danger" disabled>Disconnect</Button> : null} />
    {connection.error ? <ErrorState error={connection.error} onRetry={() => void connection.refetch()} /> : connection.isPending ? summary ? <ConnectionFacts kind={summary.kind} /> : <FieldSkeleton /> : !current ? <p className="muted settings-section-note">Not connected.</p> : <ConnectionFacts kind={current.kind} values={[connectionKindLabel[current.kind], <StatusBadge status={current.state} />, current.kind === 'shared' ? <StatusBadge status={current.tenant} /> : current.awsAccountId ?? '—']} />}
    {limit && <p className="muted settings-section-note">Sending limit: {limitSummary(limit)} Simulator addresses count toward this limit.</p>}
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Disconnect sending?" description={current?.kind === 'byo' ? 'Sending stops until you connect again. AWS resources stay in your account; delete the Bane stack in AWS to revoke access.' : 'Sending stops until you connect again.'} confirmLabel="Disconnect" danger pending={disconnect.isPending} onConfirm={async () => { await disconnect.mutateAsync(undefined); sync(null) }} />
  </section>
}

function ConnectionFacts({ kind, values }: { kind: ConnectionKind; values?: ReactNode[] }) {
  return <dl className="settings-facts">{['Type', 'Status', kind === 'shared' ? 'Hosted setup' : 'AWS account'].map((term, index) => <div key={term}><dt>{term}</dt><dd>{values ? values[index] : <SkeletonText width={index === 1 ? 64 : 110} />}</dd></div>)}</dl>
}
