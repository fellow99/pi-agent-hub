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
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Windows：隐藏子进程控制台窗口（node/npx/taskkill 均为控制台子系统）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 启动成功判定宽限：2s 内退出视为启动失败（进入 npx 兜底）。
const STARTUP_GRACE: Duration = Duration::from_secs(2);

#[derive(Default)]
struct DaemonState {
    child: Mutex<Option<Child>>,
    node: Mutex<String>,
    mode: Mutex<Option<String>>,
}

/// 持有「暂停/继续同步」菜单项句柄：菜单只在 setup 构建一次，状态变化仅 set_text 更新文案，
/// 避免反复 set_menu 整菜单重建导致 Windows 右键菜单丢失关联。
#[derive(Default)]
struct TrayUiState {
    pause_item: Mutex<Option<MenuItem<tauri::Wry>>>,
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

/// 控制台子系统进程默认会弹出终端窗口；统一加隐藏标志（Windows CREATE_NO_WINDOW，
/// Unix 起新进程组便于整树终止）。
fn configure_spawn(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(unix)]
    command.process_group(0);
    command
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

/// 终止整棵进程树：Windows taskkill /T /F；Unix 杀进程组（-pid）。
fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let _ = configure_spawn(&mut command).status();
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("kill");
        command.arg(format!("-{}", pid));
        let _ = configure_spawn(&mut command).status();
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

    let first_error = {
        let mut command = Command::new(&node_cmd);
        command.arg(&starter).arg("run").arg("--config").arg(&config);
        match configure_spawn(&mut command).spawn() {
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
        }
    };

