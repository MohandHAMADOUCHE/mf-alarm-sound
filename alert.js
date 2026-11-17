const $ = (id) => document.getElementById(id);

/**
 * Clés `[APP|ENV] item/probe` →
 *   APP
 *     ENV
 *       item/probe
 */
function formatGrouped(keys) {
  /** app -> env -> [details] */
  const tree = new Map();
  for (const k of keys) {
    const m = String(k).match(/^\[([^\]|]+)(?:\|([^\]]*))?\]\s*(.*)$/);
    const app = m ? m[1] : "(sans application)";
    const env = (m && m[2] ? m[2] : "").trim();
    const detail = (m ? m[3] : k).trim() || "—";
    if (!tree.has(app)) tree.set(app, new Map());
    const envs = tree.get(app);
    const envKey = env || "";
    if (!envs.has(envKey)) envs.set(envKey, []);
    envs.get(envKey).push(detail);
  }
  const lines = [];
  const apps = [...tree.keys()].sort((a, b) => a.localeCompare(b, "fr"));
  for (const app of apps) {
    const envs = tree.get(app);
    let n = 0;
    for (const list of envs.values()) n += list.length;
    lines.push(`${app} (${n})`);
    const envNames = [...envs.keys()].sort((a, b) => a.localeCompare(b, "fr"));
    for (const env of envNames) {
      const items = envs.get(env).sort((a, b) => a.localeCompare(b, "fr"));
      if (env) {
        lines.push(`  ${env} (${items.length})`);
        for (const it of items) lines.push(`    ${it}`);
      } else {
        for (const it of items) lines.push(`  ${it}`);
      }
    }
  }
  return lines.join("\n");
}

function appsFromKeys(keys) {
  const apps = [];
  for (const k of keys) {
    const m = String(k).match(/^\[([^\]|]+)/);
    if (m && !apps.includes(m[1])) apps.push(m[1]);
  }
  return apps;
}

async function load() {
  const { lastAlarm } = await chrome.storage.local.get("lastAlarm");
  const alarm = lastAlarm || {};
  const keys = alarm.keys || [];
  const apps = appsFromKeys(keys);
  $("ack").textContent = "Ack";
  $("meta").textContent = alarm.at
    ? `Détecté : ${new Date(alarm.at).toLocaleString()} · ${keys.length} alarme(s)` +
      (apps.length ? ` · ${apps.length} application(s)` : "")
    : "Alarme MF";
  $("keys").textContent = keys.length
    ? formatGrouped(keys)
    : "(détail indisponible)";
}

async function openMf() {
  await chrome.runtime.sendMessage({ type: "MF_FOCUS_WATCHED" }).catch(() => {});
}

$("ack").onclick = async () => {
  const { lastAlarm } = await chrome.storage.local.get("lastAlarm");
  await chrome.runtime
    .sendMessage({
      type: "MF_ACK",
      mode: "wave",
      keys: lastAlarm?.keys || [],
    })
    .catch(() => {});
  await openMf();
  window.close();
};

$("open").onclick = async () => {
  await openMf();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MF_ALERT_REFRESH") load();
});

load();
