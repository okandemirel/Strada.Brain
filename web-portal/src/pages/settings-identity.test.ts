import { describe, expect, it } from 'vitest'
import {
  resolveSettingsIdentity,
  shouldRefetchIdentityScopedSettings,
} from './settings-identity'

describe('settings identity helpers', () => {
  it('does not resolve an identity until a real session id exists', () => {
    expect(resolveSettingsIdentity(null, null)).toBeNull()
    expect(resolveSettingsIdentity('   ', 'profile-1')).toBeNull()
  })

  it('builds an identity-scoped query without falling back to a placeholder id', () => {
    expect(resolveSettingsIdentity('session-1', null)).toEqual({
      chatId: 'session-1',
      profileId: null,
      query: 'chatId=session-1',
    })

    expect(resolveSettingsIdentity('session-1', 'profile-7')).toEqual({
      chatId: 'session-1',
      profileId: 'profile-7',
      query: 'chatId=session-1&userId=profile-7&conversationId=profile-7',
    })
  })

  it('requests an immediate refetch only when the resolved identity changes to a real value', () => {
    expect(shouldRefetchIdentityScopedSettings(null, null)).toBe(false)
    expect(shouldRefetchIdentityScopedSettings(null, 'chatId=session-1')).toBe(true)
    expect(shouldRefetchIdentityScopedSettings('chatId=session-1', 'chatId=session-1')).toBe(false)
    expect(
      shouldRefetchIdentityScopedSettings(
        'chatId=session-1&userId=profile-7&conversationId=profile-7',
        'chatId=session-2&userId=profile-8&conversationId=profile-8',
      ),
    ).toBe(true)
  })
})
