# ctx-handoff

[繁體中文](README.zh-TW.md)

**Keep long Claude Code conversations going on their own, and have Claude remember what you taught it.**

Long Claude Code sessions run into three chores:

- The conversation keeps growing until answers get slow, expensive and forgetful, so you write a summary, `/clear`, and paste the summary back.
- You step away for an hour, and your next message makes Claude reread the whole conversation, slowly and at full price.
- You explain the same thing in three conversations, and the next one has forgotten it again.

ctx-handoff handles these in the background. In normal use you type no commands.

| Situation | Before | With ctx-handoff |
|---|---|---|
| The conversation is nearly full | Summarize, clear and paste by hand | A handoff summary is written, the conversation is cleared, and the new one reports where things stand and waits for you |
| You step away | Everything is reread when you return | The conversation cache is kept warm while you're gone (up to about 4 hours); after that a handoff is saved and you choose whether to continue or start fresh |
| You repeat an instruction | A new conversation forgets it | It becomes a note for this project, loaded into your next conversation |

<img src="docs/distill-demo.gif" width="300" alt="Demo: the user repeats the same instruction three times and a new conversation forgets it; ctx-handoff turns it into a rule, and the next conversation remembers">

([Full-quality MP4](docs/distill-demo.mp4). The demo text is in Traditional Chinese.)

## Is it for you?

**A good fit** if you sign in with a Claude subscription, run long sessions (for example on a 1M-context model), and open Claude Code in your project folder.

**Less of a fit:**

- API-key, Bedrock or Vertex users: the conversation cache lasts only 5 minutes, so keeping it warm doesn't help and should be turned off (see [Limitations](#limitations)). Everything else works.
- Anyone who wants notes shared across projects: notes are kept per project folder.

**Status:** experimental. It uses Claude Code's mod feature, which is still in early access, so a Claude Code update may require changes. Its messages are in Traditional Chinese.

## Quick start

Requires a Claude Code build with mods (function hooks). Tested on 2.1.287–2.1.289.

```sh
git clone https://github.com/cablate/ctx-handoff-mod ~/.claude/mods/ctx-handoff
claude --plugin-dir ~/.claude/mods/ctx-handoff
```

In that session, type `/handoff`. A status like this means it's installed:

```
[ctx-handoff] context 12034 / 門檻 600000（視窗 1000000）
快取刷新 on，本次閒置已刷新 0/3，計時器未啟動
```

To load it in every session, add its absolute path to `env` in `~/.claude/settings.json` (separate several paths with `;` on Windows, `:` on macOS/Linux):

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.claude/mods/ctx-handoff" }
```

## What it does

### Hands off when the conversation is nearly full

Once context reaches 600k tokens (80% on smaller windows), it waits until Claude finishes its turn and any background tasks and subagents are done. Then it writes a handoff summary, clears the conversation and sends the summary into the new one. The new conversation first reports what it understood, then waits for you.

If background work never finishes (a dev server, say), it hands off anyway once context is 150k tokens past the threshold (and no later than 90% of the window). Type `/handoff now` to hand off sooner.

Anything you type during a handoff isn't lost; it is sent to the new conversation with the summary. Images and other attachments can't be held, and you're told to paste them again.

### Keeps the cache warm while you're away

After about 55 idle minutes it sends a tiny request to keep the conversation cache alive, up to 3 times (about 4 hours). After that it saves a handoff summary but does **not** clear. When you come back, your first message is held and you choose:

- `/handoff resume`: start a new conversation with the summary and your message
- `/handoff continue`: stay in the current conversation

### Project notes

Every so often it turns what you corrected or explained into notes for this project, loaded at the start of each new conversation:

- **Memories:** preferences, decisions, constraints, where things live. The latest 40 are loaded.
- **Rules:** practices that keep coming up, e.g. "Use forward slashes in Bash paths (3 times)". Loaded once seen twice, up to 15.

The notes are a plain Markdown file at `~/.claude/projects/<project path>/memory/ctx-handoff.md` that you can edit. When they change, a notice shows how many items changed and where the file is.

Only the conversation since the last update is sent, to Sonnet 5.5 at low effort. On a short conversation that measured about 1,200 input tokens and 1.6 seconds. Anything that looks like a key or password is dropped before it reaches the notes.

## Commands

You won't need these in normal use. If `/handoff` is already taken by your own command or skill, it becomes `/ctx-handoff`.

| Command | Purpose |
|---|---|
| `/handoff` | Context use, feature status and recent errors |
| `/handoff now` | Hand off now (clears the current conversation) |
| `/handoff dry` | Draft a handoff summary and show its cost, without clearing |
| `/handoff distill` | Update the project notes now |
| `/handoff resume` | After being away: start a new conversation from the summary |
| `/handoff continue` | After being away: stay in the current conversation |
| `/handoff resend` | Send the handoff summary again if it didn't arrive |
| `/handoff refresh on\|off` | Turn keeping the cache warm on or off |
| `/handoff distill on\|off` | Turn project notes on or off |

## Settings

Settings are constants at the top of [`hooks/register.ts`](hooks/register.ts) and take effect when you save.

| Constant | Default | Meaning |
|---|---|---|
| `THRESHOLD` | `600_000` | Context tokens that trigger a handoff |
| `WINDOW_RATIO` | `0.8` | On smaller windows, the threshold is `window × ratio` |
| `IDLE_MS` | 55 min | Idle time before keeping the cache warm |
| `MAX_REFRESH` | `3` | How many times, before saving a handoff instead |
| `MIN_TOKENS` | `30_000` | Below this, skip cache keeping and notes |
| `DISTILL_MODEL` | `claude-sonnet-5-5` | Model used for project notes |

**Choosing a threshold:** quality is commonly seen to start slipping around 200k–300k tokens. The 600k default trades that for fewer handoffs; lower it if the model gets worse before the handoff fires.

## Limitations

- **On a 5-minute cache, turn cache keeping off.** API-key, Bedrock and Vertex users, and subscribers into usage credits, get a 5-minute cache, so a request at 55 minutes rewrites the whole cache. Run `/handoff refresh off`; it isn't detected automatically.
- **Cache keeping isn't fully confirmed.** It's not yet certain the request actually extends the main conversation's cache.
- **Notes follow the folder you start in.** Work on another project from your home folder is noted under your home folder.
- **Changing settings or updating the mod resets timers**, and a message held during a handoff may be lost.

## Upgrading from 0.1

0.2 keeps one notes file per project folder and no longer writes notes into other repos a session touches. Notes an older version put in the wrong place aren't moved for you; move them by hand or with `node tools/notes.mjs` (see [`tools/README.md`](tools/README.md)).

## Contributing

The workflow and design notes are in [`CLAUDE.md`](CLAUDE.md), the scripts in [`tools/README.md`](tools/README.md). Run `node tools/check.mjs` before sending changes.

## License

[MIT](LICENSE)
