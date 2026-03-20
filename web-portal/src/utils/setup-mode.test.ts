import { describe, expect, it } from 'vitest'
import { detectSetupMode } from './setup-mode'

describe('detectSetupMode', () => {
  it('enables setup mode when the injected setup marker is present', () => {
    expect(detectSetupMode('', true)).toBe(true)
  })

  it('enables setup mode when the setup query flag is present', () => {
    expect(detectSetupMode('?strada-setup=1', false)).toBe(true)
  })

  it('keeps the normal app mode without marker or query flag', () => {
    expect(detectSetupMode('', false)).toBe(false)
    expect(detectSetupMode('?foo=bar', false)).toBe(false)
  })
})
