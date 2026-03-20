import { SETUP_QUERY_PARAM } from '../../../src/common/setup-contract.ts'

export function detectSetupMode(
  search: string,
  markerPresent: boolean,
): boolean {
  if (markerPresent) {
    return true
  }

  const params = new URLSearchParams(search)
  return params.get(SETUP_QUERY_PARAM) === '1'
}
