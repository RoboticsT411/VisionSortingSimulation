"""A small Tkinter for the browser: the widgets the project's windows use, drawn by the page.

Widgets live here; the page draws them and sends back clicks, typing and selections.
mainloop() waits for those events and calls the commands, as Tk does."""
import itertools
import time
import traceback

import browser_bridge as bb

END = "end"
LEFT, RIGHT, TOP, BOTTOM = "left", "right", "top", "bottom"
X, Y, BOTH, NONE = "x", "y", "both", "none"
N, S, E, W, NW, NE, SW, SE, CENTER = "n", "s", "e", "w", "nw", "ne", "sw", "se", "center"
NORMAL, DISABLED, ACTIVE, HIDDEN = "normal", "disabled", "active", "hidden"
WORD, CHAR = "word", "char"
INSERT = "insert"
GROOVE, RIDGE, SOLID, SUNKEN, RAISED, FLAT = "groove", "ridge", "solid", "sunken", "raised", "flat"
TclError = RuntimeError

_ids = itertools.count(1)
_widgets = {}
_ops = []
_default_root = None
_after = []      # (time, id, fn, args)
_after_ids = itertools.count(1)

_SEND_KEYS = {"text", "fg", "foreground", "bg", "background", "font", "width", "height", "state", "anchor",
              "justify", "relief", "bd", "borderwidth", "padx", "pady", "wraplength", "cursor", "wrap"}


def _op(*args):
    _ops.append(list(args))


def _flush():
    if _ops:
        bb.send({"type": "tk", "ops": list(_ops)})
        _ops.clear()


def _clean(opts):
    out = {}
    for k, v in opts.items():
        if k in _SEND_KEYS:
            out[k] = list(v) if isinstance(v, tuple) else v
    return out


# ---------------------------------------------------------------- variables
class Variable:
    _default = ""

    def __init__(self, master=None, value=None, name=None):
        self._value = self._default if value is None else value
        self._widgets = []
        self._traces = []

    def get(self):
        return self._value

    def set(self, value):
        self._value = value
        for w in self._widgets:
            w._var_changed()
        for cb in self._traces:
            cb("", "", "write")

    def trace_add(self, mode, callback):
        self._traces.append(callback)

    trace = trace_variable = lambda self, mode, cb: self.trace_add(mode, cb)


class StringVar(Variable):
    _default = ""

    def get(self):
        return str(self._value)


class IntVar(Variable):
    _default = 0

    def get(self):
        return int(self._value)


class DoubleVar(Variable):
    _default = 0.0

    def get(self):
        return float(self._value)


class BooleanVar(Variable):
    _default = False

    def get(self):
        return bool(self._value)


# ---------------------------------------------------------------- base widget
class Misc:
    kind = "frame"

    def __init__(self, master=None, cnf=None, **kw):
        global _default_root
        if master is None:
            master = _default_root
        self.master = master
        self._id = next(_ids)
        self._children = []
        self._bindings = {}
        self._opts = dict(cnf or {}, **kw)
        _widgets[self._id] = self
        if master is not None:
            master._children.append(self)
        _op("create", self._id, self.kind, master._id if master is not None else None, self._initial())

    def _initial(self):
        return _clean(self._opts)

    # options
    def configure(self, cnf=None, **kw):
        if cnf is None and not kw:
            return dict(self._opts)
        kw = dict(cnf or {}, **kw)
        self._opts.update(kw)
        self._on_config(kw)
        sent = _clean(kw)
        if sent:
            _op("config", self._id, sent)

    config = configure

    def _on_config(self, kw):
        pass

    def cget(self, key):
        return self._opts.get(key, "")

    def __getitem__(self, key):
        return self.cget(key)

    def __setitem__(self, key, value):
        self.configure(**{key: value})

    # geometry
    def pack(self, cnf=None, **kw):
        _op("layout", self._id, "pack", _jsonable(dict(cnf or {}, **kw)))

    def grid(self, cnf=None, **kw):
        _op("layout", self._id, "grid", _jsonable(dict(cnf or {}, **kw)))

    def place(self, cnf=None, **kw):
        _op("layout", self._id, "place", _jsonable(dict(cnf or {}, **kw)))

    pack_configure, grid_configure = pack, grid

    def pack_forget(self):
        _op("layout", self._id, "none", {})

    grid_forget = grid_remove = pack_forget

    def columnconfigure(self, *a, **k):
        pass

    rowconfigure = grid_columnconfigure = grid_rowconfigure = columnconfigure

    # events
    def bind(self, sequence=None, func=None, add=None):
        self._bindings.setdefault(sequence, []).append(func)
        _op("bind", self._id, sequence)

    def _fire(self, sequence, event):
        for fn in self._bindings.get(sequence, []):
            fn(event)

    # tree
    def winfo_children(self):
        return list(self._children)

    def winfo_exists(self):
        return self._id in _widgets

    def winfo_width(self):
        return 800

    winfo_height = winfo_reqwidth = winfo_reqheight = winfo_width

    def destroy(self):
        for c in list(self._children):
            c.destroy()
        _widgets.pop(self._id, None)
        if self.master is not None and self in self.master._children:
            self.master._children.remove(self)
        _op("destroy", self._id)

    def focus_set(self):
        _op("focus", self._id)

    focus = focus_force = focus_set

    def update(self):
        _flush()
        _process_events(0)

    update_idletasks = update

    def after(self, ms, func=None, *args):
        aid = next(_after_ids)
        _after.append((time.time() + ms / 1000.0, aid, func, args))
        return f"after#{aid}"

    def after_idle(self, func, *args):
        return self.after(0, func, *args)

    def after_cancel(self, aid):
        n = int(str(aid).split("#")[-1])
        _after[:] = [a for a in _after if a[1] != n]

    def bell(self):
        pass

    def option_add(self, *a, **k):
        pass

    def quit(self):
        root = self._root()
        root._running = False

    def _root(self):
        w = self
        while w.master is not None:
            w = w.master
        return w


