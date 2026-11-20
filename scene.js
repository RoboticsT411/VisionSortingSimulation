// 3D station: platform, markers, cubes, the Niryo One with Gripper 1, and the station camera.
import * as THREE from 'three';
import * as ARM from './arm.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------------------------------------------------------------- geometry (metres, robot base frame)
// The lab board (Juan's measurements): 388 mm back to front, 259 mm across; the robot's right back
// suction cup 30 mm from the back and right edges. Holes A, B, C (25 x 25 mm, 5 mm deep) as in the
// Niryo One browser simulator. ArUco markers on 34 mm paper, flush with the board's corners at the
// front, 140 mm back from those (ID 0 to ID 3); 225 mm apart across, which is what the board allows.
const BOARD_X = [-0.128, 0.260], BOARD_Y = [-0.1425, 0.1165], PAPER = 0.034;
const MX1 = BOARD_X[1] - PAPER / 2, MX0 = MX1 - 0.140, MY0 = BOARD_Y[0] + PAPER / 2, MY1 = BOARD_Y[1] - PAPER / 2;
export const GEO = {
  sheet: { xmin: BOARD_X[0], xmax: BOARD_X[1], ymin: BOARD_Y[0], ymax: BOARD_Y[1] },
  markers: { 3: [MX0, MY0], 2: [MX0, MY1], 0: [MX1, MY0], 1: [MX1, MY1] },
  markerMm: 24, paperMm: PAPER * 1000,
  squares: { A: [0.2095, -0.063], B: [0.2095, -0.016], C: [0.2095, 0.031] },
  squareMm: 25, holeDepth: 0.005,
  circles: [],
  cube: 0.02,
  zone: { xmin: 0.132, xmax: 0.178, ymin: -0.098, ymax: 0.07 },   // where random cubes are placed (inside the pick zone)
  camera: { pos: [0.40, -0.02, 0.47], look: [0.173, -0.013, 0.0], fov: 30 },
};
const ARUCO = { 0: [[0,0,0,0,0,0],[0,1,0,1,1,0],[0,0,1,0,1,0],[0,0,0,1,1,0],[0,0,0,1,0,0],[0,0,0,0,0,0]],
  1: [[0,0,0,0,0,0],[0,0,0,0,0,0],[0,1,1,1,1,0],[0,1,0,0,1,0],[0,1,0,1,0,0],[0,0,0,0,0,0]],
  2: [[0,0,0,0,0,0],[0,0,0,1,1,0],[0,0,0,1,1,0],[0,0,0,1,0,0],[0,1,1,0,1,0],[0,0,0,0,0,0]],
  3: [[0,0,0,0,0,0],[0,1,0,0,1,0],[0,1,0,0,1,0],[0,0,1,0,0,0],[0,0,1,1,0,0],[0,0,0,0,0,0]] };
export const COLOURS = { red: '#d42f27', orange: '#f0812a', yellow: '#f3d23c', green: '#7f9c82',
  blue: '#3b6fd0', purple: '#8b5bb5', pink: '#f1a6b8', white: '#f1f0ea' };

// Niryo One: Niryo's joint chain and meshes (arm.js). Poses are those of tool_link, as on the real robot.
// Gripper 1: the grip point is 85 mm along the tool axis and 7.5 mm off it; fingers open to 27 mm.
const OPEN = ARM.OPEN_MAX, FINGER_T = ARM.FINGER.t, FINGER_W = ARM.FINGER.w;

let renderer, scene, userCam, controls, stationCam, target, previewCanvas, previewCtx;
let lights = {}, hand = null;
const arm = {};
export const robot = { joints: [0, 0.55, -1.2, 0, 0, 0], open: OPEN, held: null, connected: false,
  learning: false, heldUntil: 0, speed: 1, anim: null, problems: true, log: () => {} };
export const cubes = [];
let cubeId = 0;
const listeners = { change: [] };
export function on(ev, fn) { listeners[ev].push(fn); }
function changed(msg) { listeners.change.forEach(f => f(msg)); }

