import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, CSSProperties, ReactNode } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, Environment, useGLTF, Html } from '@react-three/drei'
import { useNavigate } from 'react-router-dom'
import * as THREE from 'three'
import { useAgents } from '../../hooks/use-api'
import { useMonitorStore } from '../../stores/monitor-store'
import {
  FURNITURE,
  FURNITURE_GLB,
  FALLBACK_GLB,
  FURNITURE_SCALE,
  FURNITURE_Y_OFFSET,
  SCALE,
  WORLD_W,
  WORLD_H,
  WALL_HEIGHT,
  CAMERA_OFFSET,
  toWorld,
  getItemBaseSize,
  getItemRotationRadians,
  resolveItemTypeKey,
  WAYPOINTS,
  DEMO_AGENTS,
  AGENT_SCALE,
  AGENT_SPEED_PX,
  AGENT_DWELL,
  pickTargetWaypoint,
  stepTowards,
  mapLiveAgents,
  mapMonitorTasks,
  type FurnitureItem,
  type OfficeWaypoint,
  type OfficeAgent,
} from './officeModel'

/**
 * Furnished isometric office — a faithful port of Hermes's RetroOffice3D
 * rendering approach (orthographic r3f camera, Kenney GLB furniture scaled the
 * Hermes way, procedural room shell). Replaces Strada's old r3f scene that
 * rendered "giant shapes" / over-zoomed. WebGL only (gated by OfficePage).
 */

// Preload every distinct GLB once so the scene pops in without per-item waits.
;[...new Set([...Object.values(FURNITURE_GLB), FALLBACK_GLB])].forEach((p) => useGLTF.preload(p))

/**
 * Renders its children but swallows any render/load error (rendering null
 * instead). Used to make the optional IBL <Environment> fail-safe: its HDR is
 * fetched from a CDN, which fails in offline / network-restricted deployments
 * (e.g. Strada's subscription-auth setups). Without this, that fetch failure
 * crashes the whole office panel ("Could not load potsdamer_platz_1k.hdr").
 */
class OptionalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(): void {
    /* intentionally ignored — the feature is optional polish */
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** One furniture prop: raw Kenney GLB, cloned, positioned via toWorld, rotated
 * about its footprint centre, and scaled by the fixed per-type multiplier. */
function FurnitureModel({ item }: { item: FurnitureItem }): JSX.Element {
  const typeKey = resolveItemTypeKey(item)
  const url = FURNITURE_GLB[typeKey] ?? FALLBACK_GLB
  const { scene } = useGLTF(url)

  // Clone per instance (drei returns a shared scene) and enable shadows.
  const cloned = useMemo(() => {
    const c = scene.clone(true)
    c.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    return c
  }, [scene])

  const [wx, , wz] = toWorld(item.x, item.y)
  const yOffset = (FURNITURE_Y_OFFSET[typeKey] ?? 0) + (item.elevation ?? 0)
  const scale = FURNITURE_SCALE[typeKey] ?? [1, 1, 1]
  const rotY = getItemRotationRadians(item)
  const { width, height } = getItemBaseSize(item)
  const pivotX = width * SCALE * 0.5
  const pivotZ = height * SCALE * 0.5

  return (
    <group position={[wx, yOffset, wz]}>
      <group position={[pivotX, 0, pivotZ]} rotation={[0, rotY, 0]}>
        <group position={[-pivotX, 0, -pivotZ]} scale={scale}>
          <primitive object={cloned} />
        </group>
      </group>
    </group>
  )
}

/** Procedural room shell: tan floor + four short walls + dark baseboards.
 * Walls are deliberately short (1 world unit) so the iso camera sees inside. */
function Room(): JSX.Element {
  const hw = WORLD_W / 2
  const hh = WORLD_H / 2
  const wallColor = '#8d6e63'
  const wallEmissive = '#4e342e'
  const wallProps = {
    color: wallColor,
    emissive: wallEmissive,
    emissiveIntensity: 0.4,
    roughness: 0.9,
  }
  return (
    <group>
      {/* dark ground under everything */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[WORLD_W * 2.2, WORLD_H * 2.4]} />
        <meshStandardMaterial color="#0c0c10" roughness={1} />
      </mesh>
      {/* tan office floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[WORLD_W, WORLD_H, 22, 14]} />
        <meshLambertMaterial color="#c8a97e" />
      </mesh>
      {/* north / south walls (run along X) */}
      <mesh position={[0, WALL_HEIGHT / 2, -hh]} receiveShadow castShadow>
        <boxGeometry args={[WORLD_W, WALL_HEIGHT, 0.12]} />
        <meshStandardMaterial {...wallProps} />
      </mesh>
      <mesh position={[0, WALL_HEIGHT / 2, hh]} receiveShadow castShadow>
        <boxGeometry args={[WORLD_W, WALL_HEIGHT, 0.12]} />
        <meshStandardMaterial {...wallProps} />
      </mesh>
      {/* west / east walls (run along Z) */}
      <mesh position={[-hw, WALL_HEIGHT / 2, 0]} receiveShadow castShadow>
        <boxGeometry args={[0.12, WALL_HEIGHT, WORLD_H]} />
        <meshStandardMaterial {...wallProps} />
      </mesh>
      <mesh position={[hw, WALL_HEIGHT / 2, 0]} receiveShadow castShadow>
        <boxGeometry args={[0.12, WALL_HEIGHT, WORLD_H]} />
        <meshStandardMaterial {...wallProps} />
      </mesh>
      {/* baseboards (inside edges) */}
      <mesh position={[0, 0.03, -hh + 0.04]}>
        <boxGeometry args={[WORLD_W, 0.06, 0.04]} />
        <meshLambertMaterial color="#0c0c10" />
      </mesh>
      <mesh position={[0, 0.03, hh - 0.04]}>
        <boxGeometry args={[WORLD_W, 0.06, 0.04]} />
        <meshLambertMaterial color="#0c0c10" />
      </mesh>
    </group>
  )
}

/**
 * Orthographic iso camera that auto-fits the whole room. For an ortho camera in
 * r3f the frustum spans the canvas in px divided by zoom, so a world point at
 * camera-space (cx,cy) is on-screen iff |cx| <= width/(2*zoom) and likewise for
 * y. We therefore pick zoom = 0.9 * min(W/(2*maxX), H/(2*maxY)) over the room's
 * AABB corners — exact framing at any viewport size (fixes the over-zoom).
 */
function CameraRig(): null {
  // Use the store's non-reactive get() so we mutate the live camera imperatively
  // (the standard r3f pattern) without tripping the hook-immutability lint rule.
  const get = useThree((s) => s.get)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)

  useEffect(() => {
    const camera = get().camera as THREE.OrthographicCamera
    camera.position.set(CAMERA_OFFSET[0], CAMERA_OFFSET[1], CAMERA_OFFSET[2])
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()

    const hw = WORLD_W / 2
    const hh = WORLD_H / 2
    const top = WALL_HEIGHT + 2.2 // headroom for tall props (bookshelf/plants)
    const v = new THREE.Vector3()
    let maxX = 1e-3
    let maxY = 1e-3
    for (const x of [-hw, hw]) {
      for (const z of [-hh, hh]) {
        for (const y of [0, top]) {
          v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
          maxX = Math.max(maxX, Math.abs(v.x))
          maxY = Math.max(maxY, Math.abs(v.y))
        }
      }
    }
    camera.zoom = 0.9 * Math.min(width / (2 * maxX), height / (2 * maxY))
    camera.updateProjectionMatrix()
  }, [get, width, height])

  return null
}

// ── walking voxel agents (ported from Hermes agents.tsx) ────────────────────
const SKIN = '#e8b894'
const NAME_LABEL_STYLE: CSSProperties = {
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
  padding: '2px 8px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  color: '#fff',
  background: 'rgba(0,0,0,0.6)',
}

