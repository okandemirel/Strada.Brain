import { SETUP_QUERY_PARAM } from '../../../src/common/setup-contract.ts'

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
