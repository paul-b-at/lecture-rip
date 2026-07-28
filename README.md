# lecture-rip

lecture-rip is an automated pipeline for JKU lecture recordings on [media.jku.at](https://media.jku.at). It discovers new episodes, transcribes audio with **Groq Whisper** (or optional local **whisper.cpp**), post-processes transcripts with **Gemini**, and writes structured notes to a Notion **Lectures** database. Run it locally with Bun, or on a schedule via **GitHub Actions** (every 3 hours, `0 */3 * * *` UTC).

![lecture-rip](https://github.com/paul-b-at/lecture-rip/actions/workflows/lecture-rip.yml/badge.svg)

## How it works

Each run walks every Subject in Notion and processes lectures that are not yet **Done**:

1. **Discover** — resolve OpenCast series/episodes from Subjects (`Media Course ID` / `Media Series ID`) via `/search/series.json` and `/search/episode.json` (no Moodle login required for public courses).
2. **Download** — fetch the recording, convert to audio with **ffmpeg**.
3. **Transcribe** — **Groq Whisper** (`whisper-large-v3` by default; downshifts to `whisper-large-v3-turbo` under budget pressure). Optional `--local` / `TRANSCRIBE_LOCAL=true` runs **whisper.cpp** on your machine (`WHISPER_MODEL_PATH`; see `.env.example`) and skips Groq — local runs are **time-chunked** (default **12 min** via `WHISPER_CHUNK_MINUTES`) to avoid repetition on long lectures.
4. **Postprocess** — **Gemini** generates chapters, summary, and exam hints (model chain in [`src/postprocess.ts`](src/postprocess.ts)).
5. **Notion** — upsert lecture rows, update **Status**, write the Gemini summary to the lecture **page body** (blocks).

**Stack:** Bun + TypeScript · OpenCast discovery · Groq Whisper or whisper.cpp · Gemini · Notion (Lectures DB + Subjects DB) · GitHub Actions (~8 runs/day on the free tier).

Semester tagging follows OpenCast: **`YYYYW`** (Wintersemester roughly Oct–Feb) vs **`YYYYS`** (Sommersemester Mar–Sep). When **`MEDIA_SEMESTER`** is unset or `auto`, the runner infers "today" in **`MEDIA_SEMESTER_TZ`** (default **`Europe/Vienna`**) so GitHub Actions (UTC clocks) aligns with Austrian term switches ([`src/semester.ts`](src/semester.ts)). Pin with **`MEDIA_SEMESTER=2026S`** when you want that prefix regardless of calendar.

## Setup

### Install

1. Copy `.env.example` to `.env` and fill in credentials.
2. `bun install`
3. `bun run start` (append `-- --local` for local transcription when `WHISPER_MODEL_PATH` is set; Homebrew’s formula installs **`whisper-cli`**, not `whisper-cpp` — see `.env.example`)

To capture logs locally, use `bun run start:tee` (creates `logs/`, then runs with `bash -o pipefail` so if `bun` fails, the script's exit code reflects that—not just `tee`).

Do not commit `.env` or `.local/jku-media-storage.json`.

### Environment (`.env.example`)

| Section | Key vars | Notes |
|---------|----------|-------|
| **Notion** | `NOTION_TOKEN`, `LECTURES_DS_ID`, `SUBJECTS_DS_ID` | Required. Column title overrides via `NOTION_LECTURES_*` / `NOTION_SUBJECTS_*` (see `.env.example`). |
| **Groq** | `GROQ_API_KEY`, `GROQ_HOURLY_AUDIO_SECONDS` | Cloud transcription (default). Optional caps: `GROQ_DAILY_AUDIO_SECONDS`, `GROQ_DAILY_REQUESTS`, `GROQ_INTER_CHUNK_MS`. |
| **Local whisper** | `TRANSCRIBE_LOCAL`, `WHISPER_MODEL_PATH`, `WHISPER_CLI`, `WHISPER_CHUNK_MINUTES` | Skips Groq; postprocessing stays on Gemini. |
| **Gemini** | `GEMINI_API_KEY`, `GEMINI_DAILY_REQUESTS` | Postprocessing only. |
| **media.jku.at** | `MEDIA_BASE_URL`, `MEDIA_SEMESTER`, `MEDIA_SEMESTER_TZ`, `MEDIA_SESSION_COOKIE`, `MEDIA_PLAYWRIGHT_STATE` | Optional auth for ACL-restricted courses. |
| **Filters** | `COURSE_FILTER`, `FORCE_RERIP` | Regex filter on Subject name; re-rip lectures already at Done. |

Other optional env: `MEDIA_RESOLVE_LOOSE_LU`, `MEDIA_LU_ALLOW_OLDER_SEM_FALLBACK`, `MEDIA_ALLOW_OFF_ANCHOR_MEDIA_KEYS`, `NTFY_TOPIC` (Actions failure ping only).

### Notion schema

**Subjects**

| Property | Type | Purpose |
|---------|------|--------|
| `Name` | title | subject label (used by `COURSE_FILTER` regex); the runner does **not** read any separate "Course" column on Subjects |
| **`Media Course ID`** | rich text (*or formula string*) | **OpenCast series name** as shown on media.jku.at (`2026S344090`, `2025W338002`, `2025W338002/4/…`). You can alternatively store **LU digits only** (`344090`); those are paired with `MEDIA_SEMESTER`/calendar semantics. Digit-only formulas that concatenate year+LU (`2026344090`) are normalized by stripping one leading `YYYY`. You can also paste a **watch / Engage URL** (`…/paella7/ui/watch.html?id=…`, `…/play/<uuid>`, `…&epFrom=<uuid>`); discovery loads that mediapackage via `/search/episode.json?id=…` and then follows its **series** id. |
| **`Media Series ID`** | optional text / URL / formula | paste OpenCast **series UUID** to pin — skips ambiguous search |
| `Glossary` | rich text | passed to Whisper as context |

**Lectures** — expected fields: title (`Name` by default), `Lecture ID` (rich text, episode UUID), **link to Subject** (`Course ID` rich-text UUID **or** relation **Subjects** column), **`Moodle URL`** (URL), `Status` (select), `Skip Reason`. Omit any extra **Course** title column—the Subject relation (or Subject uuid) identifies the course. Rename columns via `NOTION_LECTURES_*` (see `.env.example`). **`NOTION_LECTURES_SUBJECT_KIND=relation`** when the Subject column is a relation. If env names are omitted in CI (empty Actions secrets), the runner infers **`JKU Lecture ID`**, relation **`Subjects`**, and **`Source URL`** when those exact columns exist.

### Authenticating to media.jku.at

Some courses stay out of **anonymous** `/search/` results (nothing matches `2026S…344090`). Paella relies on `/search/episode.json?id=` with your browser cookies.

**Local session**

- **Raw header:** copy **`Cookie`** from DevTools while logged into `media.jku.at`, set **`MEDIA_SESSION_COOKIE`**.
- **Playwright once:** `bunx playwright install chromium`, then **`bun run media:login`**. Complete Shibboleth in the headed window, save, and set **`MEDIA_PLAYWRIGHT_STATE=.local/jku-media-storage.json`**. The runner reads that JSON and builds the same `Cookie` header (Playwright is **not** launched during `bun run start`).

**GitHub Actions:** hosted runners cannot complete interactive Shibboleth + MFA for you. Typical options: only process courses visible to anonymous `/search/`; keep a rotating **`MEDIA_SESSION_COOKIE`** repo secret (high sensitivity); use a **self-hosted** runner; or pin **`Media Series ID`** when indexing allows. Unattended Playwright with stored credentials is brittle and not shipped here on purpose (MFA, AUP, and breakage across IdP changes).

### GitHub Actions

The workflow (`.github/workflows/lecture-rip.yml`) runs on **`ubuntu-latest`** every 3 hours and on manual dispatch. It uses **`actions/cache`** on **`.cache/budget.json`** and **`.cache/transcripts`** only (cache key `lecture-rip-state-v2`; session cookies / Playwright storage state are **not** cached). **Concurrency** `group: lecture-rip` / `cancel-in-progress: false` so queued runs keep consistent quota + transcript state. **`timeout-minutes: 30`** per job — each cron tick is intended to finish quickly after the per-run quotas. Failures ping **`NTFY_TOPIC`** via ntfy.sh (no log artifacts are uploaded).

#### Secrets

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
| `GROQ_HOURLY_AUDIO_SECONDS` | *(optional)* cap on **decoded audio seconds per UTC hour** (default **`7200`**) |
| `GROQ_DAILY_AUDIO_SECONDS` | *(optional)* cap on **decoded audio seconds per UTC calendar day** (default **`28800`**; mirrors Groq ASD) |
| `GROQ_DAILY_REQUESTS` | *(optional)* Whisper **requests per UTC day** (default **`2000`**) |
| `GROQ_INTER_CHUNK_MS` | *(optional)* delay between chunk requests (`transcribe`); helps avoid Groq burst **429**s on multi-chunk opus files |
| `GEMINI_DAILY_REQUESTS` | *(optional)* local daily cap on **postprocess** `generateContent` (default **`500`**) |
| `NTFY_TOPIC` | ntfy topic for failures |
| `MEDIA_BASE_URL` | *(optional)* default `https://media.jku.at` |
| `MEDIA_SESSION_COOKIE` | *(optional)* full `Cookie` header for MEDIA_BASE_URL; use when ACL blocks anonymous `/search/` |
| `MEDIA_PLAYWRIGHT_STATE` | *(optional)* Playwright storage state JSON path (interactive login only makes sense locally) |
| `MEDIA_SEMESTER` | *(optional)* e.g. `2026S`; leave empty/`auto` for inferred term |
| `MEDIA_SEMESTER_TZ` | *(optional)* IANA zone for auto semester (default **`Europe/Vienna`** on empty secret) |
| `MEDIA_RESOLVE_LOOSE_LU` | *(optional)* opt-in LU substring heuristic when strict search stays empty (**risk**: wrong semester) |
| `MEDIA_LU_ALLOW_OLDER_SEM_FALLBACK` | *(optional)* `true` to use last-winter series when current-term OpenCast title missing (default omit = strict) |

Notion column-title overrides (**`NOTION_LECTURES_*`**, **`NOTION_SUBJECTS_*`**) mirror `.env`; set them under **Repository → Settings → Secrets and variables → Actions** so CI matches local `.env`.

#### Manual dispatch

```bash
gh workflow run lecture-rip.yml -f course_filter="ml-pattern" -f force_rerip=true
```

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

Runs at **minute 0 of every clock hour** in your Mac's timezone; Groq bookkeeping in `.cache/budget.json` resets on **UTC** hour buckets—if you care about aligning with Actions, stick to GH or adjust the plist to UTC.

## Operations

### Quotas and budget

Local counters in `.cache/budget.json` gate Groq and Gemini usage. **`actions/cache`** persists that file and `.cache/transcripts/` across CI runs so work resumes where it left off.

**Quota / resume:** When Groq's *hourly*, *daily decoded-audio*, or *daily Whisper-request* caps bite, or the Gemini *postprocess* daily limit blocks work, the run exits **without** mass-marking lectures `Skipped`; the **next scheduled run** continues where it left off.

| Local counter / env | Default | Provider reference |
|---------------------|---------|-------------------|
| Groq audio / UTC **hour** (`GROQ_HOURLY_AUDIO_SECONDS`) | 7200 s | Groq ASH ≈ 7200 s/h (whisper-large-v3) |
| Groq audio / UTC **day** (`GROQ_DAILY_AUDIO_SECONDS`) | 28800 s | Groq ASD ≈ 28800 s/day |
| Groq Whisper requests / day (`GROQ_DAILY_REQUESTS`) | 2000 | Groq RPD = 2000 |
| Gemini **postprocess** requests / day (`GEMINI_DAILY_REQUESTS`) | 500 | Google enforces one **per-project** RPD pool |

### Troubleshooting

**Discovery finds 0 lectures:** (1) Each Subject row needs **Media Course ID** (full series name like `2026S344090`, LU-only digits paired with **`MEDIA_SEMESTER`**, or a watch/play URL hint) **or** **Media Series ID** (series UUID). (2) **Notion column names** must match (override with **`NOTION_SUBJECTS_*`**). (3) **`COURSE_FILTER`** can exclude every Subject. (4) Anonymous **`/search/`** may omit your course — set **`MEDIA_SESSION_COOKIE`** from a logged-in browser or paste the **series UUID**. (5) If you store **LU-only** IDs, discovery scans neighbor terms but **keeps series only when the OpenCast title matches** your anchor (`2026S`+LU, etc.); **`MEDIA_LU_ALLOW_OLDER_SEM_FALLBACK=true`** re‑enables reuse of older terms (e.g. last WS). Loose LU substring guesses: **`MEDIA_RESOLVE_LOOSE_LU`** (default off).

## Changelog notes

- **`GROQ_DAILY_AUDIO_SECONDS`** is the daily decoded-audio cap (default 28800). It is **not** an alias for the hourly cap — use **`GROQ_HOURLY_AUDIO_SECONDS`** for that.
- Deprecated typo env names (`GROQ_DIALY_AUDIO_SECONDS`, `GROQ_DIALY_REQUESTS`, `GEMINI_DIALY_REQUESTS`) still work as silent fallbacks in [`src/budget.ts`](src/budget.ts) but are not documented above; migrate to the correctly spelled names.
- **`JKU_USER` / `JKU_PASS`** are no longer used.
