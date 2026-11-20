"""Sets up Python in the browser so the project's programs run unchanged:
windows, keys, mouse, camera, robot client, input(), time.sleep() and threads."""
import builtins
import os
import runpy
import sys
import threading
import time
import traceback

os.environ.setdefault("MPLBACKEND", "Agg")

import browser_bridge as bb       # noqa: E402
import browser_cv2                # noqa: E402

PROJECT = "/home/pyodide/project"
browser_cv2.install()
time.sleep = bb.sleep


def _input(prompt=""):
    r = bb.request_json("input", {"prompt": str(prompt)})
    if r.get("eof"):
        raise EOFError
    return r.get("text", "")


builtins.input = _input


class _InlineThread(threading.Thread):
    """Browsers give Python one thread: a thread runs to the end when started.
    (Step 4 starts robot moves in a thread; here the move simply runs, and the page keeps drawing.)"""

    def start(self):
        self._inline_done = False
        try:
            self.run()
        finally:
            self._inline_done = True

    def is_alive(self):
        return False

    def join(self, timeout=None):
        return None


threading.Thread = _InlineThread

_os_system = os.system


def _system(cmd):
    """os.system: 'cls' and 'clear' clear the terminal; other commands cannot run in a browser."""
    if str(cmd).strip().lower() in ("cls", "clear"):
        sys.stdout.flush()
        bb.send({"type": "clear"})
        return 0
    print(f"[os.system({cmd!r}) is not available in the browser]", file=sys.stderr)
    return 1


os.system = _system


def _forget_project_modules():
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None) or ""
        if f.startswith(PROJECT):
            del sys.modules[name]


def run_program(file, args):
    import tkinter
    _forget_project_modules()
    tkinter.reset()
    browser_cv2._open.clear()
    browser_cv2._callbacks.clear()
    bb.reset()
    # A program in a folder (LAB-3/main.py) runs from that folder and imports its own
    # functions.py and variables.py, as when the folder is opened in PyCharm.
    path = os.path.join(PROJECT, file)
    folder = os.path.dirname(path)
    sys.path[:] = [p for p in sys.path if not (p == PROJECT or p.startswith(PROJECT + "/"))]
    sys.path.insert(1, folder)
    os.chdir(folder)
    sys.argv = [path] + list(args)
    code = 0
    try:
        runpy.run_path(path, run_name="__main__")
    except SystemExit as e:
        if isinstance(e.code, str):
            print(e.code, file=sys.stderr)
            code = 1
        elif e.code:
            code = int(e.code)
    except KeyboardInterrupt:
        print("\nStopped.")
        code = 130
    except BaseException:
        traceback.print_exc()
        code = 1
    finally:
        try:
            browser_cv2.destroyAllWindows()
            bb.send({"type": "tk_reset"})
            if "matplotlib.pyplot" in sys.modules:
                sys.modules["matplotlib.pyplot"].close("all")
        except BaseException:
            pass
        sys.stdout.flush()
        sys.stderr.flush()
        os.chdir(PROJECT)          # leave the program's folder, so it can be renamed or deleted
    return code
