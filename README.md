# ctx-handoff

[繁體中文](README.zh-TW.md)

A Claude Code mod for long sessions. When the conversation gets too long, it writes a handoff, clears, and continues in a fresh conversation on its own. In the background it also keeps notes on what you corrected or explained, and loads them into your next conversation in the same folder. In the normal flow you type no commands.

**Who it's for:** people who run long Claude Code sessions on a 1M-context model with a Claude subscription (1-hour prompt cache), and who open Claude Code in the project folder they are working on.
**Not a good fit:** API-key, Bedrock or Vertex users (5-minute cache; see [Limitations](#limitations)), or anyone who wants notes from one project to follow them into other folders.
**Status:** experimental. It is built on Claude Code's early-access function-hooks API, which may change between releases. Messages are in Traditional Chinese.

## What you get

| Situation | Without the mod | With ctx-handoff |
|---|---|---|
| Context reaches 600k (or 80% of a smaller window) | You notice late, then write a summary and `/clear` by hand | A handoff is written, the conversation is cleared, and the new one reports what it understood and waits for you |
| You step away for an hour | The 1-hour prompt cache expires and the next message rereads everything | The cache is refreshed up to 3 times (about 4 hours); after that an away handoff is saved and nothing is cleared while you're gone |
| You explained the same thing in three conversations | A new conversation has forgotten it | It is kept as a memory or a rule in this folder's notes file and loaded at the start of the next conversation |

<img src="docs/distill-demo.gif" width="300" alt="Distill demo: the user repeats the same instruction three times and a fresh conversation forgets it; ctx-handoff distills it into a rule in the notes file, and the next conversation remembers">

([Full-quality MP4](docs/distill-demo.mp4). The demo text is in Traditional Chinese.)

## Why you can trust it

- **Tests:** `claude plugin test` passes 71/71: the threshold and window sizes, deferral while background work runs, held messages during a handoff, the away flow, distill output validation, secret filtering, file-changed-during-distill, and failure recovery.
- **Measured distill cost (2026-10-05):** a distill now sends only the conversation since the last run to Sonnet 5.5 at low effort. On a short test conversation that was 1,176 input tokens, 91 output tokens and 1.6 seconds. The earlier design forked the whole conversation on the main model: 205k–335k input tokens and 29–108 seconds per run.
- **Confirmed in real sessions:** distill writes the notes and the next message carries the changes to the model; messages typed during a handoff arrive with the handoff; past the hard cap a handoff goes ahead even with background tasks and subagents running; a folder whose own `handoff` skill takes `/handoff` gets `/ctx-handoff` instead.
- **Not yet observed:** whether an idle refresh really keeps the 1-hour cache alive, and whether the last distill always survives `/clear` (see [Limitations](#limitations)).

## Quick start

Requires a Claude Code build with function hooks (mods). Developed and tested on 2.1.287–2.1.289.

```sh
git clone https://github.com/cablate/ctx-handoff-mod ~/.claude/mods/ctx-handoff
claude --plugin-dir ~/.claude/mods/ctx-handoff
```

In that session, run `/handoff`. You should see something like:

```
[ctx-handoff] context 12034 / 門檻 600000（視窗 1000000）
快取刷新 on，本次閒置已刷新 0/3，計時器未啟動
```

To load it in every session, add the absolute path to `env` in `~/.claude/settings.json` (use `;` between several folders on Windows, `:` on macOS/Linux):

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.claude/mods/ctx-handoff" }
```

### Upgrading from 0.1

0.2 keeps **one notes file per workspace** and has no compatibility code:

- A session no longer writes notes into other repos it touches, and no longer loads their notes when it touches them. Open Claude Code in the project you work on.
- Old store keys (`projdir:*`, `migrated:*`, the global `handoffs`) are ignored and can be deleted.
- Notes that an older version filed into the wrong folder stay where they are. Move them by hand, or with `node tools/notes.mjs` (see [`tools/README.md`](tools/README.md)).

## How it works

All paths apply to the main conversation only; subagent turns are ignored.

| When | What happens | You do |
|---|---|---|
| **The conversation stops and context ≥ 600k** (or 80% of the window, whichever is lower) | Checked when Claude Code's `Stop` hook fires. If background tasks, one-shot wakeups or subagents are still running, it waits (recurring crons never block), up to a hard cap of `min(90% of the window, threshold + 150k)`. Then it forks the conversation to write a handoff, runs `/clear` and submits the handoff. | Nothing |
| **You've been idle 55 minutes** | A tiny fork refreshes the prompt cache, up to 3 times. At the 4th point it saves an away handoff and does **not** clear. | Nothing |
| **You come back after an away handoff** | Your first message is held and you are asked to choose. | `/handoff resume` starts a new conversation with the handoff and your message; `/handoff continue` stays in the old one. |

### Notes (distill)

The workspace is the folder the session started in, or the main working tree when it started in a git worktree. Its notes file is `~/.claude/projects/<encoded folder path>/memory/ctx-handoff.md`, plain Markdown that you can edit.

| Item | What it holds | Loaded into a new conversation |
|---|---|---|
| **Memory** | Preferences, decisions and constraints, where external resources live | The latest 40 |
| **Rule** | A reusable practice with how often it came up, e.g. "Use forward slashes in Bash paths (3 times)" | Seen 2+ times, top 15 by count |

- **When it runs:** after every 30 messages, on idle refresh, before an away handoff, and right before a threshold handoff. `/handoff distill` runs it now; `/handoff distill off` turns it off.
- **What is sent:** only the conversation since the last distill, as plain text with tool inputs and results clipped and the total capped at 300,000 characters, plus this workspace's current notes. One request to `DISTILL_MODEL` (Sonnet 5.5, effort low), no tools.
- **How it is applied:** the model answers with one JSON action per line (`add_memory`, `update_memory`, `delete_memory`, `add_rule`, `confirm_rule`, `update_rule`, `delete_rule`). The mod validates each line; invalid lines and anything that looks like a secret are dropped, counted and shown by `/handoff`. If the notes file changed while the request ran, nothing is written and the same part is distilled again next time.
- **How you see it:** a toast shows how many items changed and the file's full path. The changes ride on your next message as extra context; nothing is sent to the model on its own.

### Behaviours worth knowing

- **Messages typed during a handoff are not lost.** They are held with a notice (how long the handoff has been running, usually under a minute) and sent with the handoff. The same text is held only once. Attachments cannot be held and must be pasted again; the notice says so.
- **Failures are visible.** A handoff that fails (writing, `/clear`, submitting) is recorded and shown by `/handoff`. A handoff fork is abandoned after 3 minutes and held messages go back to the old conversation; a distill request after 8 minutes. After a failed threshold handoff the mod waits for 3 more messages or 10 minutes before retrying. The handoff text is saved before `/clear`, and `/handoff resend` submits it again if the submit failed.
- **History is per workspace.** The last 5 handoffs and the distill status are kept per workspace in the mod's store. Per-session keys are pruned after 30 days. The `refresh` and `distill` switches are global.

## Commands

You don't need these in the normal flow. If your own command or skill already uses `/handoff`, the mod registers `/ctx-handoff` instead.

| Command | Purpose |
|---|---|
| `/handoff` | Context use, threshold, refresh and distill state, pending away handoff, usage |
| `/handoff now` | Hand off right now (clears the conversation) |
| `/handoff dry` | Produce a handoff and show its cost, without clearing |
| `/handoff distill` | Distill this workspace's notes now |
| `/handoff resume` | Use the away handoff: `/clear`, then submit it with the held message |
| `/handoff continue` | Drop the away handoff and send the held message in the old conversation |
| `/handoff resend` | Submit a handoff that did not arrive, without another `/clear` |
| `/handoff refresh on\|off` | Turn idle cache refresh on or off; when off, the away handoff is saved after 55 idle minutes |
| `/handoff distill on\|off` | Turn background distill on or off |

## Configuration

Constants at the top of [`hooks/register.ts`](hooks/register.ts); changes hot-reload if the folder is loaded with `CLAUDE_CODE_PLUGIN_DIRS`.

| Constant | Default | Meaning |
|---|---|---|
| `THRESHOLD` | `600_000` | Context tokens that trigger a handoff |
| `WINDOW_RATIO` | `0.8` | On smaller windows the threshold becomes `window × ratio` |
| `IDLE_MS` | 55 min | Idle time before a refresh (tuned for a 1-hour cache) |
| `MAX_REFRESH` | `3` | Refreshes before the away handoff |
| `MIN_TOKENS` | `30_000` | Below this, skip refresh, background distill and the away handoff |
| `DISTILL_MODEL` | `claude-sonnet-5-5` | Distill model, with `DISTILL_EFFORT` `low` |

On the threshold: community reports and Anthropic's MRCR figures suggest quality starts slipping around 200k–300k tokens. 600k is a deliberate choice to hand off less often; lower it if the model gets worse before the handoff fires.

## Limitations

- **5-minute cache users should turn refresh off.** API-key, Bedrock and Vertex users, and subscribers who are into usage credits, get a 5-minute cache, so a refresh at 55 minutes rewrites the whole context. Run `/handoff refresh off`; the mod does not detect the TTL.
- **The idle refresh is unverified.** It is not yet confirmed that a fork's cache read extends the main conversation's 1-hour cache entry.
- **Notes stay in one folder.** Work done in your home folder is noted there, even if it was about another project.
- **The last distill runs across `/clear`.** It reads its slice first, so the handoff waits at most 5 seconds for it. Whether `/clear` lets the request finish is not yet confirmed; if not, it is recorded as failed and `/handoff` shows it.
- **Background-work detection relies on the `Stop` hook's snapshot.** A task that never ends (a dev server) defers the handoff only until the hard cap; `/handoff now` forces it earlier.
- **Hot reloads reset timers and in-memory state** (held messages, queued notes, the resend record).
- **The API is early access.** A Claude Code update may require changes.

## Development

The workflow, design decisions and tested platform facts are in [`CLAUDE.md`](CLAUDE.md); the scripts are listed in [`tools/README.md`](tools/README.md).

```sh
node tools/wt.mjs new <branch>    # edit in a temporary worktree, not the hot-reloaded folder
node tools/check.mjs              # validate, tests, tsc, tool tests, public-info scan
node tools/wt.mjs land <branch>   # check again, then fast-forward the main folder
node tools/status.mjs             # notes sizes, last distill and failures, reloads per session
```

## License

[MIT](LICENSE)
