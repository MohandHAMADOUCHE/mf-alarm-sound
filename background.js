/** Background : notif + popup alerte (position stable, écran de la fenêtre navigateur). */

const ALERT_WIN = { width: 560, minHeight: 360, maxHeight: 780 };
const BADGE_ALARM = "mf-badge";
const CONTENT_SCRIPT_ID = "mf-alarm";

const DEFAULTS = {
  soundEnabled: false,
  intervalMs: 30000,
  soundPreset: "police",
  volume: 10,
  alertErrorRecent: true,
  alertExpiredRecent: true,
  alertWarnRecent: true,
  snoozeUntil: 0,
  mutedWaveSig: "",
  snoozedWaveSig: "",
  ackedKeys: [],
  attachHint: "",
  watchedApps: [],
  attachedOrigin: "",
  attachedPattern: "",
  watchedTabId: null,
  watchedUrl: "",
};

chrome.runtime.onInstalled.addListener(() => {
  // Reset attach : sinon une vieille origine (host) reste affichable / réutilisée.
  chrome.storage.local.set({ ...DEFAULTS });
  paintBadge(false, 0, "");
  ensureBadgeAlarm();
});

chrome.runtime.onStartup?.addListener?.(() => {
  ensureBadgeAlarm();
  refreshBadgeFromStorage();
});

ensureBadgeAlarm();
refreshBadgeFromStorage();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    !changes.soundEnabled &&
    !changes.snoozeUntil &&
    !changes.mutedWaveSig &&
    !changes.attachHint
  ) {
    return;
  }
  refreshBadgeFromStorage();
});

function ensureBadgeAlarm() {
  if (!chrome.alarms) return;
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name !== BADGE_ALARM) return;
  refreshBadgeFromStorage();
  checkWatchedTabAlive();
});

async function refreshBadgeFromStorage() {
  const cfg = await chrome.storage.local.get([
    "soundEnabled",
    "snoozeUntil",
    "mutedWaveSig",
    "attachHint",
  ]);
  paintBadge(
    !!cfg.soundEnabled,
    cfg.snoozeUntil || 0,
    cfg.mutedWaveSig || "",
    cfg.attachHint || ""
  );
}

function paintBadge(soundOn, snoozeUntil, mutedWaveSig, attachHint) {
  if (attachHint) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
  } else if (mutedWaveSig) {
    chrome.action.setBadgeText({ text: "ACK" });
    chrome.action.setBadgeBackgroundColor({ color: "#fb8c00" });
  } else if (soundOn) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  } else {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#78909c" });
  }
}

async function isSnoozed() {
  // Silence temporaire retiré : plus de snooze durée.
  return false;
}

async function isWaveMuted(keys) {
  const { mutedWaveSig } = await chrome.storage.local.get("mutedWaveSig");
  if (!mutedWaveSig) return false;
  const sig = (keys || []).slice().sort().join("|");
  if (sig !== mutedWaveSig) {
    await chrome.storage.local.set({ mutedWaveSig: "" });
    return false;
  }
  return true;
}

let alertWindowId = null;
let lastNotifiedKey = "";
/** Position figée tant que la popup vit — évite la descente à chaque poll. */
let pinnedPlace = null;
/** Anti-spam focus (onFocusChanged + poll content). */
let lastFocusAt = 0;
/** Onglet Overview qui a signalé l’alarme (pas d’URL hardcodée). */
let watchedTabId = null;
/** Sérialise showAlertUi (évite double/triple create en race). */
let alertUiQueue = Promise.resolve();
let alertCreating = false;

async function rememberTab(tabId) {
  if (!tabId) return;
  watchedTabId = tabId;
  await chrome.storage.local.set({
    watchedTabId: tabId,
    attachHint: "",
  });
}

