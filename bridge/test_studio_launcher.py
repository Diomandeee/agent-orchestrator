"""Synthetic-only tests for the launcher's state-directory resolution.

The failure this guards against is not "a wrong path" but a silent one: when
$HOME is rewritten, a home-derived state directory does not exist, so every
"configured?" answer becomes missing and both context cards are exported empty.
"""

import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import studio_launcher
from studio_launcher import (
    PROXY,
    _passwd_home,
    missing_card_warnings,
    proxy_reuse_reasons,
    resolve_state_dir,
    state_dir_candidates,
)


class StateDirTests(unittest.TestCase):
    def test_ao_data_dir_wins_over_a_rewritten_home(self):
        # AO_DATA_DIR is the launcher's own export (STATE/data), so its parent is
        # the state directory of the instance that spawned the caller.
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "uctm-studio"
            harness = Path(tmp) / "harness-home"
            (state / "data").mkdir(parents=True)
            harness.mkdir()
            candidates = state_dir_candidates(
                {"HOME": str(harness), "AO_DATA_DIR": str(state / "data")})
            self.assertEqual(resolve_state_dir(candidates=candidates), state)

    def test_the_account_home_is_the_last_candidate(self):
        # The fallback exists because Path.home() follows $HOME, which the worker
        # harness rewrites.
        passwd = _passwd_home()
        if passwd is None:
            self.skipTest("no account database on this host")
        candidates = state_dir_candidates({"HOME": "/nonexistent/harness-home"})
        self.assertGreaterEqual(len(candidates), 2)
        self.assertEqual(candidates[-1], passwd / ".ao" / "uctm-studio")

    def test_an_explicit_state_dir_wins_before_it_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            explicit = Path(tmp) / "not-created-yet"
            self.assertEqual(resolve_state_dir(explicit=str(explicit)), explicit)

    def test_a_missing_world_keeps_the_first_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            candidates = [Path(tmp) / "first", Path(tmp) / "second"]
            self.assertEqual(resolve_state_dir(candidates=candidates), candidates[0])
            self.assertFalse(candidates[0].exists())


class CardWarningTests(unittest.TestCase):
    def test_an_absent_card_is_named_rather_than_exported_empty(self):
        # Both cards are exported as "" when missing, so the only signal a human
        # or an agent gets is the one this produces.
        with tempfile.TemporaryDirectory() as tmp:
            present = Path(tmp) / "permitted-context.md"
            present.write_text("card\n")
            absent = Path(tmp) / "orientation.md"

            self.assertEqual(missing_card_warnings(present, present), [])

            warnings = missing_card_warnings(present, absent)
            self.assertEqual(len(warnings), 1)
            self.assertIn("orientation card", warnings[0])
            self.assertIn(str(absent), warnings[0])

            both = missing_card_warnings(absent, absent)
            self.assertEqual(len(both), 2)


class ProxyReuseTests(unittest.TestCase):
    def test_a_healthy_recorded_proxy_is_reused_with_no_reason(self):
        # The real PROXY constant, because the guard's own predicate is a substring
        # match on the command line -- a stand-in path would test the stand-in.
        self.assertEqual(proxy_reuse_reasons(4242, True, True, f"python3 {PROXY}"), [])
        self.assertEqual(proxy_reuse_reasons(4242, True, True, f"python3 {PROXY} --port 8769"), [])

    def test_each_missing_input_is_named_separately(self):
        # A rotated token 401s every live session, so the log has to say which of the
        # four inputs failed; "it restarted again" is not a diagnosis.
        self.assertEqual(proxy_reuse_reasons(None, True, True, None),
                         ["no usable pid in proxy.pid"])
        self.assertEqual(proxy_reuse_reasons(4242, False, True, None),
                         ["proxy-token file missing"])
        self.assertEqual(proxy_reuse_reasons(4242, True, False, None),
                         ["health check did not answer as the proxy"])
        self.assertEqual(proxy_reuse_reasons(4242, True, True, ""),
                         ["pid 4242 is running something else"])

    def test_several_failures_are_reported_together_rather_than_first_only(self):
        reasons = proxy_reuse_reasons(0, False, False, None)
        self.assertEqual(len(reasons), 3)
        self.assertIn("no usable pid in proxy.pid", reasons)
        self.assertIn("proxy-token file missing", reasons)


if __name__ == "__main__":
    unittest.main()


class _ProcessStub:
    """A spawned proxy that never exits and never is, unless it is told to be."""

    def __init__(self, pid=4242, alive=True):
        self.stdin = io.BytesIO()
        self.pid = pid
        self._alive = alive
        self.terminated = False

    def poll(self):
        return None if self._alive else 1

    def terminate(self):
        self.terminated = True
        self._alive = False


