"""OpenCV windows, keys, mouse and the USB camera, replaced by the page."""
import random
import time

import cv2
import numpy as np
from pyodide.ffi import to_js

import browser_bridge as bb
from js import bridge

_open = set()
_callbacks = {}
_original_capture = cv2.VideoCapture


# ---------------------------------------------------------------- windows
def namedWindow(name, flags=0):
    if name not in _open:
        _open.add(name)
        bb.send({"type": "win_open", "name": name})


def imshow(name, img):
    namedWindow(name)
    if bridge.imshowBusy():          # the page is still drawing the last picture: skip this one
        bb.poll()
        return
    img = np.asarray(img)
    if img.dtype != np.uint8:
        img = cv2.convertScaleAbs(img)
    if img.ndim == 2:
        rgba = cv2.cvtColor(img, cv2.COLOR_GRAY2RGBA)
    elif img.shape[2] == 4:
        rgba = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
    else:
        rgba = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
    rgba = np.ascontiguousarray(rgba)
    h, w = rgba.shape[:2]
    bridge.setImshowBusy()
    bridge.postImage(name, w, h, to_js(memoryview(rgba.reshape(-1))))


def _dispatch_mouse():
    q = bb.queues["mouse"]
    while q:
        ev = q.popleft()
        cb = _callbacks.get(ev["name"])
        if cb:
            fn, param = cb
            fn(int(ev["event"]), int(ev["x"]), int(ev["y"]), int(ev.get("flags", 0)), param)


def _closed_windows():
    q = bb.queues["winclose"]
    while q:
        ev = q.popleft()
        _open.discard(ev["name"])
        bb.queues["key"].append({"type": "key", "code": ord("q")})   # closing a window = quit


def waitKey(delay=0):
    end = None if delay <= 0 else time.time() + delay / 1000.0
    while True:
        bb.poll()
        _dispatch_mouse()
        _closed_windows()
        if bb.queues["key"]:
            return int(bb.queues["key"].popleft()["code"])
        if end is None:
            bb.wait(-1)
        else:
            left = end - time.time()
            if left <= 0:
                return -1
            bb.wait(max(1, int(left * 1000)))


def setMouseCallback(name, fn, param=None):
    namedWindow(name)
    _callbacks[name] = (fn, param)


def destroyWindow(name):
    _open.discard(name)
    _callbacks.pop(name, None)
    bb.send({"type": "win_close", "name": name})


def destroyAllWindows():
    for n in list(_open):
        destroyWindow(n)


def getWindowProperty(name, prop):
    bb.poll()
    _closed_windows()
    return 1.0 if name in _open else -1.0


def _noop(*a, **k):
    return None


# ---------------------------------------------------------------- camera
LINUX_AUTO = (3, 0.75)


