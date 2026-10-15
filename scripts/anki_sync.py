"""Safe headless Anki sync, shared by the card pipeline and smoke test."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class SyncConflictError(Exception):
    """Sync could not finish safely; do not overwrite either collection."""


def checked_sync(
    col: Any,
    auth: Any,
    phase: str,
    *,
    allow_initial_download: bool = False,
    log: Callable[[str], None] = print,
) -> None:
    """Complete normal sync or bootstrap a verified-empty local collection.

    Only a pull may resolve FULL_DOWNLOAD automatically, before notes are added.
    Never full-upload, replace a nonempty collection, or repeat a full download
    if the verification sync still requests one.
    """
    from anki.sync_pb2 import SyncCollectionResponse

    def sync_result() -> int:
        result = col.sync_collection(auth, sync_media=False)
        required = result.required
        state = SyncCollectionResponse.ChangesRequired.Name(required)
        log(f"[push_cards] {phase} sync result: {state}")
        if result.new_endpoint:
            auth.endpoint = result.new_endpoint
        return required

    required = sync_result()
    if (
        allow_initial_download
        and phase == "pull"
        and required == SyncCollectionResponse.FULL_DOWNLOAD
    ):
        # is_empty() checks cards only. Orphan notes must also block replacement.
        if col.note_count() != 0 or col.card_count() != 0:
            raise SyncConflictError(
                "pull sync requires FULL_DOWNLOAD, but the local collection is "
                "not empty; refusing to replace local notes/cards"
            )
        log("[push_cards] Bootstrapping empty collection from AnkiWeb (download only, no media)")
        col.close_for_full_sync()
        try:
            col.full_upload_or_download(auth=auth, server_usn=None, upload=False)
        finally:
            # Anki's desktop client reopens after success or failure as well.
            col.reopen(after_full_sync=True)
        log("[push_cards] Initial download finished; verifying collection sync")
        required = sync_result()

    if required != SyncCollectionResponse.NO_CHANGES:
        state = SyncCollectionResponse.ChangesRequired.Name(required)
        raise SyncConflictError(
            f"{phase} sync incomplete ({state}); refusing unsafe full sync — "
            "using .apkg fallback"
        )
