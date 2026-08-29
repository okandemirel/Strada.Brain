/**
 * Procedural low-poly MESH generation — the 3D counterpart of the sprite tool.
 *
 * Measured 2026-08-27 (user: "iyi de oyun 3d idi"): the GDD's visual style is
 * two-layer — flat pixel-art puzzle canvases (covered by unity_generate_sprite)
 * on "softly rendered dimensional stages", with "plump, glossy 3D-feel"
 * characters. Everything the pipeline had produced was flat 2D; nothing could
 * originate a mesh. The user's Asset Store cache holds exactly one 3D package
 * (an off-theme racing car), so the procedural floor matters here too.
 *
 * Writes Wavefront OBJ with smooth per-vertex normals (Unity imports .obj
 * natively; the written .meta pins the guid so references don't churn). No
 * Editor, no bridge, no deps. Placeholder-grade like the sprite tool: the
 * soft low-poly look comes from the shapes themselves (rounded box, sphere,
 * capsule), and sourced art from unity_my_assets_cloud stays the preferred option
 * whenever a package fits.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reuseOrMintGuid } from "./meta-file-utils.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { validatePath } from "../../../security/path-guard.js";

// =============================================================================
// MESH MATH
// =============================================================================

export const MESH_SHAPES = ["rounded-box", "sphere", "capsule", "cylinder", "cone", "organic"] as const;
export type MeshShape = (typeof MESH_SHAPES)[number];

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Mesh {
  vertices: Vec3[];
  normals: Vec3[];
  faces: number[][]; // 1-indexed vertex indices (OBJ convention)
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Cube-sphere projection (even volume distortion). */
function spherify(x: number, y: number, z: number): Vec3 {
  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;
  return {
    x: x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3),
    y: y * Math.sqrt(1 - x2 / 2 - z2 / 2 + (x2 * z2) / 3),
    z: z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3),
  };
}

/**
 * Rounded box: a subdivided cube whose surface points are lerped toward their
 * sphere projection. `roundness` 0 = sharp cube, 1 = sphere; ~0.4 reads as a
 * "softly rendered" pillow-edged block.
 */
function roundedBox(size: number, subdivisions: number, roundness: number): Mesh {
  const half = size / 2;
  const n = Math.max(1, Math.min(12, Math.round(subdivisions)));
  const mesh: Mesh = { vertices: [], normals: [], faces: [] };
  const center = { x: 0, y: 0, z: 0 };

  // Each face: origin corner + two axis directions, walked as an (n+1)² grid.
  const faces: Array<{ o: Vec3; u: Vec3; v: Vec3 }> = [
    { o: { x: -half, y: -half, z: half }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } }, // +Z
    { o: { x: half, y: -half, z: -half }, u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } }, // -Z
    { o: { x: half, y: -half, z: half }, u: { x: 0, y: 0, z: -1 }, v: { x: 0, y: 1, z: 0 } }, // +X
    { o: { x: -half, y: -half, z: -half }, u: { x: 0, y: 0, z: 1 }, v: { x: 0, y: 1, z: 0 } }, // -X
    { o: { x: -half, y: half, z: half }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: -1 } }, // +Y
    { o: { x: -half, y: -half, z: -half }, u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 0, z: 1 } }, // -Y
  ];

  for (const face of faces) {
    const base = mesh.vertices.length;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const fu = (i / n) * 2 - 1;
        const fv = (j / n) * 2 - 1;
        const cube = {
          x: face.o.x + face.u.x * ((fu + 1) * half) + face.v.x * ((fv + 1) * half),
          y: face.o.y + face.u.y * ((fu + 1) * half) + face.v.y * ((fv + 1) * half),
          z: face.o.z + face.u.z * ((fu + 1) * half) + face.v.z * ((fv + 1) * half),
        };
        const cubeNorm = normalize(cube);
        const sph = spherify(cubeNorm.x, cubeNorm.y, cubeNorm.z);
        const rounded = {
          x: cube.x + (sph.x * half - cube.x) * roundness,
          y: cube.y + (sph.y * half - cube.y) * roundness,
          z: cube.z + (sph.z * half - cube.z) * roundness,
        };
        mesh.vertices.push(rounded);
        mesh.normals.push(normalize({ x: rounded.x - center.x, y: rounded.y - center.y, z: rounded.z - center.z }));
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        mesh.faces.push([a + 1, b + 1, d + 1], [a + 1, d + 1, c + 1]);
      }
    }
  }
  return mesh;
}

