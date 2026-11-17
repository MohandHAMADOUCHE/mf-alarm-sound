const $ = (id) => document.getElementById(id);

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
  attachedOrigin: "",
  attachHint: "",
  watchedApps: [],
};

/** Rempli au open du popup (avant le clic → request synchrone au geste). */
let activeTabId = null;
let activeOrigin = "";

function originFromTab(tab) {
  if (!tab?.url) return "";
  try {
    const u = new URL(tab.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin;
  } catch (_) {
    return "";
  }
}

function showTab(name) {
  const veille = name === "veille";
  $("tabVeille").classList.toggle("active", veille);
  $("tabReglages").classList.toggle("active", !veille);
  $("tabVeille").setAttribute("aria-selected", veille ? "true" : "false");
  $("tabReglages").setAttribute("aria-selected", veille ? "false" : "true");
  $("panelVeille").classList.toggle("active", veille);
  $("panelReglages").classList.toggle("active", !veille);
  $("panelVeille").hidden = !veille;
  $("panelReglages").hidden = veille;
}

async function load() {
  const cfg = {
    ...DEFAULTS,
    ...(await chrome.storage.local.get([
      ...Object.keys(DEFAULTS),
      "includeWarn", // legacy
      "watchedTabId",
    ])),
  };
  $("interval").value = String(cfg.intervalMs);
  $("sound").value = cfg.soundPreset;
  $("volume").value = String(cfg.volume);
  $("volLabel").textContent = String(cfg.volume);
  // migration includeWarn → alertWarnRecent
  const warnRecent =
    cfg.alertWarnRecent != null
      ? !!cfg.alertWarnRecent
      : cfg.includeWarn != null
        ? !!cfg.includeWarn
        : true;
  $("spotError").checked = cfg.alertErrorRecent !== false;
  $("spotExpired").checked = cfg.alertExpiredRecent !== false;
  $("spotWarn").checked = warnRecent;
  const linked = !!cfg.attachedOrigin || !!cfg.watchedTabId;
  paintStatus(
    !!cfg.soundEnabled,
    cfg.snoozeUntil || 0,
    cfg.mutedWaveSig || "",
    cfg.attachHint || "",
    linked
  );

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  activeTabId = tab?.id ?? null;
  activeOrigin = originFromTab(tab);
  const onWatchedTab =
    cfg.watchedTabId != null && activeTabId === cfg.watchedTabId;
  // Jamais d’URL / host dans l’UI (storage peut encore contenir attachedOrigin).
  paintScope({
    linked: !!cfg.soundEnabled && (!!cfg.attachedOrigin || !!cfg.watchedTabId),
    onWatchedTab,
    canAttach: !!activeOrigin,
    hint: cfg.attachHint || "",
  });
  paintApps(cfg.watchedApps || []);
  return cfg;
}

function paintApps(apps) {
  const list = Array.isArray(apps) ? apps.filter(Boolean) : [];
  const box = $("apps");
  box.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "Aucune application lue sur le filtre Overview.";
    box.appendChild(empty);
    return;
  }
  const title = document.createElement("strong");
  title.textContent = `Applications suivies (${list.length})`;
  const ul = document.createElement("ul");
  for (const a of list) {
    const li = document.createElement("li");
    li.textContent = a;
    ul.appendChild(li);
  }
  box.appendChild(title);
  box.appendChild(ul);
}

function paintScope({ linked, onWatchedTab, canAttach, hint }) {
  const text = $("scopeText");
  const go = $("gotoWatch");
  const showGo = !!(linked && !onWatchedTab && !hint);
  go.style.display = showGo ? "inline-block" : "none";
  if (hint) {
    text.textContent = hint;
    return;
  }
  if (linked) {
    text.textContent = onWatchedTab
      ? "Veille active sur cet onglet."
      : "Veille active sur un autre onglet.";
  } else if (canAttach) {
    text.textContent = "Prêt — active la veille sur cet onglet.";
  } else {
    text.textContent =
      "Place Overview au premier plan, puis active la veille.";
  }
}

