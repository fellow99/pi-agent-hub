const invoke = window.__TAURI__?.core?.invoke;

const el = (id) => document.getElementById(id);

let config = {};

function setMessage(text) {
  el("message").textContent = text;
}

async function refreshStatus() {
  if (!invoke) {
    el("status").textContent = "Tauri API unavailable (open through the app)";
    return;
  }
  try {
    el("status").textContent = JSON.stringify(await invoke("daemon_status"), null, 2);
  } catch (error) {
    el("status").textContent = String(error);
  }
}

async function loadConfig() {
  if (!invoke) return;
  try {
    config = await invoke("read_config");
    el("hubUrl").value = config.hub?.url ?? "";
    el("hubToken").value = config.hub?.token ?? "";
    el("hostName").value = config.host?.name ?? "";
    el("pluginRoot").value = config.pluginRoot ?? "~/.pi-agent-hub/plugins";
    setMessage("loaded");
  } catch (error) {
    setMessage(`load failed: ${error}`);
  }
}

async function saveConfig() {
  if (!invoke) return;
  config = {
    ...config,
    hub: { ...(config.hub ?? {}), url: el("hubUrl").value.trim(), token: el("hubToken").value.trim() },
    host: { ...(config.host ?? {}), name: el("hostName").value.trim() },
    pluginRoot: el("pluginRoot").value.trim(),
  };
  try {
    await invoke("write_config", { value: config });
    setMessage("saved");
    await refreshStatus();
  } catch (error) {
    setMessage(`save failed: ${error}`);
  }
}

el("start").addEventListener("click", async () => {
  if (!invoke) return;
  try {
    el("status").textContent = JSON.stringify(await invoke("start_daemon"), null, 2);
  } catch (error) {
    setMessage(String(error));
  }
});

el("stop").addEventListener("click", async () => {
  if (!invoke) return;
  try {
    el("status").textContent = JSON.stringify(await invoke("stop_daemon"), null, 2);
  } catch (error) {
    setMessage(String(error));
  }
});

el("refresh").addEventListener("click", refreshStatus);
el("save").addEventListener("click", saveConfig);
el("reload").addEventListener("click", loadConfig);

refreshStatus();
loadConfig();
