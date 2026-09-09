import { create } from 'zustand'
import type { BuildStatus, BuildMeasurement } from '../types/build-status'

interface CampaignStoreState {
  /** The latest `campaign:status` frame pushed over the chat socket. */
  pushed: BuildStatus | null
  /** The last on-demand measurement (GET /api/campaign?measure=1); kept across pushes. */
  measurement: BuildMeasurement | null
  measurementError: string | null
  measuring: boolean
  setPushed: (status: BuildStatus) => void
  setMeasurement: (m: BuildMeasurement | null, error: string | null) => void
  setMeasuring: (measuring: boolean) => void
  reset: () => void
}

export const useCampaignStore = create<CampaignStoreState>((set) => ({
  pushed: null,
  measurement: null,
  measurementError: null,
  measuring: false,
  setPushed: (status) => set({ pushed: status }),
  setMeasurement: (measurement, measurementError) => set({ measurement, measurementError, measuring: false }),
  setMeasuring: (measuring) => set({ measuring }),
  reset: () => set({ pushed: null, measurement: null, measurementError: null, measuring: false }),
}))

/** Freshest of the pushed frame and the polled response, by the daemon's own timestamp. */
export function pickFreshest(pushed: BuildStatus | null, polled: BuildStatus | null | undefined): BuildStatus | null {
  if (!pushed) return polled ?? null
  if (!polled) return pushed
  return Date.parse(polled.generatedAt) > Date.parse(pushed.generatedAt) ? polled : pushed
}
