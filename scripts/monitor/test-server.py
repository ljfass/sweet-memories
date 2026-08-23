#!/usr/bin/env python3

import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import urlsplit


HEALTHY_HTML = b"""<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="assets/app.css">
    <script type="module" src="./assets/app.js"></script>
  </head>
  <body><div id="app"></div></body>
</html>
"""


class TestHandler(BaseHTTPRequestHandler):
    flaky_requests = 0
    flaky_lock = Lock()

    def log_message(self, format_string, *args):
        pass

    def send_body(self, status, content_type, body, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        for name, value in extra_headers or ():
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def do_GET(self):
        path = urlsplit(self.path).path

        if path == "/redirect":
            self.send_body(302, "text/plain", b"", (("Location", "/healthy/index.html"),))
            return

        if path == "/flaky":
            with self.flaky_lock:
                self.__class__.flaky_requests += 1
                request_number = self.__class__.flaky_requests
            if request_number <= 2:
                self.send_body(503, "text/plain", b"temporarily unavailable")
            else:
                self.send_body(200, "text/html; charset=utf-8", HEALTHY_HTML)
            return

        if path in ("/healthy/index.html", "/healthy/"):
            self.send_body(200, "text/html; charset=utf-8", HEALTHY_HTML)
            return

        if path in ("/healthy/assets/app.js", "/assets/app.js"):
            self.send_body(200, "text/javascript", b"console.log('healthy');\n")
            return

        if path in ("/healthy/assets/app.css", "/assets/app.css"):
            self.send_body(200, "text/css", b"#app { display: block; }\n")
            return

        if path == "/redirected-asset":
            body = b"""<!doctype html>
<html><head>
  <link rel="stylesheet" href="/assets/app.css">
  <script type="module" src="/assets/redirect.js"></script>
</head><body><div id="app"></div></body></html>
"""
            self.send_body(200, "text/html", body)
            return

        if path == "/assets/redirect.js":
            location = (
                f"http://localhost:{self.server.server_port}/assets/app.js"
            )
            self.send_body(
                302,
                "text/plain",
                b"",
                (("Location", location),),
            )
            return

        if path == "/bare-redirect-asset":
            body = b"""<!doctype html>
<html><head>
  <link rel="stylesheet" href="/assets/app.css">
  <script type="module" src="/assets/bare-redirect.js"></script>
</head><body><div id="app"></div></body></html>
"""
            self.send_body(200, "text/html", body)
            return

        if path == "/assets/bare-redirect.js":
            self.send_body(302, "text/plain", b"")
            return

        if path == "/status-500":
            self.send_body(500, "text/plain", b"server error")
            return

        if path == "/not-html":
            self.send_body(200, "application/json", b'{"status":"ok"}\n')
            return

        if path == "/missing-app":
            body = b"""<!doctype html>
<html><head>
  <link rel="stylesheet" href="/assets/app.css">
  <script type="module" src="/assets/app.js"></script>
</head><body></body></html>
"""
            self.send_body(200, "text/html", body)
            return

        if path == "/no-assets":
            self.send_body(200, "text/html", b'<div id="app"></div>\n')
            return

        if path == "/bad-resource":
            body = b"""<!doctype html>
<html><head>
  <link rel="stylesheet" href="/assets/app.css">
  <script type="module" src="/assets/missing.js"></script>
</head><body><div id="app"></div></body></html>
"""
            self.send_body(200, "text/html", body)
            return

        if path == "/slow":
            time.sleep(1)
            self.send_body(200, "text/html; charset=utf-8", HEALTHY_HTML)
            return

        self.send_body(404, "text/plain", b"not found")


def main():
    if len(sys.argv) != 2:
        print("usage: test-server.py PORT_FILE", file=sys.stderr)
        return 2

    server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
    Path(sys.argv[1]).write_text(str(server.server_port), encoding="ascii")
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
