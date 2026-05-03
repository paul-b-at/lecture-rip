# lecture-rip 🎙️

Local pipeline that rips JKU lecture recordings → mlx-whisper transcript → gemma4:26b chapters + summary + exam hints → Notion Lectures DB.

Runs nightly on the M4 Pro via launchd. Zero cloud cost, audio never leaves the laptop.

## Stack
- Bun + TypeScript
- Playwright (Shibboleth SSO → Moodle → Opencast)
- ffmpeg + mlx-whisper (large-v3-turbo)
- Ollama + gemma4:26b (structured JSON)
- Notion API → Lectures DB

## Status
🚧 Vibe-coding in progress. See [build plan](https://www.notion.so/) for milestones.
