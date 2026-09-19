#!/usr/bin/env python3
"""RationaleWorm — proxy-rationale generator over observable Codex chains.

Reads KARL buffers (prompt + tool_events + cwd/git_repo) and optionally a
Codex rollout slice, then asks DeepSeek through the loopback proxy for a
proxy rationale used for SFT/DPO. Dry-run default: no credits spent.

Design mirrors scripts/run_worms.py in cognitive-twin: sequential calls,
2s gap, incremental save, checkpoint resume. Fail closed everywhere.
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "data" / "rationale_worm"
CHECKPOINT = OUT_DIR / "_checkpoint.json"
CALL_GAP = 2.0
PROXY_URL = os.environ.get("UCTM_DEEPSEEK_PROXY_URL", "http://127.0.0.1:8769/responses")
PROXY_TOKEN = os.environ.get("UCTM_DEEPSEEK_PROXY_TOKEN", "")

SYSTEM = (
    "You write a short proxy rationale for agent training. "
    "Rules: (1) reason only from the observable actions given; "
    "(2) never claim to be the original agent's thought; "
    "(3) never invent tool outputs; (4) flag corrections and aborts; "
    "(5) keep it under 150 words."
)


def load_buffer(path):
    with open(path) as f:
        raw = f.read()
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        # Some buffers contain concatenated JSON objects; take the first.
        d, _ = json.JSONDecoder().raw_decode(raw)
        if not isinstance(d, dict):
            raise ValueError("buffer is not a JSON object")
    prompt = (d.get("prompt_text") or "")[:2000]
    events = d.get("tool_events") or []
    chain = []
    for e in events[:40]:
        name = e.get("tool_name", "?")
        params = json.dumps(e.get("key_params", {}))[:300]
        ok = e.get("success")
        chain.append(f"- {name} ok={ok}: {params}")
    return {
        "session_id": d.get("session_id", Path(path).stem),
        "prompt": prompt,
        "chain": chain,
        "cwd": d.get("cwd", ""),
        "git_repo": d.get("git_repo", ""),
    }


def build_request(item):
    body = (
        f"[Session {item['session_id']} repo={item['git_repo']} cwd={item['cwd']}]\n"
        f"User prompt: {item['prompt']}\nObservable actions:\n"
        + "\n".join(item["chain"])
        + "\nWrite the proxy rationale:"
    )
    return body


def proxy_health():
    base = PROXY_URL.rsplit("/responses", 1)[0]
    try:
        with urllib.request.urlopen(base + "/healthz", timeout=5) as r:
            return r.read()[:200]
    except Exception as e:
        return f"DOWN: {e}".encode()


def proxy_call(text, max_tok=1024, temp=0.2):
    if not PROXY_TOKEN:
        raise RuntimeError("UCTM_DEEPSEEK_PROXY_TOKEN not set; refusing live call")
    payload = json.dumps({
        "model": "deepseek-flash",
        "input": f"[System]\n{SYSTEM}\n\n[Request]\n{text}",
        "max_output_tokens": max_tok,
        "temperature": temp,
    }).encode()
    req = urllib.request.Request(
        PROXY_URL, data=payload, method="POST",
        headers={"Authorization": "Bearer " + PROXY_TOKEN,
                 "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read().decode(errors="replace")
    try:
        d = json.loads(raw)
        texts = []
        for item in d.get("output", []):
            for c in item.get("content", []):
                if c.get("type") == "output_text" and c.get("text"):
                    texts.append(c["text"])
        if texts:
            return "\n".join(texts)[:2000]
        # Reasoning-only incomplete response: surface it marked, still proxy.
        for item in d.get("output", []):
            for c in item.get("content", []):
                if c.get("type") == "reasoning_text" and c.get("text"):
                    return "[PROXY reasoning-only, truncated] " + c["text"][:1500]
    except Exception:
        pass
    return raw[:2000]


CORRECTION_RES = [
    "don't worry about", "strictly focus", "too much text", "fix it",
    "not that", "that's wrong", "instead", "actually,",
]

try:
    import re as _re
    _CORR = _re.compile("|".join(_re.escape(s) for s in CORRECTION_RES), _re.I)
except Exception:
    _CORR = None


def mine_dpo_from_rollout(rollout_path, limit=20):
    """Correction-anchored DPO pairs (dry, local): redirect -> chosen=reorient,
    rejected=continued prior track. Text only from user-visible messages."""
    pairs = []
    with open(rollout_path) as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") != "response_item":
                continue
            p = o.get("payload", {})
            if p.get("type") != "message" or p.get("role") != "user":
                continue
            txt = "".join(
                c.get("text", "") for c in p.get("content", []) if isinstance(c, dict)
            ).strip()
            if len(txt) < 10 or len(txt) > 600 or "<environment_context>" in txt:
                continue
            if _CORR and not _CORR.search(txt):
                continue
            pairs.append({
                "prompt": txt[:500],
                "chosen": "Acknowledge the redirect explicitly, drop the prior track, and execute the newly scoped task with artifact verification.",
                "rejected": "Continue the prior track with a longer narrative and no artifact check.",
                "rationale_source": "proxy-deepseek",
                "signal": "user-correction",
            })
            if len(pairs) >= limit:
                break
    return pairs


def build_evidence_index():
    """Hash/identity-only index: delivery receipts + scored trajectory tiers."""
    import glob as _glob
    entries = []
    for rp in _glob.glob("/Users/mohameddiomande/.ao/uctm-studio/context-receipts/*.json"):
        try:
            d = json.load(open(rp))
        except Exception:
            continue
        for s in d.get("sources", []):
            entries.append({
                "session_id": Path(rp).stem,
                "family_id": d.get("family_id", ""),
                "slice_id": d.get("slice_id", ""),
                "evidence_id": s.get("evidence_id", ""),
                "content_sha256": s.get("content_sha256", ""),
            })
    return entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--dry-run", action="store_true", default=True)
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--mode", default="sft", choices=["sft", "dpo", "evidence", "all"])
    ap.add_argument("--rollout", default="")
    args = ap.parse_args()
    live = args.live

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done = set()
    if args.resume and CHECKPOINT.exists():
        try:
            done = set(json.loads(CHECKPOINT.read_text()).get("done", []))
        except Exception:
            pass

    targets = []
    if args.input:
        targets = [args.input]
    else:
        bufdir = Path("/Users/mohameddiomande/.claude/karl/buffers")
        targets = sorted(
            str(p) for p in bufdir.glob("*.json") if not p.name.startswith(".")
        )[: args.limit]

    sft_path = OUT_DIR / "sft_proxy.jsonl"
    rows = 0
    last = 0.0
    with open(sft_path, "a") as out:
        for t in targets:
            sid = Path(t).stem
            if sid in done:
                continue
            try:
                item = load_buffer(t)
            except Exception as e:
                print(f"skip {sid}: {e}")
                continue
            req_text = build_request(item)
            if live:
                gap = CALL_GAP - (time.time() - last)
                if gap > 0:
                    time.sleep(gap)
                try:
                    rationale = proxy_call(req_text)
                    last = time.time()
                except Exception as e:
                    print(f"live call failed for {sid}: {e}")
                    break
            else:
                h = hashlib.sha256(req_text.encode()).hexdigest()[:16]
                rationale = f"[DRY-RUN proxy rationale placeholder req={h} prompt_chars={len(item['prompt'])} actions={len(item['chain'])}]"
            row = {
                "messages": [
                    {"role": "user", "content": item["prompt"][:1000]},
                    {"role": "assistant", "content": rationale},
                ],
                "rationale_source": "proxy-deepseek",
                "session_id": sid,
            }
            out.write(json.dumps(row) + "\n")
            out.flush()
            rows += 1
            done.add(sid)
            if rows % 25 == 0:
                CHECKPOINT.write_text(json.dumps({"done": sorted(done), "at": datetime.now().isoformat()}))
            if rows >= args.limit and not args.input:
                break
    CHECKPOINT.write_text(json.dumps({"done": sorted(done), "at": datetime.now().isoformat()}))
    print(f"wrote {rows} rows live={live} -> {sft_path}")

    if args.mode in ("dpo", "all"):
        rollout = args.rollout or "/Users/mohameddiomande/.codex/sessions/2026/08/01/rollout-2026-08-01T22-37-09-019fc055-15c8-73e0-b2b6-fcb12f8dc3ec.jsonl"
        pairs = mine_dpo_from_rollout(rollout, limit=20)
        dpo_path = OUT_DIR / "dpo_proxy.jsonl"
        with open(dpo_path, "w") as out:
            for p in pairs:
                out.write(json.dumps(p) + "\n")
        print(f"wrote {len(pairs)} DPO pairs -> {dpo_path}")

    if args.mode in ("evidence", "all"):
        entries = build_evidence_index()
        ev_path = OUT_DIR / "evidence_index.jsonl"
        with open(ev_path, "w") as out:
            for e in entries:
                out.write(json.dumps(e) + "\n")
        print(f"wrote {len(entries)} evidence entries -> {ev_path}")


if __name__ == "__main__":
    sys.exit(main())
