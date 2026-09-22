#!/usr/bin/env python3
"""Tests for validate_handoff.py — the packet gate. Stdlib unittest."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from validate_handoff import validate, validate_return


def good_packet(artifact):
    return {
        "handoff_id": "20260921T000000000000Z-test-019fc055-15c",
        "generated_at": "2026-09-21T00:00:00+00:00",
        "scope": "turn",
        "lifecycle": {"continuity_assumed": False, "previous_worker_ended": True},
        "objective": {"statement": "Prove the gate.", "route": ["write", "run"],
                      "stop_gates": ["green"]},
        "evidence": {"items": [{"claim": "validator exists", "artifact": artifact,
                                "command": "ls"}],
                     "still_false": [], "open_questions": []},
        "next_prompt": "Next worker: extend the gate.",
        "stop_condition": "All cases green.",
        "lookup_policy": {"backward_lookup": "default-off"},
        "writer": {"model": "deepseek-chat", "worker": "test"},
    }


def good_return(artifact, handoff_id="20260921T000000000000Z-test-019fc055-15c"):
    return {
        "handoff_id": handoff_id,
        "generated_at": "2026-09-21T00:05:00+00:00",
        "worker": "local-worker-1",
        "tool_trajectory": ["fetch_resource", "run_container", "submit_result"],
        "artifacts": [artifact],
        "stop_condition_satisfied": True,
    }


class ValidateHandoffTests(unittest.TestCase):
    def test_valid_packet_passes(self):
        with tempfile.NamedTemporaryFile() as f:
            self.assertEqual(validate(good_packet(f.name)), [])

    def test_missing_key_fails(self):
        with tempfile.NamedTemporaryFile() as f:
            p = good_packet(f.name)
            del p["next_prompt"]
            self.assertTrue(any("next_prompt" in e for e in validate(p)))

    def test_continuity_true_rejected(self):
        with tempfile.NamedTemporaryFile() as f:
            p = good_packet(f.name)
            p["lifecycle"]["continuity_assumed"] = True
            self.assertTrue(any("continuity_assumed" in e for e in validate(p)))

    def test_missing_artifact_rejected(self):
        p = good_packet("/definitely/not/here-019fc055.json")
        self.assertTrue(any("missing on disk" in e for e in validate(p)))

    def test_missing_artifact_allowed_when_skipped(self):
        p = good_packet("/definitely/not/here-019fc055.json")
        self.assertEqual(validate(p, check_artifacts=False), [])

    def test_empty_claim_rejected(self):
        with tempfile.NamedTemporaryFile() as f:
            p = good_packet(f.name)
            p["evidence"]["items"][0]["claim"] = "  "
            self.assertTrue(any("claim" in e for e in validate(p)))

    def test_bad_lookup_rejected(self):
        with tempfile.NamedTemporaryFile() as f:
            p = good_packet(f.name)
            p["lookup_policy"]["backward_lookup"] = "rummage-freely"
            self.assertTrue(any("backward_lookup" in e for e in validate(p)))


class ValidateReturnTests(unittest.TestCase):
    """The return gate: does the answer belong to the question, and is it real."""

    def test_valid_return_passes(self):
        with tempfile.NamedTemporaryFile() as f:
            self.assertEqual(validate_return(good_return(f.name)), [])

    def test_artifact_object_form_accepted(self):
        with tempfile.NamedTemporaryFile() as f:
            item = {"path": f.name, "role": "result"}
            self.assertEqual(validate_return(good_return(item)), [])

    def test_artifact_missing_on_disk_rejected(self):
        p = good_return("/definitely/not/here-return-019fc055.json")
        self.assertTrue(any("missing on disk" in e for e in validate_return(p)))

    def test_missing_handoff_id_rejected(self):
        p = good_return("/tmp")
        del p["handoff_id"]
        self.assertTrue(any("handoff_id" in e for e in validate_return(p)))

    def test_empty_trajectory_rejected(self):
        p = good_return("/tmp")
        p["tool_trajectory"] = []
        self.assertTrue(any("tool_trajectory" in e for e in validate_return(p)))

    def test_stop_condition_must_be_bool(self):
        p = good_return("/tmp")
        p["stop_condition_satisfied"] = "yes"
        self.assertTrue(any("stop_condition_satisfied" in e for e in validate_return(p)))

    def test_unmet_stop_condition_is_still_a_valid_return(self):
        p = good_return("/tmp")
        p["stop_condition_satisfied"] = False
        self.assertEqual(validate_return(p), [])

    def test_handoff_id_must_match_the_dispatch(self):
        with tempfile.NamedTemporaryFile() as f:
            dispatch = {"handoff_id": "dispatch-abc"}
            ok = validate_return(good_return(f.name, handoff_id="dispatch-abc"),
                                 dispatch_packet=dispatch)
            self.assertEqual(ok, [])
            bad = validate_return(good_return(f.name, handoff_id="dispatch-XYZ"),
                                  dispatch_packet=dispatch)
            self.assertTrue(any("does not match" in e for e in bad))

    def test_dispatch_direction_unchanged(self):
        with tempfile.NamedTemporaryFile() as f:
            self.assertEqual(validate(good_packet(f.name)), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
