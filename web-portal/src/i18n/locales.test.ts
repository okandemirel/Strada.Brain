import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// WEB-12: locales fell behind English (75 `common` keys in six of them), and
// the gap only showed as English text in the middle of a translated page.
// Every locale must carry every English key, with the same placeholders.

type Bundle = Record<string, string>

const localesDir = join(__dirname, 'locales')
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
const PLACEHOLDER = /\{\{\s*([^},\s]+)[^}]*\}\}/g

/** Bundles mix flat ("a.b": …) and nested ({ a: { b: … } }) keys; i18next reads both. */
function flatten(value: unknown, prefix = '', out: Bundle = {}): Bundle {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (child !== null && typeof child === 'object') flatten(child, path, out)
    else out[path] = String(child)
  }
  return out
}

function readBundle(locale: string, namespace: string): Bundle {
  return flatten(JSON.parse(readFileSync(join(localesDir, locale, `${namespace}.json`), 'utf8')))
}

/** Plural forms differ per language (ja has only `_other`), so keys compare by their base. */
const baseKey = (key: string) => key.replace(PLURAL_SUFFIX, '')

function placeholders(text: string): string {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort().join(',')
}

/** Placeholders per base key, over all of its plural forms. */
function placeholdersByBase(bundle: Bundle): Map<string, string> {
  const byBase = new Map<string, Set<string>>()
  for (const [key, text] of Object.entries(bundle)) {
    const names = byBase.get(baseKey(key)) ?? new Set<string>()
    for (const name of placeholders(text).split(',').filter(Boolean)) names.add(name)
    byBase.set(baseKey(key), names)
  }
  return new Map([...byBase].map(([key, names]) => [key, [...names].sort().join(',')]))
}

const namespaces = readdirSync(join(localesDir, 'en')).map((file) => file.replace(/\.json$/, ''))
const locales = readdirSync(localesDir).filter((locale) => locale !== 'en')

describe('locale bundles', () => {
  it('finds the locales and namespaces it checks (guard)', () => {
    expect(locales).toEqual(expect.arrayContaining(['de', 'es', 'fr', 'ja', 'ko', 'tr', 'zh']))
    expect(namespaces).toEqual(expect.arrayContaining(['common', 'settings', 'setup', 'vault']))
  })

  for (const locale of locales) {
    for (const namespace of namespaces) {
      it(`${locale}/${namespace}.json has every English key with the same placeholders`, () => {
        const english = placeholdersByBase(readBundle('en', namespace))
        const translated = placeholdersByBase(readBundle(locale, namespace))
        const missing = [...english.keys()].filter((key) => !translated.has(key))
        const wrongPlaceholders = [...translated]
          .filter(([key, names]) => english.has(key) && english.get(key) !== names)
          .map(([key, names]) => `${key}: {${names}} instead of {${english.get(key)}}`)
        expect(missing).toEqual([])
        expect(wrongPlaceholders).toEqual([])
      })
    }
  }
})
