// Runs Python (Pyodide) in a worker so that blocking calls (waitKey, robot moves,
// input(), Tk mainloop) can wait with Atomics.wait while the page keeps drawing.
let py = null, ctrl = null, data = null, evt = null, intr = null;
const PROJECT = '/home/pyodide/project';
const SHIMS = '/home/pyodide/shims';

function post(msg, transfer) { postMessage(msg, transfer || []); }

// Synchronous request to the page: the page answers into the shared data buffer.
function requestSync(kind, payload) {
  Atomics.store(ctrl, 0, 0);
  post({ type: 'req', kind, payload });
  while (Atomics.load(ctrl, 0) === 0) Atomics.wait(ctrl, 0, 0, 1000);
  const n = Atomics.load(ctrl, 1);
  Atomics.store(ctrl, 0, 0);
  return data.slice(0, n);   // a non-shared copy
}
function sleepMs(ms) { const a = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(a, 0, 0, Math.max(0, ms)); }
function waitEvents(seenPos, ms) {   // wake when the page writes an event, or after ms (-1 = forever)
  if (Atomics.load(ctrl, 2) !== seenPos) return;
  Atomics.wait(ctrl, 2, seenPos, ms < 0 ? Infinity : ms);
}
function readEvents(from) {   // bytes [from, write) of the event ring
  const w = Atomics.load(ctrl, 2), N = evt.length;
  const n = w - from;
  const out = new Uint8Array(Math.max(0, n));
  for (let i = 0; i < n; i++) out[i] = evt[(from + i) % N];
  return out;
}
function writePos() { return Atomics.load(ctrl, 2); }
function imshowBusy() { return Atomics.load(ctrl, 4) === 1; }
function setImshowBusy() { Atomics.store(ctrl, 4, 1); }

self.bridge = { requestSync, sleepMs, waitEvents, readEvents, writePos, imshowBusy, setImshowBusy,
  postImage: (name, w, h, buf) => { const a = buf.slice(); post({ type: 'imshow', name, w, h, buf: a.buffer }, [a.buffer]); },
  post: (json) => post({ type: 'py', msg: JSON.parse(json) }) };

async function boot(msg) {
  ctrl = new Int32Array(msg.sabCtrl); data = new Uint8Array(msg.sabData);
  evt = new Uint8Array(msg.sabEvt); intr = new Int32Array(msg.sabIntr);
  importScripts(msg.pyodideURL + 'pyodide.js');
  py = await loadPyodide({ indexURL: msg.pyodideURL,
    stdout: s => post({ type: 'out', text: s + '\n' }), stderr: s => post({ type: 'err', text: s + '\n' }) });
  py.setInterruptBuffer(intr);
  post({ type: 'status', text: 'Loading OpenCV, scikit-learn, matplotlib...' });
  await py.loadPackage(['numpy', 'opencv-python', 'scikit-learn', 'matplotlib', 'scipy'], { messageCallback: () => {} });
  // Persistent project folder (IndexedDB)
  py.FS.mkdirTree(PROJECT); py.FS.mkdirTree(SHIMS);
  py.FS.mount(py.FS.filesystems.IDBFS, {}, PROJECT);
  await new Promise(r => py.FS.syncfs(true, r));
  for (const [path, text] of Object.entries(msg.shims)) {
    py.FS.mkdirTree((SHIMS + '/' + path).split('/').slice(0, -1).join('/'));
    py.FS.writeFile(SHIMS + '/' + path, text);
  }
  // Earlier versions kept Project 1 at the top level: move it into its folder once.
  py.runPython(`import os, shutil
P = ${JSON.stringify(PROJECT)}; F = os.path.join(P, 'AI-VISION-SORTING')
if os.path.exists(os.path.join(P, 'config.py')) and not os.path.exists(F):
    os.makedirs(F)
    for n in os.listdir(P):
        if n != 'AI-VISION-SORTING' and not n.startswith('LAB-') and not n.startswith('.sim'):
            shutil.move(os.path.join(P, n), os.path.join(F, n))`);
  // Each file from the site is copied into the student's folder once. Files they delete, rename or move
  // stay that way; files added to the site later still arrive. "Put back the original" copies them all again.
  const MAN = PROJECT + '/.sim_seeded.json';
  let seeded = []; try { seeded = JSON.parse(py.FS.readFile(MAN, { encoding: 'utf8' })); } catch (e) {}
  const had = new Set(seeded); let fresh = 0;
  for (const [path, text] of Object.entries(msg.projectFiles)) {
    const full = PROJECT + '/' + path;
    let exists = true; try { py.FS.stat(full); } catch (e) { exists = false; }
    if (msg.overwrite || (!exists && !had.has(path))) { py.FS.mkdirTree(full.split('/').slice(0, -1).join('/')); py.FS.writeFile(full, text); fresh++; }
    had.add(path);
  }
  py.FS.writeFile(MAN, JSON.stringify([...had]));
  await new Promise(r => py.FS.syncfs(false, r));
  py.runPython(`import sys; sys.path.insert(0, ${JSON.stringify(SHIMS)}); import browser_boot`);
  post({ type: 'ready', fresh });
}