// ---------------------------------------------------------------- maths
const rx = a => [[1,0,0],[0,Math.cos(a),-Math.sin(a)],[0,Math.sin(a),Math.cos(a)]];
const ry = a => [[Math.cos(a),0,Math.sin(a)],[0,1,0],[-Math.sin(a),0,Math.cos(a)]];
const rz = a => [[Math.cos(a),-Math.sin(a),0],[Math.sin(a),Math.cos(a),0],[0,0,1]];
const mul = (A, B) => A.map((r, i) => [0,1,2].map(j => r[0]*B[0][j] + r[1]*B[1][j] + r[2]*B[2][j]));
const T = A => [[A[0][0],A[1][0],A[2][0]],[A[0][1],A[1][1],A[2][1]],[A[0][2],A[1][2],A[2][2]]];
const col = (A, j) => [A[0][j], A[1][j], A[2][j]];
const add = (a, b, s = 1) => [a[0] + s*b[0], a[1] + s*b[1], a[2] + s*b[2]];
export const rpyToMat = (r, p, y) => mul(rz(y), mul(ry(p), rx(r)));
export function matToRpy(R) {
  const p = Math.asin(Math.max(-1, Math.min(1, -R[2][0])));
  if (Math.abs(Math.cos(p)) > 1e-4) return [Math.atan2(R[2][1], R[2][2]), p, Math.atan2(R[1][0], R[0][0])];
  return [0, p, Math.atan2(-R[0][1], R[1][1])];
}
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

const toArr = M => { const e = M.elements; return [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]]; };
export function fk(j) {
  const M = ARM.fkTool(j), e = M.elements;
  return { P: [e[12], e[13], e[14]], R: toArr(M) };
}
export function ik(P, R, seed) { return ARM.ik(P, R, seed || robot.joints); }
export function currentPose() {
  const { P, R } = fk(robot.joints);
  return [P[0], P[1], P[2], ...matToRpy(R)];
}

// ---------------------------------------------------------------- textures
function platformTexture() {
  const s = GEO.sheet, k = 4000;              // pixels per metre (4 per mm)
  const W = Math.round((s.ymax - s.ymin) * k), H = Math.round((s.xmax - s.xmin) * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const P = (x, y) => [(y - s.ymin) * k, (x - s.xmin) * k];
  g.fillStyle = '#2a9fd8'; g.fillRect(0, 0, W, H);       // Niryo board blue
  // painted-board texture
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) { const n = (Math.random() - 0.5) * 8; img.data[i] += n; img.data[i+1] += n; img.data[i+2] += n; }
  g.putImageData(img, 0, 0);
  // holes A, B, C: the bench shows through; the walls are in shade
  for (const [name, [x, y]] of Object.entries(GEO.squares)) {
    const [cx, cy] = P(x, y), h = GEO.squareMm * 2;
    g.fillStyle = '#5d6a70'; g.fillRect(cx - h, cy - h, 2 * h, 2 * h);
    g.fillStyle = '#d9d9d4'; g.fillRect(cx - h + 6, cy - h + 6, 2 * h - 12, 2 * h - 12);
    g.fillStyle = '#123'; g.font = '64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const [lx, ly] = P(x + GEO.squareMm / 2000 + 0.010, y); g.save(); g.translate(lx, ly); g.fillText(name, 0, 0); g.restore();
  }
  // white label behind the holes, as on the lab boards
  { const sq = Object.values(GEO.squares), cy0 = sq.reduce((a, q) => a + q[1], 0) / sq.length;
    const [lx, ly] = P(Math.min(...sq.map(q => q[0])) - GEO.squareMm / 2000 - 0.016, cy0);
    g.fillStyle = '#fff'; g.fillRect(lx - 128, ly - 28, 256, 56); g.strokeStyle = '#c9c9c9'; g.lineWidth = 4; g.strokeRect(lx - 128, ly - 28, 256, 56);
    g.fillStyle = '#111'; g.font = 'bold 34px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('SIMULATOR', lx, ly + 2); }
  // ArUco markers on white paper
  for (const [id, [x, y]] of Object.entries(GEO.markers)) {
    const [cx, cy] = P(x, y), paper = GEO.paperMm * 2, cell = GEO.markerMm * 4 / 6;
    g.fillStyle = '#fbfbf6'; g.fillRect(cx - paper, cy - paper, 2 * paper, 2 * paper);
    const bits = ARUCO[id], half = GEO.markerMm * 2;
    for (let r = 0; r < 6; r++) for (let q = 0; q < 6; q++) {
      g.fillStyle = bits[r][q] ? '#fbfbf6' : '#111111';
      g.fillRect(cx - half + q * cell, cy - half + r * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
let foamTex = null;
function foam() {
  if (foamTex) return foamTex;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const im = g.createImageData(64, 64);
  for (let i = 0; i < im.data.length; i += 4) { const v = 215 + Math.random() * 40; im.data[i] = im.data[i+1] = im.data[i+2] = v; im.data[i+3] = 255; }
  g.putImageData(im, 0, 0); foamTex = new THREE.CanvasTexture(c); foamTex.colorSpace = THREE.SRGBColorSpace;
  return foamTex;
}

// ---------------------------------------------------------------- scene
export function initScene(container, preview) {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  scene = new THREE.Scene(); scene.background = new THREE.Color('#d9dde2');

  userCam = new THREE.PerspectiveCamera(45, 1, 0.01, 10); userCam.up.set(0, 0, 1);
  userCam.position.set(0.95, -0.62, 0.72);
  controls = new OrbitControls(userCam, renderer.domElement); controls.target.set(0.13, 0, 0.12); controls.update();

  const g = GEO.camera;
  stationCam = new THREE.PerspectiveCamera(g.fov, 16 / 9, 0.01, 5); stationCam.up.set(0, 0, 1);
  stationCam.position.set(...g.pos); stationCam.lookAt(...g.look);
  target = new THREE.WebGLRenderTarget(1280, 720, { colorSpace: THREE.SRGBColorSpace });

  // table, mat, platform
  const table = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2), new THREE.MeshStandardMaterial({ color: '#b9a98c', roughness: 0.9 }));
  table.position.set(0.2, 0, -0.0052); table.receiveShadow = true; scene.add(table);
    const s = GEO.sheet;
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(s.ymax - s.ymin, s.xmax - s.xmin),
    new THREE.MeshStandardMaterial({ map: platformTexture(), roughness: 0.85 }));
  sheet.rotation.z = Math.PI / 2; sheet.position.set((s.xmin + s.xmax) / 2, (s.ymin + s.ymax) / 2, 0);
  sheet.receiveShadow = true; scene.add(sheet);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(s.xmax - s.xmin, s.ymax - s.ymin, 0.0049), new THREE.MeshStandardMaterial({ color: '#2384b4', roughness: 0.8 }));
  edge.position.set((s.xmin + s.xmax) / 2, (s.ymin + s.ymax) / 2, -0.00255); edge.receiveShadow = true; edge.castShadow = true; scene.add(edge);
  // dark hole walls under the squares (cubes in a hole sit 5 mm lower)
  for (const [x, y] of Object.values(GEO.squares)) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.005), new THREE.MeshStandardMaterial({ color: '#5d6a70' }));
    box.position.set(x, y, -0.0026); scene.add(box);
  }
  setLighting('closed');
  buildArm();
  hand = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.075, 0.025), new THREE.MeshStandardMaterial({ color: '#d9a07a', roughness: 0.7 }));
  hand.position.set(0.27, -0.14, 0.09); hand.rotation.z = 0.5; hand.castShadow = true; hand.visible = false; scene.add(hand);

  previewCanvas = preview; previewCtx = preview.getContext('2d');
  const resize = () => { const w = container.clientWidth, h = container.clientHeight; renderer.setSize(w, h); userCam.aspect = w / h; userCam.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(container); resize();
  setupPointer(container);
  const loop = () => { stepAnim(); controls.update(); renderer.render(scene, userCam); requestAnimationFrame(loop); };
  loop();
  setInterval(drawPreview, 250);
}

