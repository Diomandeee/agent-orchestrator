"""Synthetic-only tests for the codex shim's skills seeding.

Sessions run with HOME rewritten to the isolated home, so `~/.codex/skills`
resolves to a near-empty directory and every chain written with `~` fails
silently. The shim snapshots the real skills in at spawn; these tests pin the
snapshot semantics with fake trees, never the real homes.
"""

import importlib.util
import io
import os
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock


def load_shim():
    # The shim is extensionless, so no loader can be inferred: name one.
    path = Path(__file__).with_name("codex")
    loader = SourceFileLoader("codex_shim", str(path))
    spec = importlib.util.spec_from_file_location("codex_shim", path, loader=loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


codex_shim = load_shim()


def make_src(root):
    src = root / "real-skills"
    (src / "swiftui-pro").mkdir(parents=True)
    (src / "swiftui-pro" / "SKILL.md").write_text("# synthetic skill\n")
    (src / "adi").mkdir()
    (src / "adi" / "SKILL.md").write_text("# synthetic skill\n")
    return src


class SeedTests(unittest.TestCase):
    def test_a_fresh_destination_gets_the_full_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = make_src(Path(tmp))
            dest = Path(tmp) / "iso" / ".codex" / "skills"
            with mock.patch("sys.stderr", new=io.StringIO()):
                self.assertTrue(codex_shim.seed_isolated_skills(dest=dest, src=src))
            self.assertEqual(
                (dest / "swiftui-pro" / "SKILL.md").read_text(), "# synthetic skill\n")
            self.assertTrue((dest / "adi" / "SKILL.md").is_file())

    def test_a_nonempty_destination_is_overlaid_never_wiped(self):
        # A previous session wrote here; the seed must add the real skills
        # while preserving session files -- never deleting a tree another
        # live session may be reading.
        with tempfile.TemporaryDirectory() as tmp:
            src = make_src(Path(tmp))
            dest = Path(tmp) / "iso" / ".codex" / "skills"
            dest.mkdir(parents=True)
            session_file = dest / "session-report.json"
            session_file.write_text('{"synthetic": true}')
            with mock.patch("sys.stderr", new=io.StringIO()):
                self.assertTrue(codex_shim.seed_isolated_skills(dest=dest, src=src))
            self.assertTrue((dest / "swiftui-pro" / "SKILL.md").is_file())
            self.assertEqual(session_file.read_text(), '{"synthetic": true}')

    def test_a_missing_source_is_a_named_nonfatal_skip(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "iso" / ".codex" / "skills"
            with mock.patch("sys.stderr", new=io.StringIO()) as stderr:
                self.assertFalse(codex_shim.seed_isolated_skills(
                    dest=dest, src=Path(tmp) / "absent"))
            self.assertIn("uctm_codex_skills_seed_failed", stderr.getvalue())
            self.assertFalse(dest.exists())

    def test_an_unresolvable_home_is_a_named_nonfatal_skip(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "iso" / ".codex" / "skills"
            with mock.patch.object(codex_shim, "real_skills_dir", lambda: None), \
                 mock.patch("sys.stderr", new=io.StringIO()) as stderr:
                self.assertFalse(codex_shim.seed_isolated_skills(dest=dest))
            self.assertIn("uctm_codex_skills_seed_skipped", stderr.getvalue())

    def test_the_seed_never_writes_into_the_real_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = make_src(Path(tmp))
            before = sorted(p.relative_to(src).as_posix() for p in src.rglob("*"))
            dest = Path(tmp) / "iso" / ".codex" / "skills"
            dest.mkdir(parents=True)
            (dest / "stale-entry").mkdir()
            with mock.patch("sys.stderr", new=io.StringIO()):
                codex_shim.seed_isolated_skills(dest=dest, src=src)
            after = sorted(p.relative_to(src).as_posix() for p in src.rglob("*"))
            self.assertEqual(before, after)

    def test_real_home_comes_from_passwd_not_the_environment(self):
        import pwd
        with mock.patch.dict(os.environ, {"HOME": "/nonexistent/harness-home"}):
            self.assertEqual(
                codex_shim.real_home(), pwd.getpwuid(os.getuid()).pw_dir)


if __name__ == "__main__":
    unittest.main()