async function lostWatchedTab(reason) {
  watchedTabId = null;
  await detachContentScript();
  await chrome.storage.local.set({
    watchedTabId: null,
    soundEnabled: false,
    watchedApps: [],
    attachHint: reason || "Onglet de veille fermé — rattacher.",
  });
  lastNotifiedKey = "";
  pinnedPlace = null;
  chrome.notifications.clear("mf-alarm");
  if (alertWindowId != null) {
    chrome.windows.remove(alertWindowId).catch(() => {});
    alertWindowId = null;
  }
  await refreshBadgeFromStorage();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitTabComplete(tabId, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return t;
    } catch (_) {
      return null;
    }
    await sleep(250);
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

async function injectIntoTab(tabId) {
  await rememberTab(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  try {
    await chrome.tabs.sendMessage(tabId, { type: "MF_WAKE" });
  } catch (_) {}
}

/** Recrée l’onglet Overview en fond (ou au premier plan si active). Toujours on. */
async function recreateWatchedTab({ active }) {
  const { watchedUrl } = await chrome.storage.local.get("watchedUrl");
  if (!watchedUrl) return null;
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: watchedUrl,
      active: !!active,
    });
  } catch (_) {
    return null;
  }
  const ready = await waitTabComplete(tab.id);
  if (!ready) return null;
  try {
    await injectIntoTab(tab.id);
    await chrome.storage.local.set({
      watchedTabId: tab.id,
      attachHint: "",
    });
    watchedTabId = tab.id;
    return tab.id;
  } catch (_) {
    return null;
  }
}

/**
 * Garantit un onglet de veille (fantôme en fond si fermé).
 * focus=true → premier plan (geste user : Ouvrir MF / Ack / notif).
 */
async function ensureWatchedTab({ focus } = {}) {
  const cfg = await chrome.storage.local.get([
    "soundEnabled",
    "watchedTabId",
    "watchedUrl",
  ]);
  if (!cfg.soundEnabled) return null;
  const wantFocus = !!focus;
  let id = cfg.watchedTabId || watchedTabId;
  if (id != null) {
    try {
      const t = await chrome.tabs.get(id);
      if (wantFocus) {
        await chrome.tabs.update(id, { active: true });
        if (t.windowId != null) {
          await chrome.windows.update(t.windowId, { focused: true });
        }
      }
      return id;
    } catch (_) {
      watchedTabId = null;
    }
  }
  if (cfg.watchedUrl) {
    return recreateWatchedTab({ active: wantFocus });
  }
  return null;
}

async function checkWatchedTabAlive() {
  const { watchedTabId: stored, soundEnabled, watchedUrl } =
    await chrome.storage.local.get([
      "watchedTabId",
      "soundEnabled",
      "watchedUrl",
    ]);
  const id = stored || watchedTabId;
  if (!soundEnabled) return;
  if (id) {
    try {
      await chrome.tabs.get(id);
      return;
    } catch (_) {}
  }
  if (watchedUrl) {
    const newId = await recreateWatchedTab({ active: false });
    if (!newId) {
      await lostWatchedTab("Impossible de recréer l’onglet — rattacher.");
    }
    return;
  }
  if (id) await lostWatchedTab("Onglet de veille fermé — rattacher.");
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const cfg = await chrome.storage.local.get([
    "watchedTabId",
    "soundEnabled",
    "watchedUrl",
  ]);
  if (tabId !== cfg.watchedTabId && tabId !== watchedTabId) return;
  watchedTabId = null;
  await chrome.storage.local.set({ watchedTabId: null });
  if (!cfg.soundEnabled) {
    await lostWatchedTab("Onglet de veille fermé — rattacher.");
    return;
  }
  if (cfg.watchedUrl) {
    await chrome.storage.local.set({
      attachHint: "Recréation de l’onglet de veille…",
    });
    await refreshBadgeFromStorage();
    const newId = await recreateWatchedTab({ active: false });
    if (!newId) {
      await lostWatchedTab("Impossible de recréer l’onglet — rattacher.");
    } else {
      await chrome.storage.local.set({ attachHint: "" });
      await refreshBadgeFromStorage();
    }
    return;
  }
  await lostWatchedTab("Onglet de veille fermé — rattacher.");
});

