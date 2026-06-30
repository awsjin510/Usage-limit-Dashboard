# Claude × Codex 使用量儀表板

一個**同時顯示 Claude Code 與 Codex 使用量**的儀表板，部署在 **GitHub Pages**。
顯示兩者的 **5 小時視窗**與**每週視窗**使用百分比，超過門檻（預設 85%）轉紅警示，
支援自動刷新、全螢幕與響應式版面（手機 / 平板 / 桌機）。

靈感來自 [`frankchiu-dev/claude-codex-usage-dashboard`](https://github.com/frankchiu-dev/claude-codex-usage-dashboard)，
但改成**靜態網站 + 本地收集器**架構，以便部署在 GitHub Pages。

## 架構

GitHub Pages 是純靜態網站，無法執行伺服器、也無法讀取你電腦上的本地檔案。
因此資料流拆成兩段：

```
本機                                       GitHub
┌────────────────────────────┐            ┌──────────────────────────────┐
│ collector/collect.js        │            │ data 分支：data.json（摘要） │
│  讀 ~/.claude/usage-cache    │  push      │   ▲                          │
│  讀 ~/.codex/sessions        │ ─────────► │   │ raw.githubusercontent     │
│  → 只含百分比/重置時間       │            │   │                          │
│ collector/push-data.sh       │            │ docs/（GitHub Pages 靜態站） │
└────────────────────────────┘            │   app.js 輪詢 raw → 渲染     │
                                            └──────────────────────────────┘
```

- **收集器**在本機讀取使用量，產生**只含摘要**的 `data.json`（不含對話內容 / 路徑 / token）。
- 把 `data.json` force-push 到 `data` 分支（永遠單一 commit，歷史乾淨）。
- **靜態儀表板**（`docs/`）每 60 秒輪詢 `raw.githubusercontent.com/<owner>/<repo>/data/data.json` 並渲染。

### 即時性

純 GitHub Pages 無法做到秒級即時（那需要常駐伺服器，而 HTTPS 頁面抓 `http://localhost`
會被瀏覽器擋）。務實的上限是**近即時**：延遲 ≈「收集間隔 + raw CDN 快取（約 1–2 分）」。

## 快速開始

### 1. 部署儀表板到 GitHub Pages

1. Fork / push 本 repo 到你的 GitHub。
2. Repo **Settings → Pages → Build and deployment**：
   - **Source** 選 **Deploy from a branch**
   - **Branch** 選 **`main`**、資料夾選 **`/docs`**，按 **Save**
3. 約 1–2 分鐘後，GitHub 內建的 `pages-build-deployment` 會把 `docs/` 發佈到
   `https://<你的帳號>.github.io/<repo>/`。之後每次 push 到 `main` 都會自動重新發佈。
4. 編輯 `docs/config.json`，把 `dataUrl` 的 `OWNER/REPO` 換成你的帳號與 repo：
   ```json
   "dataUrl": "https://raw.githubusercontent.com/your-name/your-repo/data/data.json"
   ```

> 還沒設定收集器前，頁面會顯示內建的範例資料（`docs/data.json`）。
>
> 註：第一次啟用 Pages 必須由 repo 擁有者在網頁上手動操作一次（GitHub 不允許用
> Actions 權杖自動建立 Pages 網站）。啟用後即全自動。

### 2. 設定本地收集器

在你**平常使用 Claude Code / Codex 的電腦**上：

```bash
git clone https://github.com/your-name/your-repo.git
cd your-repo

# 測試讀取
node collector/collect.js --print

# 產生並推送一次
node collector/collect.js
./collector/push-data.sh collector/out/data.json
```

接著用排程持續更新（cron / Windows Task Scheduler / `--watch`）——
詳見 [`collector/README.md`](collector/README.md)。

## 設定（`docs/config.json`）

| 欄位 | 預設 | 說明 |
|---|---|---|
| `dataUrl` | `.../data/data.json` | 儀表板讀取的資料來源；未設定時退回內建範例 |
| `alertThreshold` | `85` | 使用百分比達此值轉紅警示 |
| `refreshSeconds` | `60` | 自動刷新間隔（秒） |
| `staleAfterSeconds` | `300` | 資料超過此秒數視為「過時」 |
| `providers` | — | 各來源的顯示名稱 / 圖示 |
| `windowLabels` | — | 視窗標籤（`5h` / `weekly`） |

## 隱私

- 推送到 repo 的 `data.json` **只包含使用百分比與重置時間**，不含對話內容、檔案路徑或 token。
- 若仍不希望摘要公開，可改用 private repo（GitHub Pages 對 private repo 需付費方案）。

## 本地預覽

```bash
cd docs
python3 -m http.server 8000
# 開 http://localhost:8000 （會讀取同目錄的範例 data.json）
```

## 專案結構

```
docs/            GitHub Pages 靜態儀表板（index.html / app.js / styles.css / config.json）
collector/       本地收集器（collect.js / push-data.sh / README.md）
config.example.json           config.json 範本
```
