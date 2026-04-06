// Prevents additional console window on Windows in release, do not remove!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

const GITHUB_OWNER: &str = "cns-studios";
const GITHUB_REPO: &str = "dropzone";
const GITHUB_API_ACCEPT: &str = "application/vnd.github+json";
const HTTP_USER_AGENT: &str = "Dropzone-Updater/1.0";

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: Option<String>,
    body: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Serialize)]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    has_update: bool,
    download_url: Option<String>,
    asset_name: Option<String>,
    release_url: Option<String>,
    notes: Option<String>,
}

fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_string()
}

fn parse_version(version: &str) -> Option<Version> {
    Version::parse(&normalize_version(version)).ok()
}

fn is_remote_newer(current: &str, remote: &str) -> bool {
    if let (Some(current_v), Some(remote_v)) = (parse_version(current), parse_version(remote)) {
        return remote_v > current_v;
    }
    normalize_version(current) != normalize_version(remote)
}

fn command_exists(cmd: &str) -> bool {
    #[cfg(target_os = "windows")]
    let checker = "where";
    #[cfg(not(target_os = "windows"))]
    let checker = "which";

    Command::new(checker)
        .arg(cmd)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn github_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to build HTTP client")
}

fn fetch_latest_release() -> Result<Option<GithubRelease>> {
    let endpoint = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        GITHUB_OWNER, GITHUB_REPO
    );

    let response = github_client()?
        .get(endpoint)
        .header("Accept", GITHUB_API_ACCEPT)
        .header("User-Agent", HTTP_USER_AGENT)
        .send()
        .context("failed to fetch latest release")?;

    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let release = response
        .error_for_status()
        .context("GitHub API returned an error for latest release")?
        .json::<GithubRelease>()
        .context("failed to parse latest release JSON")?;

    Ok(Some(release))
}

#[cfg(target_os = "linux")]
fn linux_distribution_hint() -> String {
    let os_release = fs::read_to_string("/etc/os-release").unwrap_or_default().to_lowercase();
    os_release
}

#[cfg(target_os = "linux")]
fn pick_linux_asset(assets: &[GithubAsset]) -> Option<GithubAsset> {
    let hint = linux_distribution_hint();

    let mut preferred_exts = Vec::new();
    if hint.contains("arch") || hint.contains("manjaro") {
        preferred_exts.extend([".pacman", ".pkg.tar.zst", ".deb", ".rpm"]);
    } else if hint.contains("debian") || hint.contains("ubuntu") || hint.contains("mint") {
        preferred_exts.extend([".deb", ".rpm", ".pacman", ".pkg.tar.zst"]);
    } else if hint.contains("fedora") || hint.contains("rhel") || hint.contains("centos") {
        preferred_exts.extend([".rpm", ".deb", ".pacman", ".pkg.tar.zst"]);
    } else {
        preferred_exts.extend([".deb", ".rpm", ".pacman", ".pkg.tar.zst"]);
    }

    for ext in preferred_exts {
        if let Some(asset) = assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(ext))
            .cloned()
        {
            return Some(asset);
        }
    }

    None
}

fn pick_release_asset(assets: &[GithubAsset]) -> Option<GithubAsset> {
    #[cfg(target_os = "windows")]
    {
        if let Some(asset) = assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(".exe"))
            .cloned()
        {
            return Some(asset);
        }

        return assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(".msi"))
            .cloned();
    }

    #[cfg(target_os = "linux")]
    {
        return pick_linux_asset(assets);
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = assets;
        None
    }
}

fn build_update_info(current_version: String) -> Result<UpdateInfo> {
    let Some(release) = fetch_latest_release()? else {
        return Ok(UpdateInfo {
            current_version: current_version.clone(),
            latest_version: current_version,
            has_update: false,
            download_url: None,
            asset_name: None,
            release_url: None,
            notes: Some("No published release found yet.".to_string()),
        });
    };
    let latest_version = normalize_version(&release.tag_name);
    let has_update = is_remote_newer(&current_version, &latest_version);

    let asset = if has_update {
        pick_release_asset(&release.assets)
    } else {
        None
    };

    Ok(UpdateInfo {
        current_version,
        latest_version,
        has_update,
        download_url: asset.as_ref().map(|a| a.browser_download_url.clone()),
        asset_name: asset.as_ref().map(|a| a.name.clone()),
        release_url: release.html_url,
        notes: release.body,
    })
}

