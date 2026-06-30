#!/usr/bin/env node
"use strict";

/*
 * collect.js — 本地使用量收集器（跨平台，零外部依賴）
 *
 * 讀取本機的 Claude Code 與 Codex 使用量，產生「只含摘要」的 data.json：
 *   - 僅輸出各時間視窗的使用百分比與重置時間
 *   - 不含任何對話內容、檔案路徑或 token 細節
 *
 * 用法：
 *   node collect.js                 產生 ./out/data.json
 *   node collect.js --out path.json  指定輸出位置
 *   node collect.js --print          只印到 stdout，不寫檔
 *   node collect.js --watch 60       每 60 秒重跑一次
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const CLAUDE_CACHE = path.join(HOME, ".claude", "usage-cache.json");
const CODEX_SESSIONS = path.join(HOME, ".codex", "sessions");
const CODEX_LOOKBACK_DAYS = 14;

/* ---------------- utils ---------------- */

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v * 100) / 100));
}

// Accept a percent that may be 0–1 fraction or 0–100. Heuristic: <=1 → fraction.
function normalizePercent(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return clampPct(v <= 1 ? v * 100 : v);
}

function isoOrNull(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function resetFromSeconds(seconds, baseMs) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return null;
  return new Date((baseMs || Date.now()) + s * 1000).toISOString();
}

// Walk an object and return the first value whose key matches any regex.
// wantType ("string" | "number") optionally restricts which value types qualify
// — this keeps ISO timestamps (strings) from being confused with
// seconds-remaining counters (numbers) when both live under "reset*" keys.
function findFirst(obj, regexes, wantType, seen) {
  if (obj == null || typeof obj !== "object") return undefined;
  seen = seen || new Set();
  if (seen.has(obj)) return undefined;
  seen.add(obj);
  const typeOk = (v) =>
    wantType ? typeof v === wantType : typeof v === "number" || typeof v === "string";
  for (const [k, v] of Object.entries(obj)) {
    if (regexes.some((r) => r.test(k)) && typeOk(v)) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findFirst(v, regexes, wantType, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function emptyProvider() {
  return {
    available: false,
    windows: {
      "5h": { usedPercent: null, resetsAt: null },
      weekly: { usedPercent: null, resetsAt: null },
    },
  };
}

/* ---------------- Claude ---------------- */
/*
 * ~/.claude/usage-cache.json 由 Claude Code 的 statusLine 整合寫入。
 * 其 schema 並非公開標準，因此這裡採防禦式解析：對 5h / weekly 兩個視窗，
 * 嘗試多種常見欄位命名擷取「百分比」與「重置時間」。
 */
function collectClaude() {
  const raw = readJSONSafe(CLAUDE_CACHE);
  if (!raw || typeof raw !== "object") return emptyProvider();

  // 嘗試找出兩個視窗的子物件（鍵名可能是 5h / five_hour / session、week / weekly / 7d ...）
  const pick = (obj, keyRegexes) => {
    if (!obj || typeof obj !== "object") return null;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && keyRegexes.some((r) => r.test(k))) return v;
    }
    return null;
  };

  const container = raw.windows || raw.limits || raw.rate_limits || raw.usage || raw;
  const fiveH = pick(container, [/5\s*h/i, /five/i, /hour/i, /session/i]) || container;
  const week = pick(container, [/week/i, /weekly/i, /7\s*d/i]) || container;

  const pctRegex = [/used.*percent/i, /percent.*used/i, /usage.*percent/i, /^percent/i, /pct/i, /utiliz/i];
  const resetAtRegex = [/reset.*at/i, /resets?_?at/i, /expires?(_at)?/i, /expiry/i];
  const resetSecRegex = [/reset.*in.*sec/i, /resets?_in_seconds/i, /seconds.*reset/i, /resets?_in/i];

  function win(scope) {
    const pct = normalizePercent(findFirst(scope, pctRegex, "number"));
    // ISO timestamps are strings; seconds-remaining are numbers — keep them apart.
    let resetsAt = isoOrNull(findFirst(scope, resetAtRegex, "string"));
    if (!resetsAt) resetsAt = resetFromSeconds(findFirst(scope, resetSecRegex, "number"));
    return { usedPercent: pct, resetsAt };
  }

  const w5 = win(fiveH);
  const ww = win(week);
  const available = w5.usedPercent !== null || ww.usedPercent !== null;
  return { available, windows: { "5h": w5, weekly: ww } };
}

/* ---------------- Codex ---------------- */
/*
 * ~/.codex/sessions/ 下有多個 .jsonl 會話檔。每行是一筆 JSON 事件，
 * 其中部分事件帶有 rate_limits 快照（primary = 5h 視窗、secondary = weekly 視窗）。
 * 取最近 CODEX_LOOKBACK_DAYS 天內「最新」的 rate_limits 快照。
 */
function listRecentFiles(dir, days) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const cutoff = Date.now() - days * 86400 * 1000;
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listRecentFiles(full, days)); // Codex may nest by date
    } else if (e.isFile() && full.endsWith(".jsonl")) {
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= cutoff) out.push({ file: full, mtimeMs: st.mtimeMs });
      } catch (_) {
        /* skip */
      }
    }
  }
  return out;
}

