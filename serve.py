"""Serves the simulator on this PC:  python serve.py . 8765   then open http://127.0.0.1:8765/index.html

Sends the two headers Python-in-the-browser needs (cross-origin isolation), and the right file
types: on Windows, Python takes them from the registry, which often calls .js files "text/plain",
and the browser then refuses to run them (the page stays on "Loading...")."""
import functools
import http.server
import os
import sys

TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
         ".wasm": "application/wasm", ".html": "text/html", ".css": "text/css", ".png": "image/png",
         ".svg": "image/svg+xml", ".zip": "application/zip", ".whl": "application/zip", ".tar": "application/x-tar"}


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def guess_type(self, path):
        ext = os.path.splitext(str(path))[1].lower()
        return TYPES.get(ext) or super().guess_type(path)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    folder = sys.argv[1] if len(sys.argv) > 1 else "."
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
    os.chdir(folder)
    print(f"Serving {os.getcwd()} at http://127.0.0.1:{port}/index.html  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
