#!/usr/bin/env python3
"""ponytail: mute vague + garde-fou host intranet (opaque)."""

import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "dist", "node_modules"}
# opaque : évite toute forme lisible dans le dépôt
FORBIDDEN = base64.b64decode(b"aW50cmFvcmFuZ2U=")


def wave_muted(keys, muted_sig):
    if not muted_sig:
        return False
    sig = "|".join(sorted(keys or []))
    return sig == muted_sig


def snooze_blocks(keys, snooze_until, snoozed_sig, now):
    """Pause durée : bloque seulement si même set ; nouvelle clé → False."""
    if not snooze_until or now >= snooze_until:
        return False
    sig = "|".join(sorted(keys or []))
    if snoozed_sig and sig and sig != snoozed_sig:
        return False
    return True


def filter_new_alarms(raw, acked):
    """Popup / son : seulement les clés pas encore Ack (purge si disparues)."""
    present = set(raw or [])
    kept = [k for k in (acked or []) if k in present]
    acked_set = set(kept)
    return [k for k in (raw or []) if k not in acked_set], kept


def assert_no_intranet_host():
    hits = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if FORBIDDEN in data.lower():
            hits.append(str(path.relative_to(ROOT)))
    assert not hits, "host intranet interdit : " + ", ".join(hits)


def main():
    keys = ["[A|PROD] 1", "[B|PROD] 2"]
    sig = "|".join(sorted(keys))
    assert wave_muted(keys, sig)
    assert not wave_muted(keys + ["[C|PROD] 3"], sig)
    assert not wave_muted([], sig)
    now = 1_000_000
    until = now + 60_000
    assert snooze_blocks(keys, until, sig, now)
    assert not snooze_blocks(keys + ["[C|PROD] 3"], until, sig, now)
    assert not snooze_blocks(keys, until, sig, until + 1)
    fresh, kept = filter_new_alarms(keys + ["[C|PROD] 3"], keys)
    assert fresh == ["[C|PROD] 3"]
    assert kept == keys
    fresh2, kept2 = filter_new_alarms(["[C|PROD] 3"], keys)
    assert fresh2 == ["[C|PROD] 3"]
    assert kept2 == []
    assert_no_intranet_host()
    print("selfcheck OK")


if __name__ == "__main__":
    main()
