#!/usr/bin/env python3
"""Launch the local UCTM Studio desktop without exporting provider credentials."""

import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"


def _passwd_home():
    """The user's home from the account database, ignoring a rewritten $HOME."""
    try:
        import pwd
    except ImportError:  # not a Unix host; $HOME is the only answer available
        return None
    try:
        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (KeyError, OSError):
        return None


def state_dir_candidates(env=None):
    """Candidate state directories, most specific first.

    $HOME is not the user's home. The AO worker harness rewrites it, and a path
    built from the rewritten value does not exist, so every "configured?" check
    answers missing and the two context cards are exported empty -- which is
    indistinguishable from "the user did not configure them". AO_DATA_DIR is the
    launcher's own export for the sessions it spawns (STATE/data), so its parent
    is this instance's state directory by construction.
    """
    source = os.environ if env is None else env
    candidates = []
    data = source.get("AO_DATA_DIR")
    if data:
        candidates.append(Path(data).parent)
    home = source.get("HOME")
    candidates.append((Path(home) if home else Path.home()) / ".ao" / "uctm-studio")
    passwd = _passwd_home()
    if passwd is not None:
        candidates.append(passwd / ".ao" / "uctm-studio")
    return candidates


def resolve_state_dir(explicit=None, candidates=None):
    """The first candidate that exists; otherwise the first, which main() creates."""
    if explicit:
        return Path(explicit)
    options = list(candidates) if candidates is not None else state_dir_candidates()
    for option in options:
        if option.is_dir():
            return option
    return options[0]


STATE = resolve_state_dir(os.environ.get("UCTM_STATE_DIR") or None)


def missing_card_warnings(context_card, orientation_card):
    """Cards the launcher would export as "" -- named, not silently empty."""
    missing = []
    for label, card in (("curated context card", context_card),
                        ("orientation card", orientation_card)):
        if not Path(card).is_file():
            missing.append(f"warning: {label} not found at {card}; sessions will spawn without it")
    return missing
FORGE = FRONTEND / "node_modules" / ".bin" / "electron-forge"
DAEMON = FRONTEND / "daemon" / "ao"
CODEX = ROOT / "bridge" / "codex"
PROXY = ROOT / "bridge" / "deepseek_proxy.py"
ELECTRON_APP = FRONTEND / "node_modules" / "electron" / "dist" / "Electron.app"
PID_FILE = STATE / "studio.pid"
LOG_FILE = STATE / "studio.log"
PROXY_PID_FILE = STATE / "proxy.pid"
PROXY_TOKEN_FILE = STATE / "proxy-token"
CONTEXT_CARD = STATE / "permitted-context.md"
# Written by scripts/uctm-graph.mjs --write, which regenerates it next to the
# evidence kernel. The daemon injects it at spawn so re-orientation is a digest
# comparison rather than a pass over the receipts; see
# docs/uctm/AO_F4_ORIENTATION_AT_SPAWN_2026-09-19.md.
ORIENTATION_CARD = STATE / "orientation.md"
PROXY_HEALTH = "http://127.0.0.1:8769/healthz"
CEF_BINARY = STATE / "cef-server"
CEF_PID_FILE = STATE / "cef.pid"
CEF_GRANT_FILE = STATE / "cef-grant.json"
CEF_TOKEN_FILE = STATE / "cef-token"
CEF_RECEIPTS_DIR = STATE / "context-receipts"
CEF_URL = "http://127.0.0.1:8010"
CEF_HEALTH = CEF_URL + "/health"


def is_studio_pid(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    return result.returncode == 0 and "electron-forge" in result.stdout


def proxy_ready():
    return ready(PROXY_HEALTH, '"service":"uctm-deepseek-proxy"')


def cef_ready():
    return ready(CEF_HEALTH, '"service":"cc-context-evidence-fabric"')


def cef_owned_ready():
    try:
        pid = json.loads(CEF_PID_FILE.read_text()).get("pid")
    except (FileNotFoundError, ValueError, OSError):
        return False
    if not isinstance(pid, int) or pid <= 0 or not cef_ready():
        return False
    process = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                             capture_output=True, text=True)
    return process.returncode == 0 and process.stdout.strip() == str(CEF_BINARY)


