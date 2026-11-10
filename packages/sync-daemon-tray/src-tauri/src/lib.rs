use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// 启动成功判定宽限：2s 内退出视为启动失败（进入 npx 兜底）。
const STARTUP_GRACE: Duration = Duration::from_secs(2);

#[derive(Default)]
struct DaemonState {
    child: Mutex<Option<Child>>,
    node: Mutex<String>,
    mode: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct DaemonStatus {
    running: bool,
    pid: Option<u32>,
    node: String,
    starter: String,
    mode: Option<String>,
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn config_path() -> PathBuf {
    home_dir().join(".pi-agent-hub").join("sync-daemon.json")
}

fn resources_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map_err(|error| format!("cannot resolve resource dir: {error}"))
}

fn bundled_node(root: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidate = root.join("node").join("node.exe");
    #[cfg(not(windows))]
    let candidate = root.join("node").join("bin").join("node");
    candidate.is_file().then_some(candidate)
}

fn npx_binary(root: &Path) -> String {
    #[cfg(windows)]
    let bundled = root.join("node").join("npx.cmd");
    #[cfg(not(windows))]
    let bundled = root.join("node").join("bin").join("npx");
    if bundled.is_file() {
        return bundled.to_string_lossy().into_owned();
    }
    if let Ok(value) = std::env::var("PI_AGENT_HUB_NPX") {
        if !value.is_empty() {
            return value;
        }
    }
    #[cfg(windows)]
    {
        "npx.cmd".to_string()
    }
    #[cfg(not(windows))]
    {
        "npx".to_string()
    }
}

fn starter_path(root: &Path) -> PathBuf {
    if let Ok(value) = std::env::var("PI_AGENT_HUB_STARTER") {
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }
    root.join("sync-daemon-starter.js")
}

/// 返回 (可执行命令, 展示名)。env 覆盖 -> 内置 node -> 系统 node。
fn node_for_launch(root: &Path) -> (String, String) {
    if let Ok(value) = std::env::var("PI_AGENT_HUB_NODE") {
        if !value.is_empty() {
            return (value.clone(), value);
        }
    }
    if let Some(bundled) = bundled_node(root) {
        let path = bundled.to_string_lossy().into_owned();
        return (path.clone(), path);
    }
    #[cfg(windows)]
    {
        ("node.exe".to_string(), "node (system)".to_string())
    }
    #[cfg(not(windows))]
    {
        ("node".to_string(), "node (system)".to_string())
    }
}

enum Launched {
    Child { child: Child, mode: String, node: String },
    Failed { message: String },
}

/// 在宽限内轮询子进程；返回 true 表示仍存活（启动成功），false 表示已退出（启动失败）。
fn probe_alive(child: &mut Child, grace: Duration) -> bool {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return false,
            Ok(None) if start.elapsed() < grace => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => return true,
            Err(_) => return false,
        }
    }
}

/// 启动链：node + starter -> npx -y @pi-agent-hub/sync-daemon -> 全部失败返回错误。
fn launch(app: &AppHandle) -> Launched {
    let root = match resources_dir(app) {
        Ok(root) => root,
        Err(message) => return Launched::Failed { message },
    };
    let config = config_path();
    let starter = starter_path(&root);
    let (node_cmd, node_display) = node_for_launch(&root);

    if !starter.is_file() {
        return Launched::Failed {
            message: format!("starter 不存在: {}", starter.display()),
        };
    }

    let first_error = match Command::new(&node_cmd)
        .arg(&starter)
        .arg("run")
        .arg("--config")
        .arg(&config)
        .spawn()
    {
        Ok(mut child) => {
            if probe_alive(&mut child, STARTUP_GRACE) {
                return Launched::Child {
                    child,
                    mode: "starter".to_string(),
                    node: node_display,
                };
            }
            let code = child.wait().ok().and_then(|status| status.code());
            format!("starter 在启动宽限内退出 (code={code:?})")
        }
        Err(error) => format!("无法启动 starter: {error}"),
    };

    let npx = npx_binary(&root);
    match Command::new(&npx)
        .arg("-y")
        .arg("@pi-agent-hub/sync-daemon")
        .arg("run")
        .arg("--config")
        .arg(&config)
        .spawn()
    {
        Ok(mut child) => {
            if probe_alive(&mut child, STARTUP_GRACE) {
                return Launched::Child {
                    child,
                    mode: "npx".to_string(),
                    node: npx,
                };
            }
            let code = child.wait().ok().and_then(|status| status.code());
            Launched::Failed {
                message: format!("{first_error}；npx 兜底亦退出 (code={code:?}): {npx}"),
            }
        }
        Err(error) => Launched::Failed {
            message: format!("{first_error}；npx 兜底不可用: {error}"),
        },
    }
}

