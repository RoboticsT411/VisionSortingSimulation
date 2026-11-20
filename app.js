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
  sendEvent({ type: 'kbd', event: kind, name, repeat: !!e.repeat });
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
const P1 = 'AI-VISION-SORTING/';                // Project 1's folder
const PROGRAMS = ['step1_lab5_positions.py', 'step1_tune_camera.py', 'step1_measure_markers.py', 'mapping.py',
  'step1_check_calibration.py', 'step2_collect_data.py', 'step3_train.py', 'step3_baseline_hsv.py',
  'step3_live_detect.py', 'step3_experiments.py', 'explore_kmeans.py', 'step4_sort_blocks.py', 'trials_summary.py',
  'progress.py', 'test_wrist_turn.py', 'voice_commands.py'].map(f => P1 + f);
function fillPrograms(files) {
  const sel = $('program'), cur = sel.value; sel.innerHTML = '';
  // Project 1's programs in step order, then its other programs, then everything else (LAB-3/main.py, ...)
  const ok = f => f.endsWith('.py') && !/(^|\/)(tools|student_answer_files|results|calibration|stations|dataset[^/]*|__pycache__)\//.test(f);
  const p1 = files.filter(f => ok(f) && f.startsWith(P1) && !f.slice(P1.length).includes('/') && !PROGRAMS.includes(f)).sort();
  const rest = files.filter(f => ok(f) && !f.startsWith(P1) && !PROGRAMS.includes(f)).sort();
  const names = PROGRAMS.filter(p => files.includes(p)).concat(p1, rest);
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
// File tree: folders open and close; New file / New folder / Rename / Delete act on the selected item.
const openDirs = new Set(); let selPath = '', selIsDir = false;
async function refreshFiles() {
  if (!ready) return;
  const r = await workerCall({ type: 'listFiles' });
  const list = r.list, allDirs = r.dirs || []; fillPrograms(list.map(f => f[0]));
  const ul = $('files'); ul.innerHTML = '';
  const kids = {};                           // folder -> {dirs:[], files:[[path,size]]}
  const node = d => (kids[d] = kids[d] || { dirs: new Set(), files: [] });
  const parent = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  for (const d of allDirs) { let x = d; while (x) { node(parent(x)).dirs.add(x); node(x); x = parent(x); } }
  for (const [p, size] of list) node(parent(p)).files.push([p, size]);
  if (editorFile) { let x = parent(editorFile); while (x) { openDirs.add(x); x = parent(x); } }
  const add = (d, depth) => {
    const n = kids[d] || { dirs: new Set(), files: [] }, pad = '   '.repeat(depth);
    for (const sub of [...n.dirs].sort()) {
      const li = document.createElement('li'), open = openDirs.has(sub), count = (kids[sub] ? kids[sub].files.length : 0);
      li.className = 'dir' + (sub === selPath && selIsDir ? ' cur' : ''); li.title = sub + '/';
      li.textContent = pad + (open ? '▾ ' : '▸ ') + sub.split('/').pop() + '/' + (count ? `  (${count})` : '');
      li.onclick = () => { open ? openDirs.delete(sub) : openDirs.add(sub); selPath = sub; selIsDir = true; refreshFiles(); };
      dragSource(li, sub); dropTarget(li, sub);
      ul.appendChild(li);
      if (open) add(sub, depth + 1);
    }
    for (const [p, size] of n.files) {
      const li = document.createElement('li'); li.textContent = pad + (depth ? '  ' : '') + p.split('/').pop(); li.title = `${p} (${size} bytes)`;
      li.onclick = () => { selPath = p; selIsDir = false; openFile(p); }; if (p === editorFile) li.className = 'cur';
      dragSource(li, p); dropTarget(li, parent(p)); ul.appendChild(li);
    }
  };
  add('', 0);
}
// Drag a file or folder onto a folder to move it there; drop it on the empty space below the list for the top level
function dragSource(li, path) { li.draggable = true; li.ondragstart = e => { e.dataTransfer.setData('text/x-simpath', path); e.dataTransfer.effectAllowed = 'move'; }; }
function dropTarget(el, dir) {
  el.ondragover = e => { if (e.dataTransfer.types.includes('text/x-simpath')) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); } };
  el.ondragleave = () => el.classList.remove('drop');
  el.ondrop = e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drop'); moveTo(e.dataTransfer.getData('text/x-simpath'), dir); };
}
async function moveTo(from, dir) {
  if (!from || busy()) return;
  const name = from.split('/').pop(), to = dir ? dir + '/' + name : name;
  if (to === from || (dir + '/').startsWith(from + '/')) return;          // same place, or into itself
  if (editorFile === from && editorDirty) await saveFile();
  const r = await workerCall({ type: 'rename', from, to }); if (r.error) { alert(r.error); return; }
  if (editorFile === from) editorFile = to; else if (editorFile && editorFile.startsWith(from + '/')) editorFile = to + editorFile.slice(from.length);
  if (editorFile) $('editname').textContent = editorFile;
  if (dir) openDirs.add(dir); selPath = to; refreshFiles();
}
dropTarget($('files'), '');
const busy = () => { if (running) { $('editname').textContent = 'Stop the program first: files can be changed only when no program is running.'; return true; } return false; };
const cleanPath = s => (s || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
const baseDir = () => selPath ? (selIsDir ? selPath : (selPath.includes('/') ? selPath.slice(0, selPath.lastIndexOf('/')) : '')) : '';
$('newfile').onclick = async () => {
  if (busy()) return; const d = baseDir();
  const name = cleanPath(prompt('New file name (a folder path can go in front, e.g. LAB-5/main.py):', d ? d + '/' : ''));
  if (!name || name.endsWith('/')) return;
  const ex = await workerCall({ type: 'readFile', path: name }); if (ex.text != null) { alert(name + ' already exists.'); return; }
  await workerCall({ type: 'writeFile', path: name, data: name.endsWith('.py') ? '' : '' });
  selPath = name; selIsDir = false; await refreshFiles(); openFile(name);
};
$('newfolder').onclick = async () => {
  if (busy()) return; const d = baseDir();
  const name = cleanPath(prompt('New folder name:', d ? d + '/' : '')); if (!name) return;
  await workerCall({ type: 'mkdir', path: name }); openDirs.add(name); selPath = name; selIsDir = true; refreshFiles();
};
$('renamefile').onclick = async () => {
  if (busy()) return; if (!selPath) { alert('Click a file or folder first.'); return; }
  const to = cleanPath(prompt('New name or path for ' + selPath + (selIsDir ? '/' : '') + ':', selPath)); if (!to || to === selPath) return;
  if (!selIsDir && editorFile === selPath && editorDirty) await saveFile();
  const r = await workerCall({ type: 'rename', from: selPath, to }); if (r.error) { alert(r.error); refreshFiles(); return; }
  if (editorFile === selPath) { editorFile = to; $('editname').textContent = to; }
  else if (selIsDir && editorFile && editorFile.startsWith(selPath + '/')) { editorFile = to + editorFile.slice(selPath.length); $('editname').textContent = editorFile; }
  selPath = to; refreshFiles();
};
$('deletefile').onclick = async () => {
  if (busy()) return; if (!selPath) { alert('Click a file or folder first.'); return; }
  if (!confirm('Delete ' + selPath + (selIsDir ? '/ and everything in it' : '') + '? This cannot be undone (download the project first to keep a copy).')) return;
  const rd = await workerCall({ type: 'deletePath', path: selPath }); if (rd.error) alert('Could not delete: ' + rd.error);
  if (editorFile && (editorFile === selPath || editorFile.startsWith(selPath + '/'))) { editorFile = null; editorDirty = false; cm.setValue(''); $('editname').textContent = 'Choose a file'; $('lintsum').textContent = ''; }
  selPath = ''; refreshFiles();
};
async function openFile(p) {
  if (running) { $('editname').textContent = 'Files open when no program is running (press Stop first).'; return; }
  if (editorDirty && !confirm('Discard unsaved changes to ' + editorFile + '?')) return;
  if (/\.(png|jpg|jpeg)$/i.test(p)) {
    const r = await workerCall({ type: 'readBinary', path: p }); if (!r.bytes) return;
    const url = URL.createObjectURL(new Blob([r.bytes])); $('imgview').src = url; $('imgview').style.display = 'block'; $('editor').style.display = 'none'; $('lintsum').textContent = '';
    editorFile = null; $('editname').textContent = p; showTab('files'); return;
  }
  const r = await workerCall({ type: 'readFile', path: p });
  $('imgview').style.display = 'none'; $('editor').style.display = 'block';
  editorFile = p; cm.setOption('mode', p.endsWith('.py') ? { name: 'python', version: 3 } : null);
  cm.setValue(r.text ?? '(binary file)'); cm.clearHistory(); editorDirty = false; $('editname').textContent = p; $('lintsum').textContent = '';
  showTab('files'); refreshFiles(); setTimeout(() => { cm.refresh(); cm.performLint(); }, 30);
}
// Code editor (CodeMirror 5): line numbers, Python colours, bracket matching, and live checks like
// PyCharm's: red underline for syntax errors and unknown (misspelt) names, yellow for unused ones.
let lintAnn = [];
const cm = CodeMirror($('editor'), {
  mode: { name: 'python', version: 3 }, lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
  matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true, gutters: ['CodeMirror-lint-markers', 'CodeMirror-linenumbers'],
  lint: { async: true, delay: 500, getAnnotations: (text, done) => pyLint(text).then(done) },
  extraKeys: {
    'Ctrl-S': () => saveFile(), 'Cmd-S': () => saveFile(), 'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment', 'Ctrl-G': 'jumpToLine',
    Tab: c => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('    ', 'end'), 'Shift-Tab': c => c.indentSelection('subtract'),
  },
});
async function pyLint(text) {
  if (!ready || running || !editorFile || !editorFile.endsWith('.py')) return lintAnn;     // Python is busy: keep the last marks
  const r = await workerCall({ type: 'lint', code: text, path: editorFile });
  lintAnn = (r.list || []).map(m => ({ from: CodeMirror.Pos(m.line - 1, m.col), to: CodeMirror.Pos(m.line - 1, m.end), message: m.msg, severity: m.severity }));
  const ne = lintAnn.filter(a => a.severity === 'error').length, nw = lintAnn.length - ne;
  $('lintsum').innerHTML = (ne ? `<span class="e">${ne} error${ne > 1 ? 's' : ''}</span> ` : '') + (nw ? `<span class="w">${nw} warning${nw > 1 ? 's' : ''}</span>` : '') + (!ne && !nw ? '✓ no problems' : '');
  return lintAnn;
}
cm.on('change', (c, ch) => { if (ch.origin === 'setValue') return; editorDirty = true; $('editname').textContent = editorFile + ' (not saved)'; });
function gotoLine(path, line) { openFile(path).then(() => { cm.setCursor(line - 1, 0); cm.addLineClass(line - 1, 'background', 'CodeMirror-activeline-background'); cm.focus(); cm.scrollIntoView(null, 120); }); }
async function saveFile() {
  if (!editorFile) return;
  if (running) { $('editname').textContent = editorFile + ': stop the program to save'; return; } await workerCall({ type: 'writeFile', path: editorFile, data: cm.getValue() });
  editorDirty = false; $('editname').textContent = editorFile + ' (saved)';
}
$('save').onclick = saveFile;
$('download').onclick = async () => {
  const r = await workerCall({ type: 'listFiles' }); const files = {};
  for (const [p] of r.list) { const b = await workerCall({ type: 'readBinary', path: p }); if (b.bytes) files['my_robot_files/' + p] = b.bytes; }
  const zip = window.fflate.zipSync(files, { level: 6 });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([zip])); a.download = 'my_robot_files.zip'; a.click();
};
$('upload').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; const files = window.fflate.unzipSync(new Uint8Array(await f.arrayBuffer()));
  // A zip made with "Download" (my_robot_files/...) goes back where it was; any other zip keeps its folders
  const names = Object.keys(files).filter(p => !p.endsWith('/') && !p.startsWith('__MACOSX/'));
  const strip = names.length && names.every(p => p.startsWith('my_robot_files/') || p.startsWith('vision_sorting/'));
  for (const p of names) { const rel = strip ? p.replace(/^[^/]+\//, '') : p; await workerCall({ type: 'writeFile', path: rel, data: files[p] }); }
  out(`\nUploaded ${Object.keys(files).length} files.\n`, 'meta'); refreshFiles();
};
$('resetcode').onclick = async () => {
  if (running || !confirm('Put back the original program files? Your edits to .py files are lost; your data, model and results stay.')) return;
  worker.terminate(); await bootWorker(true);
};

// ---------------------------------------------------------------- tabs
function showTab(name) { for (const t of ['terminal', 'files', 'help']) { $('tab-' + t).classList.toggle('on', t === name); $('pane-' + t).style.display = t === name ? 'flex' : 'none'; } if (name === 'files') setTimeout(() => cm.refresh(), 0); }
for (const t of ['terminal', 'files', 'help']) $('tab-' + t).onclick = () => showTab(t);

// ---------------------------------------------------------------- station controls
const COLOURS = Object.keys(S.COLOURS);
for (const c of COLOURS) {
  const b = document.createElement('button'); b.className = 'chip'; b.style.background = S.COLOURS[c]; b.title = 'Add a ' + c + ' cube';
  b.textContent = c; b.onclick = () => S.addCubeTo(c, $('addwhere').value); $('chips').appendChild(b);
}
$('random').onclick = () => S.randomScene(Number($('ncubes').value), $('sorted').checked ? ['red', 'yellow', 'green', 'red', 'yellow', 'green', 'blue', 'orange', 'white', 'pink', 'purple'] : COLOURS);
$('addother').onclick = () => S.addObjectRandom();
$('clearzone').onclick = () => S.clearZone();
$('turned').onchange = e => { S.options.turned = e.target.checked; };
// joint sliders
const sliders = [];
S.JOINT_LIMITS.forEach(([lo, hi], i) => {
  const lab = document.createElement('span'); lab.textContent = 'Joint ' + (i + 1);
  const r = document.createElement('input'); r.type = 'range'; r.min = lo; r.max = hi; r.step = 0.001;
  const v = document.createElement('span'); v.className = 'val';
  r.oninput = () => S.setJoint(i, Number(r.value));
  $('jointsliders').append(lab, r, v); sliders.push([r, v]);
});
setInterval(() => {
  const lock = !S.canJog(); $('jointbox').classList.toggle('locked', lock);
  S.robot.joints.forEach((q, i) => { const [r, v] = sliders[i]; r.disabled = lock; if (document.activeElement !== r) r.value = q; v.textContent = `${q.toFixed(3)} rad`; });
}, 100);
$('gopen').onclick = () => S.handGripper(true);
$('gclose').onclick = () => S.handGripper(false);
$('gsleep').onclick = () => [0, 0.55, -1.2, 0, 0, 0].forEach((q, i) => S.setJoint(i, q));
// Ctrl+S saves the open file from anywhere on the Files tab
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's' && $('pane-files').style.display !== 'none' && editorFile) { e.preventDefault(); saveFile(); } });
$('turnl').onclick = () => S.turnSelected(15);
$('turnr').onclick = () => S.turnSelected(-15);
$('hidecam').onclick = () => $('view').classList.add('nocam');
$('showcam').onclick = () => $('view').classList.remove('nocam');
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