def cef_token_ready():
    try:
        info = CEF_TOKEN_FILE.lstat()
        token = CEF_TOKEN_FILE.read_text().removesuffix("\n")
    except (FileNotFoundError, OSError, UnicodeError):
        return False
    return (stat.S_ISREG(info.st_mode) and info.st_mode & 0o077 == 0
            and 32 <= len(token) <= 256
            and all(char.isascii() and (char.isalnum() or char in "-_") for char in token))


def cef_receipts_ready():
    try:
        info = CEF_RECEIPTS_DIR.lstat()
    except (FileNotFoundError, OSError):
        return False
    return stat.S_ISDIR(info.st_mode) and info.st_mode & 0o077 == 0


def cef_recall_grant_ready():
    """Validate the persisted recall grant without opening any evidence source."""
    try:
        info = CEF_GRANT_FILE.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 != 0
                or info.st_size > 4096):
            return False
        grant = json.loads(CEF_GRANT_FILE.read_text(encoding="utf-8"))
        required = {
            "schema", "workspace_path", "provider_model", "family_id", "purpose",
            "after", "before", "expires_at", "max_evidence_chars",
            "allow_history_search", "allow_model_egress",
        }
        if set(grant) != required or grant.get("schema") != "uctm.recall-grant.v1":
            return False
        if not grant["workspace_path"] or not grant["provider_model"] or not grant["family_id"]:
            return False
        if not grant["allow_history_search"] or not grant["allow_model_egress"]:
            return False
        if not 256 <= int(grant["max_evidence_chars"]) <= 8192:
            return False
        expires_at = grant["expires_at"].replace("Z", "+00:00")
        from datetime import datetime, timezone
        return datetime.fromisoformat(expires_at).replace(tzinfo=timezone.utc).timestamp() > time.time()
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return False


def cef_live_delivery_ready():
    """Return true only after a real model-safe recall receipt is durable."""
    if not (cef_owned_ready() and cef_recall_grant_ready() and cef_receipts_ready()):
        return False
    try:
        for receipt_path in CEF_RECEIPTS_DIR.glob("*.json"):
            if receipt_path.stat().st_mode & 0o077 != 0 or receipt_path.stat().st_size > 16 * 1024:
                continue
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            if (receipt.get("schema") == "uctm.context-delivery.v1"
                    and receipt.get("status") == "accepted_by_codex_host"
                    and receipt.get("request_id")
                    and receipt.get("family_id")
                    and receipt.get("slice_id")
                    and receipt.get("sources")):
                return True
    except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
        return False
    return False


