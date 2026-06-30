"use strict";

const DEFAULT_CONFIG = {
  dataUrl: "./data.json",
  alertThreshold: 85,
  refreshSeconds: 60,
  staleAfterSeconds: 300,
  providers: {
    claude: { name: "Claude Code", logo: "🟧", sub: "Anthropic" },
    codex: { name: "Codex", logo: "🟢", sub: "OpenAI" },
  },
  windowLabels: { "5h": "5 小時視窗", weekly: "每週視窗" },
};

const WINDOW_ORDER = ["5h", "weekly"];
const PROVIDER_ORDER = ["claude", "codex"];

let config = DEFAULT_CONFIG;
let timer = null;

/* ---------- helpers ---------- */

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}

function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// "重置倒數" e.g. "2 天 4 小時" / "3 小時 20 分" / "12 分"
function fmtCountdown(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  let s = Math.round((d.getTime() - Date.now()) / 1000);
  if (s <= 0) return "即將重置";
  const days = Math.floor(s / 86400);
  s -= days * 86400;
  const hours = Math.floor(s / 3600);
  s -= hours * 3600;
  const mins = Math.floor(s / 60);
  if (days > 0) return `${days} 天 ${hours} 小時`;
  if (hours > 0) return `${hours} 小時 ${mins} 分`;
  return `${mins} 分`;
}

/* ---------- rendering ---------- */

function windowEl(label, win, threshold) {
  const pct = clampPct(win && win.usedPercent);
  const wrap = document.createElement("div");
  wrap.className = "window";

  const top = document.createElement("div");
  top.className = "window-top";

  const lbl = document.createElement("span");
  lbl.className = "window-label";
  lbl.textContent = label;

  const val = document.createElement("span");
  val.className = "window-pct";
  const isAlert = pct !== null && pct >= threshold;
  if (isAlert) val.classList.add("alert");
  val.textContent = pct === null ? "—" : `${Math.round(pct)}%`;

  top.append(lbl, val);

  const track = document.createElement("div");
  track.className = "track";
  const bar = document.createElement("div");
  bar.className = "bar" + (isAlert ? " alert" : "");
  bar.style.width = (pct === null ? 0 : pct) + "%";
  track.appendChild(bar);

  const meta = document.createElement("div");
  meta.className = "window-meta";
  const reset = win && win.resetsAt;
  const countdown = fmtCountdown(reset);
  const at = fmtTime(reset);
  meta.textContent =
    countdown && at ? `重置倒數 ${countdown}（${at}）` : "重置時間未知";

  wrap.append(top, track, meta);
  return wrap;
}

function providerCard(key, data) {
  const meta = config.providers[key] || { name: key, logo: "📊", sub: "" };
  const card = document.createElement("section");
  card.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";
  const logo = document.createElement("div");
  logo.className = "card-logo";
  logo.textContent = meta.logo;
  const namebox = document.createElement("div");
  const name = document.createElement("div");
  name.className = "card-name";
  name.textContent = meta.name;
  const sub = document.createElement("div");
  sub.className = "card-sub";
  sub.textContent = meta.sub || "";
  namebox.append(name, sub);
  head.append(logo, namebox);

  const available = data && data.available !== false && data.windows;
  if (!available) {
    card.classList.add("unavailable");
    const badge = document.createElement("span");
    badge.className = "badge-na";
    badge.textContent = "無資料";
    head.appendChild(badge);
  }
  card.appendChild(head);

  if (available) {
    for (const w of WINDOW_ORDER) {
      const label = (config.windowLabels && config.windowLabels[w]) || w;
      card.appendChild(windowEl(label, data.windows[w], config.alertThreshold));
    }
  } else {
    const note = document.createElement("div");
    note.className = "window-meta";
    note.textContent = "收集器尚未提供此來源的使用量資料。";
    card.appendChild(note);
  }
  return card;
}

function render(payload) {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  for (const key of PROVIDER_ORDER) {
    grid.appendChild(providerCard(key, payload && payload[key]));
  }

  const gen = payload && payload.generatedAt;
  const genEl = document.getElementById("generatedAt");
  const statusEl = document.getElementById("status");
  if (gen) {
    const d = new Date(gen);
    genEl.textContent = "資料時間：" + d.toLocaleString();
    const ageSec = (Date.now() - d.getTime()) / 1000;
    const stale = ageSec > (config.staleAfterSeconds || 300);
    statusEl.className = "status " + (stale ? "stale" : "live");
    statusEl.textContent = stale
      ? "資料已過時"
      : "即時（" + fmtTime(gen) + " 更新）";
  } else {
    genEl.textContent = "—";
    statusEl.className = "status";
    statusEl.textContent = "—";
  }
}

function showError(msg) {
  const el = document.getElementById("error");
  el.textContent = "⚠️ " + msg;
  el.classList.remove("hidden");
}
function clearError() {
  document.getElementById("error").classList.add("hidden");
}

/* ---------- data loading ---------- */

function isConfigured(url) {
  return url && !/OWNER\/REPO/.test(url);
}

async function fetchJSON(url) {
  const bust = (url.includes("?") ? "&" : "?") + "t=" + Date.now();
  const res = await fetch(url + bust, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function loadData() {
  const primary = isConfigured(config.dataUrl) ? config.dataUrl : "./data.json";
  try {
    const payload = await fetchJSON(primary);
    clearError();
    render(payload);
  } catch (e) {
    // Fall back to bundled sample for local preview / first-run demo.
    if (primary !== "./data.json") {
      try {
        const payload = await fetchJSON("./data.json");
        render(payload);
        showError(
          "無法讀取設定的 dataUrl（" +
            e.message +
            "）。目前顯示的是內建範例資料，請確認收集器已推送 data 分支。"
        );
        return;
      } catch (_) {
        /* ignore, fall through */
      }
    }
    showError("讀取使用量資料失敗：" + e.message);
  }
}

/* ---------- boot ---------- */

async function init() {
  try {
    const c = await fetchJSON("./config.json");
    config = Object.assign({}, DEFAULT_CONFIG, c, {
      providers: Object.assign({}, DEFAULT_CONFIG.providers, c.providers),
      windowLabels: Object.assign({}, DEFAULT_CONFIG.windowLabels, c.windowLabels),
    });
  } catch (_) {
    config = DEFAULT_CONFIG;
  }

  document.getElementById("refreshSeconds").textContent = config.refreshSeconds;

  document.getElementById("refreshBtn").addEventListener("click", loadData);
  document.getElementById("fullscreenBtn").addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });
  // Pause polling when tab hidden; refresh immediately when it returns.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadData();
  });

  await loadData();
  const ms = Math.max(10, Number(config.refreshSeconds) || 60) * 1000;
  timer = setInterval(loadData, ms);
}

init();
