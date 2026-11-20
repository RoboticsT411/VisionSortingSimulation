import * as S from './scene.js';
import * as UI from './ui.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const LOCAL = ['127.0.0.1', 'localhost'].includes(location.hostname);
// Python comes from the jsDelivr CDN, or from a local vendor/pyodide/ copy when testing on this PC
const PYODIDE_URL = LOCAL && !params.has('cdn') && await fetch('vendor/pyodide/pyodide.js', { method: 'HEAD' }).then(r => r.ok, () => false)
  ? new URL('vendor/pyodide/', location.href).href : 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const PACKAGE = params.get('pkg') || 'student';

// ---------------------------------------------------------------- shared memory with the worker
const sabCtrl = new SharedArrayBuffer(64 * 4), sabData = new SharedArrayBuffer(16 << 20),
  sabEvt = new SharedArrayBuffer(1 << 20), sabIntr = new SharedArrayBuffer(4);
const ctrl = new Int32Array(sabCtrl), data = new Uint8Array(sabData), evt = new Uint8Array(sabEvt), intr = new Int32Array(sabIntr);
const enc = new TextEncoder(), dec = new TextDecoder();
function sendEvent(obj) {
  const b = enc.encode(JSON.stringify(obj) + '\n'), w = Atomics.load(ctrl, 2), N = evt.length;
  for (let i = 0; i < b.length; i++) evt[(w + i) % N] = b[i];
  Atomics.store(ctrl, 2, w + b.length); Atomics.notify(ctrl, 2);
}
let pendingReply = false;
function reply(bytes) {
  data.set(bytes); Atomics.store(ctrl, 1, bytes.length); Atomics.store(ctrl, 0, 1); Atomics.notify(ctrl, 0); pendingReply = false;
}
const replyJSON = o => reply(enc.encode(JSON.stringify(o)));

// ---------------------------------------------------------------- terminal
const term = $('term');
function out(text, cls) {
  const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; term.appendChild(s);
  while (term.childNodes.length > 4000) term.removeChild(term.firstChild);
  term.scrollTop = term.scrollHeight;
}
window.__out = () => term.textContent;
let inputResolve = null;
$('terminput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && inputResolve) { const v = e.target.value; e.target.value = ''; out(v + '\n', 'echo'); const r = inputResolve; inputResolve = null; $('inputrow').classList.remove('active'); r(v); }
});
function askInput(prompt) {
  if (prompt) out(prompt);
  $('inputrow').classList.add('active'); $('terminput').focus(); showTab('terminal');
  return new Promise(r => inputResolve = r);
}

// ---------------------------------------------------------------- worker
let worker, ready = false, running = null, fileReq = 0;
const fileWaits = {};
function workerCall(msg) { return new Promise(r => { const id = ++fileReq; fileWaits[id] = r; worker.postMessage({ ...msg, id }); }); }

async function bootWorker(overwrite) {
  ready = false; setStatus('Starting Python...');
  const [shims, project] = await Promise.all([fetch('py/bundle.json').then(r => r.json()), fetch(`project/${PACKAGE}.json`).then(r => r.json())]);
  worker = new Worker('worker.js');
  worker.onmessage = onWorker;
  worker.postMessage({ type: 'boot', sabCtrl, sabData, sabEvt, sabIntr, pyodideURL: PYODIDE_URL, shims, projectFiles: project.files, overwrite: !!overwrite });
}

