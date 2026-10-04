# ctx-handoff

[繁體中文](README.zh-TW.md)

A Claude Code mod that hands a long conversation over to a fresh one **automatically**: when the main conversation's context reaches a threshold, it writes a handoff summary, runs `/clear`, and submits the handoff so the new conversation picks up where you left off. While you are away it keeps the prompt cache warm, then saves a handoff instead of clearing. It also distills what the conversation taught it into per-project notes in the background, and loads them into your next conversation. You type no commands in the normal flow.

**Who it's for:** people who run long Claude Code sessions on a 1M-context model with a Claude subscription (1-hour prompt cache). **Status:** experimental. It is built on Claude Code's early-access function-hooks API, which may change between releases. Read [Limitations](#limitations) before relying on it.

## Distill: stop saying the same thing a fourth time

<img src="docs/distill-demo.gif" width="300" alt="Distill demo: the user repeats the same instruction three times and a fresh conversation forgets it; ctx-handoff distills it into a rule in the notes file, and the next conversation remembers">

([Full-quality MP4](docs/distill-demo.mp4). The demo text is in Traditional Chinese.)

What you corrected or explained in one conversation is usually gone in the next. While the cache is still warm, distill reads the conversation with one tool-less fork and keeps what is worth keeping as two kinds of items:

| Item | What it holds | Example |
|---|---|---|
| **Memory** | Your preferences, the project's current state, where external resources live | "Lead with the conclusion", "Staging is at …" |
| **Rule** | A reusable practice with a count of how often it came up; rules seen 2+ times load into new conversations, sorted by count | "Use forward slashes in Bash paths (3 times)" |

- **It doesn't interrupt you.** Distill runs in the background, and its result rides on your next message, so the current conversation benefits right away.
- **It costs almost no extra tokens.** The fork reuses the main conversation's cache (about 99.5% read from cache, measured).
- **Notes are filed per project.** A session started in your home folder that touches several repos writes each item to the `ctx-handoff.md` of the project it belongs to. Notes load at the start of a new conversation, or the first time a session touches that project.
- **The file is yours.** The notes file is plain Markdown. Edit it directly; your edits are preserved.

Run `/handoff distill` to distill right now, or `/handoff distill off` to turn it off.

## What it does

All three paths apply to the main conversation only. Subagent turns are ignored.

| When | What happens | You do |
|---|---|---|
| **The main conversation stops and context ≥ 600k** (or 80% of the window, whichever is lower) | Decided when Claude Code's `Stop` hook fires. Waits if background tasks, one-shot scheduled wakeups or subagents are still running (recurring crons never block), up to a hard cap (below). Otherwise it forks the conversation to write a handoff (and distills memory in parallel), then runs `/clear` and submits the handoff. It waits for that distill only until 60 seconds after the handoff started; past that, the distill finishes in the background. The new conversation reports what it understood and waits for you. | Nothing |
| **You've been idle 55 minutes** | Forks a tiny request to refresh the prompt cache, up to 3 times (about 4 hours in total). At the 4th point it saves an "away handoff" and does **not** clear: you're not there, so it doesn't switch conversations on you. | Nothing |
| **You come back after an away handoff** | Holds your first message and asks you to choose. | `/handoff resume` starts a new conversation with the handoff and your message. `/handoff continue` stays in the old one. Sending a different message instead continues the old conversation with both messages. If the old conversation moves on by itself (a turn finishes while nothing is held), the away handoff is discarded as stale. |

### Behaviours worth knowing

- **Messages typed during a handoff are not lost.** From the moment a threshold handoff or `/handoff now` starts until the handoff is submitted, your messages are dropped with a notice and held. The notice says how long the handoff has been running (usually under a minute, at most about 3 minutes). Sending the same text again holds it only once. Only text can be held: images and other attachments must be pasted again after the handoff, and the notice says so. Held messages are appended to the handoff text. One that arrives after that text was built is submitted right after the handoff turn. If the handoff fails before `/clear`, they are re-submitted in the old conversation. (Slash commands pass through, and `/handoff dry` and the away handoff never hold messages.)
- **Background distill results ride on your next message.** The distilled changes are queued in memory and attached as extra context to the next prompt that really enters the conversation. Dropped prompts and slash commands do not consume them. When a distill changes anything, a toast shows how many items changed and the full path of every notes file it wrote; nothing is sent to the model until your next message. The distill right before a handoff queues nothing.
- **Distill output is JSONL, and the program applies it.** The background distill is still one tool-less fork (cache reuse). It writes one JSON action per line between `=== ACTIONS ===` and `=== END ===` (`add_memory`, `update_memory`, `delete_memory`, `add_rule`, `confirm_rule`, `update_rule`, `delete_rule`, and `move_memory` / `move_rule`, which move an item to another project in one step so it cannot be lost halfway), always in Traditional Chinese (Taiwan) with code, commands, paths and error messages kept verbatim. The program validates every line (op, required string fields, `type` in user|feedback|project|reference, project and id exist); invalid lines are dropped, counted, and up to 3 samples are kept and shown by `/handoff`, each with the reason (bad JSON, missing field, unknown project or id, and so on) and the head and tail of the line. Any action with a secret-looking field is dropped whole, and its sample is not stored.
- **Sessions that start in an outer folder still file notes per project.** Sessions often start in a parent folder (for example your home or a workspace folder) and touch several repos. The mod records, per session, the projects touched through tool paths (`file_path`, `path`, `notebook_path`) and the working directory for Bash: the nearest ancestor with a `.git`, otherwise the first-level child folder of the session root (`AppData` and dot folders skipped). The session root is `P1` (the default), taken from where the session started, so a Bash `cd` into another repo does not move it (a session started in a git worktree uses the main working tree's notes); touched projects are `P2`, `P3`, and so on (at most 8, oldest dropped). The distill prompt shows each project's memory and rules (`P1-M3`, `P2-R1`), asks the model to file each item under the project it belongs to (cross-project or unsure goes to `P1`), and writes each project's own `ctx-handoff.md`. If one project's file changed during the fork, only that file is skipped and the error names it; a move to or from that file is skipped as well. Changes from other projects are prefixed with the project name.
- **First touch injects that project's notes.** The first time a session touches a project that already has a notes file, its notes ride on your next real prompt, once per project per session, in the same format as the new-conversation context. `P1` is never injected this way (it already arrives at the start of the conversation).
- **Failures are visible and recoverable.** Every handoff failure (writing it, `/clear`, submitting) is recorded and shown by `/handoff`. A handoff fork that has not answered in 3 minutes is abandoned, and held messages go back to the old conversation; a distill fork is abandoned after 8 minutes. If `/clear` fails during `/handoff resume`, the away handoff and your held message are kept so you can choose again. After a failed threshold handoff the mod waits for 3 more user messages or 10 minutes before retrying. The full text is saved before `/clear` (as `pendingSubmit:<session id>`) and deleted only after the submit succeeds; if the submit fails, `/handoff resend` submits it again without another `/clear`.
- **Store keys are per project.** Handoff history and distill status are kept per project, so `/handoff` shows only the current project. Per-session keys are pruned 30 days after they were first seen. The `refresh` and `distill` toggles stay global.
- **Hand edits to the memory file survive.** Multi-line memory items, unknown `## ` sections and the rest of the file round-trip through a distill. A new rule whose name already exists is skipped. `/handoff` reports how many memory items are beyond the 40 that are injected.
- **Hard cap on deferral.** If background work keeps the handoff waiting, it goes ahead anyway once context reaches `min(90% of the window, threshold + 150k)`, and the handoff intro says what was still running.

Evidence so far:
- The building blocks were checked live with a probe mod. `/clear` followed by `prompt.submit` works from a mod. A fork over a 102k-token conversation read 102,003 of 102,523 input tokens from cache (about 99.5%).
- `claude plugin test`: 94/94 pass, covering JSONL validation and rejection samples with reasons, moves between projects (including a skipped destination), fork timeouts, the 60-second wait for the last distill, held-message dedupe and attachments, a Bash `cd` not moving `P1`, a git worktree using the main tree's notes, escaped secrets never stored, a failed write during a move, `/clear` failing during resume, per-project routing and touch detection, per-file skip during a fork, first-touch injection, the threshold, a 200k window, refresh then away handoff, refresh off, small-context skip, resume, held messages during a handoff, context injection, per-project store keys and pruning, failure backoff and `/handoff resend`, memory-file round trip against a copy of a real file, `Stop`-based deferral (background task, one-shot cron, recurring cron, hard cap, subagent) and the away flow.
- Confirmed live (2026-10-04): distill writes JSONL and Traditional Chinese notes; the distilled changes ride on the next message and the model sees them; a session started in the home folder files memory into the matching repo's notes; messages held during a handoff arrive appended to the new conversation's first message; past the hard cap, the handoff goes ahead even with background tasks and subagents running.
- Not yet observed: whether an idle refresh actually keeps a 1-hour cache alive. See [Limitations](#limitations).

## Quick start

Requires a Claude Code build with function hooks (mods). It was developed and tested on 2.1.287.

```sh
git clone https://github.com/cablate/ctx-handoff-mod ~/.claude/mods/ctx-handoff
claude --plugin-dir ~/.claude/mods/ctx-handoff
```

In the session, run `/handoff`. You should see something like:

```
[ctx-handoff] context 12034 / 門檻 600000（視窗 1000000）
快取刷新 on，本次閒置已刷新 0/3，計時器未啟動
```

To load it in every session, add an absolute path to `env` in `~/.claude/settings.json`. Use `;` between several folders on Windows and `:` on macOS/Linux:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.claude/mods/ctx-handoff" }
```

The mod's messages are in Traditional Chinese.

## Commands

You don't need these in the normal flow.

There is one command, `/handoff`, with subcommands.

| Command | Purpose |
|---|---|
| `/handoff` | Context use, threshold, refresh and distill state, any pending away handoff, and usage |
| `/handoff now` | Hand off right now (clears the conversation) |
| `/handoff dry` | Produce a handoff and show its cost, without clearing |
| `/handoff distill` | Distill this project's memory and rules now |
| `/handoff resume` | Use the away handoff: `/clear`, then submit it, plus the message that was held |
| `/handoff continue` | Drop the away handoff and send the held message in the old conversation |
| `/handoff resend` | Submit a handoff that did not arrive (this process's own record, else the latest it generated). Does not `/clear` |
| `/handoff refresh on\|off` | Turn idle cache refresh on or off. When off, the away handoff is saved after 55 idle minutes. |
| `/handoff distill on\|off` | Turn background distilling on or off |

The last 5 handoffs are kept in the mod's store.

## Configuration

The values are constants at the top of [`hooks/register.ts`](hooks/register.ts). Edit them there; changes hot-reload if the folder is watched.

| Constant | Default | Meaning |
|---|---|---|
| `THRESHOLD` | `600_000` | Context tokens that trigger a handoff |
| `WINDOW_RATIO` | `0.8` | On smaller windows, the threshold becomes `window × ratio` |
| `IDLE_MS` | 55 min | Idle time before a refresh (tuned for a 1-hour cache) |
| `MAX_REFRESH` | `3` | Refreshes before the away handoff |
| `MIN_TOKENS` | `30_000` | Below this, skip refresh and the away handoff |

On the threshold: community reports and Anthropic's own MRCR figures suggest quality starts slipping somewhere around 200k–300k tokens. 600k is a deliberate choice to hand off less often. Lower it if you notice the model getting worse before the handoff fires.

## Limitations

- **5-minute cache users should turn refresh off.** API-key, Bedrock and Vertex users, and subscribers who are into usage credits, get a 5-minute prompt cache. For them a refresh at 55 minutes finds the cache already gone, and each refresh rewrites the whole context. Run `/handoff refresh off`. The mod does not detect the TTL.
- **The idle refresh is unverified.** It is not yet confirmed that a fork's cache read extends the main conversation's 1-hour cache entry.
- **Background-work detection relies on the `Stop` hook's snapshot.** Which `status` values count as still running, and when `Stop` fires relative to `turn.complete`, are not yet confirmed in a real session. A task that never ends (a dev server) defers the handoff only until the hard cap; `/handoff now` forces it earlier.
- **The last distill may not finish at large context.** Distill takes about 95 seconds at 476k and about 3 minutes at 800k (the handoff itself about 28 seconds at 800k), so the handoff no longer waits for it past 60 seconds. Whether `/clear` lets that in-flight fork finish is not yet confirmed live; if it does not, that distill is recorded as failed and the end of the old conversation is not distilled.
- **Held messages keep only their text.** A mod sees an attachment's kind, never its bytes, so images sent during a handoff or after an away handoff must be pasted again; the notice says so. Tests simulate typed messages with composer-origin submits, not a real terminal.
- **Hot reloads reset the timers** and the in-memory state (held messages, queued distill notes, the resend record).
- **The API is early access.** A Claude Code update may require changes.

## Development

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # after the mod has loaded once, which writes .claude-plugin/types/
```

## License

[MIT](LICENSE)