function paintStatus(on, snoozeUntil, mutedWaveSig, attachHint, linked) {
  const waveMuted = !!(on && mutedWaveSig);
  $("unsnooze").style.display = waveMuted || attachHint ? "block" : "none";
  $("reset").style.display =
    on || linked || attachHint || waveMuted ? "block" : "none";
  if (attachHint) {
    $("status").textContent = "À rattacher";
    $("status").className = "hint";
  } else if (waveMuted) {
    $("status").textContent = "Ack — alarmes courantes en sourdine";
    $("status").className = "snooze";
  } else {
    $("status").textContent = on ? "Veille active" : "Veille inactive";
    $("status").className = on ? "on" : "off";
  }
  $("toggle").textContent = on ? "Désactiver" : "Activer";
}

async function notifyPage(msg) {
  const { watchedTabId } = await chrome.storage.local.get("watchedTabId");
  if (watchedTabId) {
    chrome.tabs.sendMessage(watchedTabId, msg).catch(() => {});
    return;
  }
  if (activeTabId != null) {
    chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
  }
}

async function savePartial(partial) {
  await chrome.storage.local.set(partial);
  await notifyPage({ type: "MF_SETTINGS", settings: partial });
}

function finishAttach(tabId, origin) {
  chrome.runtime.sendMessage(
    { type: "MF_ATTACH_GRANTED", tabId, origin },
    async (r) => {
      if (chrome.runtime.lastError || !r?.ok) {
        $("scopeText").textContent =
          r?.error || chrome.runtime.lastError?.message || "Attach échoué.";
        $("gotoWatch").style.display = "none";
        return;
      }
      await chrome.storage.local.set({ attachHint: "" });
      paintScope({ linked: true, onWatchedTab: true, canAttach: true, hint: "" });
      await savePartial({ soundEnabled: true });
      let apps = [];
      try {
        const r = await chrome.tabs.sendMessage(tabId, {
          type: "MF_REFRESH_APPS",
        });
        if (Array.isArray(r?.apps)) apps = r.apps;
      } catch (_) {}
      if (!apps.length) {
        const st = await chrome.storage.local.get("watchedApps");
        apps = st.watchedApps || [];
      }
      paintApps(apps);
      const cfg = await chrome.storage.local.get([
        "snoozeUntil",
        "mutedWaveSig",
      ]);
      paintStatus(true, cfg.snoozeUntil || 0, cfg.mutedWaveSig || "", "", true);
      chrome.action.setBadgeText({ text: "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    }
  );
}

function enableVeille() {
  if (!activeTabId || !activeOrigin) {
    $("scopeText").textContent =
      "Place Overview au premier plan, rouvre ce popup, puis réessaie.";
    $("gotoWatch").style.display = "none";
    return;
  }
  const tabId = activeTabId;
  const origin = activeOrigin;
  // request() tout de suite dans le clic (déjà accordé → true sans dialogue).
  // Motif = optional_host_permissions du manifest (Firefox).
  chrome.permissions.request({ origins: ["*://*/*"] }, () => {
    // Accordé ou non : tenter l’inject (activeTab peut suffire si refus).
    finishAttach(tabId, origin);
  });
}

async function disableVeille() {
  // Couper + oublier Ack / pause (réactivation = repartir à zéro)
  await chrome.storage.local.set({
    soundEnabled: false,
    watchedApps: [],
    snoozeUntil: 0,
    snoozedWaveSig: "",
    mutedWaveSig: "",
    ackedKeys: [],
    lastAlarm: null,
  });
  await notifyPage({
    type: "MF_SNOOZE",
    snoozeUntil: 0,
    snoozedWaveSig: "",
    ackedKeys: [],
  });
  await notifyPage({ type: "MF_WAVE_MUTE", mutedWaveSig: "", ackedKeys: [] });
  await notifyPage({ type: "MF_STOP_SOUND" });
  await notifyPage({ type: "MF_SETTINGS", settings: { soundEnabled: false } });
  const cfg = await chrome.storage.local.get([
    "attachHint",
    "attachedOrigin",
    "watchedTabId",
  ]);
  paintStatus(
    false,
    0,
    "",
    cfg.attachHint || "",
    !!cfg.attachedOrigin || !!cfg.watchedTabId
  );
  paintApps([]);
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#78909c" });
}

$("tabVeille").onclick = () => showTab("veille");
$("tabReglages").onclick = () => showTab("reglages");

$("toggle").onclick = () => {
  // Sync au clic : pas d’await (sinon permissions.request → refus silencieux Firefox).
  // Libellé du bouton = source de vérité affichée (aligné paintStatus / soundEnabled).
  if ($("toggle").textContent === "Désactiver") disableVeille();
  else enableVeille();
};

$("gotoWatch").onclick = () => {
  chrome.runtime.sendMessage({ type: "MF_FOCUS_WATCHED" }, () => {
    window.close();
  });
};

$("unsnooze").onclick = async () => {
  await chrome.storage.local.set({
    snoozeUntil: 0,
    snoozedWaveSig: "",
    mutedWaveSig: "",
    ackedKeys: [],
    attachHint: "",
  });
  chrome.runtime.sendMessage({ type: "MF_CLEAR_SNOOZE" }).catch(() => {});
  await notifyPage({
    type: "MF_SNOOZE",
    snoozeUntil: 0,
    snoozedWaveSig: "",
    ackedKeys: [],
  });
  await notifyPage({ type: "MF_WAVE_MUTE", mutedWaveSig: "", ackedKeys: [] });
  const st = await chrome.storage.local.get([
    "soundEnabled",
    "attachedOrigin",
    "watchedTabId",
    "watchedApps",
  ]);
  paintStatus(
    !!st.soundEnabled,
    0,
    "",
    "",
    !!st.attachedOrigin || !!st.watchedTabId
  );
  const onWatchedTab =
    st.watchedTabId != null && activeTabId === st.watchedTabId;
  paintScope({
    linked: !!st.soundEnabled && (!!st.attachedOrigin || !!st.watchedTabId),
    onWatchedTab,
    canAttach: !!activeOrigin,
    hint: "",
  });
  paintApps(st.watchedApps || []);
};

$("reset").onclick = async () => {
  const r = await chrome.runtime
    .sendMessage({ type: "MF_RESET_WATCH" })
    .catch(() => null);
  if (!r?.ok) {
    // filet si le background n’a pas répondu
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
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs[0]?.id ?? null;
  activeOrigin = originFromTab(tabs[0]);
  paintStatus(false, 0, "", "", false);
  paintScope({
    linked: false,
    onWatchedTab: false,
    canAttach: !!activeOrigin,
    hint: "",
  });
  paintApps([]);
  $("toggle").textContent = "Activer";
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#78909c" });
};

$("interval").onchange = () =>
  savePartial({ intervalMs: Number($("interval").value) });
$("sound").onchange = () => savePartial({ soundPreset: $("sound").value });
$("volume").oninput = () => {
  $("volLabel").textContent = $("volume").value;
};
$("volume").onchange = () =>
  savePartial({ volume: Number($("volume").value) });
$("spotError").onchange = () =>
  savePartial({ alertErrorRecent: $("spotError").checked });
$("spotExpired").onchange = () =>
  savePartial({ alertExpiredRecent: $("spotExpired").checked });
$("spotWarn").onchange = () =>
  savePartial({ alertWarnRecent: $("spotWarn").checked });

$("test").onclick = async () => {
  await notifyPage({ type: "MF_TEST_SOUND" });
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.watchedApps) return;
  paintApps(changes.watchedApps.newValue || []);
});

load();
