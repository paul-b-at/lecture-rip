# Automatic Anki sync

The card push step authenticates to AnkiWeb, pulls the collection, adds generated notes to `JKU::<courseSlug>`, then pushes changes. Sync your Anki app to receive them.

## First run or missing cache

If Anki returns `FULL_DOWNLOAD` during the initial pull, the script verifies that the runner has **zero notes and zero cards**. It then downloads the existing AnkiWeb collection, reopens it, and verifies normal sync completes before adding cards. No manual bootstrap or ZIP import is needed for this case. Media sync is disabled.

Expected log sequence:

```text
[push_cards] AnkiWeb login succeeded
[push_cards] pull sync result: FULL_DOWNLOAD
[push_cards] Bootstrapping empty collection from AnkiWeb (download only, no media)
[push_cards] Initial download finished; verifying collection sync
[push_cards] pull sync result: NO_CHANGES
...
[push_cards] push sync result: NO_CHANGES
[push_cards] AnkiWeb push sync completed
```

`added=N` counts local additions. The final push-completed message indicates the sync API reported completion; the script does not independently query AnkiWeb afterward.

## Safety and fallback

- Never automatically full-upload a collection.
- Never full-download over local notes or cards, including orphan notes.
- Never full-download during the push phase after cards have been added.
- Ambiguous `FULL_SYNC`, `FULL_UPLOAD`, failed download, or unsuccessful verification uses the existing Notion ZIP fallback instead.
- Bootstrap performs at most one download per pull; it does not loop on unresolved full-sync requests.
- A failed delivery through both paths returns a nonzero exit code.

For fallback delivery, download `course-date.apkg.zip` from the Notion row's **Deck file**, extract it, then import its unchanged `.apkg` into Anki. Past fallback-only lectures are not automatically reprocessed by this change.

## Tests

Install `anki`, `genanki`, and `requests` first.

```sh
python -m unittest discover -s tests -p 'test_*.py' -v
python tests/anki_sync_roundtrip.py
```

The second command launches Anki's bundled sync server bound to `127.0.0.1` with temporary collections and a throwaway account. It seeds one existing note, bootstraps an empty runner, pushes Basic/MC/Cloze notes, tests duplicate handling on a second pass, and verifies that another client receives all four notes. Its full upload is only for seeding that temporary test server; production never full-uploads. It uses no real account credentials and never contacts AnkiWeb.