fn existing_pid(app: &AppHandle) -> Option<u32> {
    let state = app.state::<DaemonState>();
    let mut guard = state.child.lock().expect("daemon state lock poisoned");
    let pid = guard.as_mut().and_then(|child| match child.try_wait() {
        Ok(None) => Some(child.id()),
        _ => None,
    });
    if pid.is_none() {
        *guard = None;
    }
    pid
}

fn current_status(app: &AppHandle) -> DaemonStatus {
    let pid = existing_pid(app);
    let state = app.state::<DaemonState>();
    let node = state.node.lock().expect("poisoned").clone();
    let mode = state.mode.lock().expect("poisoned").clone();
    let starter = resources_dir(app)
        .map(|root| starter_path(&root).display().to_string())
        .unwrap_or_default();
    DaemonStatus {
        running: pid.is_some(),
        pid,
        node,
        starter,
        mode,
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("config") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_error(app: &AppHandle, message: &str) {
    let _ = app
        .dialog()
        .message(format!(
            "sync-daemon 启动失败：{message}\n\n配置文件：{}",
            config_path().display()
        ))
        .title("pi-agent-hub sync-daemon")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn apply_menu(app: &AppHandle) {
    let running = existing_pid(app).is_some();
    let pause_label = if running { "暂停同步" } else { "继续同步" };
    let show = MenuItem::with_id(app, "show", "配置", true, None::<&str>);
    let pause = MenuItem::with_id(app, "pause_resume", pause_label, true, None::<&str>);
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>);
    if let (Ok(show), Ok(pause), Ok(quit)) = (show, pause, quit) {
        if let Ok(menu) = Menu::<tauri::Wry>::with_items(app, &[&show, &pause, &quit]) {
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
}

fn start_daemon_inner(app: &AppHandle) -> Result<DaemonStatus, String> {
    if existing_pid(app).is_some() {
        return Ok(current_status(app));
    }
    match launch(app) {
        Launched::Child { child, mode, node } => {
            let state = app.state::<DaemonState>();
            *state.child.lock().expect("poisoned") = Some(child);
            *state.mode.lock().expect("poisoned") = Some(mode);
            *state.node.lock().expect("poisoned") = node;
            apply_menu(app);
            Ok(current_status(app))
        }
        Launched::Failed { message } => {
            show_error(app, &message);
            Err(message)
        }
    }
}

fn stop_daemon_inner(app: &AppHandle) -> Result<DaemonStatus, String> {
    let state = app.state::<DaemonState>();
    let mut guard = state.child.lock().expect("daemon state lock poisoned");
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.mode.lock().expect("poisoned") = None;
    apply_menu(app);
    Ok(current_status(app))
}

#[tauri::command]
fn read_config() -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(config_path()).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_config(value: serde_json::Value) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| error.to_string())
}

#[tauri::command]
fn daemon_status(app: AppHandle) -> DaemonStatus {
    current_status(&app)
}

#[tauri::command]
fn start_daemon(app: AppHandle) -> Result<DaemonStatus, String> {
    start_daemon_inner(&app)
}

#[tauri::command]
fn stop_daemon(app: AppHandle) -> Result<DaemonStatus, String> {
    stop_daemon_inner(&app)
}

#[tauri::command]
fn restart_daemon(app: AppHandle) -> Result<DaemonStatus, String> {
    let _ = stop_daemon_inner(&app);
    start_daemon_inner(&app)
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    Ok(enabled)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .manage(DaemonState::default())
        .invoke_handler(tauri::generate_handler![
            read_config,
            write_config,
            daemon_status,
            start_daemon,
            stop_daemon,
            restart_daemon,
            get_autostart,
            set_autostart
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("tray icon missing").clone())
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window(app),
                    "pause_resume" => {
                        if existing_pid(app).is_some() {
                            let _ = stop_daemon_inner(app);
                        } else {
                            let _ = start_daemon_inner(app);
                        }
                    }
                    "quit" => {
                        let _ = stop_daemon_inner(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;
            apply_menu(&handle);
            // 托盘启动即拉起 daemon（失败已由内部弹窗告知）
            if start_daemon_inner(&handle).is_err() {
                // daemon 未启动成功，托盘保持驻留，用户可经「继续同步」重试
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
