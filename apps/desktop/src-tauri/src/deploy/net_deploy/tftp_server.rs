use crate::i18n::tr_en;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use sysinfo::Networks;
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub ip: String,
    pub is_loopback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TftpTransferRecord {
    pub id: String,
    pub client_ip: String,
    pub filename: String,
    pub bytes_sent: u64,
    pub total_bytes: u64,
    pub speed_kb_s: f64,
    pub status: String,
    pub ts: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TftpStatus {
    pub running: bool,
    pub bind_ip: String,
    pub port: u16,
    pub root_dir: String,
    pub transfers: Vec<TftpTransferRecord>,
}

pub fn list_network_interfaces() -> Vec<NetworkInterfaceInfo> {
    let mut out = vec![NetworkInterfaceInfo {
        name: tr_en("Tüm Arayüzler (Any)", "All Interfaces (Any)").into(),
        ip: "0.0.0.0".into(),
        is_loopback: false,
    }];
    let networks = Networks::new_with_refreshed_list();
    for (iface_name, data) in &networks {
        for ipn in data.ip_networks() {
            if let IpAddr::V4(v4) = ipn.addr {
                if !v4.is_unspecified() {
                    out.push(NetworkInterfaceInfo {
                        name: iface_name.clone(),
                        ip: v4.to_string(),
                        is_loopback: v4.is_loopback(),
                    });
                }
            }
        }
    }
    if !out.iter().any(|n| n.ip == "127.0.0.1") {
        out.push(NetworkInterfaceInfo {
            name: "Loopback".into(),
            ip: "127.0.0.1".into(),
            is_loopback: true,
        });
    }
    out
}

pub fn generate_uboot_tftp_script(
    server_ip: &str,
    target_ip: &str,
    kernel_file: &str,
    dtb_file: &str,
) -> String {
    let srv = if server_ip == "0.0.0.0" { "<HOST_IP>" } else { server_ip };
    format!(
        "setenv ipaddr {target_ip}\n\
         setenv serverip {srv}\n\
         tftpboot ${{loadaddr}} {kernel_file}\n\
         tftpboot ${{fdt_addr_r}} {dtb_file}\n\
         booti ${{loadaddr}} - ${{fdt_addr_r}}"
    )
}

pub fn resolve_safe_tftp_file(root: &Path, req_name: &str) -> Result<PathBuf, String> {
    let trimmed = req_name.trim_start_matches(['/', '\\']).trim();
    if trimmed.is_empty() || trimmed.contains(':') || trimmed.contains('\0') {
        return Err(tr_en("Geçersiz TFTP dosya adı.", "Invalid TFTP filename.").into());
    }
    let rel = Path::new(trimmed);
    for comp in rel.components() {
        match comp {
            Component::Normal(_) => {}
            _ => {
                return Err(
                    tr_en(
                        "Güvenlik İhlali: TFTP dizin dışına çıkış (..) engellendi.",
                        "Security Violation: TFTP path traversal (..) is blocked.",
                    )
                    .into(),
                )
            }
        }
    }
    let canon_root = root.canonicalize().map_err(|e| {
        crate::tf!(
            "TFTP kök dizini erişilemedi: {e}",
            "Failed to access TFTP root directory: {e}"
        )
    })?;
    let candidate = canon_root.join(rel);
    let canon_file = candidate.canonicalize().map_err(|e| {
        crate::tf!(
            "Dosya bulunamadı ({trimmed}): {e}",
            "File not found ({trimmed}): {e}"
        )
    })?;
    if !canon_file.starts_with(&canon_root) || !canon_file.is_file() {
        return Err(
            tr_en(
                "Dosya TFTP kök dizini dışında veya düzenli dosya değil.",
                "File is outside the TFTP root directory or is not a regular file.",
            )
            .into(),
        );
    }
    Ok(canon_file)
}

#[derive(Default)]
struct TftpInner {
    running: bool,
    bind_ip: String,
    port: u16,
    root_dir: String,
    transfers: Vec<TftpTransferRecord>,
    stop_tx: Option<watch::Sender<bool>>,
}

pub struct TftpServerManager {
    inner: Arc<Mutex<TftpInner>>,
}

impl Default for TftpServerManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(TftpInner::default())),
        }
    }
}

