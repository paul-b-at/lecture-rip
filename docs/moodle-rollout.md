# Moodle-first rollout

## What changed

Both repositories use the identical `src/moodle.ts` session adapter. This is shared authentication **logic**, not a shared persisted login or a new hosted service. Each scheduled job signs in independently via Shibboleth. No Moodle REST token is needed: requests use the signed-in session AJAX API. Browser cookies, SAML/LTI launch URLs and session state must never enter logs, commits, artifacts or Actions caches.

- lecture-rip reads enrolled current-term Moodle courses, finds individual and collection Opencast activities, launches each pending recording through Moodle LTI, then passes its original episode UUID and authenticated MP4 access to the existing transcription/notes/Anki pipeline.
- jku-notion-sync reads paginated calendar action events and supplements them with complete per-course monthly calendars. Assignments, quiz closing deadlines, checkmark/Crosses, feedback, lesson and workshop deadlines are supported. Meeting/open events are excluded. A quiz with no published closing deadline is not given an invented due date.
- Deadline scans cover the previous 30 days through four months ahead, restricted to the current JKU semester. Tasks with no published deadline are outside this sync.
- Task `Status`, `Assignee`, page bodies and manual entries are not overwritten. Disappearing events do not mean completion or cancellation. No task deletion/pruning is performed.
- Assignment IDs remain course-module IDs (the existing myJKU `JKU ID` format). Additional activity types use namespaced keys. Migration also matches canonical activity links on legacy `Source = JKU Sync` rows only; ambiguous matches fail.
- The existing myJKU exam sync remains in place. Exam registrations are not migrated to Moodle.

## Activation checklist

1. Merge only after Validate is green and the live preview below has been checked.
2. Verify `JKU_USER` and `JKU_PASS` exist as Actions secrets in **each** repo. The task repo already references those secret names; their presence/values have not been inspected. The lecture repo needs them too. Never send passwords in chat or commit them. Existing Notion/Groq/Gemini/Anki secrets are unchanged.
3. Run the task workflow manually with `dry_run=true` (default). Confirm existing assignments show **updated**, not duplicates, and the new activity types have the right Subjects/dates. No task or exam writes/pruning happen in dry-run.
4. Run lecture-rip manually with `discover_only=true` (default). This performs Notion reads and authenticated recording discovery only: no Notion writes, AI calls, video downloads or Anki sync.
5. If previews succeed, run both with the preview input disabled. The cron paths default to live after merge.
6. Verify a subsequent scheduled run, including a fresh-runner Shibboleth login. A browser session smoke test does **not** validate unattended CI authentication. If JKU requires interactive MFA, stop and use an approved interactive/self-hosted route; do not bypass it.

## Rollback

Locally set `TASK_SOURCE=myjku` or `RECORDING_SOURCE=media` to explicitly use the old source. Actions workflows pin `moodle`, so edit the matching workflow setting or revert the PR for a CI rollback. Never automatically fall back to a green empty result after authentication failure.

## Development

`bun install --frozen-lockfile`, `bun run check`, `bun test`. Keep the shared adapter and shared regression tests identical in both repos when modifying them. No sessions are persisted by lecture-rip; the task repo's existing local `.session/` remains gitignored and is not cached in CI.
