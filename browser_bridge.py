"""Channel between Python (in the worker) and the page: events in, requests out."""
import json
from collections import deque

from js import bridge

_pos = bridge.writePos()
queues = {"key": deque(), "mouse": deque(), "voice": deque(), "tk": deque(), "winclose": deque(), "kbd": deque()}


def reset():
    """Forget events from before this program started."""
    global _pos
    _pos = bridge.writePos()
    for q in queues.values():
        q.clear()


def poll():
    global _pos
    w = bridge.writePos()
    if w == _pos:
        return False
    raw = bridge.readEvents(_pos).to_bytes()
    _pos = w
    for line in raw.decode("utf-8", "replace").splitlines():
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        queues.setdefault(ev.get("type", "other"), deque()).append(ev)
    return True


def wait(ms):
    """Wait until the page sends an event, or ms milliseconds (-1 = no limit)."""
    bridge.waitEvents(_pos, int(ms))
    return poll()


def request(kind, payload=None):
    """Blocking request to the page; returns the answer as bytes."""
    r = bridge.requestSync(kind, json.dumps(payload if payload is not None else {}))
    return r.to_bytes()


def request_json(kind, payload=None):
    raw = request(kind, payload)
    return json.loads(raw.decode("utf-8")) if raw else {}


def send(msg):
    """Non-blocking message to the page."""
    bridge.post(json.dumps(msg))


def sleep(seconds):
    bridge.sleepMs(int(max(0.0, seconds) * 1000))
