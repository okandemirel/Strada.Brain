/**
 * Mirror of the daemon's `BuildStatus` (src/campaign/build-status.ts): the
 * measured state of the game build, served at GET /api/campaign and pushed as
 * a `campaign:status` frame. Every number is a measurement the daemon took;
 * a missing block means "not measured", never zero.
 */
export type CampaignState =
  | 'drafting-gdd'
  | 'awaiting-approval'
  | 'planning'
  | 'executing'
  | 'done'
  | 'failed'
  | 'cancelled'

export type MilestoneState = 'pending' | 'running' | 'green' | 'failed'

export interface MilestoneStatus {
  id: string
  title: string
  status: MilestoneState
  attempts: number
  maxAttempts: number
  taskId?: string
  startedAtMs?: number
  timeBoxEscalations: number
  compileVerdict?: { ok: boolean; ran: boolean; errors?: number; detail?: string }
  placeholderArtAtStart?: { sprites: number; placeholders: number }
  structureRefused: boolean
  lastStructureFinding?: string
  resultExcerpt?: string
}

export interface TaskStatus {
  id: string
  title: string
  status: string
  createdAt: number
  updatedAt: number
  lastProgress?: string
  lastProgressAt?: number
}

export interface CampaignStatus {
  id: string
  chatId: string
  channelType: string
  state: CampaignState
  projectRoot: string
  gddPath?: string
  createdAt: number
  updatedAt: number
  currentMilestone: number
  milestones: MilestoneStatus[]
  milestoneTimeBoxMs: number
  deliveryReported: boolean
  autoReviveAt?: number
  lastError?: string
  revivable: boolean
  currentTask?: TaskStatus
  activeTasks: TaskStatus[]
  independentReview?: { ok: boolean; model: string; text: string; ms: number; error?: string }
}

export interface GuardianStatus {
  projectRoot: string
  lastVerdict: 'unknown' | 'green' | 'red' | 'blind'
  lastCheckedAt: number
  lastErrorCount?: number
  lastDetail: string
  fixTaskId?: string
  fixTaskStartedAt: number
  fixAttempts: number
  maxFixAttempts: number
  bestErrorCount?: number
  attemptsWithoutProgress: number
  escalated: boolean
  blindStreak: number
  nextVerifyAt: number
}

export interface BuildMeasurement {
  measuredAt: string
  measured: boolean
  refusal: string | null
  shippedScenes: string[]
  shippedRenderers: number
  shippedWorldRenderers: number
  shippedSpriteRenderers: number
  shippedMeshRenderers: number
  artInventory: {
    prefabs: number
    models: number
    sprites: number
    placeholderSprites: number
    audio: number
    duplicateAudio: number
    shortAudio: number
  }
  boundPlaceholderSprites: number
  unbound: { prefabs: number; models: number; sprites: number }
  primitiveCallSites: number
  incomplete: string[]
}

export interface BuildStatus {
  generatedAt: string
  projectRoot?: string
  campaign: CampaignStatus | null
  guardian: GuardianStatus | null
  measurement: BuildMeasurement | null
  measurementError?: string
}
