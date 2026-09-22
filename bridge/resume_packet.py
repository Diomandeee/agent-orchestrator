#!/usr/bin/env python3
"""Turn a masked failure into a resume packet.

The Codex app-server records a provider failure as an event that still carries
the completion shape: `task_complete` with an `error` object and
`last_agent_message: null`. AO does not parse that event, so the runtime's own
record says the turn finished when it did not, and the next session is told by
hand to "pick up where codex left off".

`docs/uctm/handoff-packet.schema.json` already declares the rule this tool
enforces: "A turn without a valid packet is a failed turn." This writes that
packet, in that schema, so the failure travels as an artifact instead of a
sentence.

What it does NOT do: it does not change what the provider records, and it does
not claim the turn succeeded. A packet with unmet work is a legal packet; silence
is not.

Usage:
  resume_packet.py --scan [--out DIR] [--check] [--force] [--json]
  resume_packet.py <rollout.jsonl> [--out DIR] [--check] [--force]
  resume_packet.py --scan --watch [--interval SECONDS]

Exit codes: 0 nothing to do or every packet written and valid,
            1 a packet was produced that does not validate,
            2 an input could not be read.
"""

import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from glob import glob
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from estate_home import resolve as resolve_estate_home  # noqa: E402

ROOT = HERE.parent
DEFAULT_OUT = HERE / "parks"

MASKED_HINT = '"task_complete"'
ERROR_HINT = '"error"'
USER_HINT = '"response_item"'

# A resume objective of "continue" tells the next worker nothing. The last
# instruction is only used when it still says what the turn was for.
TRIVIAL = {
    "continue", "ok", "okay", "yes", "no", "go", "go ahead", "do it", "yes please",
    "continue please", "proceed", "next", "keep going", "sure", "yep", "yup",
}
MIN_OBJECTIVE = 40

# Harness markers ride in the same role as an instruction. A resume objective of
# "<turn_aborted> The user interrupted…" is a restatement of the failure, not the
# work, so markers are never allowed to become the objective.
MARKERS = ("<turn_aborted>", "<environment_context>", "<user_instructions>",
           "<local-command", "interrupted the previous turn on purpose")


def is_marker(text):
    head = text.lstrip()[:60].lower()
    return head.startswith("<") or any(m in text[:120] for m in MARKERS)


def estate_home():
    """The estate home, from the one shared resolver rather than a private copy."""
    return resolve_estate_home()


def error_code(message):
    """The provider's own stable word for the failure, when it gave one."""
    for marker in ('"error":"', '"code":"'):
        idx = message.find(marker)
        if idx != -1:
            tail = message[idx + len(marker):]
            code = tail.split('"', 1)[0]
            if code:
                return code
    if "unexpected status " in message:
        digits = message.split("unexpected status ", 1)[1].split(" ", 1)[0]
        if digits.isdigit():
            return "http_" + digits
    return "unclassified"


def scan_rollout(path):
    """Return the masked failures in one rollout, with its last instruction."""
    failures = []
    last_instruction = ""
    last_substantive = ""
    try:
        handle = open(path, "r", errors="replace")
    except OSError as exc:
        raise SystemExit(2) if False else IOError(str(exc))
    with handle:
        for raw in handle:
            if not raw or raw[0] != "{":
                continue
            # Writers differ on spacing (`"role": "user"` vs `"role":"user"`), and a
            # hint that only matches one of them silently drops every instruction.
            # Compare on a whitespace-collapsed copy so the gate cannot decide the
            # answer by formatting.
            compact = "".join(raw.split())
            if USER_HINT in compact and '"role":"user"' in compact:
                try:
                    item = json.loads(raw)
                except ValueError:
                    continue
                payload = item.get("payload") or {}
                text = "".join(
                    part.get("text", "")
                    for part in (payload.get("content") or [])
                    if isinstance(part, dict)
                )
                text = " ".join(text.split())
                if text and "environment_context" not in text[:200] and not is_marker(text):
                    last_instruction = text
                    if len(text) >= MIN_OBJECTIVE and text.strip().strip(".!").lower() not in TRIVIAL:
                        last_substantive = text
            if MASKED_HINT not in compact or ERROR_HINT not in compact:
                continue
            try:
                item = json.loads(raw)
            except ValueError:
                continue
            payload = item.get("payload") or {}
            if payload.get("type") != "task_complete":
                continue
            error = payload.get("error")
            if not isinstance(error, dict):
                continue
            message = str(error.get("message") or "")
            failures.append({
                "session_id": payload.get("session_id") or payload.get("thread_id") or Path(path).stem,
                "turn_id": payload.get("turn_id") or "",
                "timestamp": item.get("timestamp") or datetime.now(timezone.utc).isoformat(),
                "code": error_code(message),
                "message": " ".join(message.split())[:300],
                # Prefer the last instruction that still states an objective; fall
                # back to the raw last turn so the packet never invents one.
                "instruction": (last_substantive or last_instruction)[:300],
                "rollout": str(path),
            })
    return failures