def _jsonable(d):
    return {k: (list(v) if isinstance(v, tuple) else v) for k, v in d.items()
            if isinstance(v, (str, int, float, tuple, list, bool)) or v is None}


class Widget(Misc):
    pass


class Tk(Misc):
    kind = "root"

    def __init__(self, screenName=None, baseName=None, className="Tk", useTk=True, sync=False, use=None):
        global _default_root
        super().__init__(None)
        self._protocols = {}
        self._running = False
        if _default_root is None:
            _default_root = self

    def title(self, text=None):
        if text is not None:
            self._opts["title"] = text
            _op("title", self._id, text)
        return self._opts.get("title", "")

    wm_title = title

    def protocol(self, name=None, func=None):
        self._protocols[name] = func

    wm_protocol = protocol

    def geometry(self, *a):
        return "800x600"

    def resizable(self, *a, **k):
        pass

    minsize = maxsize = attributes = iconify = deiconify = withdraw = lift = resizable

    def mainloop(self, n=0):
        self._running = True
        _flush()
        try:
            while self._running and self._id in _widgets:
                _process_events(None)
                _flush()
        finally:
            _flush()

    def destroy(self):
        global _default_root
        self._running = False
        super().destroy()
        _flush()
        if _default_root is self:
            _default_root = None


class Toplevel(Tk):
    kind = "root"

    def __init__(self, master=None, **kw):
        Misc.__init__(self, None, **kw)
        self._protocols = {}
        self._running = False

    def mainloop(self, n=0):
        _default_root.mainloop() if _default_root else Tk.mainloop(self)


class Frame(Widget):
    kind = "frame"


class LabelFrame(Widget):
    kind = "labelframe"


class Label(Widget):
    kind = "label"

    def _initial(self):
        o = _clean(self._opts)
        tv = self._opts.get("textvariable")
        if tv is not None:
            tv._widgets.append(self)
            o["text"] = str(tv.get())
        return o

    def _var_changed(self):
        _op("config", self._id, {"text": str(self._opts["textvariable"].get())})


class Message(Label):
    pass


class Button(Widget):
    kind = "button"

    def invoke(self):
        cmd = self._opts.get("command")
        if cmd and self._opts.get("state", "normal") != "disabled":
            return cmd()

    def _click(self, ev):
        self.invoke()


class Entry(Widget):
    kind = "entry"

    def __init__(self, master=None, cnf=None, **kw):
        self._value = ""
        super().__init__(master, cnf, **kw)
        tv = self._opts.get("textvariable")
        if tv is not None:
            tv._widgets.append(self)
            self._value = str(tv.get())
            _op("value", self._id, self._value)

    def get(self):
        return self._value

    def _set(self, value, send=True):
        self._value = value
        tv = self._opts.get("textvariable")
        if tv is not None:
            tv._value = value
        if send:
            _op("value", self._id, value)

    def _index(self, i):
        if i == END or i == "end":
            return len(self._value)
        if i == INSERT or i == "insert":
            return len(self._value)
        return max(0, min(len(self._value), int(i)))

    def insert(self, index, text):
        i = self._index(index)
        self._set(self._value[:i] + str(text) + self._value[i:])

    def delete(self, first, last=None):
        a = self._index(first)
        b = a + 1 if last is None else self._index(last)
        self._set(self._value[:a] + self._value[b:])

    def _var_changed(self):
        self._set(str(self._opts["textvariable"].get()))

    def icursor(self, *a):
        pass

    select_range = selection_range = icursor