/** A 64x64 face: skin + forehead sheen + cheek blush + nose (Hermes recipe). */
function makeFaceTexture(skin: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return new THREE.CanvasTexture(canvas)
  ctx.fillStyle = skin
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = 'rgba(255,255,255,0.14)'
  ctx.fillRect(0, 0, 64, 10)
  ctx.fillStyle = 'rgba(196,122,84,0.18)'
  ctx.beginPath()
  ctx.arc(18, 38, 7, 0, Math.PI * 2)
  ctx.arc(46, 38, 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#d8a06e'
  ctx.fillRect(30, 28, 4, 10)
  ctx.fillRect(29, 37, 6, 2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

interface WalkState {
  position: [number, number]
  target: [number, number]
  tickIndex: number
  dwell: number
}

/** A walking box-person. Maintains its own canvas-px position + target waypoint
 * and lerps toward it every frame, swinging limbs + bobbing while moving. */
function AgentAvatar({ agent }: { agent: OfficeAgent }): JSX.Element {
  const groupRef = useRef<THREE.Group>(null)
  const rightLeg = useRef<THREE.Group>(null)
  const leftLeg = useRef<THREE.Group>(null)
  const rightArm = useRef<THREE.Group>(null)
  const leftArm = useRef<THREE.Group>(null)
  const faceTexture = useMemo(() => makeFaceTexture(SKIN), [])

  const home = useMemo(
    () => WAYPOINTS.find((w) => w.id === agent.homeWaypointId) ?? WAYPOINTS[0],
    [agent.homeWaypointId],
  )
  const active = agent.active ?? true
  // Active agents roam between waypoints; idle agents rest at their home spot.
  const first = useMemo(
    () => (active ? pickTargetWaypoint(agent.id, 0) : home),
    [active, agent.id, home],
  )

  // Lazily seed the mutable walk state (no ref read/write during render).
  const stateRef = useRef<WalkState | null>(null)
  stateRef.current ??= {
    position: [home.x, home.y],
    target: [first.x, first.y],
    tickIndex: 0,
    dwell: 0,
  }

  useFrame((state, delta) => {
    const g = groupRef.current
    const s = stateRef.current
    if (!g || !s) return
    const dt = Math.min(delta, 0.1)

    let moving = false
    if (s.dwell > 0) {
      s.dwell = Math.max(0, s.dwell - dt)
    } else {
      const { position, arrived } = stepTowards(s.position, s.target, AGENT_SPEED_PX, dt)
      s.position = position
      moving = !arrived
      if (arrived && active) {
        s.dwell = AGENT_DWELL
        s.tickIndex += 1
        const next = pickTargetWaypoint(agent.id, s.tickIndex)
        s.target = [next.x, next.y]
      }
    }

    const [wx, , wz] = toWorld(s.position[0], s.position[1])
    const phase = state.clock.getElapsedTime() * 9 + agent.id.length
    const bounce = moving ? Math.abs(Math.sin(phase)) * 0.07 : 0
    g.position.set(wx, bounce, wz)

    // Face the direction of travel (canvas dx→world x, canvas dy→world z).
    const dx = s.target[0] - s.position[0]
    const dy = s.target[1] - s.position[1]
    if (moving && dx * dx + dy * dy > 1) g.rotation.y = Math.atan2(dx, dy)

    const legSwing = moving ? Math.sin(phase) * 0.35 : 0
    const armSwing = moving ? Math.sin(phase) * 0.4 : 0
    if (rightLeg.current) rightLeg.current.rotation.x = legSwing
    if (leftLeg.current) leftLeg.current.rotation.x = -legSwing
    if (rightArm.current) rightArm.current.rotation.x = -armSwing
    if (leftArm.current) leftArm.current.rotation.x = armSwing
  })

  return (
    <group ref={groupRef}>
      <group scale={[AGENT_SCALE, AGENT_SCALE, AGENT_SCALE]}>
        {/* ground shadow */}
        <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.12, 12]} />
          <meshBasicMaterial color="#000" transparent opacity={0.2} />
        </mesh>
        {/* legs (swing pivots at the hip) */}
        <group ref={rightLeg} position={[-0.045, 0.1, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.07, 0.14, 0.08]} />
            <meshLambertMaterial color="#374151" />
          </mesh>
          <mesh position={[0, -0.09, 0]} castShadow>
            <boxGeometry args={[0.07, 0.05, 0.12]} />
            <meshLambertMaterial color="#1f2937" />
          </mesh>
        </group>
        <group ref={leftLeg} position={[0.045, 0.1, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.07, 0.14, 0.08]} />
            <meshLambertMaterial color="#374151" />
          </mesh>
          <mesh position={[0, -0.09, 0]} castShadow>
            <boxGeometry args={[0.07, 0.05, 0.12]} />
            <meshLambertMaterial color="#1f2937" />
          </mesh>
        </group>
        {/* torso (shirt = agent accent colour) */}
        <mesh position={[0, 0.28, 0]} castShadow>
          <boxGeometry args={[0.18, 0.2, 0.1]} />
          <meshLambertMaterial color={agent.color} />
        </mesh>
        {/* arms */}
        <group ref={rightArm} position={[-0.12, 0.28, 0]}>
          <mesh position={[0, -0.08, 0]} castShadow>
            <boxGeometry args={[0.06, 0.16, 0.06]} />
            <meshLambertMaterial color={agent.color} />
          </mesh>
          <mesh position={[0, -0.17, 0]} castShadow>
            <boxGeometry args={[0.05, 0.05, 0.05]} />
            <meshLambertMaterial color={SKIN} />
          </mesh>
        </group>
        <group ref={leftArm} position={[0.12, 0.28, 0]}>
          <mesh position={[0, -0.08, 0]} castShadow>
            <boxGeometry args={[0.06, 0.16, 0.06]} />
            <meshLambertMaterial color={agent.color} />
          </mesh>
          <mesh position={[0, -0.17, 0]} castShadow>
            <boxGeometry args={[0.05, 0.05, 0.05]} />
            <meshLambertMaterial color={SKIN} />
          </mesh>
        </group>
        {/* neck */}
        <mesh position={[0, 0.39, 0]} castShadow>
          <boxGeometry args={[0.07, 0.05, 0.07]} />
          <meshLambertMaterial color={SKIN} />
        </mesh>
        {/* head — front (+Z) face gets the painted face texture */}
        <mesh position={[0, 0.47, 0]} castShadow>
          <boxGeometry args={[0.16, 0.16, 0.14]} />
          <meshLambertMaterial attach="material-0" color={SKIN} />
          <meshLambertMaterial attach="material-1" color={SKIN} />
          <meshLambertMaterial attach="material-2" color={SKIN} />
          <meshLambertMaterial attach="material-3" color={SKIN} />
          <meshLambertMaterial attach="material-4" map={faceTexture} />
          <meshLambertMaterial attach="material-5" color={SKIN} />
        </mesh>
        {/* eyes + mouth (separate boxes just proud of the head front) */}
        <mesh position={[-0.04, 0.475, 0.072]}>
          <boxGeometry args={[0.03, 0.03, 0.01]} />
          <meshBasicMaterial color="#1a1a2e" />
        </mesh>
        <mesh position={[0.04, 0.475, 0.072]}>
          <boxGeometry args={[0.03, 0.03, 0.01]} />
          <meshBasicMaterial color="#1a1a2e" />
        </mesh>
        <mesh position={[0, 0.436, 0.074]}>
          <boxGeometry args={[0.05, 0.014, 0.01]} />
          <meshBasicMaterial color="#9c4a4a" />
        </mesh>
      </group>
      <Html center position={[0, 1.7, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{ ...NAME_LABEL_STYLE, border: `1px solid ${agent.color}` }}>{agent.name}</div>
      </Html>
    </group>
  )
}

/** A clickable floor disc for a station — hover brightens it + shows a label;
 * clicking navigates to the station's admin route via the injected onSelect. */
function WaypointHotspot({
  wp,
  onSelect,
}: {
  wp: OfficeWaypoint
  onSelect: (route: string) => void
}): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [x, , z] = toWorld(wp.x, wp.y)
  useEffect(() => () => { document.body.style.cursor = 'auto' }, [])
  return (
    <group position={[x, 0, z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.03, 0]}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
        onPointerOut={(e) => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'auto' }}
        onClick={(e) => { e.stopPropagation(); onSelect(wp.route) }}
      >
        <circleGeometry args={[0.45, 32]} />
        <meshStandardMaterial
          color={hovered ? '#7dd3fc' : '#38bdf8'}
          emissive="#38bdf8"
          emissiveIntensity={hovered ? 0.85 : 0.3}
          transparent
          opacity={hovered ? 0.85 : 0.4}
          roughness={0.5}
        />
      </mesh>
      {hovered && (
        <Html center position={[0, 0.55, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{ ...NAME_LABEL_STYLE, border: '1px solid #38bdf8' }}>{wp.label}</div>
        </Html>
      )}
    </group>
  )
}

function SceneContents({
  onSelect,
  agents,
}: {
  onSelect: (route: string) => void
  agents: readonly OfficeAgent[]
}): JSX.Element {
  return (
    <>
      <color attach="background" args={['#0b1020']} />
      <ambientLight intensity={0.72} color="#d8d4c8" />
      <directionalLight
        position={[8, 14, 6]}
        intensity={1.1}
        color="#f6f1e6"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.02}
      />
      <directionalLight position={[-5, 8, -4]} intensity={0.4} color="#7090ff" />

      <Room />
      <Suspense fallback={null}>
        {FURNITURE.map((item, i) => (
          <FurnitureModel key={item.id ?? `${item.type}-${i}`} item={item} />
        ))}
      </Suspense>

      {/* Walking agents (live when wired, else demo) + station hotspots. */}
      {agents.map((a) => (
        <AgentAvatar key={a.id} agent={a} />
      ))}
      {WAYPOINTS.map((wp) => (
        <WaypointHotspot key={wp.id} wp={wp} onSelect={onSelect} />
      ))}

      {/* Optional IBL — fail-safe: the preset HDR is fetched from a CDN, so in
          offline/restricted deployments it must degrade to "lights only" rather
          than crash the panel. OptionalBoundary swallows the fetch error. */}
      <OptionalBoundary>
        <Suspense fallback={null}>
          <Environment preset="city" />
        </Suspense>
      </OptionalBoundary>

      <CameraRig />
      <OrbitControls
        target={[0, 0, 0]}
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minZoom={20}
        maxZoom={160}
        maxPolarAngle={Math.PI / 2.2}
        rotateSpeed={0.6}
        zoomSpeed={0.8}
      />
    </>
  )
}

