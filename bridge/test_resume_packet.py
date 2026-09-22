"""Tests for bridge/resume_packet.py.

The property under test is not "a file appears". It is that a failure the
runtime recorded as a completion reaches the next session as a valid v1 packet,
exactly once, with the failure still named as a failure.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SCRIPT = HERE / "resume_packet.py"

sys.path.insert(0, str(HERE))
import resume_packet  # noqa: E402
import validate_handoff  # noqa: E402


def rollout_line(kind, payload, ordinal=0, timestamp="2026-09-21T20:58:21.000Z"):
    return json.dumps({
        "timestamp": timestamp,
        "ordinal": ordinal,
        "type": kind,
        "payload": payload,
    })


def user_message(text):
    return rollout_line("response_item", {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": text}],
    })


def masked_failure(code_message="unexpected status 413 Payload Too Large: "
                                 "{\"error\":\"invalid_request_size\"}, url: http://127.0.0.1:8769/responses",
                   turn_id="01a0b7de-6a75-78b2-8d40-3258fcb1f55b"):
    return rollout_line("event_msg", {
        "type": "task_complete",
        "turn_id": turn_id,
        "last_agent_message": None,
        "error": {"message": code_message},
    }, ordinal=2)


def clean_completion():
    return rollout_line("event_msg", {
        "type": "task_complete",
        "turn_id": "01a0b7de-9999-0000-0000-000000000000",
        "last_agent_message": "done",
    }, ordinal=3)


def write_rollout(tmp_path, *lines):
    path = tmp_path / "rollout-2026-09-21T20-58-21-01a0b7de.jsonl"
    path.write_text("\n".join(lines) + "\n")
    return path


def test_masked_failure_produces_a_packet_that_validates(tmp_path):
    rollout = write_rollout(
        tmp_path,
        user_message("Implement the pre-trim guard so a session cannot exceed the proxy cap."),
        masked_failure(),
    )
    out = tmp_path / "parks"
    code = resume_packet.run_once([rollout], out, check=False, force=False, as_json=False)
    assert code == 0

    packets = list(out.glob("resume-*.json"))
    assert len(packets) == 1
    packet = json.loads(packets[0].read_text())

    assert validate_handoff.validate(packet) == []
    assert packet["lifecycle"]["continuity_assumed"] is False
    assert packet["lifecycle"]["previous_worker_ended"] is True
    assert "invalid_request_size" in packet["evidence"]["items"][0]["claim"]
    assert packet["evidence"]["items"][0]["artifact"] == str(rollout)
    assert "pre-trim guard" in packet["objective"]["statement"]
    assert packet["lookup_policy"]["backward_lookup"] == "default-off"
    # The packet must name the turn it answers, or coverage cannot be checked.
    assert packet["source"]["turn_id"] == "01a0b7de-6a75-78b2-8d40-3258fcb1f55b"
    assert packet["source"]["failure_code"] == "invalid_request_size"


def test_a_failure_is_never_recorded_as_a_completion(tmp_path):
    rollout = write_rollout(tmp_path, user_message("anything"), masked_failure())
    failures = resume_packet.scan_rollout(rollout)
    assert len(failures) == 1
    assert failures[0]["code"] == "invalid_request_size"
    packet = resume_packet.packet_for(failures[0])
    assert "unfinished" in " ".join(packet["evidence"]["still_false"])
    assert packet["next_prompt"].startswith("A previous turn in this session ended with provider error")


def test_writing_twice_writes_once(tmp_path, capsys):
    rollout = write_rollout(tmp_path, user_message("work"), masked_failure())
    out = tmp_path / "parks"
    assert resume_packet.run_once([rollout], out, check=False, force=False, as_json=False) == 0
    assert resume_packet.run_once([rollout], out, check=False, force=False, as_json=False) == 0
    assert len(list(out.glob("resume-*.json"))) == 1
    assert "present" in capsys.readouterr().out


def test_a_clean_completion_produces_no_packet(tmp_path):
    rollout = write_rollout(tmp_path, user_message("work"), clean_completion())
    out = tmp_path / "parks"
    assert resume_packet.run_once([rollout], out, check=False, force=False, as_json=False) == 0
    assert list(out.glob("resume-*.json")) == []


def test_check_mode_writes_nothing(tmp_path):
    rollout = write_rollout(tmp_path, user_message("work"), masked_failure())
    out = tmp_path / "parks"
    assert resume_packet.run_once([rollout], out, check=True, force=False, as_json=False) == 0
    assert not out.exists()


def test_provider_unavailable_is_named_not_generalised(tmp_path):
    rollout = write_rollout(tmp_path, masked_failure(
        "unexpected status 502 Bad Gateway: {\"error\":\"provider_unavailable\"}, "
        "url: http://127.0.0.1:8769/responses"))
    failures = resume_packet.scan_rollout(rollout)
    assert failures[0]["code"] == "provider_unavailable"


def test_unreadable_rollout_exits_two(tmp_path):
    missing = tmp_path / "nope.jsonl"
    proc = subprocess.run([sys.executable, str(SCRIPT), str(missing)],
                          capture_output=True, text=True, cwd=str(ROOT))
    assert proc.returncode == 2
    assert "resume_packet_unreadable" in proc.stderr


def test_cli_scan_reports_masked_failure(tmp_path, capsys):
    rollout = write_rollout(tmp_path, user_message("work"), masked_failure())
    out = tmp_path / "parks"
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), str(rollout), "--out", str(out), "--json"],
        capture_output=True, text=True, cwd=str(ROOT))
    assert proc.returncode == 0
    body = json.loads(proc.stdout)
    assert body["masked_failures"] == 1
    assert len(body["written"]) == 1
    assert body["invalid"] == []


def estate_sessions(root):
    """A sessions tree under an estate home, with one rollout inside it."""
    sessions = root / ".ao" / "uctm-studio" / "codex" / "sessions"
    sessions.mkdir(parents=True)
    rollout = sessions / "rollout-2026-09-21T20-58-21-test.jsonl"
    rollout.write_text("")
    return rollout


def test_the_scan_root_is_the_estate_home_not_home(tmp_path, monkeypatch):
    """A rewritten $HOME must not move the scan root.

    An AO worker runs with $HOME pointed at the harness home, so a root built
    from `Path.home()` names a directory that does not exist -- and a scan of a
    missing root reports zero failures, which is indistinguishable from "nothing
    to do". That silence is the failure this tool exists to break, so the root is
    asserted rather than left to whichever home the environment happened to carry.
    """
    estate = tmp_path / "estate"
    rollout = estate_sessions(estate)
    harness_home = tmp_path / "harness-home"
    harness_home.mkdir()

    monkeypatch.setenv("HOME", str(harness_home))
    monkeypatch.setenv("UCTM_ESTATE_HOME", str(estate))
    monkeypatch.delenv("UCTM_CODEX_SESSIONS", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)

    assert resume_packet.estate_home() == estate
    assert resume_packet.discover([]) == [rollout]


def test_codex_home_answers_when_the_account_database_cannot(tmp_path, monkeypatch):
    """CODEX_HOME is the harness's own name for the directory these rollouts live in.

    It is the one signal that still points at the sessions when the passwd lookup
    fails and the estate home has fallen back to the rewritten $HOME -- the case
    where every `~`-derived candidate is wrong at the same time.
    """
    codex_home = tmp_path / "codex"
    sessions = codex_home / "sessions"
    sessions.mkdir(parents=True)
    rollout = sessions / "rollout-2026-09-21T20-58-21-test.jsonl"
    rollout.write_text("")
    harness_home = tmp_path / "harness-home"
    harness_home.mkdir()

    monkeypatch.setenv("HOME", str(harness_home))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.delenv("UCTM_ESTATE_HOME", raising=False)
    monkeypatch.delenv("UCTM_CODEX_SESSIONS", raising=False)
    # The passwd answer is unavailable, so the estate home degrades to $HOME.
    monkeypatch.setattr(resume_packet, "resolve_estate_home", lambda env=None: harness_home)

    assert resume_packet.estate_home() == harness_home
    assert resume_packet.discover([]) == [rollout]


def test_no_args_is_a_usage_error():
    proc = subprocess.run([sys.executable, str(SCRIPT)],
                          capture_output=True, text=True, cwd=str(ROOT))
    assert proc.returncode == 2
    assert "usage" in proc.stderr