def ensure_cef():
    if not CEF_BINARY.is_file():
        return False
    if not CEF_TOKEN_FILE.exists():
        token = secrets.token_urlsafe(48)
        try:
            fd = os.open(CEF_TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                output.write(token + "\n")
        except FileExistsError:
            pass
    if not cef_token_ready():
        return False
    if cef_owned_ready():
        return True
    log_fd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    env = os.environ.copy()
    # An absent card is a missing onboarding pointer, not an empty one: exporting
    # "" here leaves spawned sessions to re-read the receipts with no signal that
    # the card was expected and not found.
    for warning in missing_card_warnings(CONTEXT_CARD, ORIENTATION_CARD):
        print(warning, file=sys.stderr)
    env.update({
        "CEF_BIND": "127.0.0.1:8010",
        "CEF_EVIDENCE_SERVER": str(Path.home() / ".codex" / "skills" / "context-recovery-ops" / "mcp_server" / "evidence_recovery_server.py"),
        "CEF_AUTH_TOKEN_FILE": str(CEF_TOKEN_FILE),
        # The service repeats the grant check on every evidence route; the
        # launcher passes the same file the Studio boundary reads.
        "CEF_GRANT_FILE": str(CEF_GRANT_FILE),
    })
    with os.fdopen(log_fd, "a") as log:
        process = subprocess.Popen([str(CEF_BINARY)], env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, start_new_session=True)
    CEF_PID_FILE.write_text(json.dumps({"pid": process.pid}) + "\n")
    # A cold native Graph Kernel/RAG++ binary can take several seconds to
    # fault in from disk before the loopback health route accepts connections.
    for _ in range(300):
        if process.poll() is not None:
            return False
        if cef_ready():
            return True
        time.sleep(0.1)
    return False


def cef_grant_enforced():
    """Ask the running service whether it enforces the grant itself.

    The binary version cannot answer this: the deployed file may predate grant
    enforcement. CEF reports it on the public health route.
    """
    try:
        with urllib.request.urlopen(CEF_HEALTH, timeout=1) as response:
            if response.status != 200:
                return False
            return json.loads(response.read(4096).decode("utf-8")).get("grant_enforced") is True
    except Exception:
        return False


def proxy_reuse_reasons(pid, token_present, healthy, command):
    """Why the running provider proxy was not reused, named instead of inferred.

    The fall-through below rotates the token, and a rotated token 401s every live
    session. So the difference between a diagnosable restart and a mystery 401 is
    whether the log says which input failed: a recorded pid, a token file, a health
    answer, or a command line that is actually this proxy. Naming these changes no
    decision -- the rotation policy is the same -- it only stops the decision from
    being invisible.
    """
    reasons = []
    if not (isinstance(pid, int) and pid > 0):
        reasons.append("no usable pid in proxy.pid")
    if not token_present:
        reasons.append("proxy-token file missing")
    if not healthy:
        reasons.append("health check did not answer as the proxy")
    if reasons:
        return reasons
    if not command or str(PROXY) not in command:
        reasons.append(f"pid {pid} is running something else")
    return reasons


def listener_pid(port=8769):
    """The pid listening on the proxy port, or None.

    Used only to repair a stale pid file. A recorded pid is evidence that something
    was started once; the socket is evidence about now, and only the socket decides
    whether the proxy is up.
    """
    try:
        result = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                                capture_output=True, text=True)
    except OSError:
        return None
    for field in (result.stdout or "").split():
        if field.isdigit():
            return int(field)
    return None


def proxy_reuse_decision(healthy, token_present):
    """Reuse the running proxy iff it is answering health and a token file exists.

    The pid file is deliberately not part of this. An out-of-band restart (a manual
    proxy start, a supervisor) leaves a stale pid even though the proxy is up and its
    token is the one in the file. Refusing to reuse that state used to fall through to
    a rotation -- and a rotation writes a token the live proxy has never seen, so the
    daemon authenticates with the new file against the old process and every live
    session 401s. Reuse is the safe answer: the file and the process still agree.
    """
    return bool(healthy and token_present)


