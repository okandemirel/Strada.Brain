import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { WS_CHAT_PATH } from '../src/channels/web/ws-protocol.ts'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [tailwindcss(), react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Name only the small, always-needed vendor groups. Everything else is
        // left to Rollup, so a package lands with the lazy panel that imports
        // it: a catch-all 'vendor' chunk pulled three.js, shiki, KaTeX and the
        // graph libraries into every page load (WEB-13).
        manualChunks(id) {
          if (!id.includes('/node_modules/')) {
            return undefined
          }

          if (id.includes('/node_modules/react-router')) {
            return 'router-vendor'
          }

          // Exact package roots: '/react/' also matched '@xyflow/react/'.
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return 'react-vendor'
          }

          if (/\/node_modules\/(class-variance-authority|clsx|tailwind-merge|sonner)\//.test(id)) {
            return 'ui-vendor'
          }

          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      // The path the portal's chat socket opens on (shared with useWebSocket).
      [WS_CHAT_PATH]: {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
      '/api': {
        target: 'http://127.0.0.1:3000',
      },
      '/health': {
        target: 'http://127.0.0.1:3000',
      },
    },
  },
})
