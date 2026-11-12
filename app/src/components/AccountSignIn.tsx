import { useMutation, useQuery } from '@tanstack/react-query'
import { request } from '../data/live'
import { Alert, Button } from './ui'

export function AccountSignIn({ link = false }: { link?: boolean }) {
  const config = useQuery({ queryKey: ['account-provider'], staleTime: Infinity, retry: false,
    queryFn: () => request<{ issuer: string | null }>('/api/auth/account-config') })
  const start = useMutation({ mutationFn: async () => {
    const callback = new URL(window.location.href)
    callback.searchParams.delete('auth')
    const { url } = await request<{ url: string }>(link ? '/api/auth/link-social' : '/api/auth/sign-in/social', {
      method: 'POST', body: { provider: 'account', callbackURL: callback.href, disableRedirect: true },
    })
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.origin !== new URL(config.data!.issuer!).origin) throw Error('Unexpected account sign-in endpoint.')
    window.location.assign(target.href)
  } })
  if (!config.data?.issuer) return null
  return <><Button loading={start.isPending} onClick={() => start.mutate()}>{link ? 'Connect Anomaly account' : 'Sign in with Anomaly account'}</Button>
    {start.isError && <Alert tone="danger">Sign-in could not start. Sign in with Google and try again.</Alert>}</>
}
