#!/usr/bin/env python3
"""Loopback Responses transport: the real provider key never enters Codex's env."""

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
import traceback
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, "/Users/mohameddiomande/Developer/UCTM/bridge")
from keychain import Keychain

PORT = 8769
UPSTREAM = "https://api.deepseek.com/responses"
ACCOUNT_ENDPOINT = "https://api.deepseek.com/chat/completions"
# Must exceed the model context window in BYTES, not tokens: image/base64-heavy
# turns reach ~16 bytes per token, and a 2 MiB cap fired at 56% of a 258k window -
# below the token threshold where the harness compacts, so the turn just failed.
# Overridable at launch without a code change (bytes); falls back to the default
# when the variable is absent or unparsable.
def _max_request_bytes():
    try:
        configured = int(os.environ.get("UCTM_PROXY_MAX_REQUEST_BYTES", ""))
        if configured > 0:
            return configured
    except (TypeError, ValueError):
        pass
    return 16 * 1024 * 1024


MAX_REQUEST_BYTES = _max_request_bytes()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        pass

    def respond(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self.respond(200, b'{"service":"uctm-deepseek-proxy","ready":true}')
        else:
            self.respond(404, b'{"error":"not_found"}')

    def do_POST(self):
        if self.path != "/responses":
            self.respond(404, b'{"error":"not_found"}')
            return
        if self.headers.get("Authorization") != "Bearer " + self.server.proxy_token:
            self.respond(401, b'{"error":"unauthorized"}')
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_REQUEST_BYTES:
            # Structured rejection: the codex host surfaces error.message back to
            # the agent, so the turn can compact/truncate and retry instead of
            # blind-retrying the same oversized payload. The "error" key keeps
            # backwards compatibility with existing log classifiers.
            print(f"uctm_proxy_reject: path=/responses received={length} "
                  f"limit={MAX_REQUEST_BYTES}", file=sys.stderr)
            self.respond(413, json.dumps({
                "error": "invalid_request_size",
                "code": "request_too_large",
                "limit_bytes": MAX_REQUEST_BYTES,
                "received_bytes": length,
                "hint": "request exceeded the proxy byte cap; compact the "
                        "transcript and truncate large tool outputs, then retry",
            }).encode())
            return
        payload = self.rfile.read(length)
        upstream = Request(UPSTREAM, data=payload, method="POST", headers={
            "Authorization": "Bearer " + self.server.provider_key,
            "Content-Type": "application/json",
            "Accept": self.headers.get("Accept", "text/event-stream"),
            "Accept-Encoding": "identity",
        })
        try:
            response = urlopen(upstream, timeout=120)
        except HTTPError as error:
            body = error.read(MAX_REQUEST_BYTES)
            self.respond(error.code, body)
            return
        except URLError:
            self.respond(502, b'{"error":"provider_unavailable"}')
            return
        with response:
            self.send_response(response.status)
            self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                while chunk := response.read(16384):
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    token = sys.stdin.readline(256).strip()
    if len(token) < 32:
        return 2
    account = hashlib.sha256(json.dumps(
        [ACCOUNT_ENDPOINT, "DEEPSEEK_API_KEY"], separators=(",", ":")
    ).encode()).hexdigest().encode()
    key = Keychain().get(account)
    if not key:
        return 2
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.proxy_token = token
    server.provider_key = key.decode("ascii")
    server.serve_forever(poll_interval=0.2)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        line = traceback.extract_tb(error.__traceback__)[-1].lineno
        print(f"uctm_proxy_start_failed:{type(error).__name__}:line_{line}", file=sys.stderr)
        raise SystemExit(3)