/** UV sphere, radius r, seg×ring tessellation. */
function sphere(radius: number, segments: number, rings: number): Mesh {
  const seg = Math.max(4, Math.min(64, Math.round(segments)));
  const rng = Math.max(3, Math.min(48, Math.round(rings)));
  const mesh: Mesh = { vertices: [], normals: [], faces: [] };

  for (let j = 0; j <= rng; j++) {
    const theta = (j / rng) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let i = 0; i <= seg; i++) {
      const phi = (i / seg) * Math.PI * 2;
      const n = { x: sinT * Math.cos(phi), y: cosT, z: sinT * Math.sin(phi) };
      mesh.vertices.push({ x: n.x * radius, y: n.y * radius, z: n.z * radius });
      mesh.normals.push(n);
    }
  }
  for (let j = 0; j < rng; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + 1;
      const c = a + (seg + 1);
      const d = c + 1;
      mesh.faces.push([a + 1, b + 1, d + 1], [a + 1, d + 1, c + 1]);
    }
  }
  return mesh;
}

/** Cylinder (uncapped sides + caps), along Y, centered. */
function cylinder(radius: number, height: number, segments: number, capped: boolean): Mesh {
  const seg = Math.max(3, Math.min(64, Math.round(segments)));
  const half = height / 2;
  const mesh: Mesh = { vertices: [], normals: [], faces: [] };

  for (let i = 0; i <= seg; i++) {
    const phi = (i / seg) * Math.PI * 2;
    const nx = Math.cos(phi);
    const nz = Math.sin(phi);
    mesh.vertices.push({ x: nx * radius, y: -half, z: nz * radius });
    mesh.normals.push({ x: nx, y: 0, z: nz });
    mesh.vertices.push({ x: nx * radius, y: half, z: nz * radius });
    mesh.normals.push({ x: nx, y: 0, z: nz });
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    mesh.faces.push([a + 1, a + 2, a + 4], [a + 1, a + 4, a + 3]);
  }

  if (capped) {
    for (const sign of [1, -1]) {
      const centerIndex = mesh.vertices.length + 1;
      mesh.vertices.push({ x: 0, y: sign * half, z: 0 });
      mesh.normals.push({ x: 0, y: sign, z: 0 });
      const ringStart = mesh.vertices.length;
      for (let i = 0; i <= seg; i++) {
        const phi = (i / seg) * Math.PI * 2;
        mesh.vertices.push({ x: Math.cos(phi) * radius, y: sign * half, z: Math.sin(phi) * radius });
        mesh.normals.push({ x: 0, y: sign, z: 0 });
      }
      for (let i = 0; i < seg; i++) {
        const a = ringStart + i;
        if (sign > 0) mesh.faces.push([centerIndex, a + 1, a + 2]);
        else mesh.faces.push([centerIndex, a + 2, a + 1]);
      }
    }
  }
  return mesh;
}

/** Cone along Y, apex up, base centered. */
function cone(radius: number, height: number, segments: number): Mesh {
  const seg = Math.max(3, Math.min(64, Math.round(segments)));
  const half = height / 2;
  const mesh: Mesh = { vertices: [], normals: [], faces: [] };
  const slope = radius / Math.hypot(radius, height);

  const apexIndex = mesh.vertices.length + 1;
  mesh.vertices.push({ x: 0, y: half, z: 0 });
  mesh.normals.push({ x: 0, y: 1, z: 0 });
  const ringStart = mesh.vertices.length;
  for (let i = 0; i <= seg; i++) {
    const phi = (i / seg) * Math.PI * 2;
    const nx = Math.cos(phi);
    const nz = Math.sin(phi);
    mesh.vertices.push({ x: nx * radius, y: -half, z: nz * radius });
    mesh.normals.push(normalize({ x: nx * (1 - slope), y: slope, z: nz * (1 - slope) }));
  }
  for (let i = 0; i < seg; i++) {
    mesh.faces.push([apexIndex, ringStart + i + 1, ringStart + i + 2]);
  }
  // Base cap.
  const capCenter = mesh.vertices.length + 1;
  mesh.vertices.push({ x: 0, y: -half, z: 0 });
  mesh.normals.push({ x: 0, y: -1, z: 0 });
  const capStart = mesh.vertices.length;
  for (let i = 0; i <= seg; i++) {
    const phi = (i / seg) * Math.PI * 2;
    mesh.vertices.push({ x: Math.cos(phi) * radius, y: -half, z: Math.sin(phi) * radius });
    mesh.normals.push({ x: 0, y: -1, z: 0 });
  }
  for (let i = 0; i < seg; i++) {
    mesh.faces.push([capCenter, capStart + i + 2, capStart + i + 1]);
  }
  return mesh;
}

