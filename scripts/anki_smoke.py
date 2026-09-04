#!/usr/bin/env python3
"""AnkiWeb login smoke test — gates Anki integration (workflow_dispatch only)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

COLLECTION_PATH = Path(".cache/anki/collection.anki2")


def main() -> int:
    user = (os.environ.get("ANKIWEB_USER") or "").strip()
    password = (os.environ.get("ANKIWEB_PASS") or "").strip()

    if not user or not password:
        print("[anki-smoke] ERROR: ANKIWEB_USER and ANKIWEB_PASS must be set", file=sys.stderr)
        return 1

    try:
        from anki.collection import Collection
    except ImportError:
        print("[anki-smoke] ERROR: pip install anki", file=sys.stderr)
        return 1

    COLLECTION_PATH.parent.mkdir(parents=True, exist_ok=True)

    print(f"[anki-smoke] Opening collection at {COLLECTION_PATH}")
    col = Collection(str(COLLECTION_PATH))

    try:
        print("[anki-smoke] Attempting AnkiWeb login...")
        try:
            auth = col.sync_login(user, password)
        except Exception as e:
            msg = str(e).lower()
            print(f"[anki-smoke] ERROR: AnkiWeb login failed: {e}", file=sys.stderr)
            if "2fa" in msg or "two factor" in msg or "two-factor" in msg or "verification" in msg:
                print(
                    "[anki-smoke] Hint: AnkiWeb accounts with 2FA enabled cannot log in "
                    "non-interactively. Disable 2FA on ankidroid/ankiweb or use an app password "
                    "if Anki adds support.",
                    file=sys.stderr,
                )
            elif "invalid" in msg or "password" in msg or "401" in msg:
                print("[anki-smoke] Hint: Check ANKIWEB_USER / ANKIWEB_PASS secrets.", file=sys.stderr)
            return 1

        print("[anki-smoke] Login OK — pulling collection (sync_media=False)...")
        col.sync_collection(auth, sync_media=False)

        deck_names = [d["name"] for d in col.decks.all_names_and_ids()]
        print(f"[anki-smoke] Sync OK — {len(deck_names)} deck(s) in collection (names not printed)")
        return 0
    finally:
        col.close()


if __name__ == "__main__":
    raise SystemExit(main())
