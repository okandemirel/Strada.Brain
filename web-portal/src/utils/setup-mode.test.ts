import { describe, expect, it } from 'vitest'
import { detectSetupMode } from './setup-mode'

describe('detectSetupMode', () => {
  it('enables setup mode when the injected setup marker is present', () => {
    expect(detectSetupMode('', true, false)).toBe(true)
  })

  it('enables setup mode when the setup query flag is present', () => {
    expect(detectSetupMode('?strada-setup=1', false, false)).toBe(true)
  })

  it('ignores a stale setup query flag once first-run setup has already been committed', () => {
    expect(detectSetupMode('?strada-setup=1', false, true)).toBe(false)
  })

  it('keeps the normal app mode without marker or query flag', () => {
    expect(detectSetupMode('', false, false)).toBe(false)
    expect(detectSetupMode('?foo=bar', false, false)).toBe(false)
  })
})