def packet_for(failure):
    """A v1 handoff packet describing the unfinished turn."""
    digest = hashlib.sha256(
        (failure["session_id"] + "|" + failure["turn_id"]).encode()
    ).hexdigest()[:24]
    objective = failure["instruction"] or "Resume the turn that failed before it produced a result."
    return {
        "handoff_id": "resume-" + digest,
        "generated_at": failure["timestamp"],
        "parent_handoff_id": None,
        "turn_index": 0,
        "scope": "turn",
        "lifecycle": {
            "continuity_assumed": False,
            "previous_worker_ended": True,
        },
        "objective": {
            "statement": objective,
            "route": [
                "Read the transcript artifact below; do not assume continuity.",
                "State what completed and what did not, with the artifact that shows it.",
                "Either finish the objective or park it again naming the blocker.",
            ],
            "stop_gates": [
                "A receipt exists for the work claimed (test output, diff, or exit code).",
            ],
        },
        "evidence": {
            "items": [
                {
                    "claim": "turn ended with provider error %s and no agent message" % failure["code"],
                    "artifact": failure["rollout"],
                    "command": "python3 bridge/resume_packet.py --scan",
                },
            ],
            "still_false": [
                "The turn's objective is unfinished; this packet records the failure, not a result.",
            ],
            "open_questions": [
                "Whether the failure is transient (retry) or structural (%s)." % failure["code"],
            ],
        },
        "next_prompt": (
            "A previous turn in this session ended with provider error %s and produced no agent "
            "message. Re-ground from %s; assume no continuity. Last instruction recorded: %s"
            % (failure["code"], failure["rollout"], objective)
        ),
        "stop_condition": (
            "The objective is completed with an artifact that proves it, or parked again with a "
            "packet naming the blocker."
        ),
        "lookup_policy": {"backward_lookup": "default-off"},
        # Not schema-required, but the packet has to name the turn it answers or
        # nothing downstream can check that a masked failure was picked up. The
        # schema does not forbid extra keys.
        "source": {
            "session_id": failure["session_id"],
            "turn_id": failure["turn_id"],
            "rollout": failure["rollout"],
            "failure_code": failure["code"],
        },
        "writer": {"model": "deepseek-flash", "worker": "bridge/resume_packet.py"},
    }


def validate(path):
    """Reuse the estate's own validator rather than a second opinion."""
    sys.path.insert(0, str(HERE))
    try:
        import validate_handoff
    except ImportError:
        return ["validator unavailable: bridge/validate_handoff.py not importable"]
    try:
        with open(path, "r") as handle:
            packet = json.load(handle)
    except (OSError, ValueError) as exc:
        return ["packet unreadable: %s" % exc]
    return validate_handoff.validate(packet)


