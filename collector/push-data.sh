#!/usr/bin/env bash
#
# push-data.sh — 把收集器產生的 data.json force-push 到 repo 的 `data` 分支。
#
# 設計：`data` 分支永遠只有「單一 commit」，每次都用 --amend 覆寫，再 force-push，
# 因此使用量更新不會在歷史留下大量噪音 commit。儀表板從
#   https://raw.githubusercontent.com/<owner>/<repo>/data/data.json
# 讀取，繞過 Pages 重建，達到近即時（約 1–2 分鐘，受 raw CDN 快取影響）。
#
# 用法：
#   REMOTE=origin DATA_BRANCH=data ./push-data.sh /path/to/out/data.json
#
# 需求：本機 git 已設定可推送到該 repo 的認證（HTTPS token 或 SSH）。

set -euo pipefail

DATA_FILE="${1:-$(dirname "$0")/out/data.json}"
REMOTE="${REMOTE:-origin}"
DATA_BRANCH="${DATA_BRANCH:-data}"

if [[ ! -f "$DATA_FILE" ]]; then
  echo "找不到資料檔：$DATA_FILE（請先執行 node collect.js）" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE="$(mktemp -d)"
trap 'git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true; rm -rf "$WORKTREE"' EXIT

cd "$REPO_ROOT"

# 確保本地有 data 分支（若遠端已存在就取回，否則建立 orphan 分支）。
if git ls-remote --exit-code --heads "$REMOTE" "$DATA_BRANCH" >/dev/null 2>&1; then
  git fetch "$REMOTE" "$DATA_BRANCH" >/dev/null 2>&1 || true
  git worktree add --force "$WORKTREE" "$REMOTE/$DATA_BRANCH" >/dev/null 2>&1
  cd "$WORKTREE"
  git checkout -B "$DATA_BRANCH" >/dev/null 2>&1
else
  git worktree add --force --detach "$WORKTREE" >/dev/null 2>&1
  cd "$WORKTREE"
  git checkout --orphan "$DATA_BRANCH" >/dev/null 2>&1
  git rm -rf . >/dev/null 2>&1 || true
fi

cp "$DATA_FILE" "$WORKTREE/data.json"
git add data.json

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  git commit --amend -m "usage data update" >/dev/null 2>&1
else
  git commit -m "usage data update" >/dev/null 2>&1
fi

# 重試 force-push（指數退避）以容忍暫時性網路問題。
n=0
until git push --force-with-lease -u "$REMOTE" "$DATA_BRANCH" >/dev/null 2>&1; do
  n=$((n + 1))
  if [[ $n -ge 4 ]]; then
    echo "推送 $DATA_BRANCH 失敗（已重試 $n 次）" >&2
    exit 1
  fi
  sleep $((2 ** n))
done

echo "已推送使用量摘要到 $REMOTE/$DATA_BRANCH"
