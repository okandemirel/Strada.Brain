import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const localesDir = join(__dirname, '..', '..', 'i18n', 'locales')
const source = readFileSync(join(__dirname, 'ChannelRagStep.tsx'), 'utf8')

/** Every literal key the step passes to t() (its namespace is `setup`). */
const usedKeys = [...new Set([...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]!))]

// WEB-12: the whole Obsidian section showed raw keys ("channels.obsidian.title")
// in every language: no locale had them, and the calls pass no default.
describe('ChannelRagStep translations', () => {
  it('finds the keys it checks (guard)', () => {
    expect(usedKeys).toContain('channels.obsidian.title')
  })

  for (const locale of readdirSync(localesDir)) {
    it(`has every key the step uses in ${locale}/setup.json`, () => {
      const bundle = JSON.parse(readFileSync(join(localesDir, locale, 'setup.json'), 'utf8')) as Record<string, unknown>
      expect(usedKeys.filter((key) => typeof bundle[key] !== 'string')).toEqual([])
    })
  }
})
