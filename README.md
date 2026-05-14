# lecture-rip

AI lecture transcriber for JKU — **GitHub Actions runs hourly** (`0 * * * *` UTC): discovers episodes on [media.jku.at](https://media.jku.at), transcribes with Groq Whisper, post-processes with Gemini 2.5 Flash, writes structured notes to Notion. **`actions/cache`** keeps `.cache/budget.json` and transcripts across runs.

**Quota / resume:** When Groq *hourly decoded-audio* or *daily Whisper-request* caps (or Gemini *daily requests*) hit, the run exits **without** mass-marking lectures `Skipped`—each lecture stays on its last good **Status** (`Discovered`, `Downloaded`, `Transcribed`, …) and the **next hourly run** continues where it left off.

![lecture-rip](https://github.com/paul-b-at/lecture-rip/actions/workflows/lecture-rip.yml/badge.svg)

## Stack

- **Runtime:** Bun + TypeScript
- **Discovery:** `https://media.jku.at/search/series.json` + `/search/episode.json` (no Moodle login)
- **Transcription:** Groq Whisper (`whisper-large-v3`) — local bookkeeping in `.cache/budget.json`: **decoded audio seconds per UTC hour bucket** (`GROQ_HOURLY_AUDIO_SECONDS` or legacy **`GROQ_DAILY_AUDIO_SECONDS`**, default **7200** ≈ **2 hours** of lecture audio **that Groq hour**; counter resets when the UTC clock hour changes). **Whisper API call count** is still **per UTC calendar day** (`GROQ_DIALY_REQUESTS` / `GROQ_DAILY_REQUESTS`, default `200`).
- **Postprocessing:** Gemini 2.5 Flash (JSON schema mode) — **`GEMINI_DAILY_REQUESTS`** (alias **`GEMINI_DIALY_REQUESTS`**, default `500`) caps **`generateContent`** calls per day (each validation retry or fallback model is another request).
- **Storage:** Notion (Lectures DB + Subjects DB)
- **CI:** GitHub Actions hourly (`cron: 0 * * * *`; ~24 short runs/day on the free tier)

## Notion schema

**Subjects**

| Property | Type | Purpose |
|---------|------|--------|
| `Name` | title | subject label (used by `COURSE_FILTER` regex); the runner does **not** read any separate “Course” column on Subjects |
| **`Media Course ID`** | rich text (*or formula string*) | **OpenCast series name** as shown on media.jku.at (`2026S344090`, `2025W338002`, `2025W338002/4/…`). You can alternatively store **LU digits only** (`344090`); those are paired with `MEDIA_SEMESTER`/calendar semantics. Digit-only formulas that concatenate year+LU (`2026344090`) are normalized by stripping one leading `YYYY`. You can also paste a **watch / Engage URL** (`…/paella7/ui/watch.html?id=…`, `…/play/<uuid>`, `…&epFrom=<uuid>`); discovery loads that mediapackage via `/search/episode.json?id=…` and then follows its **series** id. |
| **`Media Series ID`** | optional text / URL / formula | paste OpenCast **series UUID** to pin — skips ambiguous search |
| `Glossary` | rich text | passed to Whisper as `prompt` |

**Lectures** — expected fields: title (`Name` by default), `Lecture ID` (rich text, episode UUID), **link to Subject** (`Course ID` rich-text UUID **or** relation **Subjects** column), **`Moodle URL`** (URL), `Status` (select), `Skip Reason`. Omit any extra **Course** title column—the Subject relation (or Subject uuid) identifies the course. The Gemini summary is on the lecture **page body** (blocks). Rename columns via `NOTION_LECTURES_*` (see `.env.example`). **`NOTION_LECTURES_SUBJECT_KIND=relation`** when the Subject column is a relation. If env names are omitted in CI (empty Actions secrets), the runner infers **`JKU Lecture ID`**, relation **`Subjects`**, and **`Source URL`** when those exact columns exist.

Semester tagging follows OpenCast: **`YYYYW`** (Wintersemester Oct–Feb) vs **`YYYYS`** (Sommersemester Mar–Sep), see [`src/semester.ts`](src/semester.ts). Override with **`MEDIA_SEMESTER`** (e.g. `2026S`). Set `auto` explicitly to reuse the computed default.

## Setup

1. Copy `.env.example` to `.env` and fill in credentials
2. `bun install`
3. `bun run start`

To capture logs, use `bun run start:tee` (creates `logs/`, then runs with `bash -o pipefail` so if `bun` fails, the script’s exit code reflects that—not just `tee`).

Optional env: `MEDIA_BASE_URL`, `MEDIA_SEMESTER`, `COURSE_FILTER`, `MEDIA_SESSION_COOKIE`, `MEDIA_PLAYWRIGHT_STATE`.

**Discovery finds 0 lectures:** (1) Each Subject row needs **Media Course ID** (full series name like `2026S344090`, LU-only digits paired with **`MEDIA_SEMESTER`**, or a watch/play URL hint) **or** **Media Series ID** (series UUID). (2) **Notion column names** must match (override with **`NOTION_SUBJECTS_*`**). (3) **`COURSE_FILTER`** can exclude every Subject. (4) Anonymous **`/search/`** may omit your course — set **`MEDIA_SESSION_COOKIE`** from a logged-in browser or paste the **series UUID**. (5) If you store **LU-only** IDs, discovery steps through **neighbor semesters** (e.g. `2026S` then `2025W`) because OpenCast titles often disagree with calendar **`MEDIA_SEMESTER`**.

Some courses stay out of **anonymous** `/search/` results (nothing matches `2026S…344090`). Paella relies on `/search/episode.json?id=` with your browser cookies.

**Local session**

- **Raw header:** copy **`Cookie`** from DevTools while logged into `media.jku.at`, set **`MEDIA_SESSION_COOKIE`**.
- **Playwright once:** `bunx playwright install chromium`, then **`bun run media:login`**. Complete Shibboleth in the headed window, save, and set **`MEDIA_PLAYWRIGHT_STATE=.cache/jku-media-storage.json`**. The runner reads that JSON and builds the same `Cookie` header (Playwright is **not** launched during `bun run start`).

**GitHub Actions:** hosted runners cannot complete interactive Shibboleth + MFA for you. Typical options: only process courses visible to anonymous `/search/`; keep a rotating **`MEDIA_SESSION_COOKIE`** repo secret (high sensitivity); use a **self-hosted** runner; or pin **`Media Series ID`** when indexing allows. Unattended Playwright with stored credentials is brittle and not shipped here on purpose (MFA, AUP, and breakage across IdP changes).

Do not commit `.env` or `.cache/jku-media-storage.json`.

### Run locally instead of Actions (LaunchAgent)

Use this for **free** unattended runs while your Mac is awake (no Actions minutes):

1. Copy [`scripts/launchd/lecture-rip.hourly.plist`](scripts/launchd/lecture-rip.hourly.plist) into `~/Library/LaunchAgents/`.
2. Edit **both** `/ABSOLUTE/PATH/TO/lecture-rip` placeholders and **`/usr/local/bin/bun`** (`which bun`; Homebrew Apple Silicon often uses `/opt/homebrew/bin/bun`).
3. `mkdir -p logs` in the repo.
4. Load once:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/lecture-rip.hourly.plist
```

Unload:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/lecture-rip.hourly.plist
```

Runs at **minute 0 of every clock hour** in your Mac’s timezone; Groq bookkeeping in `.cache/budget.json` resets on **UTC** hour buckets—if you care about aligning with Actions, stick to GH or adjust the plist to UTC.

## GitHub Actions

Uses **`ubuntu-latest`** with **`paths: .cache`** cache key `lecture-rip-state-v1` plus **concurrency** `group: lecture-rip` / `cancel-in-progress: false` so queued runs keep a consistent `.cache/` state. **`timeout-minutes: 30`** per job — each cron tick is intended to finish quickly after the hourly quotas.

### Secrets

| Secret | Purpose |
|--------|---------|
| `NOTION_TOKEN` | Notion integration token |
| `LECTURES_DS_ID` | Lectures database ID |
| `SUBJECTS_DS_ID` | Subjects database ID |
| `NOTION_LECTURES_LECTURE_ID` | *(optional)* Lectures DB **column title** for the OpenCast / dedupe id (defaults to `Lecture ID` — set if your columns are not English) |
| `NOTION_LECTURES_COURSE_SUBJECT` | *(optional)* column for subject link (`Course ID` default) |
| `NOTION_LECTURES_SUBJECT_KIND` | *(optional)* `relation` if that column is a Relation to Subjects; default `rich_text` |
| `NOTION_LECTURES_MEDIA_URL` | *(optional)* URL column (`Moodle URL` default); use exact Notion title, e.g. **Media-Link** |
| `NOTION_LECTURES_NAME` / `STATUS` / `SKIP_REASON` | *(optional)* only if those titles differ from defaults |
| `NOTION_SUBJECTS_MEDIA_COURSE_ID` | *(optional)* Subjects DB column (`Media Course ID` default) |
| `NOTION_SUBJECTS_MEDIA_SERIES_ID` | *(optional)* Subjects DB column (`Media Series ID` default) |
| `NOTION_SUBJECTS_GLOSSARY` | *(optional)* Subjects glossary column |
| `GROQ_API_KEY` | Groq API key |
| `GEMINI_API_KEY` | Gemini API key |
| `GROQ_HOURLY_AUDIO_SECONDS` | *(optional)* local cap on **decoded audio seconds per UTC hour** (default **`7200` ≈ 2h content** in that hour bucket; Groq-style rolling hour). Legacy secret name `GROQ_DAILY_AUDIO_SECONDS` still works as the same numeric cap for this **hourly** tally |
| `GROQ_DIALY_REQUESTS` / `GROQ_DAILY_REQUESTS` | *(optional)* Whisper **requests per UTC calendar day** (default `200`) |
| `GROQ_INTER_CHUNK_MS` | *(optional)* delay between chunk requests (`transcribe`); helps avoid Groq TPM/burst **429**s on multi-chunk opus files |
| `GEMINI_DAILY_REQUESTS` | *(optional)* local daily cap on **Gemini `generateContent`** calls (default `500`) |
| `NTFY_TOPIC` | ntfy topic for failures |
| `MEDIA_BASE_URL` | *(optional)* default `https://media.jku.at` |
| `MEDIA_SESSION_COOKIE` | *(optional)* full `Cookie` header for MEDIA_BASE_URL; use when ACL blocks anonymous `/search/` |
| `MEDIA_PLAYWRIGHT_STATE` | *(optional)* Playwright storage state JSON path (interactive login only makes sense locally) |
| `MEDIA_SEMESTER` | *(optional)* e.g. `2026S`; leave empty for auto |

Notion column-title overrides (**`NOTION_LECTURES_*`**, **`NOTION_SUBJECTS_*`**) mirror `.env`; set them under **Repository → Settings → Secrets and variables → Actions** so CI matches local `.env`.

`JKU_USER` / `JKU_PASS` are **no longer** used.

## Manual dispatch

```bash
gh workflow run lecture-rip.yml -f course_filter="ml-pattern" -f force_rerip=true
```
