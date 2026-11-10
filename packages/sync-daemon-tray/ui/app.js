const invoke = window.__TAURI__?.core?.invoke;

const el = (id) => document.getElementById(id);

function setMessage(text, isError = false) {
  const node = el("message");
  node.textContent = text;
  node.className = isError ? "message error" : "message ok";
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
    const config = await invoke("read_config");
    el("configText").value = JSON.stringify(config, null, 2);
    setMessage("已加载配置文件");
  } catch (error) {
    el("configText").value = "{}";
    setMessage(`加载失败（以空配置占位）：${error}`, true);
  }
  try {
    el("autostart").checked = await invoke("get_autostart");
  } catch (error) {
    setMessage(`读取开机自启状态失败：${error}`, true);
  }
}

function validateJson() {
  try {
    const parsed = JSON.parse(el("configText").value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("配置必须是一个 JSON 对象");
    }
    return parsed;
  } catch (error) {
    setMessage(`JSON 语法错误，未保存：${error.message}`, true);
    return null;
  }
}

async function saveConfig() {
  if (!invoke) return;
  const value = validateJson();
  if (value === null) return;
  try {
    await invoke("write_config", { value });
    await invoke("set_autostart", { enabled: el("autostart").checked });
    setMessage("已保存，正在重启 daemon…");
    const status = await invoke("restart_daemon");
    el("status").textContent = JSON.stringify(status, null, 2);
    setMessage("保存成功，daemon 已重启");
  } catch (error) {
    setMessage(`保存失败：${error}`, true);
  }
}

el("save").addEventListener("click", saveConfig);
el("reload").addEventListener("click", loadConfig);
el("restart").addEventListener("click", async () => {
  if (!invoke) return;
  try {
    const status = await invoke("restart_daemon");
    el("status").textContent = JSON.stringify(status, null, 2);
    setMessage("daemon 已重启");
  } catch (error) {
    setMessage(`重启失败：${error}`, true);
  }
});
el("refresh").addEventListener("click", refreshStatus);

refreshStatus();
loadConfig();
