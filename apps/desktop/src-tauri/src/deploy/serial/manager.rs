use crate::deploy::serial::uboot_macros::detect_autoboot_prompt;
use crate::i18n::tr_en;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity, SerialPort, SerialPortType, StopBits};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub description: String,
    pub vid: Option<String>,
    pub pid: Option<String>,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub is_virtual: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialOpenConfig {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,   // 7 or 8
    pub parity: String,  // "none" | "even" | "odd"
    pub stop_bits: u8,   // 1 or 2
    pub auto_interrupt_uboot: bool,
    pub interrupt_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialDataEvent {
    pub session_id: String,
    pub data: String,
    pub ts: String,
}

type TestSink = Arc<dyn Fn(String) + Send + Sync>;

struct ActiveSerialSession {
    port_handle: Option<Arc<Mutex<Box<dyn SerialPort>>>>,
    virtual_input: Option<Arc<Mutex<Vec<String>>>>,
    auto_interrupt: Arc<AtomicBool>,
    interrupt_key: String,
    stop_flag: Arc<AtomicBool>,
    transcript: Arc<Mutex<String>>,
    app: Option<AppHandle>,
    test_sink: Option<TestSink>,
}

pub struct SerialManager {
    sessions: Mutex<HashMap<String, ActiveSerialSession>>,
}

impl Default for SerialManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

fn emit_serial_chunk(
    session_id: &str,
    text: &str,
    transcript: &Arc<Mutex<String>>,
    app: Option<&AppHandle>,
    test_sink: Option<&TestSink>,
) {
    if text.is_empty() {
        return;
    }
    if let Ok(mut guard) = transcript.lock() {
        guard.push_str(text);
        if guard.len() > 256 * 1024 {
            let cut = guard.len() - 196 * 1024;
            guard.drain(..cut);
        }
    }
    if let Some(sink) = test_sink {
        sink(text.to_string());
    }
    if let Some(handle) = app {
        let _ = handle.emit(
            "deploy://serial-data",
            SerialDataEvent {
                session_id: session_id.to_string(),
                data: text.to_string(),
                ts: Local::now().format("%H:%M:%S%.3f").to_string(),
            },
        );
    }
}

impl SerialManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list_ports(&self, include_virtual: bool) -> Vec<SerialPortInfo> {
        let mut list = Vec::new();
        if let Ok(ports) = serialport::available_ports() {
            for p in ports {
                let (desc, vid, pid, mfg, sn) = match p.port_type {
                    SerialPortType::UsbPort(u) => (
                        u.product.unwrap_or_else(|| "USB Serial".into()),
                        Some(format!("{:04x}", u.vid)),
                        Some(format!("{:04x}", u.pid)),
                        u.manufacturer,
                        u.serial_number,
                    ),
                    SerialPortType::BluetoothPort => ("Bluetooth SPP".into(), None, None, None, None),
                    SerialPortType::PciPort => ("PCI Serial".into(), None, None, None, None),
                    SerialPortType::Unknown => (
                        tr_en("Standart Seri Port", "Standard Serial Port").into(),
                        None,
                        None,
                        None,
                        None,
                    ),
                };
                list.push(SerialPortInfo {
                    port_name: p.port_name,
                    description: desc,
                    vid,
                    pid,
                    manufacturer: mfg,
                    serial_number: sn,
                    is_virtual: false,
                });
            }
        }
        if include_virtual {
            list.push(SerialPortInfo {
                port_name: "mock://uart-imx8mp".into(),
                description: tr_en(
                    "Sanal i.MX8MP U-Boot / Linux UART (Simülasyon)",
                    "Virtual i.MX8MP U-Boot / Linux UART (Simulation)",
                )
                .into(),
                vid: Some("0403".into()),
                pid: Some("6001".into()),
                manufacturer: Some("FTDI (Virtual)".into()),
                serial_number: Some("MOCK-UART-01".into()),
                is_virtual: true,
            });
        }
        list
    }

    pub fn open_port(
        &self,
        app: Option<&AppHandle>,
        config: SerialOpenConfig,
        test_sink: Option<TestSink>,
    ) -> Result<String, String> {
        let session_id = format!("uart-{}", &Uuid::new_v4().to_string()[..8]);
        let stop_flag = Arc::new(AtomicBool::new(false));
        let auto_interrupt = Arc::new(AtomicBool::new(config.auto_interrupt_uboot));
        let interrupt_key = config
            .interrupt_key
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "\r".to_string());
        let transcript = Arc::new(Mutex::new(String::new()));
        let app_clone = app.cloned();
        let sink_clone = test_sink.clone();

        if config.port_name == "mock://uart-imx8mp" {
            let vinput = Arc::new(Mutex::new(Vec::<String>::new()));
            let session = ActiveSerialSession {
                port_handle: None,
                virtual_input: Some(Arc::clone(&vinput)),
                auto_interrupt: Arc::clone(&auto_interrupt),
                interrupt_key: interrupt_key.clone(),
                stop_flag: Arc::clone(&stop_flag),
                transcript: Arc::clone(&transcript),
                app: app_clone.clone(),
                test_sink: sink_clone.clone(),
            };
            self.sessions
                .lock()
                .expect("serial sessions mutex")
                .insert(session_id.clone(), session);

            let sid = session_id.clone();
            std::thread::spawn(move || {
                let boot_lines = [
                    "\r\nU-Boot SPL 2025.04-imx8mp-evk (Nov 25 2026 - 10:15:00 +0000)\r\n",
                    "DRAM: 6 GiB LPDDR4\r\nMMC: FSL_SDHC: 1, FSL_SDHC: 2\r\n",
                    "U-Boot 2025.04 (Yocto 6.0 Wrynose)\r\n",
                    "Hit any key to stop autoboot:  3 \r\n",
                ];
                for line in boot_lines {
                    if stop_flag.load(Ordering::Relaxed) {
                        return;
                    }
                    emit_serial_chunk(&sid, line, &transcript, app_clone.as_ref(), sink_clone.as_ref());
                    std::thread::sleep(Duration::from_millis(25));
                }

                // Wait briefly for interrupt or auto-interrupt trigger
                std::thread::sleep(Duration::from_millis(60));
                let interrupted_by_user = vinput.lock().map(|v| !v.is_empty()).unwrap_or(false);
                if auto_interrupt.load(Ordering::Relaxed) || interrupted_by_user {
                    if let Ok(mut v) = vinput.lock() {
                        v.clear();
                    }
                    emit_serial_chunk(
                        &sid,
                        tr_en(
                            "\r\n[Auto-Interrupt] U-Boot promptuna düşüldü.\r\nu-boot=> ",
                            "\r\n[Auto-Interrupt] Dropped into U-Boot prompt.\r\nu-boot=> ",
                        ),
                        &transcript,
                        app_clone.as_ref(),
                        sink_clone.as_ref(),
                    );
                } else {
                    emit_serial_chunk(
                        &sid,
                        "\r\nStarting kernel ...\r\nLinux version 6.12.19-yocto-standard\r\nroot@imx8mp-lpddr4-evk:~# ",
                        &transcript,
                        app_clone.as_ref(),
                        sink_clone.as_ref(),
                    );
                }

                let mut line_buf = String::new();
                while !stop_flag.load(Ordering::Relaxed) {
                    let pending: Vec<String> = {
                        let mut guard = vinput.lock().expect("vinput mutex");
                        std::mem::take(&mut *guard)
                    };
                    for chunk in pending {
                        for ch in chunk.chars() {
                            if ch == '\r' || ch == '\n' {
                                let cmd = line_buf.trim().to_string();
                                line_buf.clear();
                                let resp = match cmd.as_str() {
                                    "" => "\r\nu-boot=> ".to_string(),
                                    "printenv" => "\r\nbaudrate=115200\r\nbootcmd=run distro_bootcmd\r\nloadaddr=0x40480000\r\nfdt_addr_r=0x43000000\r\nu-boot=> ".to_string(),
                                    "ums 0 mmc 0" => tr_en(
                                        "\r\nUMS: LUN 0, dev mmc 0, hwpart 0, sector 0x0, count 0x3b72400 (USB gadget aktif)\r\nu-boot=> ",
                                        "\r\nUMS: LUN 0, dev mmc 0, hwpart 0, sector 0x0, count 0x3b72400 (USB gadget active)\r\nu-boot=> ",
                                    )
                                    .to_string(),
                                    "fastboot 0" => "\r\nStarting U-Boot USB Fastboot gadget on usb0...\r\nu-boot=> ".to_string(),
                                    "mmc list" => "\r\nFSL_SDHC: 1 (SD)\r\nFSL_SDHC: 2 (eMMC)\r\nu-boot=> ".to_string(),
                                    "reset" => "\r\nresetting ...\r\nU-Boot SPL 2025.04\r\nu-boot=> ".to_string(),
                                    _ if cmd.contains("tftpboot") => format!("\r\nUsing ethernet@30bf0000 device\r\nTFTP from server; loading '{cmd}' -> Bytes transferred = 34816000\r\nu-boot=> "),
                                    other => format!("\r\n[uart-mock] {other}\r\nu-boot=> "),
                                };
                                emit_serial_chunk(&sid, &resp, &transcript, app_clone.as_ref(), sink_clone.as_ref());
                            } else {
                                line_buf.push(ch);
                                emit_serial_chunk(&sid, &ch.to_string(), &transcript, app_clone.as_ref(), sink_clone.as_ref());
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(15));
                }
            });

            return Ok(session_id);
        }

        let db = match config.data_bits {
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        };
        let parity = match config.parity.to_ascii_lowercase().as_str() {
            "even" => Parity::Even,
            "odd" => Parity::Odd,
            _ => Parity::None,
        };
        let stop_bits = match config.stop_bits {
            2 => StopBits::Two,
            _ => StopBits::One,
        };

        let port_name = &config.port_name;
        let port = serialport::new(port_name, config.baud_rate)
            .data_bits(db)
            .parity(parity)
            .stop_bits(stop_bits)
            .timeout(Duration::from_millis(80))
            .open()
            .map_err(|e| {
                crate::tf!(
                    "Seri port açılamadı ({port_name}): {e}",
                    "Failed to open serial port ({port_name}): {e}"
                )
            })?;

        let port_arc: Arc<Mutex<Box<dyn SerialPort>>> = Arc::new(Mutex::new(port));
        let mut reader = port_arc
            .lock()
            .expect("serial port mutex")
            .try_clone()
            .map_err(|e| {
                crate::tf!(
                    "Seri port okuma tanıtıcısı klonlanamadı: {e}",
                    "Failed to clone serial port reader handle: {e}"
                )
            })?;

        let session = ActiveSerialSession {
            port_handle: Some(Arc::clone(&port_arc)),
            virtual_input: None,
            auto_interrupt: Arc::clone(&auto_interrupt),
            interrupt_key: interrupt_key.clone(),
            stop_flag: Arc::clone(&stop_flag),
            transcript: Arc::clone(&transcript),
            app: app_clone.clone(),
            test_sink: sink_clone.clone(),
        };
        self.sessions
            .lock()
            .expect("serial sessions mutex")
            .insert(session_id.clone(), session);

        let sid = session_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 2048];
            let mut rolling = String::new();
            let mut interrupted_once = false;
            while !stop_flag.load(Ordering::Relaxed) {
                match reader.read(&mut buf) {
                    Ok(n) if n > 0 => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        emit_serial_chunk(&sid, &text, &transcript, app_clone.as_ref(), sink_clone.as_ref());
                        if auto_interrupt.load(Ordering::Relaxed) && !interrupted_once {
                            rolling.push_str(&text);
                            if rolling.len() > 512 {
                                rolling = rolling[rolling.len() - 512..].to_string();
                            }
                            if detect_autoboot_prompt(&rolling) {
                                interrupted_once = true;
                                if let Ok(mut p) = port_arc.lock() {
                                    let _ = p.write_all(interrupt_key.as_bytes());
                                    let _ = p.flush();
                                }
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(_) => break,
                }
            }
        });

        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let guard = self.sessions.lock().expect("serial sessions mutex");
        let sess = guard.get(session_id).ok_or_else(|| {
            crate::tf!(
                "Bilinmeyen UART oturumu: {session_id}",
                "Unknown UART session: {session_id}"
            )
        })?;
        if let Some(ref port_arc) = sess.port_handle {
            let mut p = port_arc.lock().expect("serial port mutex");
            p.write_all(data.as_bytes())
                .map_err(|e| crate::tf!("UART yazma hatası: {e}", "UART write error: {e}"))?;
            p.flush()
                .map_err(|e| crate::tf!("UART flush hatası: {e}", "UART flush error: {e}"))?;
            return Ok(());
        }
        if let Some(ref vinput) = sess.virtual_input {
            vinput.lock().expect("vinput mutex").push(data.to_string());
            return Ok(());
        }
        Ok(())
    }

    pub fn set_auto_interrupt(&self, session_id: &str, enabled: bool) -> Result<(), String> {
        let guard = self.sessions.lock().expect("serial sessions mutex");
        let sess = guard.get(session_id).ok_or_else(|| {
            crate::tf!(
                "Bilinmeyen UART oturumu: {session_id}",
                "Unknown UART session: {session_id}"
            )
        })?;
        sess.auto_interrupt.store(enabled, Ordering::Relaxed);
        let _ = &sess.interrupt_key;
        let _ = &sess.app;
        let _ = &sess.test_sink;
        Ok(())
    }

    pub fn save_log(&self, session_id: &str, dest_path: &str) -> Result<usize, String> {
        let guard = self.sessions.lock().expect("serial sessions mutex");
        let sess = guard.get(session_id).ok_or_else(|| {
            crate::tf!(
                "Bilinmeyen UART oturumu: {session_id}",
                "Unknown UART session: {session_id}"
            )
        })?;
        let text = sess.transcript.lock().expect("transcript mutex").clone();
        let path = std::path::Path::new(dest_path);
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(path, text.as_bytes())
            .map_err(|e| crate::tf!("UART log kaydedilemedi: {e}", "Failed to save UART log: {e}"))?;
        Ok(text.len())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        if let Some(sess) = self
            .sessions
            .lock()
            .expect("serial sessions mutex")
            .remove(session_id)
        {
            sess.stop_flag.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let mut guard = self.sessions.lock().expect("serial sessions mutex");
        for (_, sess) in guard.drain() {
            sess.stop_flag.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_uart_auto_interrupts_uboot_and_executes_macros() {
        let mgr = SerialManager::new();
        let ports = mgr.list_ports(true);
        assert!(ports.iter().any(|p| p.port_name == "mock://uart-imx8mp"));

        let captured = Arc::new(Mutex::new(String::new()));
        let cap_clone = Arc::clone(&captured);
        let sink: TestSink = Arc::new(move |chunk| {
            cap_clone.lock().unwrap().push_str(&chunk);
        });

        let sid = mgr
            .open_port(
                None,
                SerialOpenConfig {
                    port_name: "mock://uart-imx8mp".into(),
                    baud_rate: 115_200,
                    data_bits: 8,
                    parity: "none".into(),
                    stop_bits: 1,
                    auto_interrupt_uboot: true,
                    interrupt_key: Some("\r".into()),
                },
                Some(sink),
            )
            .unwrap();

        std::thread::sleep(Duration::from_millis(260));
        mgr.write(&sid, "ums 0 mmc 0\r").unwrap();
        std::thread::sleep(Duration::from_millis(80));

        let out = captured.lock().unwrap().clone();
        assert!(out.contains("Hit any key to stop autoboot"));
        assert!(out.contains("u-boot=>"));
        assert!(out.contains("USB gadget aktif"));

        let log_file = std::env::temp_dir().join(format!("yocto_uart_log_{}.log", std::process::id()));
        let n = mgr.save_log(&sid, log_file.to_str().unwrap()).unwrap();
        assert!(n > 20);
        let _ = fs::remove_file(&log_file);

        mgr.close(&sid).unwrap();
    }
}
