import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// WEB-15: the portal bundled @huggingface/transformers (in-browser Whisper)
// although web-portal/package.json never declared it: it resolved only by
// walking up to the root package's optional dependencies, so a portal built
// on its own, or with optional packages omitted, failed. Every package the app
// code loads at runtime must be one this package declares.

const srcDir = __dirname
const manifest = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
])

function appSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return appSourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== 'test-setup.ts'
      ? [path]
      : []
  })
}

/**
 * Module specifiers that survive compilation: static imports and re-exports
 * (not `import type` / `export type`, which are erased), side-effect imports,
 * and dynamic `import()`.
 */
function runtimeSpecifiers(source: string): string[] {
  const found: string[] = []
  for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?[^'";]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
    if (!m[2]) found.push(m[3]!)
  }
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push(m[1]!)
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]!)
  return found
}

/** The package a bare specifier loads, or null for relative/aliased/builtin ones. */
function packageOf(specifier: string): string | null {
  if (/^(\.|\/|@\/|node:|virtual:)/.test(specifier)) return null
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  return builtinModules.includes(name) ? null : name
}

describe('portal runtime imports', () => {
  it('parses the import forms it has to see (guard)', () => {
    const sample = [
      "import { pipeline } from '@huggingface/transformers'",
      "import type { Root } from 'mdast'",
      "export { x } from 'zustand/shallow'",
      "import 'katex/dist/katex.min.css'",
      "const m = await import('shiki/langs/css.mjs')",
      "import {\n  a,\n  b,\n} from 'react'",
      "import { local } from './local'",
    ].join('\n')
    expect(runtimeSpecifiers(sample).map(packageOf)).toEqual([
      '@huggingface/transformers', 'zustand', 'react', null, 'katex', 'shiki',
    ])
  })

  it('loads only packages declared in web-portal/package.json', () => {
    const undeclared: string[] = []
    for (const file of appSourceFiles(srcDir)) {
      for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
        const pkg = packageOf(specifier)
        if (pkg && !declared.has(pkg)) undeclared.push(`${relative(srcDir, file)}: ${pkg}`)
      }
    }
    expect(undeclared).toEqual([])
  })
})
