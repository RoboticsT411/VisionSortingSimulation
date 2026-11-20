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
  let fresh = 0;
  for (const [path, text] of Object.entries(msg.projectFiles)) {
    const full = PROJECT + '/' + path;
    let exists = true; try { py.FS.stat(full); } catch (e) { exists = false; }
    if (!exists || msg.overwrite) { py.FS.mkdirTree(full.split('/').slice(0, -1).join('/')); py.FS.writeFile(full, text); fresh++; }
  }
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
      py.runPython(`import shutil, os; p = ${JSON.stringify(PROJECT + '/' + m.path)}
if os.path.isdir(p): shutil.rmtree(p)
elif os.path.exists(p): os.remove(p)`);
      await sync(); return post({ type: 'deleted', id: m.id });
    }
    if (m.type === 'listFiles') {
      const list = py.runPython(`import os, json
out = []
for d, _, fs in os.walk(${JSON.stringify(PROJECT)}):
    for f in fs:
        p = os.path.join(d, f); out.append([os.path.relpath(p, ${JSON.stringify(PROJECT)}), os.path.getsize(p)])
json.dumps(sorted(out))`);
      return post({ type: 'files', id: m.id, list: JSON.parse(list) });
    }
  } catch (err) { post({ type: 'err', text: 'worker: ' + err + '\n' }); }
};