export function RetroOfficeScene(): JSX.Element {
  // useNavigate() lives OUTSIDE the <Canvas> (react-router context does not cross
  // the r3f reconciler boundary); navigation is injected as an onSelect callback.
  const navigate = useNavigate()

  // Wire the office to the LIVE SYSTEM, in priority order:
  //  1. The supervisor's in-flight tasks (monitor-store, fed by the global WS) —
  //     the real work shown in the Monitor; each becomes a working agent.
  //  2. Else connected channel/chat sessions (GET /api/agents).
  //  3. Else the demo cast, so the office is never empty (mirrors Hermes).
  const tasks = useMonitorStore((s) => s.tasks)
  const agentsQuery = useAgents()
  const agentsData = agentsQuery.data
  const updatedAt = agentsQuery.dataUpdatedAt
  const agents = useMemo<readonly OfficeAgent[]>(() => {
    const fromTasks = mapMonitorTasks(Object.values(tasks))
    if (fromTasks.length > 0) return fromTasks
    const list = agentsData?.agents
    if (agentsData?.enabled && list && list.length > 0) {
      // Reference "now" = when the data was fetched (pure; avoids Date.now() in
      // render). Activity within RECENT_ACTIVITY_MS of the fetch = active.
      return mapLiveAgents(list, updatedAt || 0)
    }
    return DEMO_AGENTS
  }, [tasks, agentsData, updatedAt])

  return (
    <Canvas
      orthographic
      dpr={[0.85, 1.5]}
      camera={{ position: [...CAMERA_OFFSET], zoom: 48, near: 0.1, far: 100 }}
      shadows={{ type: THREE.PCFShadowMap }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      style={{ width: '100%', height: '100%' }}
    >
      <SceneContents onSelect={(route) => navigate(route)} agents={agents} />
    </Canvas>
  )
}

export default RetroOfficeScene