class Text(Widget):
    kind = "text"

    def __init__(self, master=None, cnf=None, **kw):
        self._runs = []
        self._tags = {}
        super().__init__(master, cnf, **kw)

    def _send(self):
        _op("text", self._id, self._runs, self._tags)

    def insert(self, index, text, *tags):
        run = [str(text), tags[0] if tags else ""]
        if str(index) in ("1.0", "0.0"):
            self._runs.insert(0, run)
        else:
            self._runs.append(run)
        self._send()

    def delete(self, first, last=None):
        self._runs = []
        self._send()

    def get(self, first="1.0", last=END):
        return "".join(t for t, _ in self._runs)

    def tag_config(self, tag, **kw):
        self._tags[tag] = _clean(kw)
        self._send()

    tag_configure = tag_config

    def see(self, *a):
        pass


class Radiobutton(Widget):
    kind = "radio"

    def _initial(self):
        o = _clean(self._opts)
        var = self._opts.get("variable")
        if var is not None:
            var._widgets.append(self)
            o["checked"] = var.get() == self._opts.get("value")
        return o

    def _var_changed(self):
        var = self._opts["variable"]
        _op("checked", self._id, var.get() == self._opts.get("value"))

    def _click(self, ev):
        if self._opts.get("state", "normal") == "disabled":
            return
        var = self._opts.get("variable")
        if var is not None:
            var.set(self._opts.get("value"))
        cmd = self._opts.get("command")
        if cmd:
            cmd()

    def select(self):
        var = self._opts.get("variable")
        if var is not None:
            var.set(self._opts.get("value"))


class Checkbutton(Widget):
    kind = "check"

    def _initial(self):
        o = _clean(self._opts)
        var = self._opts.get("variable")
        if var is not None:
            var._widgets.append(self)
            o["checked"] = bool(var.get())
        return o

    def _var_changed(self):
        _op("checked", self._id, bool(self._opts["variable"].get()))

    def _click(self, ev):
        var = self._opts.get("variable")
        if var is not None:
            var.set(0 if var.get() else 1)
        cmd = self._opts.get("command")
        if cmd:
            cmd()


class OptionMenu(Widget):
    kind = "option"

    def __init__(self, master, variable, value=None, *values, command=None, **kw):
        self._var = variable
        self._values = ([value] if value is not None else []) + list(values)
        self._command = command
        super().__init__(master, **kw)
        variable._widgets.append(self)

    def _initial(self):
        o = _clean(self._opts)
        o["values"] = [str(v) for v in self._values]
        o["value"] = str(self._var.get())
        return o

    def _var_changed(self):
        _op("value", self._id, str(self._var.get()))

    def _select(self, value):
        self._var.set(value)
        if self._command:
            self._command(value)


class Scrollbar(Widget):
    kind = "frame"

    def set(self, *a):
        pass


class Canvas(Widget):
    kind = "frame"


# ---------------------------------------------------------------- events
class Event:
    def __init__(self, widget, **kw):
        self.widget = widget
        self.__dict__.update(kw)


def _run_after():
    now = time.time()
    due = [a for a in _after if a[0] <= now]
    for a in due:
        _after.remove(a)
        try:
            a[2](*a[3])
        except Exception:
            traceback.print_exc()


def _process_events(timeout_ms):
    """Wait for page events (None = until one arrives or an after() is due) and handle them."""
    _run_after()
    _flush()
    if not bb.queues["tk"]:
        if timeout_ms is None:
            wait = -1
            if _after:
                wait = max(1, int((min(a[0] for a in _after) - time.time()) * 1000))
        else:
            wait = timeout_ms
        if wait != 0:
            bb.wait(wait)
        else:
            bb.poll()
    q = bb.queues["tk"]
    while q:
        ev = q.popleft()
        w = _widgets.get(ev.get("id"))
        if w is None:
            continue
        try:
            _handle(w, ev)
        except Exception:
            traceback.print_exc()
        _flush()


def _handle(w, ev):
    kind = ev["ev"]
    if kind == "click":
        if hasattr(w, "_click"):
            w._click(ev)
    elif kind == "input":
        w._set(ev.get("value", ""), send=False)
        w._fire("<Key>", Event(w, char="", keysym=""))
    elif kind == "keyrelease":
        w._set(ev.get("value", ""), send=False)
        w._fire("<KeyRelease>", Event(w, char=ev.get("char", ""), keysym=ev.get("keysym", "")))
        if ev.get("keysym") == "Return":
            w._fire("<Return>", Event(w))
    elif kind == "focus":
        w._fire("<FocusIn>", Event(w))
    elif kind == "select":
        w._select(ev.get("value"))
    elif kind == "close":
        fn = getattr(w, "_protocols", {}).get("WM_DELETE_WINDOW")
        if fn:
            fn()
        else:
            w.destroy()


def mainloop(n=0):
    if _default_root is not None:
        _default_root.mainloop()


def reset():
    """Forget every widget (called when a program ends)."""
    global _default_root
    _widgets.clear()
    _ops.clear()
    _after.clear()
    _default_root = None