export function setLighting(kind) {
  for (const l of Object.values(lights)) scene.remove(l);
  lights = {};
  if (kind === 'open') {          // blinds open: brighter, bluer daylight from the window side
    lights.h = new THREE.HemisphereLight('#e4eeff', '#5a5a5a', 2.2);
    lights.d = new THREE.DirectionalLight('#f2f6ff', 3.2); lights.d.position.set(-0.3, 0.9, 1.0);
  } else if (kind === 'lamp') {   // desk lamp: warm light from one side
    lights.h = new THREE.HemisphereLight('#fff1dc', '#3c3428', 0.7);
    lights.d = new THREE.SpotLight('#ffbf7a', 9, 2.0, 0.9, 0.5, 1.2); lights.d.position.set(0.32, -0.42, 0.42);
    lights.d.target.position.set(0.17, 0, 0); scene.add(lights.d.target);
  } else {                        // blinds closed: ceiling lights
    lights.h = new THREE.HemisphereLight('#ffffff', '#555555', 1.6);
    lights.d = new THREE.DirectionalLight('#fffaf0', 2.2); lights.d.position.set(0.35, -0.15, 1.0);
  }
  lights.d.castShadow = true; lights.d.shadow.mapSize.set(2048, 2048);
  if (lights.d.shadow.camera.isOrthographicCamera) Object.assign(lights.d.shadow.camera, { left: -0.4, right: 0.4, top: 0.4, bottom: -0.4 });
  lights.d.shadow.bias = -0.0005;
  scene.add(lights.h); scene.add(lights.d);
}
export function setHand(on) { hand.visible = on; }

// ---------------------------------------------------------------- arm
let drawArm = null;
function buildArm() { drawArm = ARM.buildArmMeshes(scene); updateArm(); }
function updateArm() {
  drawArm(robot.joints, robot.open);
  if (robot.held) placeHeld();
}
function toolFrame() {
  const k = fk(robot.joints);
  const a = col(k.R, 0), fz = col(k.R, 2);
  return { P: k.P, a, fy: col(k.R, 1), fz, G: add(add(k.P, a, ARM.GRIP[0]), fz, ARM.GRIP[2]), T: add(add(k.P, a, ARM.FINGER.tip), fz, ARM.FINGER.z) };
}
const fingerYaw = () => { const f = toolFrame(); return Math.atan2(f.fy[1], f.fy[0]); };

