export const SETUP_QUERY_PARAM = 'strada-setup'

export function detectSetupMode(
  search: string,
  markerPresent: boolean,
  firstRunCommitted: boolean,
): boolean {
  if (markerPresent) {
    return true
  }

  if (firstRunCommitted) {
    return false
  }

  const params = new URLSearchParams(search)
  return params.get(SETUP_QUERY_PARAM) === '1'
}
