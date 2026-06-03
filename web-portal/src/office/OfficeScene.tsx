import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Html, Clone, useGLTF } from '@react-three/drei'
import { useNavigate } from 'react-router-dom'
import * as THREE from 'three'
import { officeModelUrl } from './office-assets'
import { FURNITURE, WAYPOINTS, ROOM, type FurniturePlacement } from './office-layout'
import { DEMO_AGENTS, pickTargetWaypoint, stepTowards } from './office-agents'

/**
 * Furnished isometric office. A floor + two framing walls (sized from ROOM)
 * hold a furnished open-plan office (FURNITURE: real Kenney GLBs when the asset
 * exists, else a labeled low-poly primitive). DEMO_AGENTS render as avatars that
 * WALK between WAYPOINTS — each waypoint is also a subtle clickable hotspot that
 * navigates to its admin route.
 *
 * WebGL only — the page guards this behind isOffice3DEnabled() so jsdom never
 * instantiates a <Canvas>. react-router's useNavigate() relies on React context
 * that does NOT cross the <Canvas> reconciler boundary, so navigation is injected
 * into OfficeSceneContents as a plain `onSelect` callback (props DO cross),
 * resolved by OfficeScene which calls useNavigate() OUTSIDE the Canvas.
 */

// Approx world-space footprint (w, h, d) for the labeled primitive fallback of
// each known furniture id, so a missing GLB still reads as that kind of object.
const PRIMITIVE_SIZES: Record<string, readonly [number, number, number]> = {
  desk: [1.6, 0.75, 0.8],
  chair: [0.6, 1, 0.6],
  table: [1.4, 0.7, 1.4],
  couch: [2, 0.8, 0.9],
  plant: [0.6, 1.4, 0.6],
  bookshelf: [1.2, 1.8, 0.4],
  monitor: [0.7, 0.5, 0.15],
  rug: [2.4, 0.02, 1.6],
}
const DEFAULT_PRIMITIVE: readonly [number, number, number] = [1, 1, 1]

// Muted, woody/neutral tints so the primitive office still reads as furniture.
const PRIMITIVE_COLORS: Record<string, string> = {
  desk: '#a98467',
  chair: '#6b705c',
  table: '#b08968',
  couch: '#7286a0',
  plant: '#386641',
  bookshelf: '#8a5a44',
  monitor: '#1f2933',
  rug: '#3a506b',
}
const DEFAULT_PRIMITIVE_COLOR = '#8d99ae'

/** How fast agents walk, in world units / second. */
const AGENT_SPEED = 1.4
/** Seconds an agent dwells at a task spot before heading to the next one. */
const AGENT_DWELL = 1.6
/** Pad the agent's bounded area so it never clips into a wall. */
const AGENT_BOUNDS_PAD = 1

/** A real GLB prop, deep-cloned so multiple placements don't share a graph.
 *
 * Kenney models are authored in KIT UNITS, not meters — e.g. a chair is ~6 units
 * tall and the rug ~16 units wide in its own space, so dropping them into the
 * 16-unit room at a flat scale made them dwarf the walls ("giant shapes"). We
 * instead NORMALIZE each model to fit inside its real-world {@link PRIMITIVE_SIZES}
 * target box (the same dimensions the primitive fallback uses), with a single
 * uniform scale so proportions are preserved and a GLB office reads at the same
 * scale as the primitive one. The model is also centered on its footprint and
 * sat on the floor so the layout's position places it where intended (Kenney
 * models are NOT origin-centered). */
function GltfFurniture({
  url,
  placement,
}: {
  url: string
  placement: FurniturePlacement
}): JSX.Element {
  const { scene } = useGLTF(url)
  const { offset, fitScale } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const target = PRIMITIVE_SIZES[placement.modelId] ?? DEFAULT_PRIMITIVE
    // Uniform scale that fits the native model inside its target box (bind on
    // the most-constrained axis so nothing pokes past the intended footprint).
    const fit = Math.min(
      target[0] / Math.max(size.x, 1e-3),
      target[1] / Math.max(size.y, 1e-3),
      target[2] / Math.max(size.z, 1e-3),
    )
    return {
      offset: [-center.x, -box.min.y, -center.z] as [number, number, number],
      fitScale: Number.isFinite(fit) && fit > 0 ? fit : 1,
    }
  }, [scene, placement.modelId])
  const [x, , z] = placement.position
  const scale = (placement.scale ?? 1) * fitScale
  return (
    <group position={[x, 0, z]} rotation={[0, placement.rotationY ?? 0, 0]} scale={scale}>
      <Clone object={scene} position={offset} castShadow receiveShadow />
    </group>
  )
}