/** URL / reload onglet de veille → maj fantôme + réinject. */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const cfg = await chrome.storage.local.get([
    "soundEnabled",
    "watchedTabId",
    "attachedOrigin",
  ]);
  if (!cfg.soundEnabled || !cfg.attachedOrigin) return;
  const watched = cfg.watchedTabId || watchedTabId;
  if (!watched || tabId !== watched) return;
  const url = info.url || tab?.url || "";
  if (url && url.startsWith(cfg.attachedOrigin)) {
    await chrome.storage.local.set({ watchedUrl: url });
  }
  if (info.status !== "complete") return;
  if (!url.startsWith(cfg.attachedOrigin)) return;
  try {
    await injectIntoTab(tabId);
    await chrome.storage.local.set({ attachHint: "" });
    await refreshBadgeFromStorage();
  } catch (_) {}
});

async function getWatchedTabId() {
  if (watchedTabId != null) return watchedTabId;
  const { watchedTabId: stored } = await chrome.storage.local.get("watchedTabId");
  if (stored != null) watchedTabId = stored;
  return watchedTabId;
}

async function isWatchedSender(sender) {
  const id = sender?.tab?.id;
  if (id == null) return false;
  const watched = await getWatchedTabId();
  return watched != null && id === watched;
}

/**
 * Permission déjà accordée depuis le popup (user gesture).
 * Injecte uniquement dans l’onglet activé (pas toute l’origine → autres onglets inertes).
 */
async function attachGranted({ tabId, origin }) {
  if (!tabId || !origin) {
    return { ok: false, error: "Onglet / origine manquants." };
  }
  const pattern = `${origin}/*`;

  // Au cas où une vieille session avait enregistré le script sur toute l’origine
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [CONTENT_SCRIPT_ID],
    });
  } catch (_) {}

  // watchedTabId AVANT inject — sinon MF_IS_WATCHED → false et watchDom jamais démarré
  let watchedUrl = "";
  try {
    const t = await chrome.tabs.get(tabId);
    watchedUrl = t.url || "";
  } catch (_) {}

  await rememberTab(tabId);
  await chrome.storage.local.set({
    attachedOrigin: origin,
    attachedPattern: pattern,
    watchedUrl,
    attachHint: "",
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  // Content déjà présent (ré-Activer sans reload) → forcer veille + lecture apps
  try {
    await chrome.tabs.sendMessage(tabId, { type: "MF_WAKE" });
  } catch (_) {}

  return { ok: true, origin, pattern, tabId, watchedUrl: !!watchedUrl };
}

async function detachContentScript() {
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [CONTENT_SCRIPT_ID],
    });
  } catch (_) {}
  await chrome.storage.local.remove(["attachedOrigin", "attachedPattern"]);
}

async function focusWatchedTab() {
  const id = await ensureWatchedTab({ focus: true });
  if (id != null) return true;
  const { soundEnabled } = await chrome.storage.local.get("soundEnabled");
  if (soundEnabled) {
    await lostWatchedTab("Onglet Overview inaccessible — rattacher.");
  }
  return false;
}

async function notifyWatched(msg) {
  const { watchedTabId: stored } = await chrome.storage.local.get("watchedTabId");
  const id = stored || watchedTabId;
  if (!id) return;
  try {
    await chrome.tabs.sendMessage(id, msg);
  } catch (_) {
    await lostWatchedTab("Content script perdu — rattacher.");
  }
}

function alertHeightFor(keys) {
  const n = (keys || []).length;
  const h = 200 + Math.max(n, 3) * 28;
  return Math.min(ALERT_WIN.maxHeight, Math.max(ALERT_WIN.minHeight, h));
}

/** Remonte la popup au premier plan (Firefox n’a pas alwaysOnTop). */
async function focusAlert(force = false) {
  if (alertWindowId == null) return;
  const now = Date.now();
  if (!force && now - lastFocusAt < 400) return;
  lastFocusAt = now;
  try {
    await chrome.windows.update(alertWindowId, { focused: true });
  } catch (_) {
    alertWindowId = null;
    pinnedPlace = null;
  }
}

