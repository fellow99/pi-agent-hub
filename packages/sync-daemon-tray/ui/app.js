const invoke = window.__TAURI__?.core?.invoke;

const el = (id) => document.getElementById(id);

function setMessage(text, isError = false) {
  const node = el("message");
  node.textContent = text;
  node.className = isError ? "message error" : "message ok";
}

/** 红绿灯：绿=daemon 运行中，红=已停止。 */
function renderStatus(running, text) {
  const light = el("statusLight");
  const label = el("statusText");
  if (running) {
    light.className = "light on";
    light.title = "同步运行中";
    label.textContent = text ?? "运行中";
  } else {
    light.className = "light off";
    light.title = "已停止";
    label.textContent = text ?? "已停止";
  }
}

async function refreshStatus() {
  if (!invoke) {
    renderStatus(false, "Tauri API unavailable");
    return;
  }
  try {
    const status = await invoke("daemon_status");
    renderStatus(Boolean(status.running));
  } catch (error) {
    renderStatus(false, String(error));
  }
}

async function loadConfig() {
  if (!invoke) return;
  try {
    const config = await invoke("read_config");
    el("configText").value = JSON.stringify(config, null, 2);
  } catch (error) {
    el("configText").value = "{}";
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
    await invoke("restart_daemon");
    setMessage("保存成功，daemon 已重启");
  } catch (error) {
    setMessage(`保存失败：${error}`, true);
  }
}

el("save").addEventListener("click", saveConfig);
el("reload").addEventListener("click", loadConfig);

// 每秒自动刷新同步状态
setInterval(refreshStatus, 1000);

refreshStatus();
loadConfig();