/** Labeled low-poly stand-in used when a furniture id has no GLB asset. */
function PrimitiveFurniture({ placement }: { placement: FurniturePlacement }): JSX.Element {
  const [w, h, d] = PRIMITIVE_SIZES[placement.modelId] ?? DEFAULT_PRIMITIVE
  const color = PRIMITIVE_COLORS[placement.modelId] ?? DEFAULT_PRIMITIVE_COLOR
  const [x, , z] = placement.position
  const scale = placement.scale ?? 1
  // Sit the box on the floor regardless of the layout's authored y.
  return (
    <group
      position={[x, (h * scale) / 2, z]}
      rotation={[0, placement.rotationY ?? 0, 0]}
      scale={scale}
    >
      <mesh castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} roughness={0.8} metalness={0.05} />
      </mesh>
      <Html center distanceFactor={12} position={[0, h / 2 + 0.25, 0]}>
        <div
          style={{
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            padding: '1px 6px',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 500,
            color: '#e5e7eb',
            background: 'rgba(0,0,0,0.45)',
            opacity: 0.7,
          }}
        >
          {placement.modelId}
        </div>
      </Html>
    </group>
  )
}

/** One furniture placement: real GLB when we have the asset, else a primitive. */
function Furniture({ placement }: { placement: FurniturePlacement }): JSX.Element {
  const url = officeModelUrl(placement.modelId)
  if (url) {
    return <GltfFurniture url={url} placement={placement} />
  }
  return <PrimitiveFurniture placement={placement} />
}

interface WaypointHotspotProps {
  waypoint: (typeof WAYPOINTS)[number]
  onSelect: (route: string) => void
}

/**
 * A waypoint rendered as a subtle floor disc. Hovering brightens it + shows a
 * drei <Html> label; clicking navigates via onSelect(route).
 */
function WaypointHotspot({ waypoint, onSelect }: WaypointHotspotProps): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [x, , z] = waypoint.position

  // Pointer handlers set document.body.style.cursor imperatively; reset it if
  // this hotspot unmounts while still hovered so the cursor never sticks.
  useEffect(() => () => { document.body.style.cursor = 'auto' }, [])

  return (
    <group position={[x, 0, z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.02, 0]}
        onPointerOver={(event) => {
          event.stopPropagation()
          setHovered(true)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={(event) => {
          event.stopPropagation()
          setHovered(false)
          document.body.style.cursor = 'auto'
        }}
        onClick={(event) => {
          event.stopPropagation()
          onSelect(waypoint.route)
        }}
      >
        <circleGeometry args={[0.7, 32]} />
        <meshStandardMaterial
          color={hovered ? '#7dd3fc' : '#38bdf8'}
          emissive="#38bdf8"
          emissiveIntensity={hovered ? 0.8 : 0.25}
          transparent
          opacity={hovered ? 0.85 : 0.45}
          roughness={0.5}
        />
      </mesh>
      <Html center distanceFactor={12} position={[0, hovered ? 0.9 : 0.6, 0]}>
        <div
          style={{
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            padding: '2px 8px',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            background: 'rgba(0,0,0,0.6)',
            border: '1px solid #38bdf8',
            opacity: hovered ? 1 : 0,
            transform: hovered ? 'scale(1.05)' : 'scale(1)',
            transition: 'opacity 0.15s ease, transform 0.15s ease',
          }}
        >
          {waypoint.label}
        </div>
      </Html>
    </group>
  )
}

/** Clamp a coordinate so the avatar stays inside the room (minus padding). */
function clampToRoom(v: number, half: number): number {
  return Math.max(-half, Math.min(half, v))
}

interface AgentAvatarProps {
  agent: (typeof DEMO_AGENTS)[number]
}

/**
 * The agent's visible body. Split out so the `useGLTF` hook is only ever
 * mounted when the 'agent' GLB exists (never called conditionally within one
 * component, which would break the rules of hooks). When the asset is absent
 * the caller renders {@link PrimitiveAgentBody} instead.
 */
function GltfAgentBody({ url }: { url: string }): JSX.Element {
  const { scene } = useGLTF(url)
  // Normalize to ~1.6 units tall, centered, feet on the group origin.
  const { offset, scale } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    return {
      offset: [-center.x, -box.min.y, -center.z] as [number, number, number],
      scale: 1.6 / Math.max(size.y, 0.001),
    }
  }, [scene])
  return (
    <group scale={scale}>
      <Clone object={scene} position={offset} castShadow />
    </group>
  )
}