// ---------------------------------------------------------------- cubes
export function addCube(colour, x, y, yaw) {
  const c = { id: ++cubeId, colour, x, y, z: GEO.cube / 2, yaw: yaw || 0, tilt: 0, slot: null };
  const m = new THREE.Mesh(new THREE.BoxGeometry(GEO.cube, GEO.cube, GEO.cube),
    new THREE.MeshStandardMaterial({ color: COLOURS[colour] || colour, map: foam(), roughness: 0.95 }));
  m.castShadow = true; m.receiveShadow = true; m.userData.cube = c; c.mesh = m; scene.add(m);
  cubes.push(c); placeCube(c); return c;
}
function placeCube(c) { c.mesh.position.set(c.x, c.y, c.z); c.mesh.rotation.order = 'ZYX'; c.mesh.rotation.set(c.tilt, 0, c.yaw); }
function placeHeld() { const c = robot.held, f = toolFrame(); c.x = f.G[0]; c.y = f.G[1]; c.z = f.G[2]; c.yaw = fingerYaw() + c.heldYaw; c.tilt = 0; placeCube(c); }
export function removeCube(c) { scene.remove(c.mesh); cubes.splice(cubes.indexOf(c), 1); if (robot.held === c) robot.held = null; }
const angleErr = (a, b) => { let d = ((a - b) % (Math.PI / 2) + Math.PI / 2) % (Math.PI / 2); if (d > Math.PI / 4) d -= Math.PI / 2; return d; };
function freeSpot(margin) {
  const z = GEO.zone;
  for (let t = 0; t < 200; t++) {
    const x = z.xmin + Math.random() * (z.xmax - z.xmin), y = z.ymin + Math.random() * (z.ymax - z.ymin);
    if (GEO.circles.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < 0.026)) continue;          // not in a round hole
    if (Object.values(GEO.squares).some(([sx, sy]) => Math.hypot(sx - x, sy - y) < 0.04)) continue;  // away from A, B, C
    if (cubes.every(c => c.slot || Math.hypot(c.x - x, c.y - y) > (margin || 0.042))) return [x, y];
  }
  return null;
}
// Objects that are not cubes, about the size of one (for the "other" class): a ball, a bottle cap,
// a toy brick with studs, a roll of tape. Flat or thin things are ignored by the cube finder anyway.
export function addObjectRandom(kind) {
  const kinds = ['ball', 'cap', 'brick', 'tape'];
  kind = kind || kinds[Math.floor(Math.random() * kinds.length)];
  const p = freeSpot(0.04); if (!p) return null;
  const pick = a => a[Math.floor(Math.random() * a.length)];
  let obj, h;
  if (kind === 'ball') {
    obj = new THREE.Mesh(new THREE.SphereGeometry(0.011, 24, 16), new THREE.MeshStandardMaterial({ color: pick(['#e8e3d4', '#e04a3a', '#3d8f4a', '#2a63c4']), roughness: 0.6 })); h = 0.011;
  } else if (kind === 'cap') {
    obj = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 32), new THREE.MeshStandardMaterial({ color: pick(['#f2f2f2', '#d8342c', '#1f5fae', '#f0c419']), roughness: 0.5 })); h = 0.006;
  } else if (kind === 'brick') {
    obj = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: pick(['#d8342c', '#f0c419', '#2a63c4', '#2f9e44', '#f2f2f2']), roughness: 0.35 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.016, 0.0115), m); obj.add(body);
    for (const dx of [-0.012, -0.004, 0.004, 0.012]) { const st = new THREE.Mesh(new THREE.CylinderGeometry(0.0024, 0.0024, 0.0018, 12), m); st.rotation.x = Math.PI / 2; st.position.set(dx, 0, 0.0066); obj.add(st); }
    h = 0.00575;
  } else {
    obj = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0065, 12, 32), new THREE.MeshStandardMaterial({ color: '#c9a46a', roughness: 0.8 })); h = 0.0065;
  }
  obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const c = { id: ++cubeId, colour: kind, shape: kind, x: p[0], y: p[1], z: h, yaw: Math.random() * Math.PI, tilt: kind === 'cap' ? Math.PI / 2 : 0, slot: null, mesh: obj };
  obj.userData.cube = c; obj.traverse(o => o.userData.cube = c); scene.add(obj); cubes.push(c); placeCube(c);
  return c;
}
// grip point (x, y) seen from above, tool_link at height z, fingers pointing down
function toolForGrip(x, y, z, R) { const o = add(col(R, 0), col(R, 2), ARM.GRIP[2] / ARM.GRIP[0]); return [x - ARM.GRIP[0] * o[0], y - ARM.GRIP[0] * o[1], z]; }
export function placeGripper(x, y, z, yaw) {
  const R = rpyToMat(0, Math.PI / 2, yaw || 0);
  const j = ik(toolForGrip(x, y, z, R), R); if (j) { robot.joints = j; updateArm(); } return !!j;
}
export function project(x, y, z) {
  const v = new THREE.Vector3(x, y, z || 0).project(stationCam);
  return [(v.x + 1) / 2 * target.width, (1 - v.y) / 2 * target.height];
}
export function addCubeRandom(colour) { const p = freeSpot(); if (!p) return null; return addCube(colour, p[0], p[1], (Math.random() - 0.5) * Math.PI / 2); }
export function randomScene(n, colours) {
  clearZone(); for (let i = 0; i < n; i++) addCubeRandom(colours[Math.floor(Math.random() * colours.length)]);
}
export function clearZone() { for (const c of cubes.filter(c => !c.slot && c !== robot.held)) removeCube(c); }
export function emptySquares() { for (const c of cubes.filter(c => c.slot)) removeCube(c); }
function stackCount(sq) { return cubes.filter(c => c.slot && c.slot.sq === sq).length; }

