const DEFAULT_SETTINGS = {
  maxJobs: 80,
  delayMin: 4,
  delayMax: 9,
  blacklist: "",
  hrMessage: "",
  autoNext: true,
  dedupeCompany: false,
  skipSent: true
};

const settingIds = [
  "maxJobs",
  "delayMin",
  "delayMax",
  "blacklist",
  "hrMessage",
  "autoNext",
  "dedupeCompany",
  "skipSent"
];

const els = Object.fromEntries(
  [
    ...settingIds,
    "stateBadge",
    "statFound",
    "statSent",
    "statClicked",
    "statSkipped",
    "message",
    "scanBtn",
    "startBtn",
    "pauseBtn",
    "stopBtn",
    "exportBtn",
    "clearBtn"
  ].map((id) => [id, document.getElementById(id)])
);

document.addEventListener("DOMContentLoaded", async () => {
  setForm(await loadSettings());
  bindActions();
  await refreshStatus();
  window.setInterval(refreshStatus, 1200);
});

function bindActions() {
  settingIds.forEach((id) => {
    els[id].addEventListener("change", saveSettingsFromForm);
  });

  els.scanBtn.addEventListener("click", async () => {
    await sendToTab({ type: "BOSS_V2_SCAN" });
    await refreshStatus();
  });

  els.startBtn.addEventListener("click", async () => {
    const settings = await saveSettingsFromForm();
    await sendToTab({ type: "BOSS_V2_START", settings });
    await refreshStatus();
  });

  els.pauseBtn.addEventListener("click", async () => {
    await sendToTab({ type: "BOSS_V2_PAUSE" });
    await refreshStatus();
  });

  els.stopBtn.addEventListener("click", async () => {
    await sendToTab({ type: "BOSS_V2_STOP" });
    await refreshStatus();
  });

  els.exportBtn.addEventListener("click", async () => {
    const response = await sendToTab({ type: "BOSS_V2_EXPORT" });
    if (!response?.csv) {
      setMessage("暂无可导出的 v2 日志。");
      return;
    }
    downloadCsv(response.csv);
    setMessage("v2 日志已导出。");
  });

  els.clearBtn.addEventListener("click", async () => {
    await sendToTab({ type: "BOSS_V2_CLEAR" });
    await refreshStatus();
    setMessage("v2 本地记录已清空。");
  });
}

async function loadSettings() {
  const result = await chrome.storage.local.get({ bossV2Settings: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...result.bossV2Settings };
}

async function saveSettingsFromForm() {
  const settings = {
    maxJobs: clampNumber(els.maxJobs.value, 1, 1000, DEFAULT_SETTINGS.maxJobs),
    delayMin: clampNumber(els.delayMin.value, 1, 60, DEFAULT_SETTINGS.delayMin),
    delayMax: clampNumber(els.delayMax.value, 1, 120, DEFAULT_SETTINGS.delayMax),
    blacklist: els.blacklist.value,
    hrMessage: els.hrMessage.value,
    autoNext: els.autoNext.checked,
    dedupeCompany: els.dedupeCompany.checked,
    skipSent: els.skipSent.checked
  };
  if (settings.delayMax < settings.delayMin) {
    settings.delayMax = settings.delayMin;
  }
  await chrome.storage.local.set({ bossV2Settings: settings });
  setForm(settings);
  return settings;
}

function setForm(settings) {
  els.maxJobs.value = settings.maxJobs;
  els.delayMin.value = settings.delayMin;
  els.delayMax.value = settings.delayMax;
  els.blacklist.value = settings.blacklist || "";
  els.hrMessage.value = settings.hrMessage || "";
  els.autoNext.checked = settings.autoNext;
  els.dedupeCompany.checked = settings.dedupeCompany;
  els.skipSent.checked = settings.skipSent;
}

async function refreshStatus() {
  const response = await sendToTab({ type: "BOSS_V2_STATUS" }, true);
  if (!response) {
    setState("未连接");
    setMessage("请打开 BOSS 搜索结果页后再使用。");
    return;
  }
  setState(response.running ? "运行中" : response.paused ? "已暂停" : "就绪");
  els.statFound.textContent = response.found ?? 0;
  els.statSent.textContent = response.sent ?? 0;
  els.statClicked.textContent = response.clicked ?? 0;
  els.statSkipped.textContent = response.skipped ?? 0;
  setMessage(response.message || "先在 BOSS 搜索页筛好城市和岗位方向。");
}

async function sendToTab(message, silent = false) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return null;
    }
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    if (!silent) {
      setMessage("无法连接当前页面，请刷新 BOSS 页面后重试。");
    }
    return null;
  }
}

function setState(text) {
  els.stateBadge.textContent = text;
}

function setMessage(text) {
  els.message.textContent = text;
}

function clampNumber(value, min, max, fallback) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

function downloadCsv(csv) {
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `boss-v2-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
