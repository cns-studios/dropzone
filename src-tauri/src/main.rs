// Prevents additional console window on Windows in release, do not remove!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::distributions::Alphanumeric;
use rand::{thread_rng, Rng};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::sync::{LazyLock, Mutex};
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
const OAUTH_LOOPBACK_REDIRECT: &str = "http://127.0.0.1:43873/callback";
const OAUTH_CALLBACK_TIMEOUT_SECS: u64 = 240;
const OAUTH_CALLBACK_TEMPLATE: &str = include_str!("oauth_callback.html");

#[derive(Debug, Deserialize)]
struct DesktopOAuthConfig {
    auth_url: String,
    client_id: String,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenExchangeResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Debug, Serialize)]
struct OAuthStartResponse {
    session_id: String,
    auth_url: String,
}

#[derive(Debug, Serialize, Clone)]
struct OAuthPollResponse {
    status: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct OAuthSessionState {
    status: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    error: Option<String>,
}

static OAUTH_SESSIONS: LazyLock<Mutex<HashMap<String, OAuthSessionState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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

#[derive(Debug, Deserialize)]
struct DesktopApiRequest {
    server_url: String,
    access_token: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
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

fn random_token(len: usize) -> String {
    thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(digest)
}

fn update_oauth_session(session_id: &str, next: OAuthSessionState) {
    if let Ok(mut sessions) = OAUTH_SESSIONS.lock() {
        sessions.insert(session_id.to_string(), next);
    }
}

fn fetch_desktop_oauth_config(server_url: &str) -> Result<DesktopOAuthConfig> {
    let url = format!(
        "{}/desktop/auth/oauth/config",
        server_url.trim_end_matches('/')
    );
    let config = github_client()?
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", HTTP_USER_AGENT)
        .send()
        .context("failed to fetch desktop OAuth config")?
        .error_for_status()
        .context("desktop OAuth config endpoint returned error")?
        .json::<DesktopOAuthConfig>()
        .context("failed to parse desktop OAuth config JSON")?;
    Ok(config)
}

#[tauri::command]
fn desktop_device_api(request: DesktopApiRequest) -> Result<serde_json::Value, String> {
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|err| format!("invalid HTTP method: {}", err))?;
    let url = format!("{}{}", request.server_url.trim_end_matches('/'), request.path);

    let client = github_client().map_err(|err| err.to_string())?;
    let mut builder = client
        .request(method, url)
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", request.access_token))
        .header("User-Agent", HTTP_USER_AGENT);

    if let Some(body) = request.body {
        builder = builder.header("Content-Type", "application/json").body(body.to_string());
    }

    let response = builder
        .send()
        .map_err(|err| format!("request failed: {}", err))?;

    let status = response.status();
    let text = response.text().map_err(|err| format!("failed to read response: {}", err))?;
    if !status.is_success() {
        return Err(text);
    }

    if text.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }

    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) => Ok(value),
        Err(_) => Ok(serde_json::json!({"text": text})),
    }
}