/** Simple capsule/sphere stand-in figure, tinted with the agent's colour. */
function PrimitiveAgentBody({ color }: { color: string }): JSX.Element {
  return (
    <group>
      {/* body */}
      <mesh position={[0, 0.55, 0]} castShadow>
        <capsuleGeometry args={[0.22, 0.55, 4, 12]} />
        <meshStandardMaterial color={color} roughness={0.6} metalness={0.1} />
      </mesh>
      {/* head */}
      <mesh position={[0, 1.1, 0]} castShadow>
        <sphereGeometry args={[0.18, 16, 16]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} />
      </mesh>
    </group>
  )
}

/**
 * A walking agent. Maintains its own [x,z] position + current target waypoint
 * and, every frame, calls stepTowards() to move toward that target. On arrival
 * it dwells briefly, then advances to the next pickTargetWaypoint(...) — so the
 * avatars look like they are visiting task spots around the office.
 *
 * Renders the 'agent' GLB when that asset exists, else a simple capsule/box
 * figure tinted with the agent's colour. A drei <Html> name label floats above.
 */
interface WalkState {
  tickIndex: number
  position: [number, number]
  target: [number, number]
  dwell: number
}

function AgentAvatar({ agent }: AgentAvatarProps): JSX.Element {
  const groupRef = useRef<THREE.Group>(null)
  const agentUrl = officeModelUrl('agent')
  const half = ROOM.size / 2 - AGENT_BOUNDS_PAD

  // Compute the agent's starting position + first target ONCE (pure, no ref
  // access during render). `agent.id` is the only varying input; WAYPOINTS is a
  // module constant. When there are no waypoints the agent just stands still.
  const initialState = useMemo<WalkState>(() => {
    if (WAYPOINTS.length === 0) {
      return { tickIndex: 0, position: [0, 0], target: [0, 0], dwell: 0 }
    }
    const startTarget = pickTargetWaypoint(agent.id, 0, WAYPOINTS)
    const home =
      WAYPOINTS.find((w) => w.id === agent.homeWaypointId) ?? startTarget
    return {
      tickIndex: 0,
      position: [home.position[0], home.position[2]],
      target: [startTarget.position[0], startTarget.position[2]],
      dwell: 0,
    }
    // agent is stable per avatar; recompute only if its identity changes.
  }, [agent.id, agent.homeWaypointId])

  // Lazily seed the mutable walk state ref from the computed initial state, so
  // useFrame can mutate it every frame without ever triggering a re-render and
  // without reading/writing the ref during render.
  const stateRef = useRef<WalkState | null>(null)
  stateRef.current ??= {
    tickIndex: initialState.tickIndex,
    position: [...initialState.position] as [number, number],
    target: [...initialState.target] as [number, number],
    dwell: initialState.dwell,
  }

  useFrame((_, delta) => {
    const group = groupRef.current
    const s = stateRef.current
    if (!group || !s || WAYPOINTS.length === 0) return
    const dt = Math.min(delta, 0.1) // guard against tab-restore frame spikes

    if (s.dwell > 0) {
      s.dwell = Math.max(0, s.dwell - dt)
    } else {
      const { position, arrived } = stepTowards(s.position, s.target, AGENT_SPEED, dt)
      s.position = position
      if (arrived) {
        s.dwell = AGENT_DWELL
        s.tickIndex += 1
        const next = pickTargetWaypoint(agent.id, s.tickIndex, WAYPOINTS)
        s.target = [next.position[0], next.position[2]]
      }
    }

    const x = clampToRoom(s.position[0], half)
    const z = clampToRoom(s.position[1], half)
    group.position.set(x, 0, z)
    // Face the direction of travel (toward the current target).
    const dx = s.target[0] - x
    const dz = s.target[1] - z
    if (dx * dx + dz * dz > 1e-4) {
      group.rotation.y = Math.atan2(dx, dz)
    }
  })

  return (
    <group ref={groupRef}>
      {agentUrl ? (
        <Suspense fallback={<PrimitiveAgentBody color={agent.color} />}>
          <GltfAgentBody url={agentUrl} />
        </Suspense>
      ) : (
        <PrimitiveAgentBody color={agent.color} />
      )}
      <Html center distanceFactor={11} position={[0, 1.5, 0]}>
        <div
          style={{
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            padding: '2px 8px',
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            background: 'rgba(0,0,0,0.6)',
            border: `1px solid ${agent.color}`,
          }}
        >
          {agent.name}
        </div>
      </Html>
    </group>
  )
}

