import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

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
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (
            id.includes('react-markdown')
            || id.includes('remark-gfm')
            || id.includes('rehype-highlight')
            || id.includes('highlight.js')
            || id.includes('mdast')
            || id.includes('micromark')
            || id.includes('unist')
            || id.includes('hast')
          ) {
            return 'markdown-vendor'
          }

          if (id.includes('tldraw') || id.includes('@tldraw')) {
            return 'tldraw-vendor'
          }

          if (id.includes('react-router')) {
            return 'router-vendor'
          }

          if (id.includes('/react/') || id.includes('react-dom')) {
            return 'react-vendor'
          }

          if (id.includes('class-variance-authority') || id.includes('clsx') || id.includes('tailwind-merge') || id.includes('sonner')) {
            return 'ui-vendor'
          }

          return 'vendor'
        },
      },
    },
  },
  server: {
    proxy: {
      '/ws': {
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
