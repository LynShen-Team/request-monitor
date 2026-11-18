import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The build that the service serves: it reads the service's API (`network`). The dev server shows
// the built-in sample unless REQUEST_MONITOR_API names a running service, for example
// `REQUEST_MONITOR_API=http://127.0.0.1:8787 bun run dev`. OPS_API is its name from before the
// rename and is still read.
export default defineConfig(({ command }) => {
  const api = process.env.REQUEST_MONITOR_API || process.env.OPS_API
  return {
    plugins: [react()],
    // Relative asset paths: the service may be mounted under any path of a reverse proxy.
    base: './',
    define: { __OPS_SOURCE__: JSON.stringify(command === 'build' || api ? 'network' : 'preview') },
    server: api ? { proxy: { '/api': api } } : undefined,
  }
})
