// The end of adding an account in a popup (data/accounts.ts): tell the dashboard tab that opened it, then close.
// The popup has no opener once it has visited the account service, so the tabs hear it on a BroadcastChannel.
;(() => {
  const query = new URLSearchParams(location.search)
  const event = { type: 'signed-in', tab: query.get('tab'), account: query.get('account'), auth: query.get('auth') }
  try { new BroadcastChannel('bane.accounts').postMessage(event) } catch {}
  document.getElementById('status').textContent = event.auth ? 'Sign-in didn’t finish. Close this window and try again.' : 'Account added. You can close this window.'
  setTimeout(() => window.close(), 50)
})()