fn temp_update_dir() -> Result<PathBuf> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("failed to compute timestamp")?
        .as_secs();
    let dir = std::env::temp_dir().join(format!("dropzone-update-{}", stamp));
    fs::create_dir_all(&dir).context("failed to create temporary update directory")?;
    Ok(dir)
}

fn download_update_asset(download_url: &str, asset_name: &str) -> Result<PathBuf> {
    let dir = temp_update_dir()?;
    let target = dir.join(asset_name);

    let bytes = github_client()?
        .get(download_url)
        .header("Accept", "application/octet-stream")
        .header("User-Agent", HTTP_USER_AGENT)
        .send()
        .context("failed to download release asset")?
        .error_for_status()
        .context("release asset download failed")?
        .bytes()
        .context("failed to read release asset bytes")?;

    fs::write(&target, &bytes).context("failed to write release asset to disk")?;
    Ok(target)
}

#[cfg(target_os = "linux")]
fn shell_single_quote(value: &str) -> String {
    value.replace('\'', "'\\''")
}

#[cfg(target_os = "linux")]
fn linux_install_command(installer: &Path) -> Result<String> {
    let path = shell_single_quote(
        installer
            .to_str()
            .ok_or_else(|| anyhow!("invalid installer path"))?,
    );

    let name = installer
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();

    if name.ends_with(".deb") {
        return Ok(format!(
            "dpkg -i '{}' || (apt-get update && apt-get install -f -y && dpkg -i '{}')",
            path, path
        ));
    }

    if name.ends_with(".rpm") {
        return Ok(format!(
            "(dnf install -y '{}' || yum localinstall -y '{}' || rpm -Uvh '{}')",
            path, path, path
        ));
    }

    if name.ends_with(".pacman") || name.ends_with(".pkg.tar.zst") {
        return Ok(format!("pacman -U --noconfirm '{}'", path));
    }

    Err(anyhow!("unsupported Linux package type: {}", name))
}

#[cfg(target_os = "linux")]
fn write_linux_updater_script(installer: &Path, app_pid: u32) -> Result<PathBuf> {
    let dir = temp_update_dir()?;
    let script = dir.join("install-update.sh");
    let install_cmd = linux_install_command(installer)?;

    let content = format!(
        "#!/bin/sh\nset -e\nAPP_PID=\"{}\"\nwhile kill -0 \"$APP_PID\" 2>/dev/null; do sleep 1; done\n{}\n",
        app_pid, install_cmd
    );

    fs::write(&script, content).context("failed to write Linux updater script")?;
    let status = Command::new("chmod")
        .args(["+x", script.to_str().unwrap_or_default()])
        .status()
        .context("failed to chmod Linux updater script")?;
    if !status.success() {
        return Err(anyhow!("failed to make Linux updater script executable"));
    }

    Ok(script)
}

#[cfg(target_os = "linux")]
fn launch_linux_updater(script: &Path) -> Result<()> {
    let script_path = script
        .to_str()
        .ok_or_else(|| anyhow!("invalid updater script path"))?;

    if command_exists("pkexec") {
        Command::new("pkexec")
            .args(["sh", script_path])
            .spawn()
            .context("failed to start pkexec updater")?;
        return Ok(());
    }

    if command_exists("x-terminal-emulator") {
        Command::new("x-terminal-emulator")
            .args(["-e", "sh", "-lc", &format!("sudo sh '{}'", script_path)])
            .spawn()
            .context("failed to start terminal sudo updater")?;
        return Ok(());
    }

    if command_exists("xterm") {
        Command::new("xterm")
            .args(["-e", "sh", "-lc", &format!("sudo sh '{}'", script_path)])
            .spawn()
            .context("failed to start xterm sudo updater")?;
        return Ok(());
    }

    Err(anyhow!(
        "no privilege elevation path found (pkexec and terminal sudo unavailable)"
    ))
}

#[cfg(target_os = "windows")]
fn write_windows_updater_script(installer: &Path, app_pid: u32) -> Result<PathBuf> {
    let dir = temp_update_dir()?;
    let script = dir.join("install-update.ps1");
    let installer_path = installer
        .to_str()
        .ok_or_else(|| anyhow!("invalid installer path"))?
        .replace('"', "``\"");

    let content = format!(
        "$pidToWait = {}\nwhile (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 500 }}\nStart-Process -FilePath \"{}\"\n",
        app_pid, installer_path
    );

    fs::write(&script, content).context("failed to write Windows updater script")?;
    Ok(script)
}

