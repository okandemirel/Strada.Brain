import { useState } from 'react'
import type { JSX } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import { useNavigate } from 'react-router-dom'
import { OFFICE_STATIONS, type OfficeStation } from './office-stations'

const FLOOR_SIZE = 16
const WALL_HEIGHT = 4

interface StationMeshProps {
  station: OfficeStation
  onSelect: (route: string) => void
}

/**
 * One interactive desk per station. Hovering lifts + highlights it and shows
 * a drei <Html> label; clicking navigates to the station's admin route.
 */
function StationMesh({ station, onSelect }: StationMeshProps): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [x, y, z] = station.position

  return (
    <group position={[x, y, z]}>
      <mesh
        castShadow
        scale={hovered ? 1.15 : 1}
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
          onSelect(station.route)
        }}
      >
        <boxGeometry args={[1.2, 1, 1.2]} />
        <meshStandardMaterial
          color={station.color}
          emissive={station.color}
          emissiveIntensity={hovered ? 0.6 : 0.15}
          roughness={0.4}
          metalness={0.1}
        />
      </mesh>
      <Html center distanceFactor={10} position={[0, 1.1, 0]}>
        <div
          style={{
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            padding: '2px 8px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            color: '#fff',
            background: 'rgba(0,0,0,0.6)',
            border: `1px solid ${station.color}`,
            opacity: hovered ? 1 : 0.75,
            transform: hovered ? 'scale(1.05)' : 'scale(1)',
            transition: 'opacity 0.15s ease, transform 0.15s ease',
          }}
        >
          <span aria-hidden="true">{station.emoji}</span> {station.label}
        </div>
      </Html>
    </group>
  )
}

/**
 * Low-poly 3D virtual office. A floor + two back walls frame a ring of
 * interactive station desks. WebGL only — the page guards this behind
 * isOffice3DEnabled() so jsdom never instantiates a <Canvas>.
 */
export function OfficeScene(): JSX.Element {
  const navigate = useNavigate()

  return (
    <Canvas
      shadows
      camera={{ position: [0, 9, 12], fov: 50 }}
      style={{ width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#0b1020']} />
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[6, 12, 8]}
        intensity={1.1}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <hemisphereLight args={['#cdd9ff', '#0b1020', 0.4]} />

      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
        <meshStandardMaterial color="#1c2438" roughness={0.95} />
      </mesh>

      {/* Back wall */}
      <mesh position={[0, WALL_HEIGHT / 2, -FLOOR_SIZE / 2]} receiveShadow>
        <boxGeometry args={[FLOOR_SIZE, WALL_HEIGHT, 0.2]} />
        <meshStandardMaterial color="#161d2e" roughness={1} />
      </mesh>

      {/* Side wall */}
      <mesh
        position={[-FLOOR_SIZE / 2, WALL_HEIGHT / 2, 0]}
        rotation={[0, Math.PI / 2, 0]}
        receiveShadow
      >
        <boxGeometry args={[FLOOR_SIZE, WALL_HEIGHT, 0.2]} />
        <meshStandardMaterial color="#161d2e" roughness={1} />
      </mesh>

      {OFFICE_STATIONS.map((station) => (
        <StationMesh
          key={station.id}
          station={station}
          onSelect={(route) => navigate(route)}
        />
      ))}

      <OrbitControls
        enablePan={false}
        minDistance={6}
        maxDistance={22}
        maxPolarAngle={Math.PI / 2.1}
      />
    </Canvas>
  )
}
