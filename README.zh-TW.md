# ctx-handoff

[English](README.md)

給長時間使用 Claude Code 的人的 mod。對話太長時，它會自己寫好 handoff、清空對話，在新對話接著做；同時在背景記下你糾正過、交代過的事，下次在同一個資料夾開對話時自動帶入。平常不需要打任何指令。

**適合誰**：用 1M context 模型跑長時間 session、用 Claude 訂閱登入（1 小時 prompt 快取），而且習慣在要工作的專案資料夾開 Claude Code 的人。
**不適合**：用 API key、Bedrock 或 Vertex 的人（快取只有 5 分鐘，見[限制](#限制)），或希望某個專案的經驗跟著你到其他資料夾的人。
**狀態**：實驗性。建立在 Claude Code 仍屬 early access 的 function hooks API 上，版本更新可能需要跟著改。訊息為繁體中文。

## 你會得到什麼

| 情境 | 沒有這個 mod | 有 ctx-handoff |
|---|---|---|
| context 到 600k（或較小視窗的 80%） | 很晚才發現，要自己寫摘要、自己 `/clear` | 自動寫 handoff、清空對話，新對話先回報它理解的現況，再等你指示 |
| 離開一小時 | 1 小時 prompt 快取過期，下一則訊息要整段重讀 | 最多刷新快取 3 次（約 4 小時）；之後改存一份離席 handoff，你不在時不會清空對話 |
| 同一件事在三個對話裡都講過 | 新對話又忘了 | 記成這個資料夾經驗檔裡的一條記憶或規則，下一段對話開頭自動帶入 |

<img src="docs/distill-demo.gif" width="300" alt="distill 示範：同一件事講了三次，開新對話後被忘記；ctx-handoff 在背景把它整理成經驗檔裡的一條規則，下一段對話就記得了">

（[完整畫質 MP4](docs/distill-demo.mp4)）

## 為什麼可以相信

- **測試**：`claude plugin test` 71/71 通過，涵蓋門檻與視窗大小、背景工作還在跑時延後、交接期間攔下的訊息、離席流程、整理輸出的驗證、金鑰過濾、整理期間經驗檔被改，以及各種失敗的復原。
- **實測整理成本（2026-10-05）**：整理只把上次之後新增的對話交給 effort low 的 Sonnet 5.5。一段短的測試對話是輸入 1,176 token、輸出 91 token、1.6 秒。舊設計每次用主模型 fork 整段對話，輸入 20.5 萬～33.5 萬 token、29～108 秒。
- **真實 session 確認過**：整理會寫入經驗檔，變動跟著下一則訊息送到模型；交接期間打的訊息會跟 handoff 一起送進新對話；超過硬上限時，即使有背景工作和子代理在跑也會交接；資料夾裡已有自己的 `handoff` skill 時，會改用 `/ctx-handoff`。
- **還沒實際觀察到**：閒置刷新是否真能延續 1 小時快取，以及交接前那次整理是否一定能跨過 `/clear` 跑完（見[限制](#限制)）。

## 快速開始

需要支援 function hooks（mod）的 Claude Code。開發與測試用的是 2.1.287～2.1.289。

```sh
git clone https://github.com/cablate/ctx-handoff-mod ~/.claude/mods/ctx-handoff
claude --plugin-dir ~/.claude/mods/ctx-handoff
```

在這個 session 打 `/handoff`，應該會看到類似：

```
[ctx-handoff] context 12034 / 門檻 600000（視窗 1000000）
快取刷新 on，本次閒置已刷新 0/3，計時器未啟動
```

要每個 session 都載入，在 `~/.claude/settings.json` 的 `env` 加上絕對路徑（多個資料夾在 Windows 用 `;` 分隔，macOS／Linux 用 `:`）：

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/home/you/.claude/mods/ctx-handoff" }
```

### 從 0.1 升級

0.2 改成**一個工作區一份經驗檔**，而且不留相容舊版的程式：

- session 碰到其他 repo 時，不再把經驗寫進那些 repo，也不再帶入它們的經驗。請在要工作的專案資料夾開 Claude Code。
- store 裡的舊鍵（`projdir:*`、`migrated:*`、全域的 `handoffs`）不再使用，可以刪除。
- 舊版分錯資料夾的經驗不會自動搬，要手動搬，或用 `node tools/notes.mjs`（見 [`tools/README.md`](tools/README.md)）。

## 運作方式

以下都只看主對話，子代理的回合會略過。

| 時機 | 會發生什麼 | 你要做的事 |
|---|---|---|
| **對話停下來，且 context ≥ 600k**（或視窗的 80%，取較小者） | 在 Claude Code 的 `Stop` hook 觸發時判斷。如果還有背景工作、一次性排程或子代理在跑，就先等（循環排程不算），最多等到硬上限 `min(視窗的 90%, 門檻 + 150k)`。接著 fork 對話寫 handoff，執行 `/clear`，再送出 handoff。 | 不用做事 |
| **閒置 55 分鐘** | 用一個很小的 fork 刷新快取，最多 3 次。到第 4 次改存離席 handoff，而且**不** `/clear`。 | 不用做事 |
| **離席 handoff 之後回來** | 先攔下你的第一則訊息，請你選擇。 | `/handoff resume` 開新對話，帶上 handoff 和你的訊息；`/handoff continue` 留在舊對話。 |

### 經驗檔（背景整理）

工作區是 session 啟動的資料夾；從 git worktree 啟動時算主工作樹。經驗檔在 `~/.claude/projects/<編碼後的資料夾路徑>/memory/ctx-handoff.md`，是可以直接編輯的一般 Markdown。

| 條目 | 內容 | 帶入新對話 |
|---|---|---|
| **記憶** | 偏好、決定與限制、外部資源的位置 | 最新 40 條 |
| **規則** | 可重複使用的做法與出現次數，例如「Bash 路徑用正斜線（3 次）」 | 出現 2 次以上、依次數取前 15 條 |

- **什麼時候跑**：每 30 則訊息、閒置刷新時、存離席 handoff 前、門檻交接前。`/handoff distill` 立刻跑一次；`/handoff distill off` 關掉。
- **送出什麼**：只有上次整理之後的對話（轉成純文字，工具輸入與結果截短，總長上限 30 萬字），加上這個工作區現有的經驗。一次交給 `DISTILL_MODEL`（Sonnet 5.5，effort low）的請求，不帶工具。
- **怎麼套用**：模型每行輸出一個 JSON 動作（`add_memory`、`update_memory`、`delete_memory`、`add_rule`、`confirm_rule`、`update_rule`、`delete_rule`），mod 逐行驗證；無效的行和疑似金鑰的內容會丟棄、計數，顯示在 `/handoff`。請求期間經驗檔被改過，就整批不寫，下次重新整理同一段。
- **怎麼看到**：跳出提示，寫出變動幾項和檔案的完整路徑。變動會跟著你的下一則訊息當成補充資訊帶入，不會自己送訊息給模型。

### 值得知道的行為

- **交接期間打的訊息不會不見**：會先攔下並提示（交接已進行幾秒，通常不到 1 分鐘），再跟 handoff 一起送出；同樣的內容只暫存一次。附件無法暫存，要在交接後重新貼上，提示會說明。
- **失敗看得到**：交接失敗（產生、`/clear`、送出）都會記錄，顯示在 `/handoff`。handoff 的 fork 超過 3 分鐘就放棄，攔下的訊息送回舊對話；整理請求超過 8 分鐘就放棄。門檻交接失敗後，要再等 3 則訊息或 10 分鐘才重試。handoff 全文會在 `/clear` 前先存好，送出失敗時可以用 `/handoff resend` 重送。
- **紀錄依工作區分開**：最近 5 份 handoff 與整理狀態依工作區存在 mod 的 store；每個 session 的鍵 30 天後清掉。`refresh` 與 `distill` 開關是全域的。

## 指令

平常用不到。如果你自己的指令或 skill 已經叫 `/handoff`，mod 會改註冊 `/ctx-handoff`。

| 指令 | 用途 |
|---|---|
| `/handoff` | 查看 context 用量、門檻、刷新與整理狀態、待處理的離席 handoff，並列出用法 |
| `/handoff now` | 立刻交接（會清除目前對話） |
| `/handoff dry` | 試產一份 handoff 並顯示花費，不清除對話 |
| `/handoff distill` | 立刻整理這個工作區的經驗 |
| `/handoff resume` | 使用離席 handoff：`/clear` 後送出它和攔下的訊息 |
| `/handoff continue` | 放棄離席 handoff，在舊對話送出攔下的訊息 |
| `/handoff resend` | 重送沒送達的 handoff，不再 `/clear` |
| `/handoff refresh on\|off` | 開關閒置時的快取刷新；關閉時，閒置 55 分鐘就直接存離席 handoff |
| `/handoff distill on\|off` | 開關背景整理 |

## 設定

數值是 [`hooks/register.ts`](hooks/register.ts) 開頭的常數；資料夾用 `CLAUDE_CODE_PLUGIN_DIRS` 載入時，改完會自動熱重載。

| 常數 | 預設 | 意思 |
|---|---|---|
| `THRESHOLD` | `600_000` | 觸發交接的 context token 數 |
| `WINDOW_RATIO` | `0.8` | 視窗較小時，門檻改成「視窗 × 這個比例」 |
| `IDLE_MS` | 55 分鐘 | 閒置多久後刷新（依 1 小時快取設定） |
| `MAX_REFRESH` | `3` | 存離席 handoff 前最多刷新幾次 |
| `MIN_TOKENS` | `30_000` | context 低於這個值時，不刷新、不背景整理、不存離席 handoff |
| `DISTILL_MODEL` | `claude-sonnet-5-5` | 整理用的模型，搭配 `DISTILL_EFFORT` `low` |

關於門檻：社群回報和 Anthropic 的 MRCR 數據都顯示，品質大約在 200k～300k token 開始下滑。600k 是刻意選的，為了少交接幾次；如果發現交接前模型已經變差，就調低它。

## 限制

- **5 分鐘快取的使用者要關掉刷新。** 用 API key、Bedrock、Vertex，或訂閱已超出額度、開始扣 usage credits 時，快取只有 5 分鐘，第 55 分鐘的刷新會整段重寫。請執行 `/handoff refresh off`；mod 不會自動偵測快取時效。
- **閒置刷新還沒驗證。** 還不確定 fork 讀取快取能不能延長主對話那份 1 小時快取。
- **經驗只留在一個資料夾。** 在家目錄做的工作就記在家目錄，即使內容是別的專案。
- **交接前的整理會跨過 `/clear`。** 它先讀好對話片段，所以交接最多只等它 5 秒。`/clear` 之後請求能不能跑完還沒確認；如果不能，會記錄為失敗並顯示在 `/handoff`。
- **背景工作的判斷靠 `Stop` hook 的快照。** 永遠不會結束的工作（例如 dev server）只會讓交接延到硬上限；需要時用 `/handoff now` 提早交接。
- **熱重載會重置計時器和記憶體內的狀態**（攔下的訊息、排入的經驗差異、重送紀錄）。
- **API 還在 early access。** Claude Code 更新後可能需要跟著改。

## 開發

開發流程、設計決定與實測過的平台事實在 [`CLAUDE.md`](CLAUDE.md)；工具一覽在 [`tools/README.md`](tools/README.md)。

```sh
node tools/wt.mjs new <分支>      # 在暫存 worktree 改，不動熱重載中的主資料夾
node tools/check.mjs              # validate、測試、tsc、工具測試、公開資訊掃描
node tools/wt.mjs land <分支>     # 再檢查一次，通過才 fast-forward 回主資料夾
node tools/status.mjs             # 經驗檔大小、最近整理與失敗、各 session 的熱重載
```

## 授權

[MIT](LICENSE)
