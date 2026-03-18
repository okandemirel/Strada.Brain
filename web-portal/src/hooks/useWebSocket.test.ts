import { describe, expect, it } from 'vitest'
import {
  buildModelSwitchCommand,
  buildPostSetupBootstrap,
  FIRST_RUN_STORAGE_KEY,
  parsePostSetupBootstrap,
  POST_SETUP_BOOTSTRAP_STORAGE_KEY,
  schedulePostSetupBootstrap,
} from './useWebSocket'

describe('buildModelSwitchCommand', () => {
  it('preserves slash-delimited model ids for provider workers that use path-style names', () => {
    expect(
      buildModelSwitchCommand('fireworks', 'accounts/fireworks/models/llama4-maverick-instruct-basic'),
    ).toBe('/model fireworks/accounts/fireworks/models/llama4-maverick-instruct-basic')
  })

  it('sanitizes unsafe characters without breaking valid model separators', () => {
    expect(
      buildModelSwitchCommand('together<script>', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct??'),
    ).toBe('/model togetherscript/meta-llama/Llama-4-Maverick-17B-128E-Instruct')
  })
})

describe('post-setup bootstrap helpers', () => {
  it('creates onboarding-only bootstrap when autonomy is disabled', () => {
    expect(buildPostSetupBootstrap(false, 24)).toEqual({ onboarding: true })
  })

  it('creates onboarding plus autonomy bootstrap when autonomy is enabled', () => {
    expect(buildPostSetupBootstrap(true, 68)).toEqual({
      onboarding: true,
      autonomy: { enabled: true, hours: 68 },
    })
  })

  it('parses a valid bootstrap payload and rejects invalid ones', () => {
    expect(parsePostSetupBootstrap(JSON.stringify({
      onboarding: true,
      autonomy: { enabled: true, hours: 48 },
    }))).toEqual({
      onboarding: true,
      autonomy: { enabled: true, hours: 48 },
    })

    expect(parsePostSetupBootstrap('{')).toBeNull()
    expect(parsePostSetupBootstrap(JSON.stringify({ autonomy: { enabled: true, hours: 999 } }))).toEqual({
      autonomy: { enabled: true },
    })
  })

  it('sends autonomy toggle and onboarding on first connected session', () => {
    const sent: string[] = []
    const storage = new Map<string, string>([
      [
        POST_SETUP_BOOTSTRAP_STORAGE_KEY,
        JSON.stringify({
          onboarding: true,
          autonomy: { enabled: true, hours: 48 },
        }),
      ],
      [FIRST_RUN_STORAGE_KEY, '1'],
    ])

    const scheduled = schedulePostSetupBootstrap(
      {
        readyState: 1,
        send: (payload) => sent.push(payload),
      },
      {
        getItem: (key) => storage.get(key) ?? null,
        removeItem: (key) => { storage.delete(key) },
      },
      (callback) => {
        callback()
        return 0
      },
    )

    expect(scheduled).toBe(true)
    expect(sent).toEqual([
      JSON.stringify({ type: 'autonomous_toggle', enabled: true, hours: 48 }),
      JSON.stringify({ type: 'message', text: '__onboarding__' }),
    ])
    expect(storage.has(POST_SETUP_BOOTSTRAP_STORAGE_KEY)).toBe(false)
    expect(storage.has(FIRST_RUN_STORAGE_KEY)).toBe(false)
  })

  it('keeps bootstrap state when socket is not open yet', () => {
    const storage = new Map<string, string>([
      [POST_SETUP_BOOTSTRAP_STORAGE_KEY, JSON.stringify({ onboarding: true })],
      [FIRST_RUN_STORAGE_KEY, '1'],
    ])

    const scheduled = schedulePostSetupBootstrap(
      {
        readyState: 0,
        send: () => {
          throw new Error('should not send while socket is closed')
        },
      },
      {
        getItem: (key) => storage.get(key) ?? null,
        removeItem: (key) => { storage.delete(key) },
      },
      (callback) => {
        callback()
        return 0
      },
    )

    expect(scheduled).toBe(true)
    expect(storage.get(POST_SETUP_BOOTSTRAP_STORAGE_KEY)).toBe(JSON.stringify({ onboarding: true }))
    expect(storage.get(FIRST_RUN_STORAGE_KEY)).toBe('1')
  })
})
