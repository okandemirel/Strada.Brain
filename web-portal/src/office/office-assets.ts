/**
 * Office 3D model manifest — the bridge between the furnished-office scene and
 * the CC0 GLB assets shipped under `public/models/office/`.
 *
 * The scene (OfficeScene.tsx) looks up a model id with {@link officeModelUrl}.
 * When a url is returned it loads the real GLB via drei's `useGLTF`; when the
 * id is absent it falls back to a labeled low-poly PRIMITIVE. Listing only the
 * ids we actually obtained keeps that graceful degradation honest.
 *
 * Assets are CC0 1.0 (Kenney "Furniture Kit" + "Blocky Characters"). See
 * `public/models/office/CREDITS.md` for sources, conversion notes and the GLB
 * validity checks.
 *
 * This module is PURE data — no three.js import — so it unit-tests in jsdom.
 */

export interface OfficeModel {
  /** Stable lookup id used by the scene (e.g. 'desk', 'agent'). */
  id: string
  /** Public URL of the GLB, served from `public/` (e.g. '/models/office/desk.glb'). */
  url: string
  /** Whether this is a furniture prop or the walking agent avatar. */
  kind: 'furniture' | 'character'
}

/** Base public path for the office GLBs (served verbatim from `public/`). */
const MODELS_BASE = '/models/office'

/**
 * The models actually obtained as verified CC0 GLBs. Each entry maps an id the
 * scene knows about to its `/models/office/<id>.glb` url. Any known id NOT in
 * this list (none, currently) must be rendered by the scene as a primitive.
 */
export const OFFICE_MODELS: readonly OfficeModel[] = [
  { id: 'desk', url: `${MODELS_BASE}/desk.glb`, kind: 'furniture' },
  { id: 'chair', url: `${MODELS_BASE}/chair.glb`, kind: 'furniture' },
  { id: 'table', url: `${MODELS_BASE}/table.glb`, kind: 'furniture' },
  { id: 'couch', url: `${MODELS_BASE}/couch.glb`, kind: 'furniture' },
  { id: 'plant', url: `${MODELS_BASE}/plant.glb`, kind: 'furniture' },
  { id: 'bookshelf', url: `${MODELS_BASE}/bookshelf.glb`, kind: 'furniture' },
  { id: 'monitor', url: `${MODELS_BASE}/monitor.glb`, kind: 'furniture' },
  { id: 'rug', url: `${MODELS_BASE}/rug.glb`, kind: 'furniture' },
  { id: 'agent', url: `${MODELS_BASE}/agent.glb`, kind: 'character' },
]

/** True when at least one real GLB is available (else the scene uses primitives). */
export const HAS_OFFICE_MODELS: boolean = OFFICE_MODELS.length > 0

/** Look up a model's public GLB url by id, or undefined if not obtained. */
export function officeModelUrl(id: string): string | undefined {
  return OFFICE_MODELS.find((model) => model.id === id)?.url
}