/**
 * Ancre multi-écran = fenêtre qui porte l’onglet Overview surveillé.
 * (Pas la fenêtre « focused » : souvent un autre moniteur / autre app.)
 */
async function getAnchorWindow() {
  try {
    const { watchedTabId: stored } = await chrome.storage.local.get("watchedTabId");
    const id = stored || watchedTabId;
    if (id) {
      try {
        const tab = await chrome.tabs.get(id);
        if (tab?.windowId != null) {
          const w = await chrome.windows.get(tab.windowId);
          if (w && w.id !== alertWindowId) return w;
        }
      } catch (_) {}
    }
    const all = await chrome.windows.getAll({ populate: false });
    const normals = (all || []).filter(
      (w) => w.type === "normal" && w.id !== alertWindowId
    );
    const focused = normals.find((w) => w.focused);
    if (focused) return focused;
    try {
      const last = await chrome.windows.getLastFocused({ populate: false });
      if (last && last.type === "normal" && last.id !== alertWindowId) return last;
    } catch (_) {}
    return normals[0] || null;
  } catch (_) {
    return null;
  }
}

/** Centre la popup sur l’ancre (gère left négatif = écran à gauche). */
async function computePlace(width, height) {
  let left = 100;
  let top = 80;
  const anchor = await getAnchorWindow();
  if (anchor && typeof anchor.left === "number" && typeof anchor.width === "number") {
    left = Math.round(anchor.left + (anchor.width - width) / 2);
    top = Math.round(
      (anchor.top || 0) + Math.max(60, ((anchor.height || 900) - height) / 4)
    );
  }
  return { left, top, width, height };
}

/** Firefox ignore parfois left/top au create → forcer via update. */
async function applyPlace(windowId, place) {
  if (windowId == null || !place) return;
  await chrome.windows.update(windowId, {
    focused: true,
    left: place.left,
    top: place.top,
    width: place.width,
    height: place.height,
  });
}

async function findAlertWindows() {
  const url = chrome.runtime.getURL("alert.html");
  const out = [];
  try {
    const all = await chrome.windows.getAll({ populate: true });
    for (const w of all || []) {
      if (w.type !== "popup") continue;
      const hit = (w.tabs || []).some(
        (t) => t.url === url || (t.pendingUrl && t.pendingUrl === url)
      );
      if (hit) out.push(w);
    }
  } catch (_) {}
  return out;
}

async function refreshAlertTabs(keys) {
  if (alertWindowId == null) return;
  try {
    const height = alertHeightFor(keys);
    pinnedPlace = await computePlace(ALERT_WIN.width, height);
    await applyPlace(alertWindowId, pinnedPlace);
    lastFocusAt = Date.now();
  } catch (_) {
    await focusAlert(true);
  }
  try {
    const tabs = await chrome.tabs.query({ windowId: alertWindowId });
    for (const t of tabs) {
      chrome.tabs
        .sendMessage(t.id, { type: "MF_ALERT_REFRESH" })
        .catch(() => {});
    }
  } catch (_) {}
}

/** Une seule popup à la fois — file d’attente anti-race. */
function showAlertUi(payload) {
  alertUiQueue = alertUiQueue
    .then(() => showAlertUiExclusive(payload))
    .catch(() => {});
  return alertUiQueue;
}

