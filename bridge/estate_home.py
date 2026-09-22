#!/usr/bin/env python3
"""One answer to "where is the estate home?".

The worker harness rewrites $HOME to an isolated home, which is correct for the
session and wrong for every path built from `~`: `~/.ao/uctm-studio`, `~/memory`,
`~/SOUL.md` and `~/.codex/skills` all resolve somewhere empty, and a "not
configured" answer is indistinguishable from "the file is not there". Three
separate files had already grown their own private copy of this reasoning and a
fourth session still re-derived it, so it lives here once.

Order of answers, most specific first:
  1. UCTM_ESTATE_HOME, when a caller or the spawn shim named it and it exists.
  2. the account database (getpwuid), which is not affected by the rewrite.
  3. whatever $HOME says, as the only remaining answer.

`warn_if_rewritten` exists because silence is what costs a session an hour: a
rewritten $HOME is announced in one line instead of being discovered twice.
"""

import os
import sys
from pathlib import Path

ENV_VAR = "UCTM_ESTATE_HOME"


def _named(env):
    value = (env if env is not None else os.environ).get(ENV_VAR)
    if not value:
        return None
    path = Path(value)
    return path if path.is_dir() else None


def _passwd(env):
    try:
        import pwd
    except ImportError:  # not a Unix host; $HOME is the only answer available
        return None
    try:
        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (KeyError, OSError):
        return None


def resolve(env=None):
    """The estate home, or $HOME when nothing better can be established."""
    source = os.environ if env is None else env
    named = _named(source)
    if named is not None:
        return named
    home = source.get("HOME")
    passwd = _passwd(source)
    if passwd is not None and passwd.is_dir():
        return passwd
    if home:
        return Path(home)
    return Path.home()


def is_rewritten(env=None):
    """True when $HOME does not point at the estate home."""
    source = os.environ if env is None else env
    home = source.get("HOME")
    if not home:
        return False
    return Path(home).resolve() != resolve(source).resolve()


def warn_if_rewritten(env=None, stream=None):
    """Announce a rewritten $HOME once, naming both paths. Returns True if it was."""
    source = os.environ if env is None else env
    if not is_rewritten(source):
        return False
    print(
        "estate_home_rewritten HOME=%s estate_home=%s hint=%s or bridge/estate_home.py"
        % (source.get("HOME"), resolve(source), ENV_VAR),
        file=stream or sys.stderr,
    )
    return True