// ---------------------------------------------------------------- robot motion
const sleep = ms => new Promise(r => setTimeout(r, ms));
function stepAnim() {
  const a = robot.anim; if (!a) return;
  const t = Math.min(1, (performance.now() - a.t0) / a.dur);
  const s = t * t * (3 - 2 * t);
  robot.joints = a.joint ? a.from.map((v, i) => v + (a.to[i] - v) * s) : (a.path(s) || robot.joints);
  if (a.check) a.check();
  updateArm();
  if (t >= 1) { robot.anim = null; a.done(); }
}
function animate(spec) {
  // rAF stops when the tab is hidden: a timer finishes the move anyway, so Python never waits for ever.
  return new Promise(done => { const a = { ...spec, t0: performance.now(), done }; robot.anim = a;
    setTimeout(() => { if (robot.anim === a) { a.t0 = -1e9; stepAnim(); } }, spec.dur + 60); });
}

async function movePose(target) {
  const [x, y, z, r, p, yw] = target;
  const R1 = rpyToMat(r, p, yw), P1 = [x, y, z];
  const j1 = ik(P1, R1); if (!j1) return { ok: false, data: 'Goal has been rejected : no inverse kinematics solution (position out of reach)' };
  const k0 = fk(robot.joints);
  const q0 = new THREE.Quaternion().setFromRotationMatrix(m4(k0.R)), q1 = new THREE.Quaternion().setFromRotationMatrix(m4(R1));
  const dist = Math.hypot(x - k0.P[0], y - k0.P[1], z - k0.P[2]);
  const turn = q0.angleTo(q1);
  const dur = Math.max(350, 1000 * Math.max(dist / 0.12, turn / 1.4)) / robot.speed;
  const hit = new Set();
  await animate({ dur, path: s => {
      const q = q0.clone().slerp(q1, s), m = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
      const R = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
      return ik([k0.P[0] + (x - k0.P[0]) * s, k0.P[1] + (y - k0.P[1]) * s, k0.P[2] + (z - k0.P[2]) * s], R);
    }, check: () => fingerCollisions(hit) });
  robot.joints = j1; updateArm();
  return { ok: true, data: null };
}
const m4 = R => new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1);

async function moveJoints(j) {
  const d = Math.max(...j.map((v, i) => Math.abs(v - robot.joints[i])));
  await animate({ joint: true, from: robot.joints.slice(), to: j.slice(), dur: Math.max(300, 1000 * d / 1.2) / robot.speed, check: () => fingerCollisions(new Set()) });
  return { ok: true, data: null };
}

