"""Message boxes, shown by the page."""
import browser_bridge as bb
import tkinter as _tk


def _ask(kind, title, message, **kw):
    _tk._flush()
    r = bb.request_json("dialog", {"kind": kind, "title": str(title or ""), "message": str(message or "")})
    return r.get("answer")


def showinfo(title=None, message=None, **kw):
    _ask("info", title, message)
    return "ok"


def showwarning(title=None, message=None, **kw):
    _ask("warning", title, message)
    return "ok"


def showerror(title=None, message=None, **kw):
    _ask("error", title, message)
    return "ok"


def askyesno(title=None, message=None, **kw):
    return bool(_ask("yesno", title, message))


def askokcancel(title=None, message=None, **kw):
    return bool(_ask("okcancel", title, message))


def askquestion(title=None, message=None, **kw):
    return "yes" if _ask("yesno", title, message) else "no"


def askretrycancel(title=None, message=None, **kw):
    return bool(_ask("retrycancel", title, message))


def askyesnocancel(title=None, message=None, **kw):
    a = _ask("yesnocancel", title, message)
    return None if a is None else bool(a)