async function showAlertUiExclusive(payload) {
  const { soundEnabled } = await chrome.storage.local.get("soundEnabled");
  if (!soundEnabled) return;
  const keys = payload.keys || [];
  if (await isSnoozed()) return;
  if (await isWaveMuted(keys)) return;

  // Fantôme en fond seulement — focus = clic Ouvrir MF / Ack / notif
  await ensureWatchedTab({ focus: false });

  const keySig = keys.slice().sort().join("|");
  const sameWave = keySig && keySig === lastNotifiedKey;

  await chrome.storage.local.set({
    lastAlarm: {
      keys,
      at: Date.now(),
    },
  });

  // Récupérer une popup déjà ouverte (y compris orphelines d’une race).
  const existing = await findAlertWindows();
  if (existing.length) {
    alertWindowId = existing[0].id;
    for (const w of existing.slice(1)) {
      chrome.windows.remove(w.id).catch(() => {});
    }
  } else if (alertWindowId != null) {
    try {
      await chrome.windows.get(alertWindowId);
    } catch (_) {
      alertWindowId = null;
    }
  }

  if (alertWindowId != null) {
    lastNotifiedKey = keySig;
    await refreshAlertTabs(keys);
    return;
  }

  if (alertCreating) return;

  lastNotifiedKey = keySig;
  const height = alertHeightFor(keys);
  pinnedPlace = await computePlace(ALERT_WIN.width, height);

  if (!sameWave) {
    try {
      const apps = [];
      for (const k of keys) {
        const m = String(k).match(/^\[([^\]|]+)/);
        if (m && !apps.includes(m[1])) apps.push(m[1]);
      }
      const head = apps.length
        ? apps.slice(0, 4).join(", ") + (apps.length > 4 ? ` (+${apps.length - 4})` : "")
        : keys.slice(0, 3).join(", ") || "Alarme";
      await chrome.notifications.create("mf-alarm", {
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "MF — alarme",
        message: `${keys.length} · ${head}`,
        priority: 2,
        requireInteraction: true,
      });
    } catch (_) {}
  }

  alertCreating = true;
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("alert.html"),
      type: "popup",
      focused: true,
      left: pinnedPlace.left,
      top: pinnedPlace.top,
      width: pinnedPlace.width,
      height: pinnedPlace.height,
    });
    alertWindowId = win.id;
    try {
      await applyPlace(win.id, pinnedPlace);
      lastFocusAt = Date.now();
    } catch (_) {}
    // Fermer d’éventuels doublons créés en parallèle ailleurs
    const again = await findAlertWindows();
    for (const w of again) {
      if (w.id !== alertWindowId) chrome.windows.remove(w.id).catch(() => {});
    }
  } catch (_) {
    alertWindowId = null;
  } finally {
    alertCreating = false;
  }
}

async function mergeAckedKeys(alarmKeys) {
  const { ackedKeys: prev } = await chrome.storage.local.get("ackedKeys");
  const merged = [
    ...new Set([...(Array.isArray(prev) ? prev : []), ...(alarmKeys || [])]),
  ];
  await chrome.storage.local.set({ ackedKeys: merged });
  return merged;
}

async function applyAck({ keys }) {
  const { lastAlarm } = await chrome.storage.local.get("lastAlarm");
  const alarmKeys = keys || lastAlarm?.keys || [];
  const ackedKeys = await mergeAckedKeys(alarmKeys);
  const sig = alarmKeys.slice().sort().join("|");
  await chrome.storage.local.set({
    mutedWaveSig: sig || "",
    snoozeUntil: 0,
    snoozedWaveSig: "",
    ackedKeys,
  });
  lastNotifiedKey = "";
  pinnedPlace = null;
  chrome.notifications.clear("mf-alarm");
  if (alertWindowId != null) {
    chrome.windows.remove(alertWindowId).catch(() => {});
    alertWindowId = null;
  }
  await notifyWatched({ type: "MF_STOP_SOUND" });
  await notifyWatched({
    type: "MF_WAVE_MUTE",
    mutedWaveSig: sig || "",
    ackedKeys,
  });
  await refreshBadgeFromStorage();
  return { ok: true, mode: "wave", mutedWaveSig: sig || "", ackedKeys };
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === alertWindowId) {
    alertWindowId = null;
    pinnedPlace = null;
    lastNotifiedKey = "";
  }
});

