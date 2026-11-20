"""Stand-in for the `keyboard` module (used in Lab 4): keys pressed on the page while the program runs.

As with the real module, every press gives a "down" event and a "up" event, and
read_key() returns the name of the next event of either kind. Typing in a text box
(the terminal input, the editor) is not counted.
"""
import browser_bridge as bb

KEY_DOWN, KEY_UP = "down", "up"
_down = set()
bb.send({"type": "keyboard_on"})


class KeyboardEvent:
    def __init__(self, event_type, name):
        self.event_type, self.name, self.scan_code = event_type, name, 0

    def __repr__(self):
        return f"KeyboardEvent({self.name} {self.event_type})"


def _next(block=True):
    q = bb.queues["kbd"]
    while True:
        bb.poll()
        if q:
            ev = q.popleft()
            # A held key repeats. The robot moves slower than the repeats arrive, so once the key
            # is let go, the repeats still waiting are dropped: the robot stops when you stop pressing.
            if ev["event"] == KEY_DOWN and ev.get("repeat") and any(
                    e["event"] == KEY_UP and e["name"] == ev["name"] for e in q):
                continue
            name, kind = ev["name"], ev["event"]
            (_down.add if kind == KEY_DOWN else _down.discard)(name)
            return KeyboardEvent(kind, name)
        if not block:
            return None
        bb.wait(-1)


def read_event(suppress=False):
    bb.send({"type": "keyboard_on"})
    return _next()


def read_key(suppress=False):
    return read_event(suppress).name


def is_pressed(key):
    bb.send({"type": "keyboard_on"})
    while _next(block=False):
        pass
    return str(key).lower() in _down


def wait(key=None, suppress=False):
    while True:
        e = read_event()
        if e.event_type == KEY_DOWN and (key is None or e.name == str(key).lower()):
            return