async function sync() { await new Promise(r => py.FS.syncfs(false, r)); }

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'boot') return await boot(m);
    if (m.type === 'run') {
      Atomics.store(intr, 0, 0);
      post({ type: 'running', file: m.file });
      let code = 0;
      try {
        py.globals.set('_run_file', m.file); py.globals.set('_run_args', py.toPy(m.args));
        code = py.runPython('import browser_boot; browser_boot.run_program(_run_file, list(_run_args))');
      } catch (err) { post({ type: 'err', text: String(err) + '\n' }); code = 1; }
      await sync();
      post({ type: 'done', code });
      return;
    }
    if (m.type === 'readFile') {
      let text = null; try { text = py.FS.readFile(PROJECT + '/' + m.path, { encoding: 'utf8' }); } catch (e) {}
      return post({ type: 'file', id: m.id, path: m.path, text });
    }
    if (m.type === 'readBinary') {
      let bytes = null; try { bytes = py.FS.readFile(PROJECT + '/' + m.path); } catch (e) {}
      return post({ type: 'binary', id: m.id, path: m.path, bytes }, bytes ? [bytes.buffer] : []);
    }
    if (m.type === 'writeFile') {
      const full = PROJECT + '/' + m.path; py.FS.mkdirTree(full.split('/').slice(0, -1).join('/'));
      py.FS.writeFile(full, m.data); await sync(); return post({ type: 'written', id: m.id, path: m.path });
    }
    if (m.type === 'deletePath') {
      py.runPython(`import shutil, os; os.chdir(${JSON.stringify(PROJECT)}); p = ${JSON.stringify(PROJECT + '/' + m.path)}
if os.path.isdir(p): shutil.rmtree(p)
elif os.path.exists(p): os.remove(p)`);
      await sync(); return post({ type: 'deleted', id: m.id });
    }
    if (m.type === 'lint') {
      py.globals.set('_lint_code', m.code); py.globals.set('_lint_path', m.path);
      const r = py.runPython(`import browser_lint; browser_lint.lint(_lint_code, _lint_path, ${JSON.stringify(PROJECT)})`);
      return post({ type: 'lint', id: m.id, list: JSON.parse(r) });
    }
    if (m.type === 'mkdir') {
      py.FS.mkdirTree(PROJECT + '/' + m.path); await sync(); return post({ type: 'done_op', id: m.id });
    }
    if (m.type === 'rename') {
      py.globals.set('_ren', py.toPy([PROJECT + '/' + m.from, PROJECT + '/' + m.to]));
      const err = py.runPython(`import os
os.chdir(${JSON.stringify(PROJECT)})
a, b = _ren
r = ''
if os.path.exists(b): r = 'There is already a file or folder called ' + os.path.relpath(b, ${JSON.stringify(PROJECT)})
else:
    os.makedirs(os.path.dirname(b), exist_ok=True); os.rename(a, b)
r`);
      await sync(); return post({ type: 'done_op', id: m.id, error: err });
    }
    if (m.type === 'listFiles') {
      const list = py.runPython(`import os, json
out, dirs = [], []
for d, ds, fs in os.walk(${JSON.stringify(PROJECT)}):
    fs = [f for f in fs if not f.startswith('.sim')]
    for x in ds: dirs.append(os.path.relpath(os.path.join(d, x), ${JSON.stringify(PROJECT)}))
    for f in fs:
        p = os.path.join(d, f); out.append([os.path.relpath(p, ${JSON.stringify(PROJECT)}), os.path.getsize(p)])
json.dumps([sorted(out), sorted(dirs)])`);
      const [files, dirs] = JSON.parse(list);
      return post({ type: 'files', id: m.id, list: files, dirs });
    }
  } catch (err) { post({ type: 'err', text: 'worker: ' + err + '\n' }); if (m.id) post({ type: 'failed', id: m.id, error: String(err).split('\n').filter(Boolean).pop() }); }
};
