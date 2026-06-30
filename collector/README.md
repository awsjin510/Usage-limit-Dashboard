# 本地收集器（Collector）

`collect.js` 在**你的電腦**上讀取 Claude Code 與 Codex 的本地使用量檔案，
產生一份**只含摘要**（百分比 + 重置時間）的 `data.json`；
`push-data.sh` 再把它推送到 repo 的 `data` 分支，供 GitHub Pages 上的儀表板讀取。

> 為什麼需要它？GitHub Pages 是純靜態網站，伺服器端無法存取你電腦上的
> `~/.claude` 與 `~/.codex`。所以由本地收集器負責讀取與上傳。

## 讀取來源

| 來源 | 路徑 | 說明 |
|---|---|---|
| Claude Code | `~/.claude/usage-cache.json` | 由 Claude Code 的 statusLine 整合寫入 |
| Codex | `~/.codex/sessions/**/*.jsonl` | 取最近 14 天內最新的 `rate_limits` 快照（primary=5h、secondary=weekly） |

解析採**防禦式**寫法：找不到檔案或欄位時，該來源標記為 `available:false`，
儀表板會顯示「無資料」而不會壞版。輸出**只包含**百分比與重置時間，
不含任何對話內容、檔案路徑或 token 細節。

## 需求

- Node.js 18+（只用內建模組，零外部依賴）
- 已設定好可推送到本 repo 的 git 認證（HTTPS token 或 SSH）

## 手動測試

```bash
# 只印出結果，不寫檔
node collector/collect.js --print

# 產生 collector/out/data.json
node collector/collect.js

# 產生後推送到 data 分支
./collector/push-data.sh collector/out/data.json
```

## 持續更新（近即時）

### 方式 A：內建 watch + 排程推送

```bash
# 每 60 秒重新產生 data.json
node collector/collect.js --watch 60
```

### 方式 B：cron（macOS / Linux）每分鐘收集並推送

```cron
* * * * * cd /path/to/usage-limit-dashboard && node collector/collect.js && ./collector/push-data.sh >> /tmp/usage-collector.log 2>&1
```

### 方式 C：Windows 工作排程器（Task Scheduler）

建立一個每 1 分鐘觸發的工作，動作為執行：

```bat
node C:\path\to\usage-limit-dashboard\collector\collect.js && bash C:\path\to\usage-limit-dashboard\collector\push-data.sh
```

（Windows 需要可用的 `bash`，例如 Git Bash；或將 `push-data.sh` 的 git 指令改寫成 `.bat`。）

## push-data.sh 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `REMOTE` | `origin` | 推送的遠端名稱 |
| `DATA_BRANCH` | `data` | 存放 `data.json` 的分支 |

`data` 分支永遠只保留**單一 commit**（每次 `--amend` + `--force-with-lease`），
所以頻繁更新不會在 git 歷史留下大量噪音。

## 即時性說明

儀表板從 `https://raw.githubusercontent.com/<owner>/<repo>/data/data.json` 讀取，
繞過 Pages 重建。raw 內容有約 1–2 分鐘的 CDN 快取，因此實際延遲約為
「你的收集間隔 + 1～2 分鐘」。純 GitHub Pages 架構下，這是務實的即時性上限。
