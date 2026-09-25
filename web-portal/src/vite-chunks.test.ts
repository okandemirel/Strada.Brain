import { describe, expect, it } from 'vitest'
import config from '../vite.config'

// WEB-13: a catch-all `vendor` chunk put every package (three.js, shiki,
// KaTeX, the graph libraries) into one 2.6 MB chunk that index.html preloads,
// so the lazy panels saved nothing.

type ManualChunks = (id: string) => string | undefined
const output = config.build?.rollupOptions?.output
const manualChunks = (Array.isArray(output) ? output[0] : output)?.manualChunks as ManualChunks

const pkg = (path: string) => `/app/web-portal/node_modules/${path}`

describe('vendor chunking', () => {
  it('leaves packages that only lazy panels use to the bundler', () => {
    for (const id of [
      pkg('three/build/three.module.js'),
      pkg('shiki/dist/core.mjs'),
      pkg('katex/dist/katex.mjs'),
      pkg('react-force-graph-2d/dist/react-force-graph-2d.mjs'),
      pkg('react-markdown/lib/index.js'),
      // '/react/' in the path is not the react package.
      pkg('@xyflow/react/dist/esm/index.js'),
    ]) {
      expect(manualChunks(id), id).toBeUndefined()
    }
  })

  it('still groups the small vendors every page needs', () => {
    expect(manualChunks(pkg('react/index.js'))).toBe('react-vendor')
    expect(manualChunks(pkg('react-dom/cjs/react-dom-client.production.js'))).toBe('react-vendor')
    expect(manualChunks(pkg('react-router/dist/production/index.mjs'))).toBe('router-vendor')
    expect(manualChunks(pkg('clsx/dist/clsx.mjs'))).toBe('ui-vendor')
    expect(manualChunks('/app/web-portal/src/App.tsx')).toBeUndefined()
  })
})