impl TftpServerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> TftpStatus {
        let guard = self.inner.lock().expect("tftp mutex");
        TftpStatus {
            running: guard.running,
            bind_ip: guard.bind_ip.clone(),
            port: guard.port,
            root_dir: guard.root_dir.clone(),
            transfers: guard.transfers.clone(),
        }
    }

    pub async fn start(
        &self,
        app: Option<AppHandle>,
        bind_ip: &str,
        port: u16,
        root_dir: &str,
    ) -> Result<TftpStatus, String> {
        self.stop().await;

        let root_path = PathBuf::from(root_dir);
        if !root_path.exists() {
            std::fs::create_dir_all(&root_path).map_err(|e| {
                crate::tf!(
                    "TFTP kök dizini oluşturulamadı ({root_dir}): {e}",
                    "Failed to create TFTP root directory ({root_dir}): {e}"
                )
            })?;
        }

        let bind_addr = format!("{bind_ip}:{port}");
        let socket = UdpSocket::bind(&bind_addr).await.map_err(|e| {
            crate::tf!(
                "TFTP UDP portu ({bind_addr}) bağlanamadı (69 yerine 1069 deneyebilirsiniz): {e}",
                "Failed to bind TFTP UDP port ({bind_addr}; try 1069 instead of 69): {e}"
            )
        })?;
        let actual_port = socket.local_addr().map(|a| a.port()).unwrap_or(port);
        let (stop_tx, mut stop_rx) = watch::channel(false);

        {
            let mut guard = self.inner.lock().expect("tftp mutex");
            guard.running = true;
            guard.bind_ip = bind_ip.to_string();
            guard.port = actual_port;
            guard.root_dir = root_path.to_string_lossy().to_string();
            guard.transfers.clear();
            guard.stop_tx = Some(stop_tx);
        }

        let inner_ref = Arc::clone(&self.inner);
        let root_clone = root_path.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            loop {
                tokio::select! {
                    _ = stop_rx.changed() => {
                        if *stop_rx.borrow() {
                            break;
                        }
                    }
                    recv_res = socket.recv_from(&mut buf) => {
                        let Ok((len, peer)) = recv_res else { break; };
                        if len < 4 { continue; }
                        let opcode = u16::from_be_bytes([buf[0], buf[1]]);
                        if opcode != 1 { continue; } // Only RRQ on main listener
                        let parsed = parse_rrq_packet(&buf[2..len]);
                        let root_for_req = root_clone.clone();
                        let inner_for_req = Arc::clone(&inner_ref);
                        let app_for_req = app.clone();
                        let stop_for_req = stop_rx.clone();
                        tokio::spawn(async move {
                            handle_tftp_rrq(parsed, peer, root_for_req, inner_for_req, app_for_req, stop_for_req).await;
                        });
                    }
                }
            }
            if let Ok(mut guard) = inner_ref.lock() {
                guard.running = false;
            }
        });

        Ok(self.status())
    }

    pub async fn stop(&self) -> TftpStatus {
        let tx = {
            let mut guard = self.inner.lock().expect("tftp mutex");
            guard.running = false;
            guard.stop_tx.take()
        };
        if let Some(sender) = tx {
            let _ = sender.send(true);
        }
        self.status()
    }

    pub fn stop_blocking(&self) {
        let tx = {
            let mut guard = self.inner.lock().expect("tftp mutex");
            guard.running = false;
            guard.stop_tx.take()
        };
        if let Some(sender) = tx {
            let _ = sender.send(true);
        }
    }
}

fn parse_rrq_packet(payload: &[u8]) -> (String, HashMap<String, String>) {
    let parts: Vec<&[u8]> = payload.split(|b| *b == 0).collect();
    let filename = parts
        .first()
        .map(|s| String::from_utf8_lossy(s).to_string())
        .unwrap_or_default();
    let mut opts = HashMap::new();
    let mut i = 2; // skip filename & mode ("octet")
    while i + 1 < parts.len() {
        let k = String::from_utf8_lossy(parts[i]).to_ascii_lowercase();
        let v = String::from_utf8_lossy(parts[i + 1]).to_string();
        if !k.is_empty() {
            opts.insert(k, v);
        }
        i += 2;
    }
    (filename, opts)
}