// A finger coming down on a cube. Foam and the finger's rounded edge forgive a small overlap
// (up to 2 mm): the cube is nudged into the gap. More than that and the finger lands on top and pushes it.
function fingerCollisions(hit) {
  const f = toolFrame();
  const goingDown = robot.lastTz === undefined || f.T[2] < robot.lastTz - 1e-5; robot.lastTz = f.T[2];
  if (!goingDown) return;                                                            // only a finger coming down lands on a cube
  const hy = [f.fy[0], f.fy[1]], hl = Math.hypot(...hy); if (hl < 0.5) return;     // fingers not pointing down
  const ey = [hy[0] / hl, hy[1] / hl], ez = [-ey[1], ey[0]];
  for (const c of cubes) {
    if (c === robot.held || c.slot || c.shape || hit.has(c.id)) continue;
    if (f.T[2] > c.z + GEO.cube / 2 - 0.002 || f.T[2] < c.z - GEO.cube / 2) continue;
    // cube corners in the fingers' frame (y across the gap, z along the finger width), centred on the fingertips
    const h = GEO.cube / 2, co = Math.cos(c.yaw), si = Math.sin(c.yaw);
    const pts = [[h, h], [h, -h], [-h, h], [-h, -h]].map(([u, v]) => {
      const x = c.x + u * co - v * si - f.T[0], y = c.y + u * si + v * co - f.T[1];
      return [x * ey[0] + y * ey[1], x * ez[0] + y * ez[1]];
    });
    const zmin = Math.min(...pts.map(p => p[1])), zmax = Math.max(...pts.map(p => p[1]));
    if (zmax < -FINGER_W / 2 || zmin > FINGER_W / 2) continue;
    const gap = robot.open / 2;
    const ymax = Math.max(...pts.map(p => p[0])), ymin = Math.min(...pts.map(p => p[0]));
    const over = Math.max(ymax - gap, -gap - ymin);
    if (over <= 0 || ymin > gap + FINGER_T || ymax < -gap - FINGER_T) continue;
    hit.add(c.id); robot.debug = { over, yaw: c.yaw, fyaw: Math.atan2(ey[1], ey[0]), dG: [c.x - f.G[0], c.y - f.G[1]] };
    if (over <= 0.002) {
      const s = ymax - gap > 0 ? -over : over;
      c.x += s * ey[0]; c.y += s * ey[1]; placeCube(c); continue;
    }
    const away = Math.atan2(c.y - f.G[1], c.x - f.G[0]);
    c.x += 0.007 * Math.cos(away); c.y += 0.007 * Math.sin(away); c.yaw += 0.35 * (Math.random() < 0.5 ? 1 : -1);
    placeCube(c); changed(`A finger landed on the ${c.colour} cube and pushed it.` + (robot.debugOn ? ' ' + JSON.stringify(robot.debug) : ''));
    return;
  }
}

async function gripper(open) {
  const f = toolFrame();
  if (open) {
    const c = robot.held; robot.held = null;
    await animate({ joint: true, from: robot.joints, to: robot.joints, dur: 350 / robot.speed, check: () => { robot.open = Math.min(OPEN, robot.open + 0.004); } });
    robot.open = OPEN; updateArm();
    if (c) drop(c);
    return { ok: true };
  }
  // closing: is a cube between the fingers, centred and square to them?
  let best = null;
  for (const c of cubes) {
    if (c.shape) continue;                                               // only cubes can be gripped
    if (c.slot && stackCount(c.slot.sq) !== c.slot.level) continue;     // only the top of a stack
    const dxy = Math.hypot(c.x - f.G[0], c.y - f.G[1]), dz = Math.abs(c.z - f.G[2]);
    if (dxy < 0.016 && dz < 0.012 && (!best || dxy < best.dxy)) best = { c, dxy, dz };
  }
  let width = 0.006, msg = null;
  if (best) {
    // Closing fingers slide the cube to the middle of the gap, so an offset across the gap is fine.
    // Along the fingers' width (21.5 mm wide, cube 20 mm) the cube must be within 8 mm, and turned
    // no more than 12 degrees to the fingers, or it twists out as they close.
    const { c } = best, err = angleErr(c.yaw, fingerYaw());
    const hl = Math.hypot(f.fy[0], f.fy[1]) || 1, ey = [f.fy[0] / hl, f.fy[1] / hl];
    const dx = c.x - f.G[0], dy = c.y - f.G[1], along = dx * ey[0] + dy * ey[1], across = -dx * ey[1] + dy * ey[0];
    if (Math.abs(across) <= 0.008 && Math.abs(along) <= 0.008 && Math.abs(err) <= 12 * Math.PI / 180 && best.dz <= 0.008) {
      robot.held = c; c.slot = null; c.heldYaw = c.yaw - fingerYaw() - err; width = GEO.cube;
      c.x -= along * ey[0]; c.y -= along * ey[1];
      msg = `Gripped the ${c.colour} cube` + (Math.abs(across) > 0.004 ? ` (${Math.round(Math.abs(across) * 1000)} mm off the middle of the fingers).` : '.');
    } else {
      // squeezed but not held: the fingers push it into line and it slips out
      c.yaw -= err; c.x -= along * ey[0]; c.y -= along * ey[1];
      if (!c.slot) c.z = GEO.cube / 2;
      placeCube(c);
      msg = Math.abs(err) > 12 * Math.PI / 180 ? `The ${c.colour} cube was turned ${Math.round(Math.abs(err) * 180 / Math.PI)}° to the fingers: it slipped out.`
        : best.dz > 0.008 ? `The fingers closed ${Math.round(best.dz * 1000)} mm ${c.z < f.G[2] ? 'above' : 'below'} the middle of the ${c.colour} cube: it slipped out.`
        : `The ${c.colour} cube was ${Math.round(Math.hypot(along, across) * 1000)} mm off the middle of the fingers: it slipped out.`;
    }
  }
  const w0 = robot.open;
  await animate({ joint: true, from: robot.joints, to: robot.joints, dur: 450 / robot.speed, check: () => { robot.open = Math.max(width, robot.open - 0.004); } });
  robot.open = width; updateArm();
  if (msg) changed(msg);
  return { ok: true };
}

