export interface SettingsIdentity {
  chatId: string
  profileId: string | null
  query: string
}

function normalizeId(value: string | null): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

export function resolveSettingsIdentity(
  sessionId: string | null,
  profileId: string | null,
): SettingsIdentity | null {
  const chatId = normalizeId(sessionId)
  if (!chatId) return null

  const resolvedProfileId = normalizeId(profileId)
  const query = new URLSearchParams({
    chatId,
    ...(resolvedProfileId ? { userId: resolvedProfileId, conversationId: resolvedProfileId } : {}),
  }).toString()

  return {
    chatId,
    profileId: resolvedProfileId,
    query,
  }
}

export function shouldRefetchIdentityScopedSettings(
  previousQuery: string | null,
  nextQuery: string | null,
): boolean {
  return typeof nextQuery === 'string' && nextQuery.length > 0 && previousQuery !== nextQuery
}
