/**
 * Détection DOM uniquement (pastilles Overview).
 * Injecté seulement dans l’onglet de veille (pas les autres onglets du même site).
 */
(() => {
  if (window.__mfAlarmContent) return;
  window.__mfAlarmContent = true;

  const SAMPLE_FILES = {
    bateau: "sounds/boat-horn.wav",
    bateauLoin: "sounds/boat-horn-far.wav",
    airhorn: "sounds/air-horn.wav",
    train: "sounds/train-horn.wav",
    police: "sounds/police-siren.wav",
    pompier: "sounds/fire-siren.wav",
    wav: "sounds/alarm.wav",
  };
  const samplePlayers = {};

  let soundEnabled = false;
  let intervalMs = 30000;
  let soundPreset = "police";
  let volume = 10;
  /** Pastilles « < 10 min » (classe spot-recent). */
  let alertErrorRecent = true;
  let alertExpiredRecent = true;
  let alertWarnRecent = true;
  let snoozeUntil = 0;
  let mutedWaveSig = "";
  let snoozedWaveSig = "";
  /** Clés déjà Ack : exclues de la popup / du son tant qu’elles restent visibles. */
  let ackedKeys = [];

  let alarmActive = false;
  /** true = son déjà armé pour la vague en cours (évite bip à chaque poll). */
  let soundArmed = false;
  let lastBeep = 0;
  let timer = null;
  let lastHitKeys = [];
  let moTimer = null;

  function waveSig(keys) {
    return (keys || []).slice().sort().join("|");
  }

  /** Pause durée : badge / anti-rebip du set ack ; les nouvelles passent via ackedKeys. */
  function isSnoozed(keys) {
    if (!snoozeUntil || Date.now() >= snoozeUntil) {
      if (snoozeUntil || snoozedWaveSig) {
        const expired = !!(snoozeUntil && Date.now() >= snoozeUntil);
        snoozeUntil = 0;
        snoozedWaveSig = "";
        chrome.storage.local.set({ snoozeUntil: 0, snoozedWaveSig: "" });
        // Fin de pause durée → les anciennes peuvent réalerter
        if (expired) clearAckedKeys();
      }
      return false;
    }
    const sig = waveSig(keys != null ? keys : lastHitKeys);
    // Nouvelle vague pendant la pause : on garde ackedKeys (popup = nouvelles seules)
    if (snoozedWaveSig && sig && sig !== snoozedWaveSig) {
      snoozeUntil = 0;
      snoozedWaveSig = "";
      chrome.storage.local.set({ snoozeUntil: 0, snoozedWaveSig: "" });
      return false;
    }
    return true;
  }

  function isWaveMuted(keys) {
    if (!mutedWaveSig) return false;
    const sig = waveSig(keys);
    if (sig !== mutedWaveSig) {
      mutedWaveSig = "";
      chrome.storage.local.set({ mutedWaveSig: "" });
      return false;
    }
    return true;
  }

  /** Retire les clés Ack ; purge celles qui ont disparu du DOM. */
  function filterNewAlarms(raw) {
    const list = raw || [];
    const present = new Set(list);
    const kept = (ackedKeys || []).filter((k) => present.has(k));
    if (
      kept.length !== ackedKeys.length ||
      kept.some((k, i) => k !== ackedKeys[i])
    ) {
      ackedKeys = kept;
      chrome.storage.local.set({ ackedKeys: kept }).catch(() => {});
    }
    if (!kept.length) return list;
    const acked = new Set(kept);
    return list.filter((k) => !acked.has(k));
  }

  function clearAckedKeys() {
    if (!ackedKeys.length) return;
    ackedKeys = [];
    chrome.storage.local.set({ ackedKeys: [] }).catch(() => {});
  }

  function loadSettings() {
    chrome.storage.local.get(
      [
        "soundEnabled",
        "intervalMs",
        "soundPreset",
        "volume",
        "alertErrorRecent",
        "alertExpiredRecent",
        "alertWarnRecent",
        "includeWarn",
        "snoozeUntil",
        "mutedWaveSig",
        "snoozedWaveSig",
        "ackedKeys",
      ],
      (cfg) => {
        soundEnabled = !!cfg.soundEnabled;
        intervalMs = Number(cfg.intervalMs) || 30000;
        soundPreset = cfg.soundPreset || "police";
        volume = cfg.volume != null ? Number(cfg.volume) : 10;
        alertErrorRecent = cfg.alertErrorRecent !== false;
        alertExpiredRecent = cfg.alertExpiredRecent !== false;
        alertWarnRecent =
          cfg.alertWarnRecent != null
            ? !!cfg.alertWarnRecent
            : cfg.includeWarn != null
              ? !!cfg.includeWarn
              : true;
        snoozeUntil = Number(cfg.snoozeUntil) || 0;
        mutedWaveSig = cfg.mutedWaveSig || "";
        snoozedWaveSig = cfg.snoozedWaveSig || "";
        ackedKeys = Array.isArray(cfg.ackedKeys) ? cfg.ackedKeys : [];
        paintBadge();
        syncSound();
        recompute();
      }
    );
  }

  function playTone(freqs, gap, dur, type = "square") {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const vol = Math.max(0.01, Math.min(1, volume / 100)) * 0.35;
    freqs.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      const t0 = now + i * gap;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    });
    setTimeout(() => ctx.close(), freqs.length * gap * 1000 + 800);
  }

  function playSample(preset) {
    const file = SAMPLE_FILES[preset];
    if (!file) return Promise.reject(new Error("no sample"));
    if (!samplePlayers[preset]) {
      samplePlayers[preset] = new Audio(chrome.runtime.getURL(file));
    }
    const a = samplePlayers[preset];
    a.volume = Math.max(0.01, Math.min(1, volume / 100));
    a.currentTime = 0;
    return a.play();
  }

  /** Coupe wav + timer bip (Ack / mute). */
  function stopSound() {
    stopTimer();
    soundArmed = false;
    for (const a of Object.values(samplePlayers)) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch (_) {}
    }
  }

  function playBeep(force) {
    if (!force && (isSnoozed(lastHitKeys) || isWaveMuted(lastHitKeys))) return;
    if (!soundEnabled && !force) return;
    // respecte l’intervalle (évite les bips à chaque recompute)
    if (!force && lastBeep && Date.now() - lastBeep < intervalMs - 200) return;
    try {
      if (SAMPLE_FILES[soundPreset]) {
        playSample(soundPreset).catch(() =>
          playTone([880, 1175, 880], 0.35, 0.28)
        );
      } else if (soundPreset === "beep") {
        playTone([990], 0.2, 0.2);
      } else if (soundPreset === "double") {
        playTone([880, 880], 0.25, 0.15);
      } else if (soundPreset === "low") {
        playTone([220, 180], 0.4, 0.35, "sawtooth");
      } else {
        playTone([880, 1175, 880], 0.35, 0.28); // siren
      }
      lastBeep = Date.now();
    } catch (_) {}
  }

  function paintBadge() {
    let el = document.getElementById("mf-alarm-sound-badge");
    if (!el) {
      el = document.createElement("div");
      el.id = "mf-alarm-sound-badge";
      Object.assign(el.style, {
        position: "fixed",
        bottom: "12px",
        right: "12px",
        zIndex: "2147483647",
        padding: "10px 14px",
        borderRadius: "8px",
        font: "13px/1.3 system-ui,sans-serif",
        color: "#fff",
        cursor: "pointer",
        boxShadow: "0 2px 10px rgba(0,0,0,.4)",
        maxWidth: "340px",
      });
      el.title = "Clic = ON/OFF — options via icône extension";
      el.onclick = () => {
        soundEnabled = !soundEnabled;
        chrome.storage.local.set({ soundEnabled });
        if (!soundEnabled) soundArmed = false;
        syncSound();
        paintBadge();
      };
      const mount = () =>
        (document.documentElement || document.body).appendChild(el);
      if (document.documentElement) mount();
      else document.addEventListener("DOMContentLoaded", mount, { once: true });
    }
    el.style.color = "#fff";
    if (!soundEnabled) {
      el.textContent = "OFF";
      el.style.background = "#78909c"; // gris
    } else if (mutedWaveSig && isWaveMuted(lastHitKeys)) {
      el.textContent = "Ack";
      el.style.background = "#fb8c00";
      el.style.color = "#111";
    } else if (alarmActive) {
      const apps = [];
      for (const k of lastHitKeys) {
        const m = String(k).match(/^\[([^\]|]+)/);
        if (m && !apps.includes(m[1])) apps.push(m[1]);
      }
      const head = apps.length
        ? apps.slice(0, 2).join(", ") +
          (apps.length > 2 ? ` +${apps.length - 2}` : "")
        : String(lastHitKeys[0] || "alarme").slice(0, 40);
      el.textContent = `Alarme — ${head} · ${Math.round(intervalMs / 1000)}s`;
      el.style.background = "#c62828"; // rouge = alarme seulement
    } else {
      el.textContent = "ON — OK";
      el.style.background = "#2e7d32"; // vert = armé OK
    }
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function restartTimer() {
    stopTimer();
    if (
      !soundEnabled ||
      !alarmActive ||
      isSnoozed(lastHitKeys) ||
      isWaveMuted(lastHitKeys)
    ) {
      return;
    }
    timer = setInterval(() => {
      if (
        soundEnabled &&
        alarmActive &&
        !isSnoozed(lastHitKeys) &&
        !isWaveMuted(lastHitKeys)
      ) {
        playBeep();
      } else {
        stopTimer();
        soundArmed = false;
      }
    }, intervalMs);
  }

  /** Bip immédiat dès qu’on passe « doit sonner », puis intervalle. */
  function syncSound() {
    const should =
      soundEnabled &&
      alarmActive &&
      !isSnoozed(lastHitKeys) &&
      !isWaveMuted(lastHitKeys);
    if (!should) {
      stopTimer();
      soundArmed = false;
      return;
    }
    if (!soundArmed) {
      playBeep(true);
      restartTimer();
      soundArmed = true;
    } else if (!timer) {
      restartTimer();
    }
  }

  let lastSentSig = "";
  let sendTimer = null;
  let lastSentAt = 0;

  function setAlarmActive(active, keys) {
    const nextKeys = keys || [];
    const prevSig = waveSig(lastHitKeys);
    const nextSig = waveSig(nextKeys);
    // Nouvelle clé pendant pause/mute → réarmer le son
    if (active && nextSig && nextSig !== prevSig) {
      soundArmed = false;
    }
    alarmActive = !!active;
    lastHitKeys = nextKeys;
    // Lève snooze/mute vague si le set a changé (avant syncSound)
    isSnoozed(lastHitKeys);
    isWaveMuted(lastHitKeys);
    paintBadge();
    const sig =
      (alarmActive ? "1:" : "0:") + lastHitKeys.slice().sort().join("|");
    const send = () => {
      sendTimer = null;
      lastSentSig = sig;
      lastSentAt = Date.now();
      chrome.runtime
        .sendMessage({
          type: "MF_ALARM_STATE",
          active: alarmActive,
          keys: lastHitKeys,
        })
        .catch(() => {});
    };
    // Coalesce MutationObserver ; heartbeat 1.5s → rouvre popup fermée sans Ack
    if (sig !== lastSentSig) {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(send, 120);
    } else if (alarmActive && Date.now() - lastSentAt > 1500) {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(send, 120);
    }
    if (!alarmActive) soundArmed = false;
    syncSound();
  }

  /** Index colonne par libellé thead (Application, Environnement, Item…). */
  function columnIndex(wanted) {
    const ths = document.querySelectorAll(
      'table[data-tour="table"] thead th, thead[data-tour="table-header"] th'
    );
    let i = 0;
    const re = new RegExp("^" + wanted + "$", "i");
    for (const th of ths) {
      const label = th.querySelector('[class*="th-label"]');
      const text = ((label || th).textContent || "").replace(/\s+/g, " ").trim();
      if (re.test(text)) return i;
      i++;
    }
    return -1;
  }

  function cellText(row, idx) {
    if (!row || idx < 0 || idx >= row.children.length) return "";
    return (row.children[idx].textContent || "").replace(/\s+/g, " ").trim();
  }

  /** Envs MF Overview (canoniques). */
  const MF_ENVS = ["NA", "BENCH", "DEV", "PREPROD", "PROD", "QUALIF", "REC"];

  function matchKnownEnv(text) {
    const u = String(text || "").toUpperCase();
    for (const e of MF_ENVS) {
      if (u === e || new RegExp(`(?:^|[^A-Z0-9])${e}(?:[^A-Z0-9]|$)`).test(u)) {
        return e;
      }
    }
    return "";
  }

  /** Environnement colonne, sinon heuristique sur le nom d’item. "" si inconnu. */
  function resolveEnv(item, envCell) {
    const cell = (envCell || "").trim();
    const fromCell = matchKnownEnv(cell);
    if (fromCell) return fromCell;
    if (cell && !/[,…]|\.{3}/.test(cell) && cell.split(/\s+/).length <= 2) {
      const t = cell.toUpperCase();
      if (MF_ENVS.includes(t)) return t;
    }
    const s = String(item || "").toLowerCase();
    if (/preprod|hors-prod|_integ_|-integ-|\binteg\b/.test(s)) return "PREPROD";
    if (/\bqualif\b|_qualif_|-qualif-/.test(s)) return "QUALIF";
    if (/\bbench\b|_bench_|-bench-/.test(s)) return "BENCH";
    if (/\bdev\b|_dev_|-dev-/.test(s)) return "DEV";
    if (/\brec\b|_rec_|-rec-/.test(s)) return "REC";
    if (/\bprod\b|_prod_|-prod-/.test(s)) return "PROD";
    if (/(?:^|[^a-z0-9])na(?:[^a-z0-9]|$)|_na_|-na-/.test(s)) return "NA";
    const fromItem = matchKnownEnv(item);
    if (fromItem) return fromItem;
    return "";
  }

  /** Clé affichage : [APP|ENV] ou [APP] si env inconnu. */
  function alarmKey(app, env, detail) {
    const a = (app || "").trim() || "app";
    const e = (env || "").trim();
    return e ? `[${a}|${e}] ${detail}` : `[${a}] ${detail}`;
  }

  /** Légende popover Overview (ex. cpu) — ne pas alerter dessus. */
  function isLegendSpot(el) {
    return !!el.closest(
      '.popover-body, [class*="popover"], [role="tooltip"], [class*="legend"]'
    );
  }

  /**
   * Kind pastille « nouvelle » (< 10 min) : error | expired | warn.
   * Ignore acked / sans spot-recent.
   */
  function recentSpotKind(el) {
    const c = el.className || "";
    if (/spot-acked/i.test(c)) return "";
    if (!/spot-recent/i.test(c)) return "";
    if (/spot-error/i.test(c)) return "error";
    if (/spot-expired/i.test(c)) return "expired";
    if (/spot-warn/i.test(c)) return "warn";
    return "";
  }

  function kindWanted(kind) {
    if (kind === "error") return alertErrorRecent;
    if (kind === "expired") return alertExpiredRecent;
    if (kind === "warn") return alertWarnRecent;
    return false;
  }

  function kindLabel(kind) {
    if (kind === "expired") return " (expiré)";
    if (kind === "warn") return " (warn)";
    return "";
  }

  /** Vue items (non groupée ou groupe déplié) : pastilles recent nommées. */
  function collectAlarmsFromItemRows() {
    const out = [];
    const appIdx = columnIndex("Application");
    const envIdx = columnIndex("Environnement");
    const itemIdx = columnIndex("Item");
    document.querySelectorAll('[class*="spot-recent"]').forEach((el) => {
      if (isLegendSpot(el)) return;
      if (el.offsetParent === null && el.getClientRects().length === 0) return;
      const kind = recentSpotKind(el);
      if (!kindWanted(kind)) return;
      const row = el.closest("tr");
      if (row && /grouped-row/i.test(row.className || "")) return;
      const name = (el.textContent || "").trim() || "spot";
      if (/^\d+$/.test(name)) return; // compteur agrégé, pas une sonde
      const a = el.closest("a[href]");
      let item = "";
      if (a) {
        try {
          item = new URL(a.href).searchParams.get("item") || "";
        } catch (_) {}
      }
      if (!item && itemIdx >= 0) item = cellText(row, itemIdx);
      if (!item) {
        const itemCell = row?.querySelector("td[class*='col-max-content']");
        if (itemCell) item = (itemCell.textContent || "").trim();
      }
      let app = cellText(row, appIdx);
      if (!app && row) {
        let p = row.previousElementSibling;
        while (p) {
          if (/grouped-row/i.test(p.className || "")) {
            app = (p.querySelector("strong")?.textContent || "").trim();
            break;
          }
          p = p.previousElementSibling;
        }
      }
      app = (app || "").trim();
      const env = resolveEnv(item, cellText(row, envIdx));
      const detail =
        (item ? `${item}/${name}` : name) + kindLabel(kind);
      out.push(alarmKey(app, env, detail));
    });
    return out;
  }

  /**
   * Vue groupée repliée : compteurs recent seulement.
   * Clé : [APP|ENV…] N erreur(s) — items aperçu
   */
  function collectAlarmsFromGroupedRows() {
    const out = [];
    const envIdx = columnIndex("Environnement");
    const itemIdx = columnIndex("Item");
    document
      .querySelectorAll('tr[class*="grouped-row"]')
      .forEach((row) => {
        const counts = { error: 0, expired: 0, warn: 0 };
        row.querySelectorAll('[class*="spot-recent"]').forEach((el) => {
          if (isLegendSpot(el)) return;
          const kind = recentSpotKind(el);
          if (!kindWanted(kind)) return;
          const n = parseInt((el.textContent || "").trim(), 10);
          if (n > 0) counts[kind] += n;
        });
        if (!counts.error && !counts.expired && !counts.warn) return;
        const app = (row.querySelector("strong")?.textContent || "").trim();
        let envRaw = cellText(row, envIdx).replace(/\s*,\s*/g, ", ").trim();
        envRaw = envRaw.replace(/\s*[….]{1,3}\s*$/, "").trim();
        const env =
          matchKnownEnv(envRaw) ||
          (envRaw && !/[,…]/.test(envRaw) ? envRaw.toUpperCase() : "");
        let items = cellText(row, itemIdx);
        items = items.replace(/\s*[….]{1,3}\s*$/, "").trim();
        const tail = items ? ` — ${items}` : "";
        if (counts.error > 0) {
          out.push(alarmKey(app, env, `${counts.error} erreur(s)${tail}`));
        }
        if (counts.expired > 0) {
          out.push(alarmKey(app, env, `${counts.expired} expiré(s)${tail}`));
        }
        if (counts.warn > 0) {
          out.push(alarmKey(app, env, `${counts.warn} warning(s)${tail}`));
        }
      });
    return out;
  }

  function collectAlarmsDom() {
    try {
      const items = collectAlarmsFromItemRows();
      if (items.length) return items;
      return collectAlarmsFromGroupedRows();
    } catch (_) {
      return [];
    }
  }

  /**
   * Apps du filtre Overview « Application » (pastilles filter-value activées).
   * Ex. RABBITMQ MUTUALISE, KAFKA MUTUALISE
   */
  function collectFilterApps() {
    const out = [];
    try {
      document.querySelectorAll('[class*="_filter_"]').forEach((block) => {
        if (block.getAttribute("data-activated") === "false") return;
        const titleEl = block.querySelector('[class*="filter-title"]');
        const title = ((titleEl && titleEl.textContent) || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!/^application$/i.test(title)) return;
        block.querySelectorAll('[class*="filter-value"]').forEach((v) => {
          const t = (v.textContent || "").replace(/\s+/g, " ").trim();
          if (t && !out.includes(t)) out.push(t);
        });
      });
    } catch (_) {}
    return out;
  }

  let lastAppsSig = "";
  let lastSyncedUrl = "";
  let isWatchedTab = true; // injecté seulement sur l’onglet cible ; recheck au besoin
  let domWatching = false;
  let urlHooksInstalled = false;

  /** Apps + URL → storage (fantôme recrée avec les filtres à jour). */
  function syncPageSnapshot(force) {
    if (!isWatchedTab || !soundEnabled) return collectFilterApps();
    const apps = collectFilterApps();
    const url = location.href || "";
    const sig = apps.join("|");
    if (!force && sig === lastAppsSig && url === lastSyncedUrl) return apps;
    lastAppsSig = sig;
    lastSyncedUrl = url;
    chrome.storage.local.set({ watchedApps: apps }).catch(() => {});
    chrome.runtime
      .sendMessage({ type: "MF_PAGE_SYNC", apps, url })
      .catch(() => {});
    return apps;
  }

  function syncWatchedApps() {
    syncPageSnapshot(false);
  }

  /** Lecture apps pour le popup (même si soundEnabled vient d’être armé). */
  function pushFilterApps() {
    return syncPageSnapshot(true);
  }

  function installUrlHooks() {
    if (urlHooksInstalled) return;
    urlHooksInstalled = true;
    const notify = () => {
      if (!isWatchedTab || !soundEnabled) return;
      scheduleRecompute();
      syncPageSnapshot(false);
    };
    window.addEventListener("popstate", notify);
    window.addEventListener("hashchange", notify);
    try {
      const wrap = (fn) =>
        function (...args) {
          const r = fn.apply(this, args);
          notify();
          return r;
        };
      history.pushState = wrap(history.pushState.bind(history));
      history.replaceState = wrap(history.replaceState.bind(history));
    } catch (_) {}
  }

  function recompute() {
    if (!isWatchedTab) return;
    if (!soundEnabled) {
      setAlarmActive(false, []);
      return;
    }
    // Toujours remonter l’état : si la popup a été fermée sans Ack,
    // le background doit pouvoir la rouvrir (même set d’alarmes).
    syncWatchedApps();
    const raw = [...new Set(collectAlarmsDom())];
    // Après Ack : uniquement les nouvelles (pas celles déjà acquittées).
    const uniq = filterNewAlarms(raw);
    setAlarmActive(uniq.length > 0, uniq);
  }

  function refreshWatchedFlag(cb) {
    chrome.runtime.sendMessage({ type: "MF_IS_WATCHED" }, (r) => {
      if (chrome.runtime.lastError) {
        isWatchedTab = true;
      } else {
        isWatchedTab = !!r?.watched;
      }
      if (!isWatchedTab) {
        stopSound();
        const el = document.getElementById("mf-alarm-sound-badge");
        if (el) el.remove();
      }
      if (cb) cb();
    });
  }

  function scheduleRecompute() {
    if (moTimer) return;
    moTimer = setTimeout(() => {
      moTimer = null;
      recompute();
    }, 250);
  }

  function watchDom() {
    if (domWatching) return;
    domWatching = true;
    installUrlHooks();
    const root = document.documentElement || document.body;
    if (!root || typeof MutationObserver !== "function") {
      setInterval(() => recompute(), 3000);
      return;
    }
    const mo = new MutationObserver(() => scheduleRecompute());
    mo.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    // filet de sécurité si MF mute le DOM sans mutation utile
    setInterval(() => recompute(), 15000);
  }

  /** Ré-Activer / fantôme : content déjà injecté → reprendre la veille. */
  function wakeWatching(cb) {
    watchDom();
    refreshWatchedFlag(() => {
      if (!isWatchedTab) {
        // Attach vient de setter watchedTabId : 2e chance (race MF_IS_WATCHED).
        isWatchedTab = true;
      }
      paintBadge();
      if (soundEnabled) recompute();
      const apps = pushFilterApps();
      if (cb) cb(apps);
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "MF_SOUND_TOGGLE") {
      soundEnabled = !!msg.enabled;
      if (!soundEnabled) soundArmed = false;
      paintBadge();
      syncSound();
    }
    if (msg?.type === "MF_SETTINGS" && msg.settings) {
      const s = msg.settings;
      if ("soundEnabled" in s) {
        const next = !!s.soundEnabled;
        if (next !== soundEnabled) soundArmed = false;
        soundEnabled = next;
        if (!soundEnabled) {
          lastAppsSig = "";
          snoozeUntil = 0;
          snoozedWaveSig = "";
          mutedWaveSig = "";
          ackedKeys = [];
          alarmActive = false;
          lastHitKeys = [];
          lastSentSig = "";
          stopSound();
          chrome.storage.local
            .set({
              watchedApps: [],
              snoozeUntil: 0,
              snoozedWaveSig: "",
              mutedWaveSig: "",
              ackedKeys: [],
              lastAlarm: null,
            })
            .catch(() => {});
        }
      }
      if ("intervalMs" in s) {
        intervalMs = Number(s.intervalMs) || intervalMs;
        if (soundArmed) restartTimer(); // nouvel intervalle sans re-bip
      }
      if ("soundPreset" in s) soundPreset = s.soundPreset || soundPreset;
      if ("volume" in s) volume = Number(s.volume) || volume;
      if ("alertErrorRecent" in s) alertErrorRecent = !!s.alertErrorRecent;
      if ("alertExpiredRecent" in s)
        alertExpiredRecent = !!s.alertExpiredRecent;
      if ("alertWarnRecent" in s) alertWarnRecent = !!s.alertWarnRecent;
      if ("includeWarn" in s && !("alertWarnRecent" in s)) {
        alertWarnRecent = !!s.includeWarn;
      }
      paintBadge();
      syncSound();
      if (soundEnabled) wakeWatching();
      else recompute();
    }
    if (msg?.type === "MF_SNOOZE") {
      snoozeUntil = Number(msg.snoozeUntil) || 0;
      if ("snoozedWaveSig" in msg) snoozedWaveSig = msg.snoozedWaveSig || "";
      if ("ackedKeys" in msg && Array.isArray(msg.ackedKeys)) {
        ackedKeys = msg.ackedKeys;
      }
      if (!snoozeUntil) clearAckedKeys();
      if (isSnoozed(lastHitKeys)) stopSound();
      paintBadge();
      syncSound();
      recompute();
    }
    if (msg?.type === "MF_WAVE_MUTE") {
      mutedWaveSig = msg.mutedWaveSig || "";
      if ("ackedKeys" in msg && Array.isArray(msg.ackedKeys)) {
        ackedKeys = msg.ackedKeys;
      }
      if (isWaveMuted(lastHitKeys)) stopSound();
      paintBadge();
      syncSound();
      recompute();
    }
    if (msg?.type === "MF_ACKED_KEYS") {
      ackedKeys = Array.isArray(msg.ackedKeys) ? msg.ackedKeys : [];
      stopSound();
      paintBadge();
      recompute();
    }
    if (msg?.type === "MF_STOP_SOUND") {
      stopSound();
      paintBadge();
      syncSound();
    }
    if (msg?.type === "MF_HARD_RESET") {
      isWatchedTab = false;
      soundEnabled = false;
      snoozeUntil = 0;
      snoozedWaveSig = "";
      mutedWaveSig = "";
      ackedKeys = [];
      alarmActive = false;
      lastHitKeys = [];
      lastSentSig = "";
      lastAppsSig = "";
      stopSound();
      const el = document.getElementById("mf-alarm-sound-badge");
      if (el) el.remove();
      return;
    }
    if (msg?.type === "MF_TEST_SOUND") playBeep(true);
    if (msg?.type === "MF_WAKE") {
      wakeWatching((apps) => sendResponse({ ok: true, apps: apps || [] }));
      return true;
    }
    if (msg?.type === "MF_REFRESH_APPS") {
      lastAppsSig = "";
      wakeWatching((apps) => {
        const list = apps && apps.length ? apps : pushFilterApps();
        sendResponse({ ok: true, apps: list });
      });
      return true;
    }
  });

  // Sync popup/reset → évite badge page « Pause » vs extension OFF
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.soundEnabled) {
      soundEnabled = !!changes.soundEnabled.newValue;
      if (!soundEnabled) stopSound();
      else wakeWatching();
    }
    if (changes.snoozeUntil) {
      snoozeUntil = Number(changes.snoozeUntil.newValue) || 0;
    }
    if (changes.snoozedWaveSig) {
      snoozedWaveSig = changes.snoozedWaveSig.newValue || "";
    }
    if (changes.mutedWaveSig) {
      mutedWaveSig = changes.mutedWaveSig.newValue || "";
    }
    if (changes.ackedKeys) {
      ackedKeys = Array.isArray(changes.ackedKeys.newValue)
        ? changes.ackedKeys.newValue
        : [];
    }
    if (changes.watchedTabId) {
      if (changes.watchedTabId.newValue == null) {
        isWatchedTab = false;
        stopSound();
        const el = document.getElementById("mf-alarm-sound-badge");
        if (el) el.remove();
        return;
      }
      wakeWatching();
      return;
    }
    if (!isWatchedTab) return;
    paintBadge();
    syncSound();
  });

  // rafraîchir pastille snooze
  setInterval(() => {
    if (!isWatchedTab) return;
    if (isSnoozed(lastHitKeys)) paintBadge();
    else if (snoozeUntil && Date.now() >= snoozeUntil) {
      snoozeUntil = 0;
      snoozedWaveSig = "";
      clearAckedKeys(); // fin de pause → les anciennes peuvent réalerter
      chrome.storage.local.set({ snoozeUntil: 0, snoozedWaveSig: "" });
      soundArmed = false;
      paintBadge();
      syncSound();
      recompute();
    }
  }, 15000);

  loadSettings();
  refreshWatchedFlag(() => {
    if (!isWatchedTab) return;
    watchDom();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", paintBadge, { once: true });
    } else paintBadge();
  });
  // Au cas où le watchedTabId arrive juste après l’inject
  setInterval(() => {
    refreshWatchedFlag(() => {
      if (isWatchedTab) watchDom();
    });
  }, 10000);
})();