/**
 * The contents of the office scene — everything that lives *inside* the
 * <Canvas>. Extracted from OfficeScene so:
 *  1. Testability: @react-three/test-renderer can mount it directly (no real
 *     WebGL) to verify a waypoint hotspot click calls onSelect(route).
 *  2. Context boundary: useNavigate() does not cross the <Canvas> reconciler
 *     boundary, so navigation is injected as an `onSelect` callback prop.
 */
export function OfficeSceneContents({
  onSelect,
}: {
  onSelect: (route: string) => void
}): JSX.Element {
  const half = ROOM.size / 2

  return (
    <>
      <color attach="background" args={['#0b1020']} />
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[8, 14, 8]}
        intensity={1.15}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <hemisphereLight args={['#dbe4ff', '#0b1020', 0.5]} />

      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[ROOM.size, ROOM.size]} />
        <meshStandardMaterial color="#e8e2d4" roughness={0.95} />
      </mesh>

      {/* Back wall */}
      <mesh position={[0, ROOM.wallHeight / 2, -half]} receiveShadow>
        <boxGeometry args={[ROOM.size, ROOM.wallHeight, 0.2]} />
        <meshStandardMaterial color="#cdd3e0" roughness={1} />
      </mesh>

      {/* Side wall */}
      <mesh
        position={[-half, ROOM.wallHeight / 2, 0]}
        rotation={[0, Math.PI / 2, 0]}
        receiveShadow
      >
        <boxGeometry args={[ROOM.size, ROOM.wallHeight, 0.2]} />
        <meshStandardMaterial color="#c4cad8" roughness={1} />
      </mesh>

      {/* Furniture: real GLB when the asset exists, else a labeled primitive. */}
      <Suspense fallback={null}>
        {FURNITURE.map((placement, i) => (
          <Furniture key={`${placement.modelId}-${i}`} placement={placement} />
        ))}
      </Suspense>

      {/* Walking agents (suspends only if the 'agent' GLB is being loaded). */}
      <Suspense fallback={null}>
        {DEMO_AGENTS.map((agent) => (
          <AgentAvatar key={agent.id} agent={agent} />
        ))}
      </Suspense>

      {/* Clickable task-spot hotspots -> navigation. */}
      {WAYPOINTS.map((waypoint) => (
        <WaypointHotspot key={waypoint.id} waypoint={waypoint} onSelect={onSelect} />
      ))}

      <OrbitControls
        enablePan={false}
        minDistance={8}
        maxDistance={32}
        maxPolarAngle={Math.PI / 2.1}
      />
    </>
  )
}

/**
 * Furnished isometric virtual office with walking agents. Orthographic camera
 * positioned equally on x/y/z for the classic isometric read. WebGL only.
 */
export function OfficeScene(): JSX.Element {
  const navigate = useNavigate()
  const iso = ROOM.size * 0.9

  return (
    <Canvas
      shadows
      orthographic
      camera={{ position: [iso, iso, iso], zoom: 38, near: -200, far: 1000 }}
      style={{ width: '100%', height: '100%' }}
    >
      <OfficeSceneContents onSelect={(route) => navigate(route)} />
    </Canvas>
  )
}
