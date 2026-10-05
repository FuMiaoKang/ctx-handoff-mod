# 檢討紀錄

依 work-retro 的格式只留現況。每次檢討先從「待結案項目」逐項標記結果。

## 1. 待結案項目

| 項目 | 上線 | 怎麼驗證 | 訊號 |
|---|---|---|---|
| 整理改用 `model.complete`（Sonnet 5.5 low）、只送錨點之後的片段 | 2026-10-05 | 看幾次真實整理的變動數、丟棄行數、輸入／輸出 token 與秒數，和舊 fork（輸入 20～33 萬、輸出 2.6k～10.9k、29～108 秒）比較；變動內容是否合理 | `node tools/status.mjs` 的 `distill:last`／`distill:error` |
| 交接前整理跨過 `/clear`（只等 5 秒） | 2026-10-05 | 下一次在場交接後，`交接前` 那次整理有沒有寫進經驗檔，或記成 `aborted` | `distill:error` 出現 `交接前`＋`timeout`／`aborted` 就要改回等待 |
| `/handoff` 被佔用時改用 `/ctx-handoff` | 2026-10-05 | 在有 `handoff` skill 的資料夾開 session，`/ctx-handoff` 可用 | 對話檔有「改用 /ctx-handoff」訊息 |
| 一個工作區一份經驗檔（拿掉跨專案分檔、搬移、已知專案清單） | 2026-10-05 | 各工作區開的 session 只寫自己的經驗檔；不再出現分錯專案或寫進別的 repo 的變動 | `node tools/status.mjs` 的經驗檔清單與 `distill:last` 寫入路徑 |
| `tools/`（check、wt、status、notes） | 2026-10-05 | 下次改 mod 時全程用 `wt.mjs new/land`、改經驗檔用 `notes.mjs`，不再手寫一次性腳本 | 對話裡出現新的臨時改檔或查詢腳本就算沒生效 |

## 2. 待採用佇列

無。維護者決定背景整理維持自動寫入（2026-10-05）。

## 3. 上次量到的規模（2026-10-05）

| 層 | 規模 |
|---|---|
| 經驗檔（每次對話載入） | 家目錄 10 條記憶／0 條規則（5.2 KB）；ctx-handoff 專案 1／0（0.8 KB）；另兩個專案 27／16（28.4 KB）、32／10（46.0 KB） |
| repo 追蹤檔 | 21 個；`CLAUDE.md`＋`tools/` 共 491 行 |
| repo 外的 ctx-handoff 檔案 | `settings.json` 的 `CLAUDE_CODE_PLUGIN_DIRS`、store 一個檔、各專案經驗檔（其餘已清除） |

## 4. 本專案改過的預設值

無。