/** Capsule (cylinder + hemispherical caps) along Y — the "plump" body shape. */
function capsule(radius: number, height: number, segments: number, rings: number): Mesh {
  const seg = Math.max(4, Math.min(48, Math.round(segments)));
  const rng = Math.max(2, Math.min(24, Math.round(rings)));
  const cylHalf = Math.max(0, height / 2 - radius);
  const mesh: Mesh = { vertices: [], normals: [], faces: [] };

  // Full-latitude rings: from south pole to north pole; the ring's y and its
  // normal both follow the hemisphere, the cylinder section keeps latitude 0.
  const totalRings = rng * 2 + 1;
  for (let j = 0; j <= totalRings; j++) {
    const theta = (j / totalRings) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const y = cosT >= 0 ? cylHalf + radius * Math.cos(Math.min(theta, Math.PI / 2)) : -cylHalf - radius * Math.cos(Math.max(theta, Math.PI / 2));
    for (let i = 0; i <= seg; i++) {
      const phi = (i / seg) * Math.PI * 2;
      const n = { x: sinT * Math.cos(phi), y: cosT, z: sinT * Math.sin(phi) };
      mesh.vertices.push({ x: n.x * radius, y, z: n.z * radius });
      mesh.normals.push(n);
    }
  }
  for (let j = 0; j < totalRings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + 1;
      const c = a + (seg + 1);
      const d = c + 1;
      mesh.faces.push([a + 1, b + 1, d + 1], [a + 1, d + 1, c + 1]);
    }
  }
  return mesh;
}

// =============================================================================
// ORGANIC — metaball fields + marching tetrahedra (the "plump glossy" tier)
// =============================================================================

/** One blob of an organic build: an ellipsoid field centred at pos. */
export interface OrganicField {
  pos: [number, number, number];
  radii: [number, number, number];
}

/**
 * Wyvill metaball potential: (1 - D²)² inside the ellipsoid, 0 outside, where
 * D is the normalized ellipsoid distance. Sum of these over the field list is
 * what the iso surface wraps — blobs fuse where their fields overlap, which is
 * exactly the soft "plump" look primitives can't give.
 */
function makeField(fields: readonly OrganicField[]): (p: Vec3) => number {
  return (p) => {
    let sum = 0;
    for (const f of fields) {
      const dx = (p.x - f.pos[0]) / f.radii[0];
      const dy = (p.y - f.pos[1]) / f.radii[1];
      const dz = (p.z - f.pos[2]) / f.radii[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) {
        const t = 1 - d2;
        sum += t * t;
      }
    }
    return sum;
  };
}

/**
 * Field gradient via central differences — the glossy smooth-shading normals.
 *
 * NEGATED: the Wyvill potential DECREASES outward (max at each blob centre),
 * so the raw gradient points INTO the surface. Shipping it as the vertex
 * normal — and letting emitTriangle agree with it — rendered every organic
 * mesh inside-out (backface-culled/black-lit in Unity). The outward surface
 * normal is minus the gradient.
 */
function fieldNormal(field: (p: Vec3) => number, p: Vec3, h: number): Vec3 {
  const gx = field({ x: p.x + h, y: p.y, z: p.z }) - field({ x: p.x - h, y: p.y, z: p.z });
  const gy = field({ x: p.x, y: p.y + h, z: p.z }) - field({ x: p.x, y: p.y - h, z: p.z });
  const gz = field({ x: p.x, y: p.y, z: p.z + h }) - field({ x: p.x, y: p.y, z: p.z - h });
  return normalize({ x: -gx, y: -gy, z: -gz });
}

/**
 * Marching tetrahedra over the summed field. Chosen over classic marching
 * cubes on purpose: the 256-entry edge/tri tables are the whole of MC's bulk
 * and a typo there is a silent hole in the mesh — six tetrahedra per cube and
 * three tiny cases are auditable. Winding is settled empirically per triangle
 * against the field gradient, so orientation can never be table-wrong.
 */
