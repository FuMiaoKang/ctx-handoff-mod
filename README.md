# ctx-handoff

[繁體中文](README.zh-TW.md)

A Claude Code mod that hands a long conversation over to a fresh one **automatically**: when the main conversation's context reaches a threshold, it writes a handoff summary, runs `/clear`, and submits the handoff so the new conversation picks up where you left off. While you are away it keeps the prompt cache warm, then saves a handoff instead of clearing. You type no commands in the normal flow.

**Who it's for:** people who run long Claude Code sessions on a 1M-context model with a Claude subscription (1-hour prompt cache). **Status:** experimental. It is built on Claude Code's early-access function-hooks API, which may change between releases. Read [Limitations](#limitations) before relying on it.

## What it does

All three paths apply to the main conversation only. Subagent turns are ignored.

| When | What happens | You do |
|---|---|---|
| **A turn ends and context ≥ 600k** (or 80% of the window, whichever is lower) | Waits if background shells, workflows or subagents are still running. Otherwise it forks the conversation to write a handoff, then runs `/clear` and submits the handoff. The new conversation reports what it understood and waits for you. | Nothing |
| **You've been idle 55 minutes** | Forks a tiny request to refresh the prompt cache, up to 3 times (about 4 hours in total). At the 4th point it saves an "away handoff" and does **not** clear: you're not there, so it doesn't switch conversations on you. | Nothing |
| **You come back after an away handoff** | Holds your first message and asks you to choose. | `/handoff-resume` starts a new conversation with the handoff and your message. `/handoff-continue` stays in the old one. |

Evidence so far:
- The building blocks were checked live with a probe mod. `/clear` followed by `prompt.submit` works from a mod. A fork over a 102k-token conversation read 102,003 of 102,523 input tokens from cache (about 99.5%).
- `claude plugin test`: 8/8 pass, covering the threshold, a 200k window, refresh then away handoff, refresh off, small-context skip, resume, deferral for a background shell, and deferral for a running subagent.
- Not yet observed: a full real session reaching 600k, and whether an idle refresh actually keeps a 1-hour cache alive. See [Limitations](#limitations).

## Quick start

Requires a Claude Code build with function hooks (mods). It was developed and tested on 2.1.287.

```sh
git clone https://github.com/cablate/ctx-handoff-mod ~/.claude/mods/ctx-handoff
claude --plugin-dir ~/.claude/mods/ctx-handoff
```

In the session, run `/handoff-status`. You should see something like:

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

| Command | Purpose |
|---|---|
| `/handoff-status` | Context use, threshold, refresh state, any pending away handoff |
| `/handoff-refresh on\|off` | Turn idle cache refresh on or off. When off, the away handoff is saved after 55 idle minutes. |
| `/handoff-resume` | Use the away handoff: `/clear`, then submit it, plus the message that was held |
| `/handoff-continue` | Drop the away handoff and send the held message in the old conversation |
| `/handoff-now yes` | Hand off right now (clears the conversation) |

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

- **5-minute cache users should turn refresh off.** API-key, Bedrock and Vertex users, and subscribers who are into usage credits, get a 5-minute prompt cache. For them a refresh at 55 minutes finds the cache already gone, and each refresh rewrites the whole context. Run `/handoff-refresh off`. The mod does not detect the TTL.
- **The idle refresh is unverified.** It is not yet confirmed that a fork's cache read extends the main conversation's 1-hour cache entry.
- **Background-work detection is partial.** Background Bash is read from a structured field. Workflow and Monitor task IDs are parsed from tool output text, and that format is unverified. A task that never ends (a dev server) defers the handoff until its record expires after 12 hours. Use `/handoff-now yes` to force it.
- **Held messages keep only their text.** If the first message after an away handoff has images, only the text is carried over. The hold itself has no automated test, because a test cannot simulate a typed message.
- **Hot reloads reset the timers** and the background-task tracking.
- **The API is early access.** A Claude Code update may require changes.

## Development

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # after the mod has loaded once, which writes .claude-plugin/types/
```

## License

[MIT](LICENSE)