function drop(c) {
  // which square is under it?
  let where = null;
  for (const [sq, [x, y]] of Object.entries(GEO.squares)) {
    const d = Math.hypot(c.x - x, c.y - y); if (d < 0.02 && (!where || d < where.d)) where = { sq, x, y, d };
  }
  const yawErr = Math.abs(angleErr(c.yaw, 0));
  if (where) {
    const level = stackCount(where.sq) + 1;
    const fits = level === 1 ? where.d <= 0.004 && yawErr <= 16 * Math.PI / 180 : where.d <= 0.008;
    if (fits && level <= 3) {
      c.slot = { sq: where.sq, level };
      if (level === 1) { c.x = where.x; c.y = where.y; c.yaw = 0; }
      c.z = -GEO.holeDepth + GEO.cube / 2 + (level - 1) * GEO.cube; c.tilt = 0; placeCube(c);
      changed(`The ${c.colour} cube is on square ${where.sq}, level ${level}.`);
      return;
    }
    if (level === 1 && where.d <= 0.012) {     // on the rim of the hole, tilted
      c.z = GEO.cube / 2 + 0.002; c.tilt = 0.35; placeCube(c);
      changed(`The ${c.colour} cube landed on the rim of square ${where.sq} (${yawErr > 16 * Math.PI / 180 ? 'turned' : 'off centre'}).`);
      return;
    }
    if (level > 1) {                           // fell off the stack
      const away = Math.atan2(c.y - where.y, c.x - where.x) || 0;
      c.x = where.x + 0.03 * Math.cos(away) - 0.02; c.y = where.y + 0.03 * Math.sin(away); c.z = GEO.cube / 2; c.tilt = 0;
      placeCube(c); changed(`The ${c.colour} cube fell off the stack on ${where.sq}.`); return;
    }
  }
  c.z = GEO.cube / 2; c.tilt = 0;
  for (const o of cubes) if (o !== c && Math.hypot(o.x - c.x, o.y - c.y) < GEO.cube) { c.x += 0.022; }
  placeCube(c); changed(`The ${c.colour} cube was put down on the platform.`);
}

export async function robotCommand(cmd, args) {
  const ok = { ok: true, data: null };
  if (cmd === 'connect') {
    if (robot.connected) return { ok: false, data: 'the robot is already connected to another program' };
    if (performance.now() < robot.heldUntil) return { ok: false, data: 'the robot still holds the connection of a program that was stopped without closing it' };
    robot.connected = true; changed('Robot connected.'); return ok;
  }
  if (cmd === 'quit') { robot.connected = false; return ok; }
  if (!robot.connected) return { ok: false, data: 'not connected' };
  switch (cmd) {
    case 'calibrate': await sleep(600 / robot.speed); return ok;
    case 'change_tool': case 'set_arm_max_velocity': return ok;
    case 'open_gripper': return gripper(true);
    case 'close_gripper': return gripper(false);
    case 'move_pose': {
      const names = ['rot.x (roll)', 'rot.y (pitch)', 'rot.z (yaw)'];
      for (let i = 3; i < 6; i++) if (Math.abs(args[i]) > Math.PI + 1e-6)
        return { ok: false, data: `Goal has been rejected : ${names[i - 3]} not in range ( -3.14159 , 3.14159 )` };
      robot.learning = false; return movePose(args);
    }
    case 'shift_pose': { const p = currentPose(); p[args[0]] += args[1]; return movePose(p); }
    case 'move_joints': robot.learning = false; return moveJoints(args);
    case 'get_pose': return { ok: true, data: currentPose() };
    case 'get_joints': return { ok: true, data: robot.joints.slice() };
    case 'get_learning_mode': return { ok: true, data: robot.learning };
    case 'set_learning_mode': robot.learning = !!args[0]; changed(robot.learning ? 'Learning mode ON: drag on the platform to move the gripper; arrow keys, PgUp/PgDn and [ ] fine-tune.' : 'Learning mode OFF.'); return ok;
  }
  return { ok: false, data: 'unknown command ' + cmd };
}
export function programEnded() {
  if (robot.connected) {
    robot.connected = false;
    if (robot.problems) { robot.heldUntil = performance.now() + 15000; changed('The program ended without closing its robot connection: the robot holds it for 15 s, as a real one does.'); }
  }
  robot.anim = null;
}