def write_proxy_token(token):
    """Persist the token the daemon reads, 0600 and swapped in by rename.

    Called only after the replacement proxy answers health. Writing it first was the
    same defect one step earlier: a spawn that cannot bind the port (or dies for any
    other reason) left the rotated token behind for the daemon to authenticate with,
    which 401s live sessions while giving the caller a False that looks like "nothing
    happened". The file is the daemon's copy of the proxy's token, so it is written
    once there is a proxy that has that token.
    """
    temp = PROXY_TOKEN_FILE.with_name(PROXY_TOKEN_FILE.name + f".tmp-{os.getpid()}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write(token + "\n")
    os.replace(temp, PROXY_TOKEN_FILE)


def ensure_proxy():
    try:
        pid = json.loads(PROXY_PID_FILE.read_text()).get("pid")
    except (FileNotFoundError, ValueError, OSError):
        pid = None
    token_present = PROXY_TOKEN_FILE.is_file()
    healthy = proxy_ready()
    command = None
    if pid and token_present and healthy:
        result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
        command = result.stdout if result.returncode == 0 else ""
    if proxy_reuse_decision(healthy, token_present):
        if not (pid and command and str(PROXY) in command):
            # The proxy is answering, so the token file still matches the process that
            # holds it. Repair the pid file if the socket can name the listener, and say
            # so either way: a stale pid that is silently tolerated is the next 401.
            live = listener_pid()
            if live and live != pid:
                PROXY_PID_FILE.write_text(json.dumps({"pid": live}) + "\n")
                print(f"reusing the provider proxy; repaired a stale proxy.pid ({pid} -> {live})",
                      file=sys.stderr)
            else:
                print("reusing the provider proxy; proxy.pid could not be verified "
                      f"(recorded {pid!r}) and was left alone", file=sys.stderr)
        return True
    reasons = proxy_reuse_reasons(pid, token_present, healthy, command)
    print("restarting the provider proxy (" + "; ".join(reasons) + "); "
          "this rotates the token and will 401 any live session", file=sys.stderr)
    token = secrets.token_urlsafe(48)
    log_fd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(log_fd, "a") as log:
        process = subprocess.Popen([sys.executable, str(PROXY)], stdin=subprocess.PIPE,
                                   stdout=log, stderr=log, start_new_session=True)
        process.stdin.write((token + "\n").encode())
        process.stdin.close()
    for _ in range(40):
        if process.poll() is not None:
            print("the replacement provider proxy exited before answering health; the previous "
                  "token file is untouched, so a live session keeps working", file=sys.stderr)
            return False
        if proxy_ready():
            write_proxy_token(token)
            PROXY_PID_FILE.write_text(json.dumps({"pid": process.pid}) + "\n")
            return True
        time.sleep(0.1)
    # Alive but not serving. Stop it rather than return with a proxy that may bind the
    # port a moment later holding a token the file was never given: that is the 401 this
    # ordering exists to prevent, produced by our own timeout instead of by a spawn.
    try:
        process.terminate()
    except OSError:
        pass
    print("the replacement provider proxy did not answer health in time; stopped it and left "
          "the previous token file untouched", file=sys.stderr)
    return False


def ready(url, marker=None):
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            if response.status != 200:
                return False
            return marker is None or marker in response.read(4096).decode("utf-8", "replace")
    except Exception:
        return False


def doctor():
    env = os.environ.copy()
    env["CODEX_HOME"] = str(STATE / "codex")
    auth = subprocess.run([str(CODEX), "login", "status"], env=env,
                          capture_output=True, text=True)
    try:
        pid = json.loads(PID_FILE.read_text()).get("pid")
    except (FileNotFoundError, ValueError, OSError):
        pid = None
    desktop = is_studio_pid(pid) and ready("http://localhost:5173/", "<title>UCTM Studio</title>")
    daemon = ready("http://127.0.0.1:3001/readyz")
    proxy = proxy_ready()
    cef = cef_owned_ready()
    # A durable delivery receipt proves delivery, not pipeline qualification.
    # The CEF service itself reports live_pipeline_qualified=false, and the gate
    # document requires evidence_context_connected to stay false until the
    # remaining live checks pass. Report the two claims separately.
    delivery_proven = cef_live_delivery_ready()
    live_gate_open = ["restart_cancel_checks", "pre_hydration_no_read_proof"]
    transport_lines = (auth.stdout or auth.stderr).strip().splitlines()
    report = {
        "product": "UCTM Studio",
        "state_dir": str(STATE),
        "desktop": "ready" if desktop else "not_running",
        "daemon": "ready" if daemon else "not_running",
        "codex_host": "configured" if CODEX.is_file() else "missing",
        "deepseek_transport": "ready" if proxy and auth.returncode == 0 else "unavailable",
        "deepseek_transport_detail": "" if auth.returncode == 0 else (
            transport_lines[0][:200] if transport_lines else ""),
        "coding_harness_ready": bool(desktop and daemon and proxy and auth.returncode == 0),
        "curated_user_context_configured": CONTEXT_CARD.is_file() and CONTEXT_CARD.stat().st_mode & 0o077 == 0,
        "orientation_card_configured": ORIENTATION_CARD.is_file() and ORIENTATION_CARD.stat().st_mode & 0o077 == 0,
        "cef_service_ready": cef,
        "cef_auth_configured": cef_token_ready(),
        "cef_delivery_receipts_ready": cef_receipts_ready(),
        "cef_recall_grant_configured": cef_recall_grant_ready(),
        "cef_grant_enforced_by_service": cef_grant_enforced(),
        "cef_live_delivery_proven": delivery_proven,
        "uctm_spine_connected": False,
        "evidence_context_connected": False,
        "evidence_context_gate_open": live_gate_open,
        "cef_live_pipeline_qualified": False,
        "product_acceptance": "coding_ui_qualified_full_architecture_partial",
    }
    print(json.dumps(report, sort_keys=True))
    return 0 if report["coding_harness_ready"] else 1


def main():
    for path in (FORGE, DAEMON, CODEX, PROXY, ELECTRON_APP, STATE / "codex" / "config.toml"):
        if not path.exists():
            print(f"UCTM Studio is incomplete: {path}", file=sys.stderr)
            return 2
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    CEF_RECEIPTS_DIR.mkdir(mode=0o700, exist_ok=True)
    if not cef_receipts_ready():
        print("UCTM context receipt directory must be private.", file=sys.stderr)
        return 2
    if not ensure_proxy():
        print("UCTM DeepSeek transport could not start.", file=sys.stderr)
        return 2
    ensure_cef()
    try:
        current = json.loads(PID_FILE.read_text()).get("pid")
    except (FileNotFoundError, ValueError, OSError):
        current = None
    if is_studio_pid(current):
        subprocess.run(["open", "-a", str(ELECTRON_APP)], check=False)
        print("UCTM Studio is already open.")
        return 0

    env = os.environ.copy()
    env.update({
        "AO_DATA_DIR": str(STATE / "data"),
        "AO_RUN_FILE": str(STATE / "running.json"),
        "AO_PORT": "3001",
        "AO_AGENT": "codex",
        "AO_DAEMON_COMMAND": f"{DAEMON} daemon",
        "AO_CODEX_BIN": str(CODEX),
        "CODEX_HOME": str(STATE / "codex"),
        "AO_TELEMETRY_EVENTS": "off",
        "AO_TELEMETRY_METRICS": "off",
        "AO_TELEMETRY_REMOTE": "off",
        "AO_SENTRY_DSN": "",
        "VITE_AO_SENTRY_DSN": "",
        "UCTM_STUDIO": "1",
        "VITE_UCTM_STUDIO": "1",
        "UCTM_CONTEXT_CARD_PATH": str(CONTEXT_CARD) if CONTEXT_CARD.is_file() else "",
        "UCTM_ORIENTATION_CARD_PATH": str(ORIENTATION_CARD) if ORIENTATION_CARD.is_file() else "",
        # The path is rechecked on every /recall turn; adding or revoking a
        # grant does not require restarting the desktop or daemon.
        "UCTM_CEF_URL": CEF_URL,
        "UCTM_CEF_GRANT_PATH": str(CEF_GRANT_FILE),
        "UCTM_CEF_TOKEN_PATH": str(CEF_TOKEN_FILE),
        "UCTM_CEF_RECEIPTS_DIR": str(CEF_RECEIPTS_DIR),
        "PATH": f"{ROOT / 'bridge'}:{env.get('PATH', '')}",
    })
    log_fd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(log_fd, "a") as log:
        process = subprocess.Popen([str(FORGE), "start"], cwd=FRONTEND, env=env,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   start_new_session=True)
    PID_FILE.write_text(json.dumps({"pid": process.pid}) + "\n")
    for _ in range(60):
        if process.poll() is not None:
            print(f"UCTM Studio failed to launch; see {LOG_FILE}", file=sys.stderr)
            return 1
        if ready("http://127.0.0.1:3001/readyz") and ready("http://localhost:5173/", "<title>UCTM Studio</title>"):
            print("UCTM Studio is open (Codex + DeepSeek).")
            return 0
        time.sleep(0.5)
    print(f"UCTM Studio is still starting; see {LOG_FILE}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(doctor() if sys.argv[1:] == ["--doctor"] else main())