async function onWorker(e) {
  const m = e.data;
  if (m.type === 'out') out(m.text);
  else if (m.type === 'err') out(m.text, 'err');
  else if (m.type === 'status') setStatus(m.text);
  else if (m.type === 'ready') { ready = true; setStatus('Ready'); refreshFiles(); window.__ready = true; }
  else if (m.type === 'running') { running = m.file; setRun(true); }
  else if (m.type === 'done') { keyboardOn = false; out(`\n[${running} finished${m.code ? ', exit code ' + m.code : ''}]\n`, 'meta'); running = null; setRun(false); S.programEnded(); UI.cvCloseAll(); UI.tkReset(); stopVoice(); refreshFiles(); window.__done = (window.__done || 0) + 1; }
  else if (m.type === 'imshow') UI.cvShow(m.name, m.w, m.h, m.buf, () => Atomics.store(ctrl, 4, 0));
  else if (m.type === 'py') handlePy(m.msg);
  else if (m.type === 'req') handleRequest(m.kind, JSON.parse(m.payload));
  else if (fileWaits[m.id]) { fileWaits[m.id](m); delete fileWaits[m.id]; }
}
function handlePy(msg) {
  if (msg.type === 'win_open') UI.cvOpen(msg.name);
  else if (msg.type === 'win_close') UI.cvClose(msg.name);
  else if (msg.type === 'tk') UI.tkOps(msg.ops);
  else if (msg.type === 'tk_reset') UI.tkReset();
  else if (msg.type === 'clear') term.textContent = '';
  else if (msg.type === 'keyboard_on') keyboardOn = true;
}
// The `keyboard` module (Lab 4) reads keys pressed anywhere on the page, as on a PC,
// except while typing in a text box. Each press sends a "down" and a "up" event, like the real module.
let keyboardOn = false;
const KEYNAMES = { ' ': 'space', Enter: 'enter', Escape: 'esc', Backspace: 'backspace', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down',
  ArrowLeft: 'left', ArrowRight: 'right', Shift: 'shift', Control: 'ctrl', Alt: 'alt', Delete: 'delete', PageUp: 'page up', PageDown: 'page down' };
