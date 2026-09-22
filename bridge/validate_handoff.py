#!/usr/bin/env python3
"""Validate a stateless handoff packet (docs/uctm/handoff-packet.schema.json).

Stdlib only. Beyond shape, it enforces the two semantic rules that make the
anti-hallucination claim real:
  1. continuity_assumed must be false (a worker that cannot remember cannot
     misremember — any packet claiming continuity is rejected).
  2. every evidence artifact path must exist on disk (claims point at live
     artifacts, not prose).

Two directions, one gate:
  dispatch (default) — a packet going out to a worker.
  return (--return)  — the packet coming back, which must name the dispatch it
    answers, list a tool trajectory, and point at artifacts that exist on disk.
  A return with stop_condition_satisfied false is VALID but UNMET (an explicit
  failure note is a legal return; silence is not).

Usage: validate_handoff.py <packet.json> [--return] [--dispatch <dispatch.json>]
                           [--no-artifact-check]
Exit 0 valid, 1 invalid (reasons on stdout), 2 unreadable.
"""

import json
import os
import sys

REQUIRED_TOP = ("handoff_id", "generated_at", "lifecycle", "objective",
                "evidence", "next_prompt", "stop_condition")


def validate(packet, check_artifacts=True):
    errors = []
    if not isinstance(packet, dict):
        return ["packet must be a JSON object"]
    for key in REQUIRED_TOP:
        if key not in packet:
            errors.append(f"missing required key: {key}")
    if errors:
        return errors

    life = packet["lifecycle"]
    if not isinstance(life, dict) or life.get("continuity_assumed") is not False:
        errors.append("lifecycle.continuity_assumed must be false")

    obj = packet["objective"]
    if not isinstance(obj, dict) or not str(obj.get("statement", "")).strip():
        errors.append("objective.statement must be non-empty")

    ev = packet["evidence"]
    if not isinstance(ev, dict) or not isinstance(ev.get("items"), list):
        errors.append("evidence.items must be a list")
    else:
        for i, item in enumerate(ev["items"]):
            if not isinstance(item, dict):
                errors.append(f"evidence.items[{i}] must be an object")
                continue
            if not str(item.get("claim", "")).strip():
                errors.append(f"evidence.items[{i}].claim must be non-empty")
            artifact = str(item.get("artifact", "")).strip()
            if not artifact:
                errors.append(f"evidence.items[{i}].artifact must be non-empty")
            elif check_artifacts and not os.path.exists(os.path.expanduser(artifact)):
                errors.append(f"evidence.items[{i}].artifact missing on disk: {artifact}")

    if not str(packet.get("next_prompt", "")).strip():
        errors.append("next_prompt must be non-empty")
    if not str(packet.get("stop_condition", "")).strip():
        errors.append("stop_condition must be non-empty")

    lookup = packet.get("lookup_policy", {})
    if lookup and lookup.get("backward_lookup", "default-off") not in (
            "default-off", "named-artifact-only"):
        errors.append("lookup_policy.backward_lookup must be default-off or named-artifact-only")
    return errors


REQUIRED_RETURN = ("handoff_id", "worker", "tool_trajectory", "artifacts",
                   "stop_condition_satisfied")


def return_artifact_path(item):
    """A return artifact is a path string or an object carrying a path."""
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        return str(item.get("path", "")).strip()
    return ""


def validate_return(packet, check_artifacts=True, dispatch_packet=None):
    """Validate the packet a worker sends back.

    The dispatch gate proves a work order is well-formed. This gate proves the
    answer is *about* that order: it names the dispatch it answers, records how
    the work was done, and points at artifacts that exist on disk. It cannot
    prove the work was done well — only that something real was produced and
    the claim is inspectable.
    """
    errors = []
    if not isinstance(packet, dict):
        return ["return packet must be a JSON object"]
    for key in REQUIRED_RETURN:
        if key not in packet:
            errors.append(f"missing required key: {key}")
    if errors:
        return errors

    if not str(packet.get("handoff_id", "")).strip():
        errors.append("handoff_id must be non-empty")
    elif dispatch_packet is not None:
        expected = str(dispatch_packet.get("handoff_id", "")).strip()
        if not expected:
            errors.append("dispatch packet has no handoff_id to match against")
        elif str(packet["handoff_id"]).strip() != expected:
            errors.append(f"handoff_id does not match the dispatch packet: "
                          f"{packet['handoff_id']} != {expected}")

    if not str(packet.get("worker", "")).strip():
        errors.append("worker must be non-empty")

    traj = packet.get("tool_trajectory")
    if not isinstance(traj, list) or not traj:
        errors.append("tool_trajectory must be a non-empty list")
    else:
        for i, step in enumerate(traj):
            if not str(step).strip():
                errors.append(f"tool_trajectory[{i}] must be non-empty")

    arts = packet.get("artifacts")
    if not isinstance(arts, list) or not arts:
        errors.append("artifacts must be a non-empty list")
    else:
        for i, item in enumerate(arts):
            path = return_artifact_path(item)
            if not path:
                errors.append(f"artifacts[{i}] must be a path or an object with a path")
            elif check_artifacts and not os.path.exists(os.path.expanduser(path)):
                errors.append(f"artifacts[{i}] missing on disk: {path}")

    if not isinstance(packet.get("stop_condition_satisfied"), bool):
        errors.append("stop_condition_satisfied must be true or false")
    return errors


def main():
    USAGE = ("usage: validate_handoff.py <packet.json> [--return] "
             "[--dispatch <dispatch.json>] [--no-artifact-check]")
    args = sys.argv[1:]
    if not args or args[0].startswith("--"):
        print(USAGE)
        return 2
    mode_return = "--return" in args
    check_artifacts = "--no-artifact-check" not in args
    dispatch_packet = None
    if "--dispatch" in args:
        i = args.index("--dispatch")
        if i + 1 >= len(args):
            print(USAGE)
            return 2
        try:
            with open(os.path.expanduser(args[i + 1])) as f:
                dispatch_packet = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            print(f"unreadable dispatch packet: {e}")
            return 2
    try:
        with open(args[0]) as f:
            packet = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"unreadable: {e}")
        return 2
    if mode_return:
        errors = validate_return(packet, check_artifacts=check_artifacts,
                                 dispatch_packet=dispatch_packet)
    else:
        errors = validate(packet, check_artifacts=check_artifacts)
    if errors:
        print("INVALID:")
        for e in errors:
            print(f"  - {e}")
        return 1
    if mode_return:
        state = "MET" if packet.get("stop_condition_satisfied") is True else "UNMET"
        print(f"VALID return: {packet.get('handoff_id')} "
              f"({len(packet.get('artifacts', []))} artifacts, "
              f"{len(packet.get('tool_trajectory', []))} steps, "
              f"stop condition {state})")
    else:
        print(f"VALID: {packet.get('handoff_id')} "
              f"({len(packet['evidence']['items'])} evidence items, "
              f"scope={packet.get('scope', 'turn')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
