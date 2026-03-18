export const SETUP_QUERY_PARAM = 'strada-setup'

export function detectSetupMode(search: string, markerPresent: boolean): boolean {
  if (markerPresent) {
    return true
  }

  const params = new URLSearchParams(search)
  return params.get(SETUP_QUERY_PARAM) === '1'
}
