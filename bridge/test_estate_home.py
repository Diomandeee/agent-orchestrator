"""Tests for bridge/estate_home.py and the shim's export of it.

The defect under test is not "a path is wrong". It is that a rewritten $HOME is
invisible: the wrong path exists, looks normal, and answers "not configured".
So these tests pin that the true home is named, that a stale name is refused,
and that the rewrite is announced rather than discovered.
"""

import io
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import estate_home  # noqa: E402


def test_named_home_wins_when_it_exists(tmp_path):
    named = tmp_path / "estate"
    named.mkdir()
    env = {"HOME": "/isolated/home", "UCTM_ESTATE_HOME": str(named)}
    assert estate_home.resolve(env) == named


def test_a_stale_name_is_refused(tmp_path, monkeypatch):
    # A name that points nowhere is worse than no name: it would silently
    # redirect every path built from it.
    monkeypatch.setattr(estate_home, "_passwd", lambda env=None: tmp_path)
    env = {"HOME": "/isolated/home", "UCTM_ESTATE_HOME": str(tmp_path / "gone")}
    assert estate_home.resolve(env) == tmp_path


def test_passwd_answers_when_home_is_rewritten(tmp_path, monkeypatch):
    monkeypatch.setattr(estate_home, "_passwd", lambda env=None: tmp_path)
    assert estate_home.resolve({"HOME": "/isolated/home"}) == tmp_path


def test_home_is_the_last_resort(monkeypatch):
    monkeypatch.setattr(estate_home, "_passwd", lambda env=None: None)
    assert estate_home.resolve({"HOME": "/only/answer"}) == Path("/only/answer")


def test_rewrite_is_detected(tmp_path, monkeypatch):
    monkeypatch.setattr(estate_home, "_passwd", lambda env=None: tmp_path)
    assert estate_home.is_rewritten({"HOME": "/isolated/home"}) is True
    assert estate_home.is_rewritten({"HOME": str(tmp_path)}) is False


def test_warning_names_both_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(estate_home, "_passwd", lambda env=None: tmp_path)
    stream = io.StringIO()
    assert estate_home.warn_if_rewritten({"HOME": "/isolated/home"}, stream=stream) is True
    line = stream.getvalue()
    assert "estate_home_rewritten" in line
    assert "/isolated/home" in line and str(tmp_path) in line
    assert "UCTM_ESTATE_HOME" in line


def test_no_warning_when_nothing_is_rewritten(tmp_path, monkeypatch):
    monkeypatch.setattr(estate_home, "_passwd", lambda env=None: tmp_path)
    stream = io.StringIO()
    assert estate_home.warn_if_rewritten({"HOME": str(tmp_path)}, stream=stream) is False
    assert stream.getvalue() == ""


def test_shim_names_the_estate_home_to_the_session_it_spawns():
    """The spawn shim is the one place that can answer this for every child.

    Asserted at the source level on purpose: the shim execs the host binary, so
    there is no return value to inspect. Losing this line is how the trap
    returns, which is what the test is for.
    """
    source = (HERE / "codex").read_text()
    assert 'os.environ["HOME"] = ISOLATED_HOME' in source
    assert 'os.environ["UCTM_ESTATE_HOME"] = estate' in source
    assert "estate = real_home()" in source