class ProxyRotationTests(unittest.TestCase):
    """The rotation ordering, with the socket, the spawn and the token file faked.

    Both properties are about what is on disk when the call returns, because the
    failure they prevent is invisible from the call site: a rotated token the live
    proxy has never seen looks exactly like a healthy restart until a session 401s.
    """

    def test_a_healthy_proxy_is_reused_even_with_a_stale_pid_file(self):
        # The out-of-band restart: the proxy is up and holds the token in the file, but
        # proxy.pid still names whatever started it before. Reuse is the safe answer --
        # the file and the process still agree -- and the stale pid is repaired or named.
        with tempfile.TemporaryDirectory() as tmp:
            token = Path(tmp) / "proxy-token"
            token.write_text("live-token\n")
            with mock.patch.object(studio_launcher, "PROXY_TOKEN_FILE", token), \
                 mock.patch.object(studio_launcher, "PROXY_PID_FILE", Path(tmp) / "proxy.pid"), \
                 mock.patch.object(studio_launcher, "proxy_ready", lambda: True), \
                 mock.patch.object(studio_launcher, "listener_pid", lambda *a, **k: None), \
                 mock.patch("sys.stderr", new=io.StringIO()):
                self.assertTrue(studio_launcher.ensure_proxy())
            self.assertEqual(token.read_text(), "live-token\n")

    def test_a_rotation_that_cannot_start_leaves_the_previous_token_in_place(self):
        # The spawn dies because the port is already bound (the flaky-probe case). Under
        # the old ordering the token file had already been overwritten, so the daemon
        # authenticated with a token the live proxy had never seen.
        with tempfile.TemporaryDirectory() as tmp:
            token = Path(tmp) / "proxy-token"
            token.write_text("live-token\n")
            pid_file = Path(tmp) / "proxy.pid"
            with mock.patch.object(studio_launcher, "PROXY_TOKEN_FILE", token), \
                 mock.patch.object(studio_launcher, "PROXY_PID_FILE", pid_file), \
                 mock.patch.object(studio_launcher, "LOG_FILE", Path(tmp) / "proxy.log"), \
                 mock.patch.object(studio_launcher, "proxy_ready", lambda: False), \
                 mock.patch.object(studio_launcher, "subprocess") as proc, \
                 mock.patch("sys.stderr", new=io.StringIO()):
                proc.Popen.return_value = _ProcessStub(alive=False)
                proc.PIPE = studio_launcher.subprocess.PIPE
                self.assertFalse(studio_launcher.ensure_proxy())
            self.assertEqual(token.read_text(), "live-token\n")
            self.assertFalse(pid_file.exists())

    def test_a_rotation_that_answers_health_writes_both_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            token = Path(tmp) / "proxy-token"
            token.write_text("old-token\n")
            pid_file = Path(tmp) / "proxy.pid"
            probes = {"n": 0}

            def health():
                probes["n"] += 1
                return probes["n"] > 1

            with mock.patch.object(studio_launcher, "PROXY_TOKEN_FILE", token), \
                 mock.patch.object(studio_launcher, "PROXY_PID_FILE", pid_file), \
                 mock.patch.object(studio_launcher, "LOG_FILE", Path(tmp) / "proxy.log"), \
                 mock.patch.object(studio_launcher, "proxy_ready", health), \
                 mock.patch.object(studio_launcher, "subprocess") as proc, \
                 mock.patch("sys.stderr", new=io.StringIO()):
                proc.Popen.return_value = _ProcessStub()
                proc.PIPE = studio_launcher.subprocess.PIPE
                self.assertTrue(studio_launcher.ensure_proxy())
            self.assertNotEqual(token.read_text().strip(), "old-token")
            self.assertEqual(pid_file.read_text().strip(), '{"pid": 4242}')
            self.assertEqual(token.stat().st_mode & 0o777, 0o600)

    def test_a_rotation_that_never_answers_health_is_stopped_not_left_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            token = Path(tmp) / "proxy-token"
            token.write_text("live-token\n")
            stub = _ProcessStub()
            with mock.patch.object(studio_launcher, "PROXY_TOKEN_FILE", token), \
                 mock.patch.object(studio_launcher, "PROXY_PID_FILE", Path(tmp) / "proxy.pid"), \
                 mock.patch.object(studio_launcher, "LOG_FILE", Path(tmp) / "proxy.log"), \
                 mock.patch.object(studio_launcher, "proxy_ready", lambda: False), \
                 mock.patch.object(studio_launcher, "subprocess") as proc, \
                 mock.patch.object(studio_launcher.time, "sleep", lambda _s: None), \
                 mock.patch("sys.stderr", new=io.StringIO()):
                proc.Popen.return_value = stub
                proc.PIPE = studio_launcher.subprocess.PIPE
                self.assertFalse(studio_launcher.ensure_proxy())
            self.assertTrue(stub.terminated)
            self.assertEqual(token.read_text(), "live-token\n")

    def test_the_reuse_decision_costs_nothing_when_either_input_is_missing(self):
        self.assertTrue(studio_launcher.proxy_reuse_decision(True, True))
        self.assertFalse(studio_launcher.proxy_reuse_decision(True, False))
        self.assertFalse(studio_launcher.proxy_reuse_decision(False, True))
        self.assertFalse(studio_launcher.proxy_reuse_decision(False, False))