    let npx = npx_binary(&root);
    let mut command = Command::new(&npx);
    command
        .arg("-y")
        .arg("@pi-agent-hub/sync-daemon")
        .arg("run")
        .arg("--config")
        .arg(&config);
    match configure_spawn(&mut command).spawn() {
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
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_error(app: &AppHandle, message: &str) {
    // 非阻塞（show）：blocking_show 不允许在主线程调用，否则会短暂阻塞事件循环。
    app.dialog()
        .message(format!(
            "sync-daemon 启动失败：{message}\n\n配置文件：{}",
            config_path().display()
        ))
        .title("pi-agent-hub sync-daemon")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

/// 仅更新「暂停/继续同步」菜单项文案（菜单本体在 setup 构建一次，不整体重建）。
/// 保留 defer：set_text 也走菜单内部队列，应排在菜单回调返回后的主线程执行。
fn apply_menu(app: &AppHandle) {
    let running = existing_pid(app).is_some();
    let label = if running { "暂停同步" } else { "继续同步" };
    let state = app.state::<TrayUiState>();
    {
        let guard = state.pause_item.lock().ok();
        if let Some(guard) = guard {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_text(label);
            }
        }
    }
}

/// 延迟到主线程更新菜单文案：避免在菜单回调（Windows 菜单消息循环）内直接触碰菜单资源；
/// 从 stop/start 后台线程调用时，排队到主线程执行 set_text。
fn defer_menu(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply_menu(&handle));
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
            defer_menu(app);
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
    let child = state.child.lock().expect("daemon state lock poisoned").take();
    if let Some(mut child) = child {
        let pid = child.id();
        // 整树终止（starter -> daemon -> 插件），避免孤儿进程与残留控制台/图标。
        kill_process_tree(pid);
        let _ = child.wait();
    }
    *state.mode.lock().expect("poisoned") = None;
    defer_menu(app);
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

/// daemon 控制命令均 async：进程终止/启动/探测会给主线程带来毫秒~秒级阻塞，
/// 放后台线程执行避免卡 WebView 事件循环。
#[tauri::command]
async fn start_daemon(app: AppHandle) -> Result<DaemonStatus, String> {
    start_daemon_inner(&app)
}

#[tauri::command]
async fn stop_daemon(app: AppHandle) -> Result<DaemonStatus, String> {
    stop_daemon_inner(&app)
}

#[tauri::command]
async fn restart_daemon(app: AppHandle) -> Result<DaemonStatus, String> {
    let _ = stop_daemon_inner(&app);
    start_daemon_inner(&app)
}

#[tauri::command]
async fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
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
            // 菜单一次性构建并附加；之后绝不 set_menu 整体替换，仅按需 set_text（避免右键菜单丢失）。
            let show = MenuItem::with_id(&handle, "show", "配置", true, None::<&str>)?;
            let pause = MenuItem::with_id(&handle, "pause_resume", "继续同步", true, None::<&str>)?;
            let quit = MenuItem::with_id(&handle, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::<tauri::Wry>::with_items(&handle, &[&show, &pause, &quit])?;
            app.manage(TrayUiState {
                pause_item: Mutex::new(Some(pause.clone())),
            });
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("tray icon missing").clone())
                .tooltip("pi-agent-hub")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => show_window(app),
                    "pause_resume" => {
                        // stop/start 移到后台线程，避免阻塞菜单消息循环；文案经 defer_menu 主线程更新。
                        let thread_handle = app.clone();
                        std::thread::spawn(move || {
                            if existing_pid(&thread_handle).is_some() {
                                let _ = stop_daemon_inner(&thread_handle);
                            } else {
                                let _ = start_daemon_inner(&thread_handle);
                            }
                        });
                    }
                    "quit" => {
                        let _ = stop_daemon_inner(&handle);
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
            // 配置窗口点关闭（X）时保持托盘驻留：隐藏而非销毁窗口，
            // 避免「最后一个窗口关闭 → Tauri 退出整个应用」导致托盘消失。
            if let Some(window) = app.get_webview_window("config") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }
            let handle = app.handle().clone();
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

#[cfg(all(test, windows))]
mod tests {
    use super::{configure_spawn, kill_process_tree};
    use std::io::{BufRead, Read};
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    fn spawn_node_tree() -> Child {
        let script = [
            "const { spawn } = require('child_process');",
            "const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { stdio:'ignore' });",
            "process.stdout.write('GPID=' + child.pid + String.fromCharCode(10));",
            "setInterval(()=>{},1000);",
        ]
        .concat();
        let mut command = Command::new("node");
        command.args(["-e", &script]).stdout(Stdio::piped()).stderr(Stdio::piped());
        configure_spawn(&mut command).spawn().expect("node tree spawns")
    }

    /// 轮询读 stdout 首行（父 node 打印孙 pid），带 4s 超时；看门狗 2s 后兜底终止。
    fn read_grandchild_pid(child: &mut Child) -> u32 {
        let stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");
        let (tx, rx) = mpsc::channel();
        // 独立线程读首行（read_line 阻塞直到有数据/EOF）
        let tx_line = tx.clone();
        thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let mut line = String::new();
            if reader.read_line(&mut line).is_ok() {
                let _ = tx_line.send(format!("OUT:{line}"));
            }
        });
        // 独立线程收 stderr 诊断
        thread::spawn(move || {
            let mut buf = String::new();
            if stderr.read_to_string(&mut buf).is_ok() && !buf.is_empty() {
                let _ = tx.send(format!("ERR:{buf}"));
            }
        });
        // 看门狗：2s 未读到则终止树，避免挂死
        let pid = child.id();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            kill_process_tree(pid);
        });
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            match rx.try_recv() {
                Ok(msg) if msg.starts_with("OUT:GPID=") => {
                    return msg["OUT:GPID=".len()..].trim().parse().expect("grandchild pid is a number");
                }
                Ok(msg) => {
                    eprintln!("child diag: {msg}");
                }
                Err(mpsc::TryRecvError::Empty) => thread::sleep(Duration::from_millis(50)),
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        panic!("grandchild pid not observed in time (diag above)")
    }

    fn process_alive(pid: u32) -> bool {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    #[test]
    fn no_window_flag_does_not_break_spawn() {
        let mut child = spawn_node_tree();
        let _ = read_grandchild_pid(&mut child);
        kill_process_tree(child.id());
        let _ = child.wait();
        thread::sleep(Duration::from_millis(600));
        assert!(!process_alive(child.id()), "parent should be dead");
    }

    #[test]
    fn tree_kill_removes_grandchild() {
        let mut child = spawn_node_tree();
        let grand = read_grandchild_pid(&mut child);
        let top = child.id();
        assert!(grand > 0 && grand != top, "grandchild pid distinct");
        kill_process_tree(top);
        let _ = child.wait();
        thread::sleep(Duration::from_millis(800));
        assert!(!process_alive(top), "top process should be gone");
        assert!(!process_alive(grand), "grandchild should be gone via tree kill");
    }
}