def discover(explicit):
    if explicit:
        return [Path(p) for p in explicit]
    home = estate_home()
    roots = []
    override = os.environ.get("UCTM_CODEX_SESSIONS")
    if override:
        roots.append(Path(override))
    # CODEX_HOME is the harness's own name for the directory these rollouts live
    # in, so where a launcher pinned it, it outranks every `~`-derived guess --
    # including when the account database cannot be read and the estate home
    # falls back to the rewritten $HOME.
    codex_home = os.environ.get("CODEX_HOME")
    if codex_home:
        roots.append(Path(codex_home) / "sessions")
    # Derived per call rather than from a module constant: an AO worker runs with
    # $HOME rewritten to the harness home, so `Path.home()` froze a root that does
    # not exist -- and a scan of a missing root yields zero failures, which is
    # indistinguishable from "nothing to do". That silence is the failure this
    # tool exists to break, so the root is asked for here, through the one shared
    # resolver, instead of being settled at import.
    roots.append(home / ".ao" / "uctm-studio" / "codex" / "sessions")
    found = []
    for root in dict.fromkeys(roots):
        if root.is_dir():
            found.extend(Path(p) for p in glob(str(root / "**" / "*.jsonl"), recursive=True))
    return sorted(set(found))


def run_once(files, out_dir, check, force, as_json):
    out_dir = Path(out_dir)
    written, skipped, invalid, failures = [], [], [], []
    for path in files:
        try:
            found = scan_rollout(path)
        except IOError as exc:
            print("resume_packet_unreadable %s: %s" % (path, exc), file=sys.stderr)
            return 2
        for failure in found:
            failures.append(failure)
            packet = packet_for(failure)
            target = out_dir / (packet["handoff_id"] + ".json")
            if target.exists() and not force:
                skipped.append(str(target))
                continue
            if check:
                written.append(str(target) + " (check: not written)")
                continue
            out_dir.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".json.tmp")
            with open(tmp, "w") as handle:
                json.dump(packet, handle, indent=2)
                handle.write("\n")
            os.replace(tmp, target)
            problems = validate(target)
            if problems:
                invalid.append((str(target), problems))
            else:
                written.append(str(target))

    if as_json:
        print(json.dumps({
            "schema": "uctm.resume-packet.v0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "masked_failures": len(failures),
            "written": written,
            "already_present": skipped,
            "invalid": [{"path": p, "problems": q} for p, q in invalid],
            "failures": failures,
        }, indent=2))
    else:
        for failure in failures:
            print("masked_failure session=%s turn=%s code=%s"
                  % (failure["session_id"][:20], failure["turn_id"][:20], failure["code"]))
        for path in written:
            print("resume_packet_written %s" % path)
        for path in skipped:
            print("resume_packet_present %s" % path)
        for path, problems in invalid:
            print("resume_packet_invalid %s" % path)
            for problem in problems:
                print("  - %s" % problem)
        print("RESUME_PACKETS scanned=%d masked=%d written=%d present=%d invalid=%d"
              % (len(files), len(failures), len(written), len(skipped), len(invalid)))

    if invalid:
        return 1
    return 0


def main(argv):
    out_dir = str(DEFAULT_OUT)
    check = force = as_json = watch = scan = False
    interval = 30.0
    explicit = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--scan":
            scan = True
        elif arg == "--check":
            check = True
        elif arg == "--force":
            force = True
        elif arg == "--json":
            as_json = True
        elif arg == "--watch":
            watch = True
        elif arg == "--out" and i + 1 < len(argv):
            i += 1
            out_dir = argv[i]
        elif arg == "--interval" and i + 1 < len(argv):
            i += 1
            interval = max(1.0, float(argv[i]))
        elif arg.startswith("-"):
            print(__doc__.strip().splitlines()[-3], file=sys.stderr)
            return 2
        else:
            explicit.append(arg)
        i += 1

    if not explicit and not scan:
        print("usage: resume_packet.py --scan [--out DIR] [--check] [--json]", file=sys.stderr)
        return 2

    if not watch:
        return run_once(discover(explicit), out_dir, check, force, as_json)

    # A watcher that never rewrites its own history: each packet is written once,
    # keyed by session and turn, so a restart cannot duplicate or lose one.
    while True:
        code = run_once(discover(explicit), out_dir, check, force, as_json)
        if code != 0:
            return code
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