function extractRateLimits(obj) {
  // Locate a rate_limits object anywhere in the event.
  if (!obj || typeof obj !== "object") return null;
  if (obj.rate_limits && typeof obj.rate_limits === "object") return obj.rate_limits;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = extractRateLimits(v);
      if (found) return found;
    }
  }
  return null;
}

function codexWindowFrom(scope, baseMs) {
  if (!scope || typeof scope !== "object") return { usedPercent: null, resetsAt: null };
  const pct = normalizePercent(
    findFirst(scope, [/used.*percent/i, /percent.*used/i, /^used_percent$/i, /percent/i], "number")
  );
  let resetsAt = isoOrNull(findFirst(scope, [/reset.*at/i, /resets?_?at/i, /expires?(_at)?/i], "string"));
  if (!resetsAt) {
    resetsAt = resetFromSeconds(
      findFirst(scope, [/resets?_in_seconds/i, /reset.*in.*sec/i, /resets?_in/i], "number"),
      baseMs
    );
  }
  return { usedPercent: pct, resetsAt };
}

function collectCodex() {
  const files = listRecentFiles(CODEX_SESSIONS, CODEX_LOOKBACK_DAYS);
  if (files.length === 0) return emptyProvider();
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest file first

  let best = null; // { rl, baseMs }
  let bestTs = -Infinity;

  for (const { file, mtimeMs } of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (_) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch (_) {
        continue;
      }
      const rl = extractRateLimits(evt);
      if (!rl) continue;
      const tsRaw = evt.timestamp || evt.time || evt.ts || evt.created_at;
      const ts = tsRaw ? new Date(tsRaw).getTime() : mtimeMs;
      const tsVal = Number.isFinite(ts) ? ts : mtimeMs;
      if (tsVal >= bestTs) {
        bestTs = tsVal;
        best = { rl, baseMs: tsVal };
      }
    }
    // Newest file already scanned fully; if we found something we can stop early
    // once we've passed files older than the current best snapshot.
    if (best && mtimeMs < bestTs) break;
  }

  if (!best) return emptyProvider();

  const rl = best.rl;
  const primary = rl.primary || rl["5h"] || rl.five_hour || rl.session || rl;
  const secondary = rl.secondary || rl.weekly || rl.week || rl["7d"] || rl;

  const w5 = codexWindowFrom(primary, best.baseMs);
  const ww = codexWindowFrom(secondary, best.baseMs);
  const available = w5.usedPercent !== null || ww.usedPercent !== null;
  return { available, windows: { "5h": w5, weekly: ww } };
}

/* ---------------- main ---------------- */

function build() {
  return {
    generatedAt: new Date().toISOString(),
    claude: collectClaude(),
    codex: collectCodex(),
  };
}

function parseArgs(argv) {
  const args = { out: path.join(__dirname, "out", "data.json"), print: false, watch: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--print") args.print = true;
    else if (a === "--watch") args.watch = Math.max(5, parseInt(argv[++i], 10) || 60);
  }
  return args;
}

function runOnce(args) {
  const data = build();
  const json = JSON.stringify(data, null, 2);
  if (args.print) {
    process.stdout.write(json + "\n");
  } else {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json + "\n");
    const c = data.claude.available ? "OK" : "no data";
    const x = data.codex.available ? "OK" : "no data";
    console.log(`[${data.generatedAt}] wrote ${args.out}  (claude ${c}, codex ${x})`);
  }
  return data;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.watch) {
    runOnce(args);
    setInterval(() => {
      try {
        runOnce(args);
      } catch (e) {
        console.error("collect error:", e.message);
      }
    }, args.watch * 1000);
  } else {
    runOnce(args);
  }
}

if (require.main === module) main();

module.exports = { build, collectClaude, collectCodex, normalizePercent };
