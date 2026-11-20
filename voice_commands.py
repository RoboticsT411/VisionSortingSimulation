"""
OPTIONAL EXTRA - Voice commands (browser version).

In the online simulator, speech recognition is done by the web browser (Chrome or Edge)
instead of Vosk: allow the microphone when asked. The class has the same calls as the
lab version, so your step 4 code is the same:

    from voice_commands import VoiceListener
    voice = VoiceListener()          # starts listening
    word = voice.get()               # the newest word said, or None (never waits)
    voice.stop()

Try it on its own: run voice_commands.py and say one of the words.
Safety: a voice command is only read BETWEEN robot moves.
"""
import time
from collections import deque

import browser_bridge as bb

WORDS = ["red", "yellow", "green", "all", "go", "skip", "stop"]
MODEL_DIR = "browser speech recognition"


class VoiceListener:
    def __init__(self, words=WORDS, model_dir=MODEL_DIR, device=None):
        self.words = list(words)
        self._words = deque()
        self.last_heard = None
        r = bb.request_json("voice", {"cmd": "start", "words": self.words})
        if not r.get("ok"):
            raise SystemExit("Voice commands: " + r.get("error", "the browser cannot listen")
                             + "\nUse Chrome or Edge and allow the microphone.")
        print("Speech recognition: the browser's (allow the microphone when asked).")

    def _pump(self):
        bb.poll()
        q = bb.queues["voice"]
        while q:
            ev = q.popleft()
            text = ev.get("text", "").lower().strip()
            if not text:
                continue
            now = time.time()
            commands = [w for w in text.replace(",", " ").split() if w in self.words]
            for w in commands:
                self._words.append((w, now))
            self.last_heard = (commands[-1] if commands else text, now, bool(commands))

    def get(self, since=None):
        self._pump()
        word = None
        while self._words:
            w, t = self._words.popleft()
            if since is None or t >= since:
                word = w
        return word

    def heard_text(self):
        self._pump()
        if self.last_heard is None:
            return "Heard: nothing yet"
        text, t, is_command = self.last_heard
        ago = f"{time.time() - t:.0f} s ago"
        if is_command:
            return f'Heard: "{text}" ({ago})'
        return f'Heard: "{text}" - not a command ({ago})'

    def stop(self):
        bb.request_json("voice", {"cmd": "stop"})


def main():
    voice = VoiceListener()
    print("Listening for:", ", ".join(WORDS), "  (press Stop to end)")
    try:
        while True:
            voice._pump()
            while voice._words:
                print("heard:", voice._words.popleft()[0])
            bb.wait(500)
    except KeyboardInterrupt:
        pass
    finally:
        voice.stop()


if __name__ == "__main__":
    main()
