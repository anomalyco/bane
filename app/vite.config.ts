import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// @react-email/editor's own "react-email" imports resolve to a slim shim (src/features/campaigns/react-email-shim.ts
// explains why); everything else, the shim included, gets the real package.
const reactEmailShim = fileURLToPath(new URL('./src/features/campaigns/react-email-shim.ts', import.meta.url))
const slimReactEmail: Plugin = {
  name: 'bane:slim-react-email', enforce: 'pre',
  resolveId(source, importer) { return source === 'react-email' && importer?.includes('/node_modules/@react-email/editor/') ? reactEmailShim : null },
}

export default defineConfig({
  plugins: [slimReactEmail, react()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: Object.fromEntries(['/v1', '/api/auth', '/mcp', '/.well-known', '/unsubscribe', '/health', '/openapi.json'].map(path => [path, {target: 'http://127.0.0.1:8793', changeOrigin: false}])),
  },
})
