(() => {
  let saved = null
  try { saved = localStorage.getItem('bane.theme') } catch {}
  const theme = saved === 'light' || saved === 'dark'
    ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  // The browser's own bars (a phone's status bar, Safari's toolbar) take the page's frame colour.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', theme === 'dark' ? '#080808' : '#FAFAFA')
})()

// Start the session check while the app's scripts download. The app (data/live.ts) takes these
// responses over, and only when the account and workspace headers match what it would have sent itself.
// The account is this tab's (sessionStorage); a new tab asks as the browser's default account.
;(() => {
  const path = location.pathname, query = new URLSearchParams(location.search)
  if (path === '/docs' || path.startsWith('/docs/') || query.get('invitation') || query.get('account')) return
  let account = null, workspace = null, ready = null
  try { account = sessionStorage.getItem('bane.account'); workspace = account && localStorage.getItem('bane.workspace:' + account); ready = localStorage.getItem('bane.dashboard-ready') } catch {}
  const start = url => {
    const response = fetch(url, { credentials: 'include', headers: { Accept: 'application/json', ...(account ? { 'X-Nightmail-Account': account } : {}), ...(workspace ? { 'X-Bane-Workspace': workspace } : {}) } })
    response.catch(() => {}) // The app awaits the real rejection; this only silences the unhandled one.
    return response
  }
  const responses = { '/v1/me': start('/v1/me') }
  // The public homepage check, for visitors whose workspace is not remembered as ready.
  if (path === '/' && ready !== (workspace ?? '*')) responses['/health'] = start('/health')
  window.__baneEarly = { account, workspace: workspace || null, at: Date.now(), responses }
})()
