use std::process::{Child, Command};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};

#[derive(Default)]
struct DaemonState {
    child: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct DaemonStatus {
    running: bool,
    pid: Option<u32>,
    node: String,
    daemon: String,
}

fn home_dir() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn config_path() -> std::path::PathBuf {
    home_dir().join(".pi-agent-hub").join("sync-daemon.json")
}

fn daemon_entry() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("PI_AGENT_HUB_DAEMON") {
        return std::path::PathBuf::from(path);
    }
    std::path::PathBuf::from("sync-daemon/dist/main.js")
}

fn node_binary() -> String {
    std::env::var("PI_AGENT_HUB_NODE").unwrap_or_else(|_| "node".to_string())
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
fn daemon_status(state: State<'_, DaemonState>) -> DaemonStatus {
    let mut guard = state.child.lock().expect("daemon state lock poisoned");
    let pid = guard.as_mut().and_then(|child| match child.try_wait() {
        Ok(None) => Some(child.id()),
        _ => None,
    });
    if pid.is_none() {
        *guard = None;
    }
    DaemonStatus {
        running: pid.is_some(),
        pid,
        node: node_binary(),
        daemon: daemon_entry().display().to_string(),
    }
}

#[tauri::command]
fn start_daemon(state: State<'_, DaemonState>) -> Result<DaemonStatus, String> {
    let mut guard = state.child.lock().expect("daemon state lock poisoned");
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|error| error.to_string())?.is_none() {
            return Ok(DaemonStatus {
                running: true,
                pid: Some(child.id()),
                node: node_binary(),
                daemon: daemon_entry().display().to_string(),
            });
        }
    }
    let config = config_path();
    let child = Command::new(node_binary())
        .arg(daemon_entry())
        .arg("run")
        .arg("--config")
        .arg(&config)
        .spawn()
        .map_err(|error| format!("failed to start daemon: {error}"))?;
    let pid = child.id();
    *guard = Some(child);
    Ok(DaemonStatus {
        running: true,
        pid: Some(pid),
        node: node_binary(),
        daemon: daemon_entry().display().to_string(),
    })
}

#[tauri::command]
fn stop_daemon(state: State<'_, DaemonState>) -> Result<DaemonStatus, String> {
    let mut guard = state.child.lock().expect("daemon state lock poisoned");
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(DaemonStatus {
        running: false,
        pid: None,
        node: node_binary(),
        daemon: daemon_entry().display().to_string(),
    })
}

pub fn run() {
    tauri::Builder::default()
        .manage(DaemonState::default())
        .invoke_handler(tauri::generate_handler![
            read_config,
            write_config,
            daemon_status,
            start_daemon,
            stop_daemon
        ])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Open settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("tray icon missing").clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("config") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("config") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
