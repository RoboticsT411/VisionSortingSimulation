// Niryo One arm: Niryo's joint chain (niryo_one_ros, as in the lab's Niryo One browser simulator),
// numerical inverse kinematics, and the link and Gripper 1 meshes.
// Kinematics and meshes: github.com/NiryoRobotics/niryo_one_ros and niryo_one (GPLv3).
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { LINK_VISUALS } from './lib/niryo/visual_meshes.js';
import { GRIPPER_VISUALS } from './lib/niryo/gripper_meshes.js';

const H = Math.PI / 2;
// [name, position in parent, euler (extrinsic XYZ), joint limits]
export const CHAIN = [
  ['shoulder_link', [0, 0, 0.103], [0, 0, 0], [-3.05433, 3.05433]],
  ['arm_link', [0, 0, 0.080], [H, -H, 0], [-1.5708, 0.640187]],
  ['elbow_link', [0.210, 0, 0], [0, 0, -H], [-1.397485, 1.5707963]],
  ['forearm_link', [0.0415, 0.030, 0], [0, H, 0], [-3.05433, 3.05433]],
  ['wrist_link', [0, 0, 0.180], [0, -H, 0], [-1.74533, 1.91986]],
  ['hand_link', [0.0164, -0.0055, 0], [0, H, 0], [-2.57436, 2.57436]],
];
const TOOL = { pos: [0, 0, 0.0073], euler: [-H, -H, 0] };
export const GRIP = [0.085, 0, -0.0075];     // grip point in the tool_link frame (Gripper 1)
export const FINGER = { tip: 0.0868, z: -0.00755, t: 0.006, w: 0.0215 };   // Gripper 1 fingers: tip along x, centre below the axis, thickness, width
export const OPEN_MAX = 0.027;

const fixed = (pos, e) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(e[0], e[1], e[2], 'ZYX')).setPosition(...pos);
const LINK_FIXED = CHAIN.map(c => fixed(c[1], c[2]));
const TOOL_FIXED = fixed(TOOL.pos, TOOL.euler);
const rz = q => new THREE.Matrix4().makeRotationZ(q);

export function fkAll(j) {
  const mats = []; let M = new THREE.Matrix4();
  for (let i = 0; i < 6; i++) { M = M.clone().multiply(LINK_FIXED[i]).multiply(rz(j[i])); mats.push(M); }
  return { links: mats, tool: M.clone().multiply(TOOL_FIXED) };
}
export const fkTool = j => fkAll(j).tool;

// pose error (position, rotation vector) of tool matrix A towards target (p, R as Matrix4)
function poseError(A, p, Rt) {
  const pa = new THREE.Vector3().setFromMatrixPosition(A);
  const e = new THREE.Vector3(...p).sub(pa);
  const Ra = new THREE.Matrix4().extractRotation(A);
  const dR = Rt.clone().multiply(Ra.clone().transpose());
  const q = new THREE.Quaternion().setFromRotationMatrix(dR);
  if (q.w < 0) { q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; }
  const s = Math.sqrt(1 - Math.min(1, q.w * q.w)), ang = 2 * Math.acos(Math.min(1, q.w));
  const w = s < 1e-9 ? [0, 0, 0] : [q.x / s * ang, q.y / s * ang, q.z / s * ang];
  return [e.x, e.y, e.z, ...w];
}
function solve6(A, b) {     // Gaussian elimination
  const n = 6, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]]; if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// Damped least squares from a starting guess; returns joints or null if the pose cannot be reached.
export function ik(p, R3, seed) {
  const Rt = new THREE.Matrix4().set(R3[0][0], R3[0][1], R3[0][2], 0, R3[1][0], R3[1][1], R3[1][2], 0, R3[2][0], R3[2][1], R3[2][2], 0, 0, 0, 0, 1);
  const seeds = [seed, [0, 0.3, -0.6, 0, -1.2, 0], [Math.atan2(p[1], p[0]), 0, 0, 0, -H, 0], [0, -0.5, 0.5, 0, -H, 0]];
  for (const s0 of seeds) {
    if (!s0) continue;
    let j = s0.slice();
    for (let it = 0; it < 200; it++) {
      const e = poseError(fkTool(j), p, Rt);
      const err = Math.hypot(e[0], e[1], e[2]), rerr = Math.hypot(e[3], e[4], e[5]);
      if (err < 2e-5 && rerr < 2e-4) return j.map(wrapLimit);
      const Jm = [[], [], [], [], [], []], d = 1e-6;
      for (let k = 0; k < 6; k++) {
        const jj = j.slice(); jj[k] += d; const e2 = poseError(fkTool(jj), p, Rt);
        for (let r = 0; r < 6; r++) Jm[r][k] = (e[r] - e2[r]) / d;
      }
      const lambda = 1e-4, JtJ = [...Array(6)].map((_, a) => [...Array(6)].map((_, b) => Jm.reduce((s, row) => s + row[a] * row[b], 0) + (a === b ? lambda : 0)));
      const Jte = [...Array(6)].map((_, a) => Jm.reduce((s, row, r) => s + row[a] * e[r], 0));
      const dq = solve6(JtJ, Jte); if (!dq) break;
      const scale = Math.min(1, 0.4 / Math.max(...dq.map(Math.abs)));
      j = j.map((v, k) => clampJ(k, v + dq[k] * scale));
    }
  }
  return null;
}
const wrapLimit = v => v;
function clampJ(k, v) { const [lo, hi] = CHAIN[k][3]; return Math.max(lo, Math.min(hi, v)); }

// ---------------------------------------------------------------- meshes
export function buildArmMeshes(scene) {
  const b64 = (s, Type) => { const u = Uint8Array.from(atob(s), c => c.charCodeAt(0)); return new Type(u.buffer); };
  const groups = {};
  const make = parts => {
    const g = new THREE.Group(); g.matrixAutoUpdate = false;
    for (const part of parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b64(part.p, Float32Array), 3));
      geo.setIndex(new THREE.BufferAttribute(b64(part.i, part.w === 2 ? Uint16Array : Uint32Array), 1));
      const color = new THREE.Color(part.c[0] / 255, part.c[1] / 255, part.c[2] / 255).convertSRGBToLinear();
      const m = new THREE.Mesh(toCreasedNormals(geo, Math.PI / 6), new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide }));
      m.castShadow = true; m.receiveShadow = true; g.add(m);
    }
    scene.add(g); return g;
  };
  for (const [name, parts] of Object.entries(LINK_VISUALS)) groups[name] = make(parts);
  for (const [name, parts] of Object.entries(GRIPPER_VISUALS)) groups[name] = make(parts);
  groups.base_link.matrix.identity();
  return (j, opening) => {
    const k = fkAll(j);
    CHAIN.forEach((c, i) => { if (groups[c[0]]) { groups[c[0]].matrix.copy(k.links[i]); groups[c[0]].matrixWorldNeedsUpdate = true; } });
    const q = Math.max(0, Math.min(OPEN_MAX, opening)) / 2;
    const set = (name, dy) => { const g = groups[name]; if (!g) return; g.matrix.copy(k.tool).multiply(new THREE.Matrix4().makeTranslation(0, dy, 0)); g.matrixWorldNeedsUpdate = true; };
    set('g1_base', 0); set('g1_finger_left', q); set('g1_finger_right', -q);
  };
}
