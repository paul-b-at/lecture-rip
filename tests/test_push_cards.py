"""Offline regression tests: python -m unittest discover -s tests -p 'test_*.py'."""

from __future__ import annotations

import copy
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, create_autospec, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from anki.collection import Collection

import anki_smoke
import push_cards

BATCH = {
    "lectureId": "04fb17aa-bc62-4c3a-9a37-08f426f20fcc",
    "lectureDate": "2026-10-14",
    "courseSlug": "problem-solving",
    "cards": [{
        "type": "basic",
        "front": "What is a heuristic?",
        "back": "A strategy for guiding search.",
        "tags": ["Problem Solving", "Problem_Solving", " search\tstrategy\n", "", "  "],
    }],
}
EXPECTED_TAGS = ["lec-20261014", "problem-solving", "Problem_Solving", "search_strategy"]


class TagTests(unittest.TestCase):
    def test_normalizes_whitespace_and_deduplicates(self):
        self.assertEqual(push_cards.tags_for_card(BATCH, BATCH["cards"][0]), EXPECTED_TAGS)

    def test_missing_null_and_invalid_tags(self):
        for tags in (None, [], [None, 42, " ", "Valid::Child", "über\u00a0cool"]):
            with self.subTest(tags=tags):
                card = {"tags": tags}
                result = push_cards.tags_for_card(BATCH, card)
                self.assertTrue(all(not any(c.isspace() for c in tag) for tag in result))
        self.assertEqual(push_cards.tags_for_card(BATCH, {}), EXPECTED_TAGS[:2])

    def test_normalizes_course_slug_without_changing_deck_name(self):
        batch = {**BATCH, "courseSlug": "Problem Solving"}
        self.assertEqual(push_cards.tags_for_card(batch, {})[1], "Problem_Solving")
        self.assertEqual(push_cards.deck_name(batch["courseSlug"]), "JKU::Problem Solving")

    def test_native_collection_and_guid_deduplication(self):
        with tempfile.TemporaryDirectory() as directory:
            col = Collection(str(Path(directory) / "collection.anki2"))
            try:
                deck_id = col.decks.id(push_cards.deck_name(BATCH["courseSlug"]))
                card = BATCH["cards"][0]
                self.assertEqual(push_cards.add_note_to_collection(col, BATCH, card, deck_id), "added")
                self.assertEqual(push_cards.add_note_to_collection(col, BATCH, card, deck_id), "skipped")
                note = col.get_note(col.find_notes("")[0])
                self.assertEqual(set(note.tags), set(EXPECTED_TAGS))
                self.assertEqual(note.guid, push_cards.note_guid(BATCH["lectureId"], card["front"]))
            finally:
                col.close()

    def test_real_apkg_export_for_all_card_types(self):
        batch = copy.deepcopy(BATCH)
        batch["cards"] += [
            {"type": "mc", "front": "Pick one", "back": "Explanation", "options": ["A", "B"], "correct": 0, "tags": ["Problem Solving"]},
            {"type": "cloze", "front": "A {{c1::heuristic}} guides search.", "back": "", "tags": ["Problem Solving"]},
        ]
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(push_cards, "OUT_DIR", Path(directory)):
                path = push_cards.write_apkg(batch)
            with zipfile.ZipFile(path) as package:
                package.extract("collection.anki2", directory)
            with sqlite3.connect(Path(directory) / "collection.anki2") as db:
                notes = db.execute("SELECT guid, tags FROM notes").fetchall()
            self.assertEqual(len(notes), 3)
            for guid, tags in notes:
                self.assertIn("Problem_Solving", tags.split())
                self.assertNotIn("Problem Solving", tags)
            self.assertIn(push_cards.note_guid(BATCH["lectureId"], BATCH["cards"][0]["front"]), [row[0] for row in notes])


class LoginTests(unittest.TestCase):
    @patch.dict(os.environ, {"ANKIWEB_USER": "test@example.invalid", "ANKIWEB_PASS": "test-only"})
    def test_sync_pull_passes_endpoint_and_disables_media(self):
        col = create_autospec(Collection, instance=True)
        auth = push_cards.sync_pull(col)
        col.sync_login.assert_called_once_with("test@example.invalid", "test-only", endpoint=None)
        col.sync_collection.assert_called_once_with(auth, sync_media=False)

    @patch.dict(os.environ, {"ANKIWEB_USER": "test@example.invalid", "ANKIWEB_PASS": "test-only"})
    def test_smoke_passes_endpoint(self):
        col = create_autospec(Collection, instance=True)
        col.decks = MagicMock()
        col.decks.all_names_and_ids.return_value = []
        with tempfile.TemporaryDirectory() as directory, patch.object(anki_smoke, "COLLECTION_PATH", Path(directory) / "collection.anki2"), patch("anki.collection.Collection", return_value=col):
            self.assertEqual(anki_smoke.main(), 0)
        col.sync_login.assert_called_once_with("test@example.invalid", "test-only", endpoint=None)
        col.close.assert_called_once()


