"""Part A falsification suite: retrieve re-compression root cause (round 4).

One case per acceptance item a2-a5, run against the real site-packages
modules with an isolated in-memory CCR store (HEADROOM_CCR_BACKEND=memory,
set before any headroom import).

Usage:
    python test_retrieve_forms.py <case>
    case in {rust-mirror-key, aggregate-envelope, newline-drift, cache-swap-guard, all}

Exit 0 = the case (or all cases) holds on the installed tree.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

os.environ["HEADROOM_CCR_BACKEND"] = "memory"  # MUST precede headroom imports

from headroom.cache.compression_cache import CompressionCache  # noqa: E402
from headroom.cache.compression_store import get_compression_store  # noqa: E402
from headroom.transforms.content_router import (  # noqa: E402
    _CODEMODE_RESULT_HEADER_RE,
    _is_retrieved_original,
)
from headroom.transforms.smart_crusher import SmartCrusher  # noqa: E402

HEADER = "Script completed\nWall time 0.1 seconds\nOutput:\n\n"


def sha24(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:24]


def seed(original: str, explicit_hash: str | None = None) -> str:
    """Store an original the way a compressor would; returns the store key."""
    return get_compression_store().store(
        original=original,
        compressed=f"<<ccr:{sha24(original)[:12]}>>",
        compression_strategy="test",
        explicit_hash=explicit_hash,
    )


def seed_via_mirror(original: str) -> str:
    """Store an original through the REAL patched Rust-mirror path.

    SmartCrusher.__new__ skips __init__ (no Rust runtime needed); the mirror
    method only touches self._rust, which the fake satisfies. This exercises
    the dual-key patch itself, not a re-implementation of it.
    """
    ccr_hash = hashlib.sha256(original.encode()).hexdigest()[:12]

    class _FakeRust:
        def ccr_get(self, hash_str: str):
            return original if hash_str == ccr_hash else None

    crusher = SmartCrusher.__new__(SmartCrusher)
    crusher._rust = _FakeRust()
    crusher._mirror_single_hash_to_python_store(
        ccr_hash, strategy="string_ccr", query_context="", tool_name="codemode"
    )
    return ccr_hash


def case_rust_mirror_key() -> None:
    """a2: a Rust string_ccr original (12-hex explicit_hash mirror key) is
    recognized as a retrieved original — no fresh marker."""
    original = "RUST_MIRROR_ORIGINAL:" + "x" * 600
    ccr_hash = seed_via_mirror(original)

    store = get_compression_store()
    # The mirror must have dual-keyed: the Rust 12-hex key (redemption path)
    # AND the content-derived 24-hex default key (probe path).
    assert store.exists(ccr_hash), "mirror did not store the explicit 12-hex key"
    assert store.exists(sha24(original)), (
        "mirror did not store the sha256[:24] alias (dual-key missing)"
    )
    # The probe must recognize the wire body: retrieved original + the one
    # trailing "\n" the extension's byte-differentiation guard appends.
    assert _is_retrieved_original(original + "\n"), "probe missed a Rust-mirrored original"


def case_aggregate_envelope() -> None:
    """a3: a codemode JSON envelope of retrieved originals ships intact."""
    members = {
        "ctx": "CTX_ORIGINAL:" + "a" * 700,
        "ls": "LS_ORIGINAL:" + "b" * 600,
        "git": "GIT_ORIGINAL:" + "c" * 550,
    }
    for value in members.values():
        seed(value)  # default sha256[:24] key — the Python-compressor keyspace
    # The wire body: codemode header + JSON envelope of the retrieved
    # originals, each carrying the extension's trailing "\n".
    envelope = json.dumps({k: v + "\n" for k, v in members.items()})
    body = HEADER + envelope
    assert _CODEMODE_RESULT_HEADER_RE.match(body), (
        "fixture header does not match the router's regex"
    )
    assert _is_retrieved_original(body), "probe missed the aggregated retrieve envelope"
    # Control: the same envelope shape with all-fresh members must NOT probe
    # positive (the probe is content-identity, not shape-identity).
    fresh = json.dumps(
        {
            k: v + "\n"
            for k, v in {
                "ctx": "FRESH_CTX:" + "p" * 700,
                "ls": "FRESH_LS:" + "q" * 600,
                "git": "FRESH_GIT:" + "r" * 550,
            }.items()
        }
    )
    assert not _is_retrieved_original(HEADER + fresh), (
        "probe false-positives on all-fresh envelopes"
    )


def case_newline_drift() -> None:
    """a4: accumulated trailing newlines do not defeat recognition."""
    stored = "DRIFT_ORIGINAL:" + "d" * 600 + "\n\n\n"  # session line 21 form
    seed(stored)
    # One retrieval + extension append on top of the accumulated original.
    assert _is_retrieved_original(stored + "\n"), (
        "probe missed accumulated trailing newlines"
    )
    # The exact stored bytes (no append) must also probe positive.
    assert _is_retrieved_original(stored), "probe missed the exact stored body"


def case_cache_swap_guard() -> None:
    """a5: the compression cache never re-pins an aggregated-retrieve body."""
    members = {"ctx": "CACHE_CTX:" + "e" * 700, "ls": "CACHE_LS:" + "f" * 600}
    for value in members.values():
        seed(value)
    body = HEADER + json.dumps({k: v + "\n" for k, v in members.items()})
    marker_form = HEADER + "<<ccr:0123456789ab,string,2.5KB>>"
    # Precondition: the probe recognizes the body, so the guard is what
    # blocks the cache write (not the orig==comp equality branch).
    assert _is_retrieved_original(body), "precondition failed: probe missed the body"

    cache = CompressionCache()
    originals = [{"role": "tool", "tool_call_id": "call_1", "content": body}]
    compressed = [{"role": "tool", "tool_call_id": "call_1", "content": marker_form}]
    cache.update_from_result(originals, compressed)

    assert cache.get_compressed(cache.content_hash(body)) is None, (
        "cache stored an aggregated-retrieve body"
    )
    replayed = cache.apply_cached(originals)
    assert replayed[0]["content"] == body, (
        "apply_cached swapped an aggregated-retrieve body"
    )

    # Control: a plain (non-retrieve) body must still cache and swap — the
    # guard is narrow, not a cache kill-switch.
    plain = "PLAIN_TOOL_RESULT:" + "g" * 700
    cache.update_from_result(
        [{"role": "tool", "tool_call_id": "call_2", "content": plain}],
        [{"role": "tool", "tool_call_id": "call_2", "content": "PLAIN_COMPRESSED"}],
    )
    swapped = cache.apply_cached(
        [{"role": "tool", "tool_call_id": "call_2", "content": plain}]
    )
    assert swapped[0]["content"] == "PLAIN_COMPRESSED", "guard broke normal caching"


CASES = {
    "rust-mirror-key": case_rust_mirror_key,
    "aggregate-envelope": case_aggregate_envelope,
    "newline-drift": case_newline_drift,
    "cache-swap-guard": case_cache_swap_guard,
}


def main() -> int:
    case = sys.argv[1] if len(sys.argv) > 1 else "all"
    if case == "all":
        names = list(CASES)
    elif case in CASES:
        names = [case]
    else:
        print(f"unknown case: {case}", file=sys.stderr)
        return 2
    for name in names:
        try:
            CASES[name]()
        except AssertionError as exc:
            print(f"FAIL {name}: {str(exc) or 'assertion failed'}", file=sys.stderr)
            return 1
        except Exception as exc:  # noqa: BLE001 - report, don't traceback-spam
            print(f"ERROR {name}: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 1
        print(f"PASS {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())