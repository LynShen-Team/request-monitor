import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One self-contained index.html (scripts, styles, fonts and data inlined), so the preview opens
// from disk by double-click, with no server. `bun run build:single` then runs scripts/inline.ts.
export default defineConfig({
  plugins: [react()],
  base: './',
  define: { __OPS_SOURCE__: JSON.stringify('preview') },
  build: {
    outDir: 'dist-single',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
