"""Checks a Python file as it is typed in the editor, like PyCharm's red and yellow underlines.

Errors (red): syntax and indentation errors, and names that are not defined anywhere, which is
how a misspelt variable or function name shows up (`prnt`, `clinet.connect`).
Warnings (yellow): imports and variables that are never used, names defined twice.
Names brought in with `from module import *` are looked up in that module when it can be found
(the project's own files and the robot client), so misspellings are still caught in the labs.
"""
import ast
import builtins
import json
import os
import sys

from pyflakes import checker, messages as M

ERRORS = (M.UndefinedName, M.UndefinedLocal, M.UndefinedExport, M.ReturnOutsideFunction,
          M.YieldOutsideFunction, M.ContinueOutsideLoop, M.BreakOutsideLoop, M.DuplicateArgument,
          M.TooManyExpressionsInStarredAssignment, M.TwoStarredExpressions)
SKIP = (M.ImportStarUsed, M.ImportStarNotPermitted)


def _module_names(name, folders, seen=None):
    """Top-level names a module defines, read from its source without importing it; None if not found."""
    seen = seen if seen is not None else set()
    if name in seen:
        return set()
    seen.add(name)
    rel = name.replace(".", "/")
    for d in folders:
        for cand in (os.path.join(d, rel + ".py"), os.path.join(d, rel, "__init__.py")):
            if os.path.isfile(cand):
                try:
                    tree = ast.parse(open(cand, encoding="utf-8").read())
                except Exception:
                    return None
                names = set()
                for node in tree.body:
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        names.add(node.name)
                    elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                        for t in (node.targets if isinstance(node, ast.Assign) else [node.target]):
                            for n in ast.walk(t):
                                if isinstance(n, ast.Name):
                                    names.add(n.id)
                    elif isinstance(node, ast.Import):
                        names.update((a.asname or a.name).split(".")[0] for a in node.names)
                    elif isinstance(node, ast.ImportFrom):
                        for a in node.names:
                            if a.name == "*":
                                sub = _module_names(node.module or "", folders, seen)
                                if sub is None:
                                    return None
                                names |= sub
                            else:
                                names.add(a.asname or a.name)
                return {n for n in names if not n.startswith("_")}
    try:                                   # an installed package (numpy, cv2, ...): ask it
        mod = __import__(name)
        for part in name.split(".")[1:]:
            mod = getattr(mod, part)
        return set(getattr(mod, "__all__", None) or [n for n in dir(mod) if not n.startswith("_")])
    except Exception:
        return None


def lint(code, path, project):
    out = []
    try:
        tree = compile(code, path, "exec", ast.PyCF_ONLY_AST)
    except SyntaxError as e:
        line = e.lineno or 1
        col = max((e.offset or 1) - 1, 0)
        msg = e.msg
        if isinstance(e, IndentationError):
            msg = "Indentation: " + msg
        out.append({"line": line, "col": col, "end": col + 1, "msg": msg, "severity": "error"})
        return json.dumps(out)

    folders = [os.path.dirname(os.path.join(project, path)), project] + [p for p in sys.path if p]
    stars = [n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names)]
    star_names, unknown = set(), False
    for m in stars:
        names = _module_names(m or "", folders)
        if names is None:
            unknown = True
        else:
            star_names |= names

    w = checker.Checker(tree, filename=path, builtins=set(dir(builtins)) | {"__file__", "__name__"})
    lines = code.splitlines()
    for m in sorted(w.messages, key=lambda m: (m.lineno, m.col)):
        if isinstance(m, SKIP):
            continue
        if isinstance(m, M.ImportStarUsage):          # name maybe from a star import
            name = m.message_args[0]
            if unknown or name in star_names:
                continue
            msg, sev = f"Unresolved name '{name}' (not defined here, nor in {', '.join(stars)})", "error"
        else:
            msg = m.message % m.message_args
            sev = "error" if isinstance(m, ERRORS) else "warning"
            if isinstance(m, M.UndefinedName):
                msg = f"Unresolved name '{m.message_args[0]}' (misspelt, or not defined or imported)"
        text = lines[m.lineno - 1] if 0 < m.lineno <= len(lines) else ""
        col = m.col or 0
        end = col + 1
        if m.message_args and isinstance(m.message_args[0], str):
            word = m.message_args[0].split(".")[-1]
            i = text.find(word, col)
            if i >= 0:
                col, end = i, i + len(word)
        out.append({"line": m.lineno, "col": col, "end": max(end, col + 1), "msg": msg, "severity": sev})
    return json.dumps(out)