// ---------------------------------------------------------------- learning mode: move the gripper by hand
export function jog(dx, dy, dz, dyaw) {
  const p = currentPose(), R = mul(rz(dyaw || 0), rpyToMat(p[3], p[4], p[5]));
  const j = ik([p[0] + dx, p[1] + dy, p[2] + dz], R); if (j) { robot.joints = j; updateArm(); }
}
function moveGripperTo(x, y) {
  const p = currentPose(), R = rpyToMat(0, Math.PI / 2, matToRpy(rpyToMat(p[3], p[4], p[5]))[2] || 0);
  const k = fk(robot.joints), down = rpyToMat(p[3], p[4], p[5]);
  const tilt = Math.acos(Math.max(-1, Math.min(1, -col(down, 0)[2])));
  const Rg = tilt < 0.2 ? down : R;
  const j = ik(toolForGrip(x, y, Math.max(p[2], 0.1), Rg), Rg); if (j) { robot.joints = j; updateArm(); }
}

// ---------------------------------------------------------------- mouse in the 3D view
function setupPointer(el) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  let drag = null;
  const pick = e => { const r = el.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, userCam); };
  const onPlane = (z = 0) => { plane.constant = -z; const p = new THREE.Vector3(); return ray.ray.intersectPlane(plane, p) ? p : null; };
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; pick(e);
    if (robot.learning) { const p = onPlane(); if (p) { drag = { kind: 'arm' }; controls.enabled = false; moveGripperTo(p.x, p.y); } return; }
    const hits = ray.intersectObjects(cubes.filter(c => !c.slot && c !== robot.held).map(c => c.mesh), true);
    if (hits.length) { const c = hits[0].object.userData.cube; drag = { kind: 'cube', c }; controls.enabled = false; }
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return; pick(e); const p = onPlane(drag.kind === 'cube' ? 0.01 : 0); if (!p) return;
    if (drag.kind === 'arm') moveGripperTo(p.x, p.y);
    else { drag.c.x = p.x; drag.c.y = p.y; if (!drag.c.shape) { drag.c.z = GEO.cube / 2; drag.c.tilt = 0; } placeCube(drag.c); }
  });
  window.addEventListener('pointerup', () => { drag = null; controls.enabled = true; });
  el.addEventListener('wheel', e => {
    pick(e); const hits = ray.intersectObjects(cubes.filter(c => !c.slot).map(c => c.mesh));
    if (hits.length && e.shiftKey === false && e.altKey === false) {
      const c = hits[0].object.userData.cube; c.yaw += (e.deltaY > 0 ? 1 : -1) * 5 * Math.PI / 180; placeCube(c);
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, { capture: true, passive: false });
  el.addEventListener('dblclick', e => { pick(e); const hits = ray.intersectObjects(cubes.filter(c => !c.slot).map(c => c.mesh)); if (hits.length) removeCube(hits[0].object.userData.cube); });
  el.tabIndex = 0;
  el.addEventListener('keydown', e => {
    if (!robot.learning) return; const s = e.shiftKey ? 0.005 : 0.001, map = { ArrowUp: [-s, 0, 0], ArrowDown: [s, 0, 0], ArrowLeft: [0, -s, 0], ArrowRight: [0, s, 0], PageUp: [0, 0, s], PageDown: [0, 0, -s] };
    if (map[e.key]) { jog(...map[e.key], 0); e.preventDefault(); }
    if (e.key === '[') jog(0, 0, 0, 2 * Math.PI / 180); if (e.key === ']') jog(0, 0, 0, -2 * Math.PI / 180);
  });
}

// ---------------------------------------------------------------- station camera
export function renderCameraFrame(w, h) {
  if (target.width !== w || target.height !== h) target.setSize(w, h);
  renderer.setRenderTarget(target); renderer.render(scene, stationCam); renderer.setRenderTarget(null);
  const buf = new Uint8Array(w * h * 4); renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
  return buf;
}
export let previewPaused = false;
export function pausePreview(on) { previewPaused = on; }
function drawPreview() {
  if (previewPaused || !previewCanvas || previewCanvas.offsetParent === null) return;
  const w = 320, h = 180, buf = renderCameraFrame(w, h), img = previewCtx.createImageData(w, h);
  for (let r = 0; r < h; r++) img.data.set(buf.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
  previewCtx.putImageData(img, 0, 0);
}
export function stationCameraPosition() { return GEO.camera.pos; }