function organicMesh(
  fields: readonly OrganicField[],
  iso: number,
  cellSize: number,
): Mesh {
  const field = makeField(fields);

  // Bounding box of all ellipsoids, padded so the surface can close.
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const f of fields) {
    const rMax = Math.max(f.radii[0], f.radii[1], f.radii[2]);
    for (const [axis, i] of [[f.pos[0], "x"], [f.pos[1], "y"], [f.pos[2], "z"]] as Array<[number, "x" | "y" | "z"]>) {
      min[i] = Math.min(min[i], axis - rMax * 1.4);
      max[i] = Math.max(max[i], axis + rMax * 1.4);
    }
  }
  const nx = Math.min(96, Math.max(4, Math.ceil((max.x - min.x) / cellSize)));
  const ny = Math.min(96, Math.max(4, Math.ceil((max.y - min.y) / cellSize)));
  const nz = Math.min(96, Math.max(4, Math.ceil((max.z - min.z) / cellSize)));
  const stepX = (max.x - min.x) / nx;
  const stepY = (max.y - min.y) / ny;
  const stepZ = (max.z - min.z) / nz;

  // Sample the field once per grid point (reuse across the 8 cubes it touches).
  const grid: number[][][] = [];
  for (let k = 0; k <= nz; k++) {
    const plane: number[][] = [];
    for (let j = 0; j <= ny; j++) {
      const row: number[] = [];
      for (let i = 0; i <= nx; i++) {
        row.push(field({ x: min.x + i * stepX, y: min.y + j * stepY, z: min.z + k * stepZ }));
      }
      plane.push(row);
    }
    grid.push(plane);
  }

  const mesh: Mesh = { vertices: [], normals: [], faces: [] };
  const weld = new Map<string, number>();

  const addVertex = (p: Vec3): number => {
    const key = `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
    const existing = weld.get(key);
    if (existing !== undefined) return existing;
    const index = mesh.vertices.length + 1; // OBJ is 1-indexed
    weld.set(key, index);
    mesh.vertices.push(p);
    mesh.normals.push(fieldNormal(field, p, Math.min(stepX, stepY, stepZ) * 0.5));
    return index;
  };

  const lerpOnEdge = (a: Vec3, va: number, b: Vec3, vb: number): Vec3 => {
    const t = (iso - va) / (vb - va);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };

  const emitTriangle = (ia: number, ib: number, ic: number): void => {
    const pa = mesh.vertices[ia - 1]!;
    const pb = mesh.vertices[ib - 1]!;
    const pc = mesh.vertices[ic - 1]!;
    // Orient against the field gradient at the centroid: outward, always.
    const ab = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
    const ac = { x: pc.x - pa.x, y: pc.y - pa.y, z: pc.z - pa.z };
    const cross = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x,
    };
    const centroid = { x: (pa.x + pb.x + pc.x) / 3, y: (pa.y + pb.y + pc.y) / 3, z: (pa.z + pb.z + pc.z) / 3 };
    const grad = fieldNormal(field, centroid, Math.min(stepX, stepY, stepZ) * 0.5);
    const dot = cross.x * grad.x + cross.y * grad.y + cross.z * grad.z;
    if (dot >= 0) mesh.faces.push([ia, ib, ic]);
    else mesh.faces.push([ia, ic, ib]);
  };

  // The six tetrahedra of a cube (corner indices 0..7, body diagonal 0→6).
  const TETS: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
  ];
  const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const pos: Vec3[] = [];
        const val: number[] = [];
        for (const [dx, dy, dz] of CORNERS) {
          pos.push({ x: min.x + (i + dx) * stepX, y: min.y + (j + dy) * stepY, z: min.z + (k + dz) * stepZ });
          val.push(grid[k + dz]![j + dy]![i + dx]!);
        }
        for (const tet of TETS) {
          const inside: number[] = [];
          const outside: number[] = [];
          for (const idx of tet) {
            (val[idx]! >= iso ? inside : outside).push(idx);
          }
          if (inside.length === 0 || inside.length === 4) continue;
          if (inside.length === 1 || inside.length === 3) {
            const one = inside.length === 1 ? inside[0]! : outside[0]!;
            const others = inside.length === 1 ? outside : inside;
            const p0 = lerpOnEdge(pos[one]!, val[one]!, pos[others[0]!]!, val[others[0]!]!);
            const p1 = lerpOnEdge(pos[one]!, val[one]!, pos[others[1]!]!, val[others[1]!]!);
            const p2 = lerpOnEdge(pos[one]!, val[one]!, pos[others[2]!]!, val[others[2]!]!);
            emitTriangle(addVertex(p0), addVertex(p1), addVertex(p2));
          } else {
            // Two inside, two outside: quad across the four crossing edges.
            const [i0, i1] = [inside[0]!, inside[1]!];
            const [o0, o1] = [outside[0]!, outside[1]!];
            const p0 = lerpOnEdge(pos[i0]!, val[i0]!, pos[o0]!, val[o0]!);
            const p1 = lerpOnEdge(pos[i0]!, val[i0]!, pos[o1]!, val[o1]!);
            const p2 = lerpOnEdge(pos[i1]!, val[i1]!, pos[o0]!, val[o0]!);
            const p3 = lerpOnEdge(pos[i1]!, val[i1]!, pos[o1]!, val[o1]!);
            emitTriangle(addVertex(p0), addVertex(p2), addVertex(p1));
            emitTriangle(addVertex(p1), addVertex(p2), addVertex(p3));
          }
        }
      }
    }
  }
  return mesh;
}

// =============================================================================
// OBJ WRITER
// =============================================================================

function toObj(mesh: Mesh, objectName: string): string {
  const lines: string[] = [`# generated by unity_generate_mesh`, `o ${objectName}`];
  for (const v of mesh.vertices) {
    lines.push(`v ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)}`);
  }
  for (const n of mesh.normals) {
    lines.push(`vn ${n.x.toFixed(4)} ${n.y.toFixed(4)} ${n.z.toFixed(4)}`);
  }
  lines.push("s 1");
  for (const face of mesh.faces) {
    lines.push(`f ${face.map((i) => `${i}//${i}`).join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

function modelMeta(guid: string): string {
  return `fileFormatVersion: 2
guid: ${guid}
ModelImporter:
  serializedVersion: 22200
  internalIDToNameTable: []
  externalObjects: {}
  materials:
    materialImport: 1
    materialName: 0
    materialSearch: 1
    materialLocation: 1
  animations:
    legacyGenerateAnimations: 4
    bakeSimulation: 0
    resampleCurves: 1
    optimizeGameObjects: 4
    removeConstantCurves: 0
    motionNodeName:
    animationImportErrors:
    animationImportWarnings:
    animationRetargetingWarnings:
    animationDoRetargetingWarnings: 0
    importAnimatedCustomProperties: 0
  importTangents: 0
  importWeights: 0
  globalScale: 1
  useFileScale: 0
  useFileUnits: 0
  meshCompression: 0
  isReadable: 0
  optimizeMeshPolygons: 1
  optimizeMeshVertices: 1
  weldVertices: 1
  indexFormat: 0
  addCollider: 0
  swapUVChannels: 0
  generateSecondaryUV: 0
`;
}

// =============================================================================
// TOOL
// =============================================================================

export class MeshGenerateTool implements ITool {
  readonly name = "unity_generate_mesh";
  readonly description =
    "Generate a placeholder-grade low-poly 3D mesh (OBJ + import .meta, no Editor needed) for a " +
    "game element that needs DIMENSION — a stage prop, a 'plump glossy' character body, a rounded " +
    "block. The GDD's two-layer style needs pixel sprites for puzzles (unity_generate_sprite) and " +
    "meshes for dimensional elements. Use when unity_my_assets_cloud has nothing the user already owns. " +
    "Compose characters in the prefab: a capsule body mesh + sphere head mesh as child objects.";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Element name the mesh is for, e.g. 'PigBody' or 'StageBlock'. Also the file name.",
      },
      path: {
        type: "string",
        description: "Project-relative output directory under Assets/ (default: Assets/Art/Generated/Meshes).",
      },
      shape: {
        type: "string",
        enum: MESH_SHAPES,
        description: "Silhouette: rounded-box (soft block), sphere, capsule (plump body), cylinder, cone.",
      },
      size: {
        type: "number",
        description: "Largest dimension in meters, 0.05–10 (default 1).",
      },
      roundness: {
        type: "number",
        description: "rounded-box only: 0 (sharp cube) to 1 (sphere). Default 0.4 — the soft pillow look.",
      },
      detail: {
        type: "number",
        description: "Tessellation hint (segments/subdivisions), 4–48. Default 16.",
      },
      fields: {
        type: "array",
        description:
          "organic only: the blobs of the build as ellipsoid fields, e.g. a pig = body + head + 2 ears + snout. " +
          "Each: {pos:[x,y,z], radii:[rx,ry,rz]} in meters. Overlapping fields fuse into one smooth surface.",
        items: {
          type: "object",
          properties: {
            pos: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
            radii: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          },
          required: ["pos", "radii"],
        },
      },
      iso: {
        type: "number",
        description: "organic only: iso-surface threshold 0.1–0.9 (default 0.5; higher = slimmer).",
      },
      provider: {
        type: "string",
        enum: ["procedural", "local"],
        description:
          "'procedural' = built-in analytic shapes + metaball organic (always works). 'local' = open-weights " +
          "image-to-3D on this machine (e.g. TripoSR; install via `strada assets-local-setup`).",
      },
      prompt: {
        type: "string",
        description:
          "local only: concept prompt for the 2D stage when no image is given — the tool generates a concept " +
          "image with the local 2D model, then lifts it to 3D.",
      },
      image: {
        type: "string",
        description:
          "local only: project-relative path to a source image to lift into 3D (skips the 2D stage).",
      },
      model: {
        type: "string",
        description: "local only: image-to-3d catalog id (triposr, ...). Default: smallest your device supports.",
      },
      model2d: {
        type: "string",
        description: "local only: text-to-image catalog id for the concept stage (sd15, sdxl, flux-schnell).",
      },
    },
    required: ["name", "shape"],
  };

  /**
   * The open-weights path: lift an image into 3D with a local image-to-3D
   * model (e.g. TripoSR). With no source image, a concept is drawn first by
   * the local 2D model — the free 2D→3D pipeline.
   */
  private async executeLocal(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const { LocalModelRunner } = await import("../../../assets-local/local-model-runner.js");
    const { defaultModelFor, supportedModels } = await import("../../../assets-local/model-catalog.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    // Explicit ids go through the DEVICE-GATED list: getModelSpec would hand
    // back a model this machine cannot run.
    const gatedSpec = (id: string, kind: "text-to-image" | "image-to-3d") =>
      supportedModels().find((m) => m.id === id && m.kind === kind);

    const rawName = String(input["name"] ?? "").trim();
    if (!/^[A-Za-z][\w-]{0,40}$/.test(rawName)) {
      return { content: "Error: name must start with a letter and contain only letters, digits, _ or -", isError: true };
    }
    const dirRel = String(input["path"] ?? "Assets/Art/Generated/Meshes");
    if (!/^Assets([/\\]|$)/i.test(dirRel.replace(/\\/g, "/")) && dirRel !== "Assets") {
      return { content: "Error: path must be under Assets/", isError: true };
    }

    const model3d = input["model"] !== undefined ? gatedSpec(String(input["model"]), "image-to-3d") : defaultModelFor("image-to-3d");
    if (!model3d) {
      return {
        content:
          "Error: no local image-to-3D model for this device. Run `strada assets-local-setup` to see " +
          "what your machine supports, or use provider 'procedural'.",
        isError: true,
      };
    }
    const runner = new LocalModelRunner();
    if (!runner.isModelInstalled(model3d.id)) {
      return {
        content: `Error: ${model3d.label} is not installed. Run \`strada assets-local-setup --model ${model3d.id}\` first.`,
        isError: true,
      };
    }

    // Resolve the source image: given, or drawn by the local 2D model.
    // Everything below can REJECT (spawn failure, the 20-minute inference
    // timeout killing the child) — a thrown error must come back as an
    // actionable isError, not escape the tool, and the scratch dir must go.
    let imageAbs: string;
    const scratch = mkdtempSync(join(tmpdir(), "mesh-local-"));
    try {
    if (input["image"] !== undefined) {
      const rel = String(input["image"]);
      const imgCheck = await validatePath(context.projectPath, rel);
      if (!imgCheck.valid) return { content: `Error: ${imgCheck.error ?? "image path invalid"}`, isError: true };
      imageAbs = imgCheck.fullPath;
    } else {
      const model2d = input["model2d"] !== undefined ? gatedSpec(String(input["model2d"]), "text-to-image") : defaultModelFor("text-to-image");
      if (!model2d || !runner.isModelInstalled(model2d.id)) {
        return {
          content:
            `Error: no image given and no local 2D model installed for the concept stage. Pass an image, or run ` +
            `\`strada assets-local-setup --model ${model2d?.id ?? "sd15"}\`.`,
          isError: true,
        };
      }
      const prompt =
        input["prompt"] !== undefined
          ? String(input["prompt"])
          : await (async () => {
              let family = "toon-casual";
              try {
                const { loadStyleProfile } = await import("../../style/style-profile.js");
                family = loadStyleProfile(context.projectPath)?.family ?? family;
              } catch {
                /* stock default */
              }
              const subject = rawName.replace(/([A-Z])/g, " $1").toLowerCase();
              if (family === "realistic") {
                return `${subject}, realistic game character, natural materials and proportions, single object centered on plain background, full body visible`;
              }
              return `${subject}, casual mobile game character, soft glossy 3d-look, single object centered on plain background, full body visible`;
            })();
      imageAbs = join(scratch, `${rawName}-concept.png`);
      const drawn = await runner.textToImage(model2d, prompt, imageAbs, {
        negative: "blurry, watermark, text, multiple objects, cropped",
        size: 512,
      });
      if (!drawn.ok) return { content: `Error: concept stage failed: ${drawn.detail}`, isError: true };
    }

    const relFile = `${dirRel.replace(/[/\\]+$/, "")}/${rawName}.obj`;
    const pathCheck = await validatePath(context.projectPath, relFile, { allowMissingParents: true });
    if (!pathCheck.valid) return { content: `Error: ${pathCheck.error ?? "path validation failed"}`, isError: true };
    mkdirSync(dirname(pathCheck.fullPath), { recursive: true });

    const lifted = await runner.imageToMesh(model3d, imageAbs, pathCheck.fullPath);
    if (!lifted.ok) return { content: `Error: image-to-3D failed: ${lifted.detail}`, isError: true };

    const guid = reuseOrMintGuid(`${pathCheck.fullPath}.meta`);
    writeFileSync(`${pathCheck.fullPath}.meta`, modelMeta(guid), "utf8");
    return {
      content:
        `Mesh written by local image-to-3D (${model3d.label}): ${relFile} (+ .meta). ` +
        "Unity imports it as a model on next refresh. Place it on a child of the element's prefab — an " +
        "unreferenced mesh draws nothing.",
    };
    } catch (err) {
      return {
        content:
          `Error: local mesh generation failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "Falls back available: provider 'procedural' needs no local model.",
        isError: true,
      };
    } finally {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // Scratch cleanup is best-effort.
      }
    }
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return { content: "Error: mesh generation is disabled in read-only mode", isError: true };
    }

    const provider = String(input["provider"] ?? "procedural");
    if (provider !== "procedural" && provider !== "local") {
      return { content: "Error: provider must be 'procedural' or 'local'", isError: true };
    }
    if (provider === "local") {
      return this.executeLocal(input, context);
    }

    const rawName = String(input["name"] ?? "").trim();
    if (!/^[A-Za-z][\w-]{0,40}$/.test(rawName)) {
      return {
        content: "Error: name must start with a letter and contain only letters, digits, _ or - (e.g. 'PigBody')",
        isError: true,
      };
    }

    const dirRel = String(input["path"] ?? "Assets/Art/Generated/Meshes");
    if (!/^Assets([/\\]|$)/i.test(dirRel.replace(/\\/g, "/")) && dirRel !== "Assets") {
      return { content: "Error: path must be under Assets/", isError: true };
    }

    const shape = String(input["shape"] ?? "");
    if (!(MESH_SHAPES as readonly string[]).includes(shape)) {
      return { content: `Error: shape must be one of ${MESH_SHAPES.join(", ")}`, isError: true };
    }

    const sizeRaw = Number(input["size"] ?? 1);
    const size = Number.isFinite(sizeRaw) ? Math.min(10, Math.max(0.05, sizeRaw)) : 1;
    const detailRaw = Number(input["detail"] ?? 16);
    const detail = Number.isFinite(detailRaw) ? Math.min(48, Math.max(4, Math.round(detailRaw))) : 16;
    const roundRaw = Number(input["roundness"] ?? 0.4);
    const roundness = Number.isFinite(roundRaw) ? Math.min(1, Math.max(0, roundRaw)) : 0.4;

    let mesh: Mesh;
    switch (shape as MeshShape) {
      case "rounded-box":
        mesh = roundedBox(size, Math.min(12, detail), roundness);
        break;
      case "sphere":
        mesh = sphere(size / 2, detail, Math.max(3, Math.round(detail * 0.75)));
        break;
      case "capsule":
        mesh = capsule(size * 0.35, size, detail, Math.max(2, Math.round(detail / 3)));
        break;
      case "cylinder":
        mesh = cylinder(size / 2, size, detail, true);
        break;
      case "cone":
        mesh = cone(size / 2, size, detail);
        break;
      case "organic": {
        const rawFields = input["fields"];
        if (!Array.isArray(rawFields) || rawFields.length === 0) {
          return {
            content:
              "Error: shape 'organic' needs fields — the blobs of the build, e.g. " +
              '[{"pos":[0,0.35,0],"radii":[0.3,0.28,0.22]}, {"pos":[0,0.72,0.05],"radii":[0.2,0.18,0.16]}]',
            isError: true,
          };
        }
        const fields: OrganicField[] = [];
        for (const f of rawFields as Array<Record<string, unknown>>) {
          const pos = Array.isArray(f["pos"]) ? (f["pos"] as unknown[]).map(Number) : [];
          const radii = Array.isArray(f["radii"]) ? (f["radii"] as unknown[]).map(Number) : [];
          if (
            pos.length !== 3 || radii.length !== 3 ||
            pos.some((v) => !Number.isFinite(v)) ||
            radii.some((v) => !Number.isFinite(v) || v <= 0)
          ) {
            return { content: "Error: each field needs pos:[x,y,z] and radii:[rx,ry,rz] (finite numbers, radii > 0)", isError: true };
          }
          if (radii.some((v) => v > 10)) {
            return { content: "Error: field radii must be ≤ 10 meters", isError: true };
          }
          fields.push({ pos: pos as [number, number, number], radii: radii as [number, number, number] });
        }
        if (fields.length > 24) {
          return { content: "Error: max 24 fields per organic mesh (compose in the prefab instead)", isError: true };
        }
        const isoRaw = Number(input["iso"] ?? 0.5);
        const iso = Number.isFinite(isoRaw) ? Math.min(0.9, Math.max(0.1, isoRaw)) : 0.5;
        // Cell size from the smallest radius present: fine enough to keep ears
        // and snouts, coarse enough to stay fast.
        const minRadius = Math.min(...fields.flatMap((f) => f.radii));
        const cellSize = Math.max(0.01, minRadius / 4);
        mesh = organicMesh(fields, iso, cellSize);
        if (mesh.vertices.length === 0) {
          return {
            content: "Error: no surface at this iso — the fields don't overlap enough. Lower iso (e.g. 0.3) or move the blobs closer.",
            isError: true,
          };
        }
        break;
      }
    }

    // The game's own style profile shapes the silhouette: `plump` squashes
    // X/Z outward and Y down — the "plump, glossy 3D-feel" the GDD asks for.
    // Explicit `plump` input wins; no profile = natural proportions.
    try {
      const { loadStyleProfile } = await import("../../style/style-profile.js");
      const plumpInput = Number(input["plump"]);
      const plump = Number.isFinite(plumpInput)
        ? Math.min(1.5, Math.max(0.5, plumpInput))
        : loadStyleProfile(context.projectPath)?.proportions.plump ?? 1.0;
      if (plump !== 1.0) {
        for (const v of mesh!.vertices) {
          v.x *= plump;
          v.z *= plump;
          v.y *= 2 - plump;
        }
        // Non-uniform scale transforms normals by the INVERSE-TRANSPOSE —
        // dividing each axis by its scale factor, then renormalizing. The old
        // loop only renormalized already-unit normals (a no-op), so plumped
        // meshes lit as though unsquashed.
        for (let i = 0; i < mesh!.normals.length; i++) {
          const n = mesh!.normals[i]!;
          mesh!.normals[i] = normalize({ x: n.x / plump, y: n.y / (2 - plump), z: n.z / plump });
        }
      }
    } catch {
      /* style application is best-effort */
    }

    const relFile = `${dirRel.replace(/[/\\]+$/, "")}/${rawName}.obj`;
    const pathCheck = await validatePath(context.projectPath, relFile, { allowMissingParents: true });
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error ?? "path validation failed"}`, isError: true };
    }

    try {
      // Reuse the existing guid on regeneration — a fresh guid orphans every
      // prefab/scene binding to the previous version of this mesh.
      const guid = reuseOrMintGuid(`${pathCheck.fullPath}.meta`);
      mkdirSync(dirname(pathCheck.fullPath), { recursive: true });
      writeFileSync(pathCheck.fullPath, toObj(mesh!, rawName), "utf8");
      writeFileSync(`${pathCheck.fullPath}.meta`, modelMeta(guid), "utf8");
      return {
        content:
          `Mesh written: ${relFile} (+ .meta, guid ${guid.slice(0, 8)}…, ${mesh!.vertices.length} verts, ` +
          `${mesh!.faces.length} tris). Unity imports it as a model on next refresh. Place it on a child of the ` +
          "element's prefab with a smooth/Lit material — an unreferenced mesh draws nothing.",
      };
    } catch (err) {
      return {
        content: `Error: mesh write failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