fn exchange_auth_code(
    auth_base_url: &str,
    code: &str,
    code_verifier: &str,
    client_id: &str,
    state: &str,
) -> Result<OAuthTokenExchangeResponse> {
    let token_url = format!("{}/v2/token", auth_base_url.trim_end_matches('/'));
    let payload = serde_json::json!({
        "code": code,
        "code_verifier": code_verifier,
        "client_id": client_id,
        "redirect_uri": OAUTH_LOOPBACK_REDIRECT,
        "state": state,
    });

    let token = github_client()?
        .post(token_url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", HTTP_USER_AGENT)
        .body(payload.to_string())
        .send()
        .context("failed to exchange auth code")?
        .error_for_status()
        .context("auth code exchange returned error")?
        .json::<OAuthTokenExchangeResponse>()
        .context("failed to parse token exchange response")?;

    Ok(token)
}

fn parse_callback_query(request_data: &str) -> Option<HashMap<String, String>> {
    let line = request_data.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    if method != "GET" {
        return None;
    }

    let target = parts.next()?;
    let query = target.split('?').nth(1)?;
    let query = query.split('#').next().unwrap_or(query);
    let mut result = HashMap::new();
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        let k = kv.next().unwrap_or("");
        let v = kv.next().unwrap_or("");
        if k.is_empty() {
            continue;
        }
        let decoded = urlencoding::decode(v).ok()?.to_string();
        result.insert(k.to_string(), decoded);
    }
    Some(result)
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn render_loopback_body(ok: bool, message: &str) -> String {
    let status_label = if ok { "Login completed" } else { "Login failed" };
    let title = if ok {
        "You are signed in"
    } else {
        "We could not complete sign in"
    };
    let dot_color = if ok { "#2de19e" } else { "#ff6868" };

    OAUTH_CALLBACK_TEMPLATE
        .replace("__STATUS_LABEL__", status_label)
        .replace("__TITLE__", title)
        .replace("__MESSAGE__", &escape_html(message))
        .replace("__DOT_COLOR__", dot_color)
}

fn serve_loopback_response(stream: &mut std::net::TcpStream, ok: bool, message: &str) {
    let body = render_loopback_body(ok, message);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn run_loopback_session(session_id: String, auth_base_url: String, client_id: String, state: String, verifier: String) {
    let listener = match TcpListener::bind("127.0.0.1:43873") {
        Ok(v) => v,
        Err(err) => {
            update_oauth_session(
                &session_id,
                OAuthSessionState {
                    status: "failed".to_string(),
                    access_token: None,
                    refresh_token: None,
                    error: Some(format!("failed to bind oauth callback port: {}", err)),
                },
            );
            return;
        }
    };

    let _ = listener.set_nonblocking(false);
    let _ = listener.set_ttl(1);

    for incoming in listener.incoming() {
        let mut stream = match incoming {
            Ok(s) => s,
            Err(err) => {
                update_oauth_session(
                    &session_id,
                    OAuthSessionState {
                        status: "failed".to_string(),
                        access_token: None,
                        refresh_token: None,
                        error: Some(format!("oauth callback listener failed: {}", err)),
                    },
                );
                return;
            }
        };

        let mut buffer = [0u8; 8192];
        let read_count = stream.read(&mut buffer).unwrap_or(0);
        if read_count == 0 {
            serve_loopback_response(&mut stream, false, "No callback payload received.");
            continue;
        }

        let request_text = String::from_utf8_lossy(&buffer[..read_count]).to_string();
        let Some(query) = parse_callback_query(&request_text) else {
            serve_loopback_response(&mut stream, false, "Callback query is invalid.");
            continue;
        };

        let code = query.get("code").cloned().unwrap_or_default();
        let returned_state = query.get("state").cloned().unwrap_or_default();
        if code.is_empty() || returned_state != state {
            serve_loopback_response(&mut stream, false, "State validation failed or code missing.");
            update_oauth_session(
                &session_id,
                OAuthSessionState {
                    status: "failed".to_string(),
                    access_token: None,
                    refresh_token: None,
                    error: Some("oauth callback validation failed".to_string()),
                },
            );
            return;
        }

        match exchange_auth_code(&auth_base_url, &code, &verifier, &client_id, &state) {
            Ok(token) => {
                serve_loopback_response(&mut stream, true, "Dropzone is finalizing your session.");
                update_oauth_session(
                    &session_id,
                    OAuthSessionState {
                        status: "completed".to_string(),
                        access_token: Some(token.access_token),
                        refresh_token: token.refresh_token,
                        error: None,
                    },
                );
                return;
            }
            Err(err) => {
                serve_loopback_response(&mut stream, false, "Token exchange failed.");
                update_oauth_session(
                    &session_id,
                    OAuthSessionState {
                        status: "failed".to_string(),
                        access_token: None,
                        refresh_token: None,
                        error: Some(format!("oauth token exchange failed: {}", err)),
                    },
                );
                return;
            }
        }
    }
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

#[tauri::command]
async fn start_oauth_loopback(server_url: String) -> Result<OAuthStartResponse, String> {
    let trimmed = server_url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("server URL is required".to_string());
    }

    let oauth_config = tauri::async_runtime::spawn_blocking({
        let value = trimmed.clone();
        move || fetch_desktop_oauth_config(&value)
    })
    .await
    .map_err(|e| format!("failed to join oauth config task: {}", e))?
    .map_err(|e| e.to_string())?;

    let session_id = random_token(32);
    let state = random_token(40);
    let verifier = random_token(96);
    let challenge = pkce_challenge(&verifier);

    let auth_url = format!(
        "{}/login?response_type=code&client_id={}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&scope=openid%20profile&state={}",
        oauth_config.auth_url.trim_end_matches('/'),
        urlencoding::encode(&oauth_config.client_id),
        urlencoding::encode(OAUTH_LOOPBACK_REDIRECT),
        urlencoding::encode(&challenge),
        urlencoding::encode(&state),
    );

    update_oauth_session(
        &session_id,
        OAuthSessionState {
            status: "pending".to_string(),
            access_token: None,
            refresh_token: None,
            error: None,
        },
    );

    std::thread::spawn({
        let sid = session_id.clone();
        let auth_base = oauth_config.auth_url;
        let client_id = oauth_config.client_id;
        let state_value = state;
        move || run_loopback_session(sid, auth_base, client_id, state_value, verifier)
    });

    let sid_for_timeout = session_id.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(OAUTH_CALLBACK_TIMEOUT_SECS));
        if let Ok(mut sessions) = OAUTH_SESSIONS.lock() {
            if let Some(current) = sessions.get_mut(&sid_for_timeout) {
                if current.status == "pending" {
                    current.status = "failed".to_string();
                    current.error = Some("oauth callback timed out".to_string());
                }
            }
        }
    });

    Ok(OAuthStartResponse { session_id, auth_url })
}

#[tauri::command]
fn poll_oauth_loopback(session_id: String) -> Result<OAuthPollResponse, String> {
    let sessions = OAUTH_SESSIONS
        .lock()
        .map_err(|_| "failed to lock oauth sessions".to_string())?;

    let Some(state) = sessions.get(&session_id) else {
        return Ok(OAuthPollResponse {
            status: "failed".to_string(),
            access_token: None,
            refresh_token: None,
            error: Some("oauth session not found".to_string()),
        });
    };

    Ok(OAuthPollResponse {
        status: state.status.clone(),
        access_token: state.access_token.clone(),
        refresh_token: state.refresh_token.clone(),
        error: state.error.clone(),
    })
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
        .plugin(tauri_plugin_http::init())
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
            download_and_install_update,
            desktop_device_api,
            start_oauth_loopback,
            poll_oauth_loopback
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}