// Si le navigateur reprend le focus pendant une alarme → popup devant
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (alertWindowId == null) return;
  if (windowId === alertWindowId) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  focusAlert();
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== "mf-alarm") return;
  await applyAck({});
  await focusWatchedTab();
  chrome.notifications.clear("mf-alarm");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "MF_ALERT_REPOSITION") {
    sendResponse({ ok: true, ignored: true });
    return false;
  }

  if (msg?.type === "MF_FOCUS_WATCHED") {
    focusWatchedTab().then((ok) => sendResponse({ ok }));
    return true;
  }

  if (msg?.type === "MF_ATTACH_GRANTED") {
    attachGranted(msg).then((r) => sendResponse(r));
    return true;
  }

  if (msg?.type === "MF_IS_WATCHED") {
    isWatchedSender(sender).then((watched) =>
      sendResponse({ watched, tabId: sender?.tab?.id ?? null })
    );
    return true;
  }

  /** Filtre / URL de l’onglet de veille → snapshot pour recréation fantôme. */
  if (msg?.type === "MF_PAGE_SYNC") {
    isWatchedSender(sender).then(async (watched) => {
      if (!watched) {
        sendResponse({ ok: false });
        return;
      }
      const patch = {};
      if (Array.isArray(msg.apps)) patch.watchedApps = msg.apps;
      if (typeof msg.url === "string" && /^https?:\/\//i.test(msg.url)) {
        const { attachedOrigin } = await chrome.storage.local.get(
          "attachedOrigin"
        );
        if (!attachedOrigin || msg.url.startsWith(attachedOrigin)) {
          patch.watchedUrl = msg.url;
        }
      }
      if (Object.keys(patch).length) {
        await chrome.storage.local.set(patch);
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "MF_DETACH") {
    detachContentScript().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg?.type === "MF_ALARM_STATE") {
    // Uniquement l’onglet sur lequel la veille a été activée
    isWatchedSender(sender).then((watched) => {
      if (!watched) {
        sendResponse({ ok: false, ignored: true });
        return;
      }
      if (msg.active) {
        showAlertUi(msg).then(() => sendResponse({ ok: true }));
        return;
      }
      lastNotifiedKey = "";
      pinnedPlace = null;
      chrome.notifications.clear("mf-alarm");
      if (alertWindowId != null) {
        chrome.windows.remove(alertWindowId).catch(() => {});
        alertWindowId = null;
      }
      chrome.storage.local.set({ mutedWaveSig: "" });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "MF_RESET_WATCH") {
    (async () => {
      const id = await getWatchedTabId();
      // Notifier l’onglet AVANT de couper watchedTabId (sinon message ignoré / badge page zombie)
      if (id != null) {
        try {
          await chrome.tabs.sendMessage(id, { type: "MF_HARD_RESET" });
        } catch (_) {}
      }
      watchedTabId = null;
      lastNotifiedKey = "";
      pinnedPlace = null;
      chrome.notifications.clear("mf-alarm");
      if (alertWindowId != null) {
        chrome.windows.remove(alertWindowId).catch(() => {});
        alertWindowId = null;
      }
      await detachContentScript();
      await chrome.storage.local.set({
        soundEnabled: false,
        watchedTabId: null,
        watchedUrl: "",
        attachedOrigin: "",
        attachedPattern: "",
        watchedApps: [],
        attachHint: "",
        snoozeUntil: 0,
        snoozedWaveSig: "",
        mutedWaveSig: "",
        ackedKeys: [],
        lastAlarm: null,
      });
      await refreshBadgeFromStorage();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "MF_CLEAR_SNOOZE") {
    chrome.storage.local.set({
      snoozeUntil: 0,
      snoozedWaveSig: "",
      mutedWaveSig: "",
      ackedKeys: [],
      attachHint: "",
    });
    lastNotifiedKey = "";
    notifyWatched({
      type: "MF_SNOOZE",
      snoozeUntil: 0,
      snoozedWaveSig: "",
      ackedKeys: [],
    });
    notifyWatched({ type: "MF_WAVE_MUTE", mutedWaveSig: "", ackedKeys: [] });
    refreshBadgeFromStorage();
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === "MF_ACK_SNOOZE" || msg?.type === "MF_ACK") {
    applyAck(msg).then((r) => sendResponse(r));
    return true;
  }

  if (msg?.type === "MF_ALARM") {
    sendResponse({ ok: true });
  }
  return false;
});
