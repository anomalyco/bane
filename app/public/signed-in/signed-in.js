// Adding an account in a popup (data/accounts.ts). The dashboard opens this page with noopener, so neither window holds
// a reference to the other; everything they say goes over a BroadcastChannel, tagged with the opening tab's nonce.
// ?start=1: announce the popup, start the sign-in (a same-origin POST, so the dashboard's Origin check applies) and go
// to the account service's chooser. Back from the callback: report the account added, or why not, and close.
;(() => {
  const query = new URLSearchParams(location.search), tab = query.get('tab')
  const status = document.getElementById('status')
  let channel = null
  try { channel = new BroadcastChannel('bane.accounts') } catch {}
  const finish = (account, auth) => {
    channel?.postMessage({ type: 'signed-in', tab, account, auth })
    status.textContent = auth ? 'Sign-in didn’t finish. Close this window and try again.' : 'Account added. You can close this window.'
    setTimeout(() => window.close(), 50)
  }
  if (query.get('start') !== '1') return finish(query.get('account'), query.get('auth'))
  channel?.postMessage({ type: 'add-started', tab })
  status.textContent = 'Opening Anomaly account…'
  const callback = new URL('/signed-in/', location.origin)
  if (tab) callback.searchParams.set('tab', tab)
  fetch('/api/auth/sign-in/account', { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ callbackURL: callback.href, prompt: 'select_account' }) })
    .then(async response => {
      const body = await response.json().catch(() => null)
      if (!response.ok) throw body?.error?.code === 'ACCOUNT_LIMIT' ? 'account_limit' : 'error'
      const url = new URL(body.url)
      if (url.protocol !== 'https:') throw 'error'
      location.replace(url.href)
    })
    .catch(reason => finish(null, typeof reason === 'string' ? reason : 'error'))
})()
