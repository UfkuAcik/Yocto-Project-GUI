use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeStatus {
    pub running: bool,
    pub mode: String,
    pub port: u16,
    pub ws_url: String,
    pub http_url: String,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
}

pub struct BridgeManager {
    state: Mutex<BridgeInner>,
}

struct BridgeInner {
    child: Option<Child>,
    mode: String,
    port: u16,
    last_error: Option<String>,
}

impl Default for BridgeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl BridgeManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BridgeInner {
                child: None,
                mode: "mock".to_string(),
                port: 18765,
                last_error: None,
            }),
        }
    }

    fn locate_bridge_dir() -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("packages/yocto-bridge"));
            candidates.push(cwd.join("../packages/yocto-bridge"));
            candidates.push(cwd.join("../../packages/yocto-bridge"));
            candidates.push(cwd.join("../../../packages/yocto-bridge"));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("yocto-bridge"));
                candidates.push(dir.join("../../../../packages/yocto-bridge"));
                candidates.push(dir.join("../../../../../packages/yocto-bridge"));
            }
        }
        candidates.into_iter().find(|p| p.join("bridge/server.py").exists())
    }

    fn resolve_python(bridge_dir: &Path) -> String {
        let venv_win = bridge_dir.join(".venv/Scripts/python.exe");
        if venv_win.exists() {
            return venv_win.to_string_lossy().to_string();
        }
        let venv_unix = bridge_dir.join(".venv/bin/python");
        if venv_unix.exists() {
            return venv_unix.to_string_lossy().to_string();
        }
        if cfg!(windows) {
            "python".to_string()
        } else {
            "python3".to_string()
        }
    }

    fn pick_port(preferred: u16) -> u16 {
        if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
            return preferred;
        }
        TcpListener::bind(("127.0.0.1", 0))
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .unwrap_or(preferred)
    }

    pub fn ensure_started(&self, mock: bool) -> BridgeStatus {
        let mut guard = self.state.lock().expect("bridge mutex poisoned");
        if let Some(child) = guard.child.as_mut() {
            if let Ok(None) = child.try_wait() {
                return self.snapshot_locked(&guard);
            }
            guard.child = None;
        }

        let Some(bridge_dir) = Self::locate_bridge_dir() else {
            guard.last_error = Some(
                tr_en(
                    "packages/yocto-bridge dizini bulunamadı.",
                    "packages/yocto-bridge directory was not found.",
                )
                .to_string(),
            );
            return self.snapshot_locked(&guard);
        };

        let port = Self::pick_port(18765);
        let python_bin = Self::resolve_python(&bridge_dir);
        let mode_str = if mock { "mock" } else { "live" }.to_string();

        let mut cmd = Command::new(&python_bin);
        cmd.current_dir(&bridge_dir)
            .args(["-m", "bridge.server", "--host", "127.0.0.1", "--port", &port.to_string()]);
        if mock {
            cmd.arg("--mock");
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        match cmd.spawn() {
            Ok(child) => {
                guard.child = Some(child);
                guard.port = port;
                guard.mode = mode_str;
                guard.last_error = None;

                // Wait briefly until port accepts TCP connections
                let deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < deadline {
                    if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
            Err(err) => {
                guard.last_error = Some(crate::tf!(
                    "yocto-bridge başlatılamadı: {err}",
                    "Failed to start yocto-bridge: {err}"
                ));
            }
        }

        self.snapshot_locked(&guard)
    }

    pub fn status(&self) -> BridgeStatus {
        let mut guard = self.state.lock().expect("bridge mutex poisoned");
        if let Some(child) = guard.child.as_mut() {
            if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
                guard.child = None;
            }
        }
        self.snapshot_locked(&guard)
    }

    pub fn stop(&self) {
        let mut guard = self.state.lock().expect("bridge mutex poisoned");
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn snapshot_locked(&self, guard: &BridgeInner) -> BridgeStatus {
        let pid = guard.child.as_ref().map(|c| c.id());
        let running = pid.is_some() || std::net::TcpStream::connect(("127.0.0.1", guard.port)).is_ok();
        BridgeStatus {
            running,
            mode: guard.mode.clone(),
            port: guard.port,
            ws_url: format!("ws://127.0.0.1:{}/ws", guard.port),
            http_url: format!("http://127.0.0.1:{}", guard.port),
            pid,
            last_error: guard.last_error.clone(),
        }
    }
}

impl Drop for BridgeManager {
    fn drop(&mut self) {
        self.stop();
    }
}