class DeliveryTests(unittest.TestCase):
    def run_delivery(self, *, pull_error=None, push_error=None, fallback=True, missing_anki=False, card_failures=0, batch_error=None):
        col = MagicMock()
        with ExitStack() as stack:
            directory = stack.enter_context(tempfile.TemporaryDirectory())
            stack.enter_context(patch.object(push_cards, "COLLECTION_PATH", Path(directory) / "collection.anki2"))
            stack.enter_context(patch.object(push_cards, "load_batches", return_value=[copy.deepcopy(BATCH)]))
            stack.enter_context(patch.object(push_cards, "log"))
            stack.enter_context(patch.dict(os.environ, {"NOTION_TOKEN": "test-only", "ANKI_DECKS_DS_ID": "test-only"}))
            stack.enter_context(patch("anki.collection.Collection", return_value=col))
            stack.enter_context(patch.object(push_cards, "sync_pull", side_effect=pull_error, return_value=object()))
            stack.enter_context(patch.object(push_cards, "sync_push", side_effect=push_error))
            stack.enter_context(patch.object(push_cards, "push_batch_to_collection", side_effect=batch_error, return_value={"added": 1, "skipped": 0, "failed": card_failures}))
            fallback_mock = stack.enter_context(patch.object(push_cards, "fallback_apkg_notion", return_value=fallback))
            find_row = stack.enter_context(patch.object(push_cards, "notion_find_deck_row", return_value="test-row"))
            request_patch = stack.enter_context(patch.object(push_cards.requests, "patch"))
            if missing_anki:
                stack.enter_context(patch.dict(sys.modules, {"anki.collection": None}))
            result = push_cards.main()
            return result, fallback_mock.call_count, find_row.call_count, request_patch.call_count, col

    def test_no_batches_is_success(self):
        with patch.object(push_cards, "load_batches", return_value=[]):
            self.assertEqual(push_cards.main(), 0)

    def test_pull_failure_falls_back_and_reports_failure_if_undelivered(self):
        for fallback in (True, False):
            with self.subTest(fallback=fallback):
                result, calls, updates, _, col = self.run_delivery(pull_error=RuntimeError("login failed"), fallback=fallback)
                self.assertEqual(result, 0 if fallback else 1)
                self.assertEqual(calls, 1)
                self.assertEqual(updates, 0)
                col.close.assert_called_once()

    def test_missing_anki_fallback_exit_status(self):
        for fallback in (True, False):
            with self.subTest(fallback=fallback):
                result, calls, updates, _, _ = self.run_delivery(missing_anki=True, fallback=fallback)
                self.assertEqual(result, 0 if fallback else 1)
                self.assertEqual(calls, 1)
                self.assertEqual(updates, 0)

    def test_push_failures_use_fallback_and_never_mark_synced(self):
        for error in (push_cards.SyncConflictError("conflict"), RuntimeError("connection refused")):
            for fallback in (True, False):
                with self.subTest(error=error, fallback=fallback):
                    result, calls, updates, patches, col = self.run_delivery(push_error=error, fallback=fallback)
                    self.assertEqual(result, 0 if fallback else 1)
                    self.assertEqual(calls, 1)
                    self.assertEqual((updates, patches), (0, 0))
                    col.close.assert_called_once()

    def test_success_marks_synced_without_fallback(self):
        result, calls, updates, patches, col = self.run_delivery()
        self.assertEqual((result, calls, updates, patches), (0, 0, 1, 1))
        col.close.assert_called_once()

    def test_card_failure_returns_nonzero_without_synced_status(self):
        result, _, updates, _, _ = self.run_delivery(card_failures=1)
        self.assertEqual((result, updates), (1, 0))

    def test_batch_exception_recovered_by_fallback(self):
        for fallback in (True, False):
            with self.subTest(fallback=fallback):
                result, calls, updates, _, _ = self.run_delivery(batch_error=RuntimeError("batch error"), fallback=fallback)
                self.assertEqual(result, 0 if fallback else 1)
                self.assertEqual((calls, updates), (1, 0))

    def test_fatal_error_exits_nonzero(self):
        script = str(Path(push_cards.__file__).resolve())
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "out"
            out.mkdir()
            (out / "cards.json").write_text("invalid json")
            result = subprocess.run([sys.executable, script], cwd=directory, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Fatal error", result.stdout)


if __name__ == "__main__":
    unittest.main()
