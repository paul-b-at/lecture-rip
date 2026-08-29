#!/usr/bin/env python3
"""Push lecture-rip Anki cards to AnkiWeb; .apkg + Notion fallback on sync failure."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import traceback
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import genanki
import requests

from anki_models import (
    collection_model_id,
    deck_id_for_name,
    get_genanki_basic_model,
    get_genanki_cloze_model,
    get_genanki_mc_model,
    note_fields_for_card,
)

COLLECTION_PATH = Path(".cache/anki/collection.anki2")
CARDS_PATH = Path("out/cards.json")
OUT_DIR = Path("out")
NOTION_VERSION = "2022-06-28"


class SyncConflictError(Exception):
    """Raised when AnkiWeb sync conflicts — triggers .apkg fallback, no force overwrite."""


def log(msg: str) -> None:
    print(msg, flush=True)


def note_guid(lecture_id: str, front: str) -> str:
    digest = hashlib.sha1(f"{lecture_id}:{front}".encode("utf-8")).hexdigest()
    return digest[:10]


def lec_tag(lecture_date: str) -> str:
    compact = lecture_date.replace("-", "")
    return f"lec-{compact}"


def deck_name(course_slug: str) -> str:
    return f"JKU::{course_slug}"


def count_by_type(cards: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"mc": 0, "basic": 0, "cloze": 0}
    for c in cards:
        t = c.get("type")
        if t in counts:
            counts[t] += 1
    return counts


def load_batches() -> list[dict[str, Any]]:
    if not CARDS_PATH.exists():
        return []
    raw = json.loads(CARDS_PATH.read_text(encoding="utf-8"))
    return raw if isinstance(raw, list) else []


def guid_exists(col: Any, guid: str) -> bool:
    row = col.db.scalar("SELECT 1 FROM notes WHERE guid = ?", guid)
    return row is not None


def add_note_to_collection(
    col: Any,
    batch: dict[str, Any],
    card: dict[str, Any],
    deck_id: int,
) -> str:
    """Returns 'added' | 'skipped'."""
    guid = note_guid(batch["lectureId"], card["front"])
    if guid_exists(col, guid):
        return "skipped"

    model_id = collection_model_id(col, card["type"])
    model = col.models.get(model_id)
    note = col.new_note(model)
    note.guid = guid
    fields = note_fields_for_card(card)
    for i, val in enumerate(fields):
        note.fields[i] = val

    tags = list(dict.fromkeys(
        [lec_tag(batch["lectureDate"]), batch["courseSlug"], *card.get("tags", [])]
    ))
    note.tags = tags
    col.add_note(note, deck_id)
    return "added"


def push_batch_to_collection(col: Any, batch: dict[str, Any]) -> dict[str, int]:
    dname = deck_name(batch["courseSlug"])
    deck_id = col.decks.id(dname, create=True)
    stats = {"added": 0, "skipped": 0, "failed": 0}

    for card in batch.get("cards") or []:
        try:
            result = add_note_to_collection(col, batch, card, deck_id)
            stats[result] += 1
        except Exception as e:
            stats["failed"] += 1
            log(f"[push_cards] Card add failed ({batch.get('lectureId')}): {e}")
    return stats


def build_genanki_deck(batch: dict[str, Any]) -> genanki.Deck:
    dname = deck_name(batch["courseSlug"])
    deck = genanki.Deck(deck_id_for_name(dname), dname)
    mc_model = get_genanki_mc_model()
    basic_model = get_genanki_basic_model()
    cloze_model = get_genanki_cloze_model()

    for card in batch.get("cards") or []:
        guid = note_guid(batch["lectureId"], card["front"])
        ctype = card["type"]
        if ctype == "mc":
            model = mc_model
            fields = note_fields_for_card(card)
        elif ctype == "basic":
            model = basic_model
            fields = note_fields_for_card(card)
        elif ctype == "cloze":
            model = cloze_model
            fields = note_fields_for_card(card)
        else:
            continue

        note = genanki.Note(
            model=model,
            fields=fields,
            guid=guid,
            tags=[lec_tag(batch["lectureDate"]), batch["courseSlug"], *card.get("tags", [])],
        )
        deck.add_note(note)
    return deck


def write_apkg(batch: dict[str, Any]) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = batch["courseSlug"]
    dt = batch["lectureDate"]
    out_path = OUT_DIR / f"{slug}-{dt}.apkg"
    deck = build_genanki_deck(batch)
    package = genanki.Package(deck)
    package.models = [
        get_genanki_mc_model(),
        get_genanki_basic_model(),
        get_genanki_cloze_model(),
    ]
    package.write_to_file(str(out_path))
    return out_path


def notion_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def notion_upload_file(token: str, file_path: Path) -> str:
    """Upload file via Notion file_uploads API; return file_upload id."""
    create = requests.post(
        "https://api.notion.com/v1/file_uploads",
        headers=notion_headers(token),
        json={
            "filename": file_path.name,
            "content_type": "application/octet-stream",
        },
        timeout=120,
    )
    create.raise_for_status()
    upload_id = create.json()["id"]

    with file_path.open("rb") as fh:
        send = requests.post(
            f"https://api.notion.com/v1/file_uploads/{upload_id}/send",
            headers={
                "Authorization": f"Bearer {token}",
                "Notion-Version": NOTION_VERSION,
            },
            files={"file": (file_path.name, fh, "application/octet-stream")},
            timeout=300,
        )
    send.raise_for_status()
    return upload_id


def notion_find_deck_row(token: str, database_id: str, course_slug: str) -> str | None:
    resp = requests.post(
        f"https://api.notion.com/v1/databases/{database_id}/query",
        headers=notion_headers(token),
        json={
            "filter": {
                "property": "Course Slug",
                "rich_text": {"equals": course_slug},
            },
            "page_size": 1,
        },
        timeout=60,
    )
    resp.raise_for_status()
    results = resp.json().get("results") or []
    if not results:
        return None
    return results[0]["id"]


def notion_upsert_deck_row(
    token: str,
    database_id: str,
    batch: dict[str, Any],
    apkg_path: Path,
    upload_id: str,
) -> str:
    course_slug = batch["courseSlug"]
    counts = count_by_type(batch.get("cards") or [])
    total = sum(counts.values())
    title = f"{course_slug} — {batch['lectureDate']}"
    today = date.today().isoformat()

    properties: dict[str, Any] = {
        "Name": {"title": [{"text": {"content": title[:2000]}}]},
        "Course Slug": {"rich_text": [{"text": {"content": course_slug[:2000]}}]},
        "Deck file": {
            "files": [
                {
                    "type": "file_upload",
                    "file_upload": {"id": upload_id},
                    "name": apkg_path.name,
                },
            ],
        },
        "Source": {"select": {"name": ".apkg fallback"}},
        "Status": {"select": {"name": "Ready"}},
        "Card count": {"number": total},
        "MC cards": {"number": counts["mc"]},
        "Basic cards": {"number": counts["basic"]},
        "Cloze cards": {"number": counts["cloze"]},
        "Last generated": {"date": {"start": today}},
    }

    page_id = notion_find_deck_row(token, database_id, course_slug)
    if page_id:
        resp = requests.patch(
            f"https://api.notion.com/v1/pages/{page_id}",
            headers=notion_headers(token),
            json={"properties": properties},
            timeout=60,
        )
        resp.raise_for_status()
        return page_id

    resp = requests.post(
        "https://api.notion.com/v1/pages",
        headers=notion_headers(token),
        json={
            "parent": {"database_id": database_id},
            "properties": properties,
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["id"]


def ntfy_ping(topic: str, message: str) -> None:
    if not topic:
        return
    try:
        requests.post(f"https://ntfy.sh/{topic}", data=message.encode("utf-8"), timeout=15)
    except Exception as e:
        log(f"[push_cards] ntfy ping failed: {e}")


def fallback_apkg_notion(batch: dict[str, Any]) -> bool:
    token = (os.environ.get("NOTION_TOKEN") or "").strip()
    database_id = (os.environ.get("ANKI_DECKS_DS_ID") or "").strip()
    ntfy_topic = (os.environ.get("NTFY_TOPIC") or "").strip()

    if not token or not database_id:
        log("[push_cards] Fallback skipped — NOTION_TOKEN or ANKI_DECKS_DS_ID unset")
        return False

    try:
        apkg_path = write_apkg(batch)
        upload_id = notion_upload_file(token, apkg_path)
        page_id = notion_upsert_deck_row(token, database_id, batch, apkg_path, upload_id)
        counts = count_by_type(batch.get("cards") or [])
        total = sum(counts.values())
        notion_url = f"https://notion.so/{page_id.replace('-', '')}"
        log(f"[push_cards] Fallback .apkg → Notion ({total} cards): {notion_url}")
        ntfy_ping(
            ntfy_topic,
            f"lecture-rip Anki fallback: {batch['courseSlug']} {total} cards → {notion_url}",
        )
        return True
    except Exception as e:
        log(f"[push_cards] Fallback failed for {batch.get('lectureId')}: {e}")
        traceback.print_exc()
        return False


def sync_pull(col: Any) -> Any:
    user = (os.environ.get("ANKIWEB_USER") or "").strip()
    password = (os.environ.get("ANKIWEB_PASS") or "").strip()
    if not user or not password:
        raise RuntimeError("ANKIWEB_USER / ANKIWEB_PASS not set")
    auth = col.sync_login(user, password)
    col.sync_collection(auth, sync_media=False)
    return auth


def sync_push(col: Any, auth: Any) -> None:
    try:
        col.sync_collection(auth, sync_media=False)
    except Exception as e:
        msg = str(e).lower()
        if "conflict" in msg or "sync" in msg:
            raise SyncConflictError(str(e)) from e
        raise


def main() -> int:
    batches = load_batches()
    if not batches:
        log("[push_cards] No out/cards.json batches — nothing to do")
        return 0

    totals = {
        "lectures": 0,
        "added": 0,
        "skipped_dupes": 0,
        "failed": 0,
        "fallback": 0,
    }

    try:
        from anki.collection import Collection
    except ImportError:
        log("[push_cards] ERROR: pip install anki genanki requests")
        for batch in batches:
            if fallback_apkg_notion(batch):
                totals["fallback"] += 1
        log(
            f"[push_cards] summary lectures={len(batches)} added=0 skipped-dupes=0 "
            f"failed=0 fallback={totals['fallback']} (anki not installed)"
        )
        return 0

    COLLECTION_PATH.parent.mkdir(parents=True, exist_ok=True)
    col = Collection(str(COLLECTION_PATH))

    auth = None
    sync_ok = False
    try:
        auth = sync_pull(col)
        sync_ok = True
    except Exception as e:
        log(f"[push_cards] AnkiWeb login/sync failed — using .apkg fallback: {e}")
        col.close()
        for batch in batches:
            totals["lectures"] += 1
            if fallback_apkg_notion(batch):
                totals["fallback"] += 1
            else:
                totals["failed"] += 1
        log(
            f"[push_cards] summary lectures={totals['lectures']} added=0 skipped-dupes=0 "
            f"failed={totals['failed']} fallback={totals['fallback']}"
        )
        return 0

    try:
        for batch in batches:
            totals["lectures"] += 1
            lecture_id = batch.get("lectureId", "?")
            try:
                stats = push_batch_to_collection(col, batch)
                totals["added"] += stats["added"]
                totals["skipped_dupes"] += stats["skipped"]
                totals["failed"] += stats["failed"]
                log(
                    f"[push_cards] {lecture_id}: added={stats['added']} "
                    f"skipped={stats['skipped']} failed={stats['failed']}"
                )
            except Exception as e:
                log(f"[push_cards] Batch failed ({lecture_id}): {e}")
                totals["failed"] += 1
                if fallback_apkg_notion(batch):
                    totals["fallback"] += 1

        if sync_ok and auth is not None:
            try:
                sync_push(col, auth)
            except SyncConflictError as e:
                log(f"[push_cards] Sync conflict on push — falling back affected batches: {e}")
                for batch in batches:
                    if fallback_apkg_notion(batch):
                        totals["fallback"] += 1
            except Exception as e:
                log(f"[push_cards] Push sync failed (notes may be local only): {e}")

        # Mark synced rows in Notion when push succeeded without conflict fallback
        token = (os.environ.get("NOTION_TOKEN") or "").strip()
        db_id = (os.environ.get("ANKI_DECKS_DS_ID") or "").strip()
        if token and db_id and totals["added"] > 0 and totals["fallback"] == 0:
            by_course: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for batch in batches:
                by_course[batch["courseSlug"]].append(batch)
            for course_slug, course_batches in by_course.items():
                all_cards: list[dict[str, Any]] = []
                for b in course_batches:
                    all_cards.extend(b.get("cards") or [])
                try:
                    counts = count_by_type(all_cards)
                    page_id = notion_find_deck_row(token, db_id, course_slug)
                    props = {
                        "Name": {
                            "title": [{"text": {"content": f"{course_slug} (AnkiWeb)"[:2000]}}],
                        },
                        "Course Slug": {"rich_text": [{"text": {"content": course_slug[:2000]}}]},
                        "Source": {"select": {"name": "AnkiWeb sync"}},
                        "Status": {"select": {"name": "Synced"}},
                        "Card count": {"number": sum(counts.values())},
                        "MC cards": {"number": counts["mc"]},
                        "Basic cards": {"number": counts["basic"]},
                        "Cloze cards": {"number": counts["cloze"]},
                        "Last generated": {"date": {"start": date.today().isoformat()}},
                    }
                    if page_id:
                        requests.patch(
                            f"https://api.notion.com/v1/pages/{page_id}",
                            headers=notion_headers(token),
                            json={"properties": props},
                            timeout=60,
                        )
                    else:
                        requests.post(
                            "https://api.notion.com/v1/pages",
                            headers=notion_headers(token),
                            json={"parent": {"database_id": db_id}, "properties": props},
                            timeout=60,
                        )
                except Exception as e:
                    log(f"[push_cards] Notion sync status update failed ({course_slug}): {e}")

    finally:
        col.close()

    log(
        f"[push_cards] summary lectures={totals['lectures']} added={totals['added']} "
        f"skipped-dupes={totals['skipped_dupes']} failed={totals['failed']} "
        f"fallback={totals['fallback']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        log(f"[push_cards] Fatal error (non-blocking): {e}")
        traceback.print_exc()
        raise SystemExit(0)