fn build_error_packet(code: u16, msg: &str) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(5 + msg.len());
    pkt.extend_from_slice(&5u16.to_be_bytes());
    pkt.extend_from_slice(&code.to_be_bytes());
    pkt.extend_from_slice(msg.as_bytes());
    pkt.push(0);
    pkt
}

fn record_transfer(
    inner: &Arc<Mutex<TftpInner>>,
    app: Option<&AppHandle>,
    rec: TftpTransferRecord,
) {
    if let Ok(mut guard) = inner.lock() {
        if let Some(existing) = guard.transfers.iter_mut().find(|t| t.id == rec.id) {
            *existing = rec.clone();
        } else {
            guard.transfers.insert(0, rec.clone());
            guard.transfers.truncate(30);
        }
    }
    if let Some(h) = app {
        let _ = h.emit("deploy://tftp-transfer", rec);
    }
}

async fn handle_tftp_rrq(
    (filename, opts): (String, HashMap<String, String>),
    peer: SocketAddr,
    root: PathBuf,
    inner: Arc<Mutex<TftpInner>>,
    app: Option<AppHandle>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let Ok(tx_sock) = UdpSocket::bind("0.0.0.0:0").await else {
        return;
    };

    let safe_path = match resolve_safe_tftp_file(&root, &filename) {
        Ok(p) => p,
        Err(err) => {
            let err_pkt = build_error_packet(1, &err);
            let _ = tx_sock.send_to(&err_pkt, peer).await;
            return;
        }
    };

    const MAX_TFTP_FILE_BYTES: u64 = 512 * 1024 * 1024;
    let Ok(meta) = tokio::fs::metadata(&safe_path).await else {
        let _ = tx_sock.send_to(&build_error_packet(2, "Stat failure"), peer).await;
        return;
    };
    if meta.len() > MAX_TFTP_FILE_BYTES {
        let _ = tx_sock
            .send_to(&build_error_packet(3, "File exceeds 512 MiB TFTP limit"), peer)
            .await;
        return;
    }

    let Ok(bytes) = tokio::fs::read(&safe_path).await else {
        let _ = tx_sock.send_to(&build_error_packet(2, "Read failure"), peer).await;
        return;
    };

    let blksize: usize = opts
        .get("blksize")
        .and_then(|v| v.parse::<usize>().ok())
        .map(|v| v.clamp(8, 1468))
        .unwrap_or(512);

    // Send RFC 2348 OACK if blksize or tsize requested
    if opts.contains_key("blksize") || opts.contains_key("tsize") {
        let mut oack = vec![0u8, 6u8];
        if opts.contains_key("blksize") {
            oack.extend_from_slice(b"blksize\0");
            oack.extend_from_slice(blksize.to_string().as_bytes());
            oack.push(0);
        }
        if opts.contains_key("tsize") {
            oack.extend_from_slice(b"tsize\0");
            oack.extend_from_slice(bytes.len().to_string().as_bytes());
            oack.push(0);
        }
        let _ = tx_sock.send_to(&oack, peer).await;
        let mut ack_buf = [0u8; 64];
        if let Ok(Ok((_, ack_peer))) = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            tx_sock.recv_from(&mut ack_buf),
        )
        .await
        {
            if ack_peer != peer {
                let _ = tx_sock
                    .send_to(&build_error_packet(5, "Unknown transfer ID"), ack_peer)
                    .await;
            }
        }
    }

    let xfer_id = format!("tftp-{}", &Uuid::new_v4().to_string()[..8]);
    let total_bytes = bytes.len() as u64;
    let started = Instant::now();
    let mut offset = 0usize;
    let mut block_num: u16 = 1;

    loop {
        if *stop_rx.borrow() {
            break;
        }
        let end = (offset + blksize).min(bytes.len());
        let slice = &bytes[offset..end];
        let mut pkt = Vec::with_capacity(4 + slice.len());
        pkt.extend_from_slice(&3u16.to_be_bytes());
        pkt.extend_from_slice(&block_num.to_be_bytes());
        pkt.extend_from_slice(slice);

        let mut acked = false;
        let mut ack_buf = [0u8; 64];
        for _retry in 0..3 {
            if tx_sock.send_to(&pkt, peer).await.is_err() {
                break;
            }
            tokio::select! {
                _ = stop_rx.changed() => { return; }
                ack_res = tokio::time::timeout(std::time::Duration::from_secs(2), tx_sock.recv_from(&mut ack_buf)) => {
                    if let Ok(Ok((alen, ack_peer))) = ack_res {
                        if ack_peer == peer && alen >= 4 && u16::from_be_bytes([ack_buf[0], ack_buf[1]]) == 4 {
                            let ack_blk = u16::from_be_bytes([ack_buf[2], ack_buf[3]]);
                            if ack_blk == block_num {
                                acked = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
        if !acked {
            record_transfer(
                &inner,
                app.as_ref(),
                TftpTransferRecord {
                    id: xfer_id,
                    client_ip: peer.ip().to_string(),
                    filename,
                    bytes_sent: offset as u64,
                    total_bytes,
                    speed_kb_s: 0.0,
                    status: "timeout".into(),
                    ts: Local::now().format("%H:%M:%S").to_string(),
                },
            );
            return;
        }

        offset = end;
        let secs = started.elapsed().as_secs_f64().max(0.005);
        let speed_kb_s = (offset as f64 / 1024.0) / secs;
        let finished = slice.len() < blksize;

        if finished || block_num % 16 == 0 {
            record_transfer(
                &inner,
                app.as_ref(),
                TftpTransferRecord {
                    id: xfer_id.clone(),
                    client_ip: peer.ip().to_string(),
                    filename: filename.clone(),
                    bytes_sent: offset as u64,
                    total_bytes,
                    speed_kb_s,
                    status: if finished { "completed" } else { "sending" }.into(),
                    ts: Local::now().format("%H:%M:%S").to_string(),
                },
            );
        }

        if finished {
            break;
        }
        block_num = block_num.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tftp_server_serves_file_over_udp_and_rejects_path_traversal() {
        let dir = std::env::temp_dir().join(format!("yocto_tftp_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let payload = b"YOCTO-KERNEL-IMAGE-TFTP-TEST-BYTES-1234567890";
        std::fs::write(dir.join("Image"), payload).unwrap();

        let mgr = TftpServerManager::new();
        let st = mgr
            .start(None, "127.0.0.1", 0, dir.to_str().unwrap())
            .await
            .unwrap();
        assert!(st.running);
        assert!(st.port > 0);
        let srv_addr: SocketAddr = format!("127.0.0.1:{}", st.port).parse().unwrap();

        // 1. Valid RRQ download
        let cli = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mut rrq = vec![0u8, 1u8];
        rrq.extend_from_slice(b"Image\0octet\0");
        cli.send_to(&rrq, srv_addr).await.unwrap();

        let mut buf = [0u8; 1024];
        let (n, data_peer) = tokio::time::timeout(std::time::Duration::from_secs(2), cli.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(u16::from_be_bytes([buf[0], buf[1]]), 3); // DATA
        assert_eq!(u16::from_be_bytes([buf[2], buf[3]]), 1); // Block 1
        assert_eq!(&buf[4..n], payload);

        let ack = [0u8, 4u8, 0u8, 1u8];
        cli.send_to(&ack, data_peer).await.unwrap();

        // 2. Traversal attack must get TFTP ERROR opcode 5
        let mut bad_rrq = vec![0u8, 1u8];
        bad_rrq.extend_from_slice(b"../etc/passwd\0octet\0");
        cli.send_to(&bad_rrq, srv_addr).await.unwrap();
        let (en, _) = tokio::time::timeout(std::time::Duration::from_secs(2), cli.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert!(en >= 4);
        assert_eq!(u16::from_be_bytes([buf[0], buf[1]]), 5); // ERROR

        mgr.stop().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