#[cfg(target_os = "windows")]
fn launch_windows_updater(script: &Path) -> Result<()> {
    let script_path = script
        .to_str()
        .ok_or_else(|| anyhow!("invalid PowerShell updater script path"))?;

    Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            script_path,
        ])
        .spawn()
        .context("failed to launch Windows updater")?;

    Ok(())
}

fn install_downloaded_asset_cli(installer: &Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new(installer)
            .spawn()
            .context("failed to launch installer")?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let install_cmd = linux_install_command(installer)?;

        if command_exists("sudo") {
            let status = Command::new("sudo")
                .args(["sh", "-c", &install_cmd])
                .status()
                .context("failed to execute installer with sudo")?;
            if status.success() {
                return Ok(());
            }
        }

        if command_exists("pkexec") {
            let status = Command::new("pkexec")
                .args(["sh", "-c", &install_cmd])
                .status()
                .context("failed to execute installer with pkexec")?;
            if status.success() {
                return Ok(());
            }
        }

        return Err(anyhow!(
            "could not elevate permissions for installation (sudo/pkexec failed)"
        ));
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = installer;
        Err(anyhow!("updates are not supported on this OS yet"))
    }
}

fn run_cli_update() -> Result<i32> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    println!("Checking for Dropzone updates...");
    let info = build_update_info(current_version)?;

    if !info.has_update {
        if info.notes.as_deref() == Some("No published release found yet.") {
            println!("No published release found yet.");
            return Ok(0);
        }
        println!(
            "You are up to date (current: {}, latest: {}).",
            info.current_version, info.latest_version
        );
        return Ok(0);
    }

    let download_url = info
        .download_url
        .as_deref()
        .ok_or_else(|| anyhow!("no downloadable asset found for this platform"))?;
    let asset_name = info
        .asset_name
        .as_deref()
        .ok_or_else(|| anyhow!("missing asset metadata"))?;

    println!(
        "New release found: {} (current: {}).",
        info.latest_version, info.current_version
    );
    print!("Download and install now? [y/N]: ");
    io::stdout().flush().ok();

    let mut answer = String::new();
    io::stdin().read_line(&mut answer).ok();
    if !matches!(answer.trim().to_lowercase().as_str(), "y" | "yes") {
        println!("Update cancelled.");
        return Ok(0);
    }

    println!("Downloading {}...", asset_name);
    let installer = download_update_asset(download_url, asset_name)?;

    println!("Installing update...");
    install_downloaded_asset_cli(&installer)?;
    println!("Updater launched.");
    Ok(0)
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || build_update_info(current_version))
        .await
        .map_err(|e| format!("failed to join update check task: {}", e))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_and_install_update(
    app: tauri::AppHandle,
    download_url: String,
    asset_name: String,
) -> Result<(), String> {
    let installer = tauri::async_runtime::spawn_blocking(move || {
        download_update_asset(&download_url, &asset_name)
    })
    .await
    .map_err(|e| format!("failed to join update download task: {}", e))?
    .map_err(|e| e.to_string())?;

    let app_pid = std::process::id();

    #[cfg(target_os = "windows")]
    {
        let script = write_windows_updater_script(&installer, app_pid).map_err(|e| e.to_string())?;
        launch_windows_updater(&script).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let script = write_linux_updater_script(&installer, app_pid).map_err(|e| e.to_string())?;
        launch_linux_updater(&script).map_err(|e| format!(
            "{}\nTip: run `dropzone --update` in a terminal if GUI elevation fails.",
            e
        ))?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = installer;
        return Err("updates are not supported on this OS yet".to_string());
    }

    app.exit(0);
    Ok(())
}

fn main() {
    if std::env::args().any(|arg| arg == "--update") {
        let exit_code = match run_cli_update() {
            Ok(code) => code,
            Err(err) => {
                eprintln!("Update failed: {}", err);
                1
            }
        };
        std::process::exit(exit_code);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init()) 
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Open Dropzone", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::with_id("dropzone-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Dropzone")
                .on_menu_event(|app: &tauri::AppHandle, event| {
                    match event.id.as_ref() {
                        "quit" => {
                            std::process::exit(0);
                        }
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            let ctrl_shift_d = Shortcut::from_str("Ctrl+Shift+D").unwrap();
            app.global_shortcut().on_shortcut(ctrl_shift_d, move |app: &tauri::AppHandle, shortcut, _event| {
                if shortcut == &ctrl_shift_d {
                    if let Some(window) = app.get_webview_window("main") {
                        let is_visible = window.is_visible().unwrap_or(false);
                        if is_visible {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
            })?;

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide();
                api.prevent_close();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            check_for_updates,
            download_and_install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}