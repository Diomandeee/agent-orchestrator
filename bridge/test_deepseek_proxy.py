"""Synthetic-only contract tests for the loopback provider transport."""

import io
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from deepseek_proxy import Handler, ThreadingHTTPServer


class FakeResponse:
    status = 200
    headers = {"Content-Type": "application/json"}

    def __init__(self):
        self.stream = io.BytesIO(b'{"id":"synthetic"}')

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, amount):
        return self.stream.read(amount)


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.proxy_token = "synthetic-local-token"
        self.server.provider_key = "synthetic-provider-secret"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_health_and_unauthorized_requests(self):
        with urlopen(self.base + "/healthz") as response:
            self.assertIn(b'"service":"uctm-deepseek-proxy"', response.read())
        request = Request(self.base + "/responses", data=b"{}", method="POST")
        with self.assertRaises(HTTPError) as caught:
            urlopen(request)
        self.assertEqual(caught.exception.code, 401)
        caught.exception.close()

    def test_authorized_request_forwards_only_upstream(self):
        calls = []

        def fake_upstream(request, timeout):
            calls.append((request.full_url, request.data, request.get_header("Authorization"), timeout))
            return FakeResponse()

        request = Request(self.base + "/responses", data=b'{"model":"deepseek-flash"}',
                          method="POST", headers={"Authorization": "Bearer synthetic-local-token"})
        with patch("deepseek_proxy.urlopen", side_effect=fake_upstream):
            with urlopen(request) as response:
                self.assertEqual(response.read(), b'{"id":"synthetic"}')
        self.assertEqual(calls, [(
            "https://api.deepseek.com/responses", b'{"model":"deepseek-flash"}',
            "Bearer synthetic-provider-secret", 120,
        )])


if __name__ == "__main__":
    unittest.main()
