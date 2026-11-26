//! Cross-platform real PTY manager using `portable-pty` (ConPTY on Windows, PTY on Unix).

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySessionDescriptor {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PtyOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PtyExitPayload {
    session_id: String,
}

struct ActivePty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, ActivePty>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn open_session(
        &self,
        app: Option<&AppHandle>,
        cols: u16,
        rows: u16,
        shell_cmd: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<PtySessionDescriptor, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(8),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| crate::tf!("PTY açılamadı: {e}", "Failed to open PTY: {e}"))?;

        let default_shell = if cfg!(windows) {
            "powershell.exe"
        } else {
            "bash"
        };
        let mut cmd = CommandBuilder::new(shell_cmd.filter(|s| !s.is_empty()).unwrap_or(default_shell));
        if cfg!(windows) && shell_cmd.is_none() {
            cmd.arg("-NoLogo");
        }
        if let Some(dir) = cwd.filter(|s| !s.trim().is_empty()) {
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| crate::tf!("Kabuk başlatılamadı: {e}", "Failed to spawn shell: {e}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| crate::tf!("PTY okuyucu alınamadı: {e}", "Failed to acquire PTY reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| crate::tf!("PTY yazıcı alınamadı: {e}", "Failed to acquire PTY writer: {e}"))?;

        let session_id = format!("lpty-{}", &Uuid::new_v4().to_string()[..8]);
        let sid_for_thread = session_id.clone();
        let app_clone = app.cloned();

        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        if let Some(handle) = app_clone.as_ref() {
                            let _ = handle.emit(
                                "pty://output",
                                PtyOutputPayload {
                                    session_id: sid_for_thread.clone(),
                                    data: text,
                                },
                            );
                        }
                    }
                }
            }
            if let Some(handle) = app_clone.as_ref() {
                let _ = handle.emit(
                    "pty://exit",
                    PtyExitPayload {
                        session_id: sid_for_thread,
                    },
                );
            }
        });

        let mut guard = self.sessions.lock().expect("pty mutex poisoned");
        guard.insert(
            session_id.clone(),
            ActivePty {
                master: pair.master,
                writer,
                child,
            },
        );

        Ok(PtySessionDescriptor {
            session_id,
            cols,
            rows,
            title: if cfg!(windows) {
                "PowerShell (ConPTY)".to_string()
            } else {
                "Bash (PTY)".to_string()
            },
        })
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut guard = self.sessions.lock().expect("pty mutex poisoned");
        let sess = guard.get_mut(session_id).ok_or_else(|| {
            crate::tf!(
                "PTY oturumu bulunamadı: {session_id}",
                "PTY session not found: {session_id}"
            )
        })?;
        sess.writer
            .write_all(data.as_bytes())
            .and_then(|_| sess.writer.flush())
            .map_err(|e| crate::tf!("PTY yazma hatası: {e}", "PTY write error: {e}"))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let guard = self.sessions.lock().expect("pty mutex poisoned");
        let sess = guard.get(session_id).ok_or_else(|| {
            crate::tf!(
                "PTY oturumu bulunamadı: {session_id}",
                "PTY session not found: {session_id}"
            )
        })?;
        sess.master
            .resize(PtySize {
                rows: rows.max(4),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| crate::tf!("PTY boyutlandırma hatası: {e}", "PTY resize error: {e}"))
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let mut guard = self.sessions.lock().expect("pty mutex poisoned");
        if let Some(mut sess) = guard.remove(session_id) {
            let _ = sess.child.kill();
            let _ = sess.child.wait();
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let mut guard = self.sessions.lock().expect("pty mutex poisoned");
        for (_, mut sess) in guard.drain() {
            let _ = sess.child.kill();
            let _ = sess.child.wait();
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_session_open_resize_write_and_clean_close() {
        let mgr = PtyManager::new();
        let cmd = if cfg!(windows) { "cmd.exe" } else { "sh" };
        let desc = mgr
            .open_session(None, 80, 24, Some(cmd), None)
            .expect("open PTY session");
        assert!(desc.session_id.starts_with("lpty-"));
        mgr.resize(&desc.session_id, 120, 40).expect("resize PTY");
        mgr.write(&desc.session_id, "exit\r\n").expect("write PTY");
        mgr.close(&desc.session_id).expect("close PTY");
    }
}
