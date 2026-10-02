# ctx-handoff

[English](README.md)

一個 Claude Code mod，**自動**把太長的對話交接給新對話：主對話的 context 達到門檻時，它會產生一份 handoff 摘要，執行 `/clear`，再把 handoff 送進新對話，讓工作從原處接續。你離開時，它會幫你保溫 prompt 快取；到最後只存一份 handoff，不清除對話。正常使用時不必打任何指令。

**適合誰**：用 1M context 模型跑長時間 Claude Code session、而且用 Claude 訂閱登入（1 小時 prompt 快取）的人。**狀態**：實驗性。它建立在 Claude Code 仍屬 early access 的 function hooks API 上，Claude Code 改版時可能需要跟著調整。依賴它之前，請先讀[限制](#限制)。

## 它會做什麼

三條路徑都只作用在主對話，子代理的回合一律略過。

| 什麼時候 | 會發生什麼 | 你要做什麼 |
|---|---|---|
| **回合結束，且 context ≥ 600k**（或視窗的 80%，取較小者） | 如果還有背景 shell、workflow 或子代理在跑，就先等。否則 fork 對話產生 handoff，接著 `/clear` 並送出 handoff。新對話會回報它理解的現況，然後等你指示。 | 不用 |
| **閒置 55 分鐘** | fork 一個很小的請求刷新快取，最多 3 次（合計約 4 小時）。到第 4 次改成存一份「離席 handoff」，而且**不** `/clear`：你不在，所以不替你換對話。 | 不用 |
| **離席 handoff 存好後你回來** | 先攔下你的第一則訊息，請你選擇。 | `/handoff-resume` 開新對話，帶上 handoff 和這則訊息；`/handoff-continue` 留在原本的對話。 |

目前的證據：
- 用 probe mod 實際驗證過幾個基本元件：mod 可以執行 `/clear` 後接著 `prompt.submit`；對 102k token 的對話做 fork 時，102,523 個輸入 token 中有 102,003 個是從快取讀取（約 99.5%）。
- `claude plugin test`：8/8 通過。涵蓋門檻觸發、200k 視窗、刷新後存離席 handoff、關閉刷新、context 太小時略過、resume，以及背景 shell 和子代理還在跑時延後。
- 還沒實際觀察到的：在真實 session 中一路跑到 600k 的完整流程，以及閒置刷新是否真的能讓 1 小時快取延續。見[限制](#限制)。

## 快速開始

需要支援 function hooks（mod）的 Claude Code 版本。開發與測試用的是 2.1.287。

```sh
git clone https://github.com/cablate/ctx-handoff-mod ~/.claude/mods/ctx-handoff
claude --plugin-dir ~/.claude/mods/ctx-handoff
```

在 session 裡執行 `/handoff-status`，應該會看到類似：

```
[ctx-handoff] context 12034 / 門檻 600000（視窗 1000000）
快取刷新 on，本次閒置已刷新 0/3，計時器未啟動
```

想讓每個 session 都自動載入，在 `~/.claude/settings.json` 的 `env` 加上絕對路徑。有多個資料夾時，Windows 用 `;` 分隔，macOS/Linux 用 `:`：

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.claude/mods/ctx-handoff" }
```

## 指令

正常使用時用不到這些。

| 指令 | 用途 |
|---|---|
| `/handoff-status` | 查看 context 用量、門檻、刷新狀態，以及有沒有待處理的離席 handoff |
| `/handoff-refresh on\|off` | 開關閒置時的快取刷新。關閉時，閒置 55 分鐘就直接存離席 handoff |
| `/handoff-resume` | 使用離席 handoff：先 `/clear`，再送出 handoff 和剛才被攔下的訊息 |
| `/handoff-continue` | 放棄離席 handoff，在原本的對話送出被攔下的訊息 |
| `/handoff-now yes` | 立刻交接（會清除目前對話） |

最近 5 份 handoff 會保存在 mod 的 store 裡。

## 設定

數值是 [`hooks/register.ts`](hooks/register.ts) 開頭的常數，直接改那裡即可；資料夾有被監看時，存檔就會熱重載。

| 常數 | 預設 | 意義 |
|---|---|---|
| `THRESHOLD` | `600_000` | 觸發交接的 context token 數 |
| `WINDOW_RATIO` | `0.8` | 視窗較小時，門檻改成「視窗 × 這個比例」 |
| `IDLE_MS` | 55 分鐘 | 閒置多久後刷新（依 1 小時快取設定） |
| `MAX_REFRESH` | `3` | 存離席 handoff 前最多刷新幾次 |
| `MIN_TOKENS` | `30_000` | context 低於這個值時，不刷新也不存離席 handoff |

關於門檻：社群回報和 Anthropic 自己公布的 MRCR 數據都顯示，品質大約在 200k–300k 左右開始下滑。設 600k 是刻意的選擇，為了減少交接的次數。如果你發現還沒交接模型就開始變差，就把門檻調低。

## 限制

- **5 分鐘快取的使用者應關閉刷新。** 用 API key、Bedrock、Vertex，或訂閱已超出額度、開始扣 usage credits 時，prompt 快取只有 5 分鐘。這時第 55 分鐘的刷新會發現快取早就過期，而且每次刷新都會重寫整段 context。請執行 `/handoff-refresh off`。mod 不會自動偵測 TTL。
- **閒置刷新還沒驗證。** 還不確定 fork 讀取快取時，能不能延長主對話那份 1 小時快取的時效。
- **背景工作只能偵測一部分。** 背景 Bash 的 task id 是從結構化欄位讀的；Workflow 和 Monitor 的 task id 是從工具輸出文字裡抓的，格式還沒驗證。永遠不會結束的工作（例如 dev server）會讓交接一直延後，直到它的紀錄在 12 小時後作廢。需要時可以用 `/handoff-now yes` 強制交接。
- **被攔下的訊息只保留文字。** 離席 handoff 後的第一則訊息如果附了圖片，只會帶上文字。攔下訊息這個行為本身沒有自動測試，因為測試環境模擬不了「使用者親手輸入的訊息」。
- **熱重載會重置**計時器和背景工作的追蹤紀錄。
- **API 還在 early access。** Claude Code 更新後可能需要跟著修改。

## 開發

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # mod 載入過一次、產生 .claude-plugin/types/ 之後才能跑
```

## 授權

[MIT](LICENSE)
