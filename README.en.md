# AITermHub

**A lightweight Windows session manager for AI coding CLIs — keep dozens of sessions open without your PC grinding to a halt.**

For people who keep Claude Code and Codex CLI sessions open per project and hop between them. Idle sessions go to sleep and give memory back; come back and you continue the same conversation.

[한국어](README.md) · [Download](https://github.com/Backhacandy/AITermHub/releases/latest) · Free · Open source (AGPL-3.0)

> The app UI is Korean-only for now. English UI is planned.

<!-- MEASURE-EN:START -->
<!-- MEASURE-EN:END -->

## Why

Juggling several projects with AI CLIs creates a loop: keep every session open and memory fills up; close them and reopening re-reads the whole conversation (tokens); so you stop closing them. AITermHub breaks the loop by making sessions cheap to sleep and cheap to resume.

## What it does

- **Sleeps idle sessions** — after 2 minutes idle the process is suspended and its memory released; after an hour it's stopped (the conversation stays). It waits an hour because the server-side prompt cache lasts an hour.
- **Cost-aware compaction** — compacts a long conversation when "extra cost of not compacting" exceeds "cost of compacting", so resuming carries less context.
- **Resume after restart** — close the app or reboot and the work continues in the same conversation.
- **Stuck-command detection** — commands far past their timeout are unstuck and the agent continues; sessions that say "working" but are frozen show as "not responding".
- **One window** — Claude Code, Codex and terminal tabs, per-session memory, and usage limits (5-hour / weekly).
- **Light app** — built with Tauri (Rust).

Experimental (Settings → 실험 기능): multi-agent **team tabs** and a Claude-vs-Codex **compare tab** — off by default because in our measurements they were slower and used more tokens than a single session.

## Install

1. Download `AITermHub_…_x64-setup.exe` from the [latest release](https://github.com/Backhacandy/AITermHub/releases/latest).
2. If **"Windows protected your PC"** appears, click **More info → Run anyway**. The installer isn't code-signed yet (certificates cost money for an individual developer); it's built from this repository's source.
3. On first launch the app checks for Claude Code or Codex CLI. Either one is enough.

Updates show a banner and install only when you click. Requires Windows 10/11 x64 and Claude Code or Codex CLI with your own subscription.

## Privacy

No telemetry. Everything the app connects to (update checks, and opt-in remote/notification/GitHub features) is listed under Settings → 정보. The app never reads or moves your Claude/Codex credentials.

## License

[AGPL-3.0-or-later](LICENSE). Copyright (c) 2026 Backhacandy. If you distribute a modified version or offer it as a network service, you must publish its source under the same license. Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md) (includes a CLA).
