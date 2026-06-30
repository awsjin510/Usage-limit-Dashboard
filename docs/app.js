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
let manual = false; // true when showing pasted data — auto-refresh is paused
const PASTE_KEY = "usageDashboard.pastedPayload";

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
  el.classList.remove("hidden", "info");
}
function showNotice(msg) {
  const el = document.getElementById("error");
  el.textContent = "ℹ️ " + msg;
  el.classList.add("info");
  el.classList.remove("hidden");
}
function clearError() {
  document.getElementById("error").classList.add("hidden");
  document.getElementById("error").classList.remove("info");
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

// Build a provider object from a Claude usage-cache.json (rate_limits shape).
function providerFromClaudeCache(rl) {
  const win = (w) => {
    w = w || {};
    const pct = typeof w.used_percentage === "number" ? w.used_percentage : null;
    let resetsAt = null;
    if (typeof w.resets_at === "number") {
      // Unix epoch seconds (Claude statusLine) — but tolerate ms just in case.
      const ms = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;
      resetsAt = new Date(ms).toISOString();
    } else if (typeof w.resets_at === "string") {
      const d = new Date(w.resets_at);
      if (!isNaN(d.getTime())) resetsAt = d.toISOString();
    }
    return { usedPercent: pct, resetsAt };
  };
  const five = win(rl.five_hour);
  const week = win(rl.seven_day);
  return {
    available: five.usedPercent !== null || week.usedPercent !== null,
    windows: { "5h": five, weekly: week },
  };
}

// Accept either a full data.json payload, or a raw ~/.claude/usage-cache.json.
function normalizePasted(obj) {
  if (obj && (obj.claude || obj.codex)) return obj; // already a data.json payload
  const rl = obj && (obj.rate_limits || obj);
  if (rl && (rl.five_hour || rl.seven_day)) {
    const at = obj && typeof obj.fetchedAt === "number" ? new Date(obj.fetchedAt) : new Date();
    return { generatedAt: at.toISOString(), claude: providerFromClaudeCache(rl) };
  }
  throw new Error("無法辨識的格式：需要 data.json 或含 rate_limits 的 usage-cache.json");
}

function showPasted(payload, persist) {
  manual = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (persist) {
    try {
      localStorage.setItem(PASTE_KEY, JSON.stringify(payload));
    } catch (_) {
      /* storage may be unavailable */
    }
  }
  render(payload);
  showNotice("顯示你貼上的資料（自動刷新已暫停）。按「清除」可恢復。");
}

async function loadData() {
  if (manual) return; // showing pasted data — don't overwrite
  const configured = isConfigured(config.dataUrl);
  const primary = configured ? config.dataUrl : "./data.json";
  try {
    const payload = await fetchJSON(primary);
    if (configured) {
      clearError();
    } else {
      // dataUrl 還是 OWNER/REPO 佔位字串 → 顯示的是內建範例，不是真實用量。
      showNotice(
        "目前顯示的是「範例資料」，不是你的真實用量。請設定 config.json 的 dataUrl 並執行收集器（見 README）。"
      );
    }
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
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadData();
  });

  // --- paste-data UI ---
  const panel = document.getElementById("pastePanel");
  const pasteMsg = document.getElementById("pasteMsg");
  document.getElementById("pasteBtn").addEventListener("click", () => {
    panel.classList.toggle("hidden");
  });
  document.getElementById("pasteShow").addEventListener("click", () => {
    pasteMsg.classList.remove("error");
    pasteMsg.textContent = "";
    const text = document.getElementById("pasteText").value.trim();
    if (!text) {
      pasteMsg.textContent = "請先貼上 JSON。";
      pasteMsg.classList.add("error");
      return;
    }
    try {
      const payload = normalizePasted(JSON.parse(text));
      showPasted(payload, true);
      panel.classList.add("hidden");
    } catch (e) {
      pasteMsg.textContent = "解析失敗：" + e.message;
      pasteMsg.classList.add("error");
    }
  });
  document.getElementById("pasteClear").addEventListener("click", () => {
    try {
      localStorage.removeItem(PASTE_KEY);
    } catch (_) {
      /* ignore */
    }
    document.getElementById("pasteText").value = "";
    manual = false;
    clearError();
    loadData();
    if (!timer) {
      const ms = Math.max(10, Number(config.refreshSeconds) || 60) * 1000;
      timer = setInterval(loadData, ms);
    }
  });

  // Restore previously pasted data (survives refresh) so the user keeps their view.
  let restored = false;
  try {
    const saved = localStorage.getItem(PASTE_KEY);
    if (saved) {
      showPasted(JSON.parse(saved), false);
      restored = true;
    }
  } catch (_) {
    /* ignore */
  }

  if (!restored) {
    await loadData();
    const ms = Math.max(10, Number(config.refreshSeconds) || 60) * 1000;
    timer = setInterval(loadData, ms);
  }
}

init();