class BrowserCapture:
    """The station's camera, rendered by the page. Behaves like a USB webcam:
    auto exposure and auto white balance drift with the scene, autofocus hunts,
    a manual focus far from the right value blurs the picture, and there is sensor noise."""
    BEST_FOCUS = 30

    def __init__(self, index=0, backend=None):
        self.props = {cv2.CAP_PROP_FRAME_WIDTH: 1280.0, cv2.CAP_PROP_FRAME_HEIGHT: 720.0,
                      cv2.CAP_PROP_AUTO_EXPOSURE: 3.0, cv2.CAP_PROP_EXPOSURE: 150.0,
                      cv2.CAP_PROP_AUTO_WB: 1.0, cv2.CAP_PROP_WB_TEMPERATURE: 4600.0,
                      cv2.CAP_PROP_AUTOFOCUS: 1.0, cv2.CAP_PROP_FOCUS: 0.0,
                      cv2.CAP_PROP_BRIGHTNESS: 128.0, cv2.CAP_PROP_CONTRAST: 32.0,
                      cv2.CAP_PROP_SATURATION: 64.0, cv2.CAP_PROP_GAIN: 0.0}
        self.opened = index == 0
        self.gain = 1.0
        self.wb = np.ones(3)
        self.blur = 0.0

    def isOpened(self):
        return self.opened

    def set(self, prop, value):
        self.props[prop] = float(value)
        return True

    def get(self, prop):
        if prop == cv2.CAP_PROP_WB_TEMPERATURE and self.props[cv2.CAP_PROP_AUTO_WB] >= 0.5:
            t = (self.wb[0] - self.wb[2]) / 0.24
            return float(min(10000, max(2000, int(4600 + 1500 * t) // 100 * 100)))
        return float(self.props.get(prop, -1))

    def grab(self):
        return self.opened

    def release(self):
        self.opened = False

    def read(self):
        if not self.opened:
            return False, None
        w = int(self.props[cv2.CAP_PROP_FRAME_WIDTH])
        h = int(self.props[cv2.CAP_PROP_FRAME_HEIGHT])
        raw = bb.request("frame", {"w": w, "h": h})
        if len(raw) != w * h * 4:
            return False, None
        img = np.frombuffer(raw, np.uint8).reshape(h, w, 4)
        frame = cv2.flip(cv2.cvtColor(img, cv2.COLOR_RGBA2BGR), 0)
        small = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA).reshape(-1, 3).astype(np.float32)
        self._exposure(small)
        self._white_balance(small)
        gains = np.array([self.wb[0], 1.0, self.wb[2]]) * self.gain
        lut = np.clip(np.arange(256)[:, None] * gains[None, :], 0, 255).astype(np.uint8).reshape(1, 256, 3)
        frame = cv2.LUT(frame, lut)
        frame = self._focus(frame)
        return True, self._noise(frame)

    _noise_cache = None

    def _noise(self, frame):
        h, w = frame.shape[:2]
        if self._noise_cache is None or self._noise_cache[0].shape[1] != w:
            rng = np.random.default_rng(1)
            n = rng.normal(0, 2.5, (h + 64, w, 3))
            BrowserCapture._noise_cache = (np.clip(n, 0, 255).astype(np.uint8), np.clip(-n, 0, 255).astype(np.uint8))
        pos, neg = self._noise_cache
        k = random.randrange(64)
        return cv2.subtract(cv2.add(frame, pos[k:k + h]), neg[k:k + h])

    def _exposure(self, small):
        v = self.props[cv2.CAP_PROP_AUTO_EXPOSURE]
        if v >= 2 or v == 0.75:   # automatic: aims for an average brightness, so a hand or the arm changes every colour
            target = 118.0 / max(10.0, float(small.mean()))
            self.gain = 0.6 * self.gain + 0.4 * target
        else:
            self.gain = max(0.05, self.props[cv2.CAP_PROP_EXPOSURE] / 150.0)

    def _white_balance(self, small):
        if self.props[cv2.CAP_PROP_AUTO_WB] >= 0.5:   # automatic: drifts with what is in view
            m = small.mean(axis=0) + 1e-3
            target = 1.0 + 0.5 * (np.array([m[1] / m[0], 1.0, m[1] / m[2]]) - 1.0)
            self.wb = 0.7 * self.wb + 0.3 * np.clip(target, 0.8, 1.25)
        else:
            t = (self.props[cv2.CAP_PROP_WB_TEMPERATURE] - 4600.0) / 1500.0
            self.wb = np.array([1.0 + 0.12 * t, 1.0, 1.0 - 0.12 * t])

    def _focus(self, frame):
        if self.props[cv2.CAP_PROP_AUTOFOCUS] >= 0.5:  # autofocus hunts now and then
            if random.random() < 0.08:
                self.blur = random.choice([0.0, 0.0, 0.8, 1.6, 2.4])
            sigma = self.blur
        else:
            sigma = abs(self.props[cv2.CAP_PROP_FOCUS] - self.BEST_FOCUS) / 12.0
        if sigma > 0.3:
            return cv2.GaussianBlur(frame, (0, 0), sigma)
        return frame


def VideoCapture(source=0, backend=None, *args):
    if isinstance(source, int):
        return BrowserCapture(source, backend)
    return _original_capture(source, *([backend] if backend is not None else []), *args)


def install():
    cv2.namedWindow = namedWindow
    cv2.imshow = imshow
    cv2.waitKey = waitKey
    cv2.waitKeyEx = waitKey
    cv2.pollKey = lambda: waitKey(1)
    cv2.setMouseCallback = setMouseCallback
    cv2.destroyWindow = destroyWindow
    cv2.destroyAllWindows = destroyAllWindows
    cv2.getWindowProperty = getWindowProperty
    for name in ("moveWindow", "resizeWindow", "setWindowTitle", "setWindowProperty", "startWindowThread"):
        setattr(cv2, name, _noop)
    cv2.VideoCapture = VideoCapture