function kbd(e, kind) {
  if (!running || !keyboardOn) return;
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  const name = KEYNAMES[e.key] || (e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  sendEvent({ type: 'kbd', event: kind, name });
}
document.addEventListener('keydown', e => kbd(e, 'down'));
document.addEventListener('keyup', e => kbd(e, 'up'));
async function handleRequest(kind, p) {
  pendingReply = true;
  try {
    if (kind === 'frame') return reply(S.renderCameraFrame(p.w, p.h));
    if (kind === 'robot') return replyJSON(await S.robotCommand(p.cmd, p.args || []));
    if (kind === 'dialog') return replyJSON(await UI.dialog(p));
    if (kind === 'input') return replyJSON({ text: await askInput(p.prompt) });
    if (kind === 'voice') return replyJSON(p.cmd === 'start' ? startVoice() : (stopVoice(), { ok: true }));
    replyJSON({});
  } catch (err) { out('page: ' + err + '\n', 'err'); replyJSON({ ok: false, data: String(err) }); }
}

// ---------------------------------------------------------------- run / stop
const PROGRAMS = ['step1_lab5_positions.py', 'step1_tune_camera.py', 'step1_measure_markers.py', 'mapping.py',
  'step1_check_calibration.py', 'step2_collect_data.py', 'step3_train.py', 'step3_baseline_hsv.py',
  'step3_live_detect.py', 'step3_experiments.py', 'explore_kmeans.py', 'step4_sort_blocks.py', 'trials_summary.py',
  'progress.py', 'test_wrist_turn.py', 'voice_commands.py'];
function fillPrograms(files) {
  const sel = $('program'), cur = sel.value; sel.innerHTML = '';
  const top = files.filter(f => f.endsWith('.py') && !f.includes('/') && !PROGRAMS.includes(f)).sort();
  const sub = files.filter(f => f.endsWith('.py') && f.includes('/') && !/^(tools|student_answer_files|results|calibration|stations|dataset)/.test(f)).sort();   // e.g. LAB-3/main.py
  const names = PROGRAMS.filter(p => files.includes(p)).concat(top, sub);
  for (const n of names) { const o = document.createElement('option'); o.value = o.textContent = n; sel.appendChild(o); }
  if (names.includes(cur)) sel.value = cur;
}
export function run(file, args) {
  if (!ready || running) return false;
  file = file || $('program').value; args = args ?? $('args').value.trim();
  if (editorDirty) saveFile();
  out(`\n$ python ${file}${args ? ' ' + args : ''}\n`, 'meta'); showTab('terminal');
  worker.postMessage({ type: 'run', file, args: args ? args.match(/"[^"]*"|\S+/g).map(s => s.replace(/^"|"$/g, '')) : [] });
  return true;
}
function stop() {
  if (!running) return;
  Atomics.store(intr, 0, 2);                    // KeyboardInterrupt, as Ctrl+C
  if (inputResolve) { const r = inputResolve; inputResolve = null; $('inputrow').classList.remove('active'); r(''); }
  sendEvent({ type: 'wake' });
}
function setRun(on) { S.pausePreview(on); $('run').disabled = on || !ready; $('stop').disabled = !on; $('runlabel').textContent = on ? 'Running ' + running : ''; }
function setStatus(t) { $('status').textContent = t; if (t === 'Ready') setRun(false); }
$('run').onclick = () => run();
$('stop').onclick = stop;
$('restart').onclick = async () => { if (!confirm('Restart Python? A running program is stopped at once.')) return; worker.terminate(); running = null; UI.cvCloseAll(); UI.tkReset(); S.programEnded(); await bootWorker(false); };

// ---------------------------------------------------------------- files and editor
let editorFile = null, editorDirty = false;
async function refreshFiles() {
  if (!ready) return;
  const r = await workerCall({ type: 'listFiles' });
  const list = r.list; fillPrograms(list.map(f => f[0]));
  const ul = $('files'); ul.innerHTML = '';
  const dirs = {};
  for (const [p, size] of list) { const d = p.includes('/') ? p.split('/')[0] : ''; (dirs[d] = dirs[d] || []).push([p, size]); }
  for (const d of Object.keys(dirs).sort()) {
    if (d) { const h = document.createElement('li'); h.className = 'dir'; h.textContent = d + '/  (' + dirs[d].length + ' files)'; h.onclick = () => h.classList.toggle('open'); ul.appendChild(h); }
    for (const [p, size] of dirs[d]) {
      if (d && dirs[d].length > 12) continue;
      const li = document.createElement('li'); li.textContent = (d ? '   ' : '') + p.split('/').pop(); li.title = `${p} (${size} bytes)`;
      li.onclick = () => openFile(p); if (p === editorFile) li.className = 'cur'; ul.appendChild(li);
    }
  }
}
async function openFile(p) {
  if (running) { $('editname').textContent = 'Files open when no program is running (press Stop first).'; return; }
  if (editorDirty && !confirm('Discard unsaved changes to ' + editorFile + '?')) return;
  if (/\.(png|jpg|jpeg)$/i.test(p)) {
    const r = await workerCall({ type: 'readBinary', path: p }); if (!r.bytes) return;
    const url = URL.createObjectURL(new Blob([r.bytes])); $('imgview').src = url; $('imgview').style.display = 'block'; $('editor').style.display = 'none';
    editorFile = null; $('editname').textContent = p; showTab('files'); return;
  }
  const r = await workerCall({ type: 'readFile', path: p });
  $('imgview').style.display = 'none'; $('editor').style.display = 'block';
  $('editor').value = r.text ?? '(binary file)'; editorFile = p; editorDirty = false; $('editname').textContent = p; showTab('files'); refreshFiles();
}
$('editor').addEventListener('input', () => { editorDirty = true; $('editname').textContent = editorFile + ' (not saved)'; });
$('editor').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
  if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.setRangeText('    ', s, t.selectionEnd, 'end'); editorDirty = true; }
});
async function saveFile() {
  if (!editorFile) return;
  if (running) { $('editname').textContent = editorFile + ': stop the program to save'; return; } await workerCall({ type: 'writeFile', path: editorFile, data: $('editor').value });
  editorDirty = false; $('editname').textContent = editorFile + ' (saved)';
}
$('save').onclick = saveFile;
$('download').onclick = async () => {
  const r = await workerCall({ type: 'listFiles' }); const files = {};
  for (const [p] of r.list) { const b = await workerCall({ type: 'readBinary', path: p }); if (b.bytes) files['vision_sorting/' + p] = b.bytes; }
  const zip = window.fflate.zipSync(files, { level: 6 });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([zip])); a.download = 'vision_sorting_online.zip'; a.click();
};
$('upload').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; const files = window.fflate.unzipSync(new Uint8Array(await f.arrayBuffer()));
  for (const [p, bytes] of Object.entries(files)) { if (p.endsWith('/')) continue; const rel = p.replace(/^[^/]+\//, ''); await workerCall({ type: 'writeFile', path: rel, data: bytes }); }
  out(`\nUploaded ${Object.keys(files).length} files.\n`, 'meta'); refreshFiles();
};
$('resetcode').onclick = async () => {
  if (running || !confirm('Put back the original program files? Your edits to .py files are lost; your data, model and results stay.')) return;
  worker.terminate(); await bootWorker(true);
};

// ---------------------------------------------------------------- tabs
function showTab(name) { for (const t of ['terminal', 'files', 'help']) { $('tab-' + t).classList.toggle('on', t === name); $('pane-' + t).style.display = t === name ? 'flex' : 'none'; } }
for (const t of ['terminal', 'files', 'help']) $('tab-' + t).onclick = () => showTab(t);

// ---------------------------------------------------------------- station controls
const COLOURS = Object.keys(S.COLOURS);
for (const c of COLOURS) {
  const b = document.createElement('button'); b.className = 'chip'; b.style.background = S.COLOURS[c]; b.title = 'Add a ' + c + ' cube';
  b.textContent = c; b.onclick = () => S.addCubeRandom(c); $('chips').appendChild(b);
}
$('random').onclick = () => S.randomScene(Number($('ncubes').value), $('sorted').checked ? ['red', 'yellow', 'green', 'red', 'yellow', 'green', 'blue', 'orange', 'white', 'pink', 'purple'] : COLOURS);
$('addother').onclick = () => S.addObjectRandom();
$('clearzone').onclick = () => S.clearZone();
$('emptysq').onclick = () => S.emptySquares();
$('light').onchange = e => S.setLighting(e.target.value);
$('hand').onchange = e => S.setHand(e.target.checked);
$('speed').onchange = e => S.robot.speed = Number(e.target.value);
$('problems').onchange = e => S.robot.problems = e.target.checked;
S.on('change', msg => { $('event').textContent = msg; $('event').classList.remove('flash'); void $('event').offsetWidth; $('event').classList.add('flash'); });

// ---------------------------------------------------------------- voice (browser speech recognition)
let rec = null, voiceOn = false;
function startVoice() {
  voiceOn = true; $('voicebox').style.display = 'flex';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('voicestate').textContent = 'This browser has no speech recognition: type the words here instead.'; return { ok: true }; }
  try {
    rec = new SR(); rec.continuous = true; rec.interimResults = false; rec.lang = 'en-GB';
    rec.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) { const t = e.results[i][0].transcript; $('voicestate').textContent = 'Heard: ' + t; sendEvent({ type: 'voice', text: t }); } };
    rec.onend = () => { if (voiceOn) try { rec.start(); } catch (e) {} };
    rec.onerror = e => { $('voicestate').textContent = 'Microphone: ' + e.error + ' (you can type the words here)'; };
    rec.start(); $('voicestate').textContent = 'Listening (allow the microphone).';
  } catch (err) { $('voicestate').textContent = 'Microphone not available: type the words here.'; }
  return { ok: true };
}
function stopVoice() { voiceOn = false; $('voicebox').style.display = 'none'; if (rec) try { rec.stop(); } catch (e) {} rec = null; }
$('voicetype').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) { sendEvent({ type: 'voice', text: e.target.value.trim() }); $('voicestate').textContent = 'Typed: ' + e.target.value; e.target.value = ''; } });

// ---------------------------------------------------------------- start
if (!crossOriginIsolated) {
  out('This page needs to reload once to enable Python (cross-origin isolation)...\n', 'err');
} else {
  S.initScene($('view'), $('preview'));
  UI.initUI($('windows'), sendEvent);
  S.randomScene(6, ['red', 'yellow', 'green', 'blue', 'white', 'orange']);
  bootWorker(false);
}
window.__sim = { run, stop, S, sendEvent, refreshFiles, workerCall, get running() { return running; }, get ready() { return ready; } };
