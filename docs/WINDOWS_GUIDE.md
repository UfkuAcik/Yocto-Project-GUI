# Windows 10/11 & WSL2 / Docker / Target Flashing Guide

Yocto Studio was engineered from the ground up so Windows 10/11 embedded engineers can run serious Yocto 6.0 Wrynose & 5.0 Scarthgap builds cleanly without fighting NTFS slowdowns or `usbipd-win` USB passthrough headaches.

---

## 1. Mandatory WSL2 `ext4` Rule (`-32001 NTFS_PATH_FORBIDDEN`)

BitBake cannot safely build on Windows NTFS drives mounted via `/mnt/c` due to case-insensitivity, broken POSIX permissions/hardlinks, and severe 9p filesystem overhead.

- **Blocked automatically (`-32001`):** `/mnt/c/...`, `/mnt/d/...`, `C:\Users\...`, `\\wsl$\...`
- **Recommended `ext4` workspace paths inside WSL2:**
  - `/home/<user>/yocto-studio/<project-name>`
  - `/home/<user>/yocto-cache/sstate-cache` and `/home/<user>/yocto-cache/downloads`
  - Or a dedicated second `ext4` virtual disk (`yocto-builds.vhdx`) mounted at `/mnt/yocto-ext4`.

---

## 2. Tuning `.wslconfig` for Yocto 6.0 Wrynose

Compiling Chromium, Qt, LLVM, or `linux-yocto` inside WSL2 can trigger Linux OOM kills if default WSL2 memory limits (`50%` host RAM) are left untuned.

Use **Environment Doctor (Module 1)** -> **Configure `.wslconfig`** (or edit `%USERPROFILE%\.wslconfig`) safely:

```ini
[wsl2]
memory=24GB
processors=8
swap=8GB
```

After updating `.wslconfig`, run `wsl --shutdown` in PowerShell before reopening WSL2. You can also compact bloated `.vhdx` build images from **Environment Doctor** using `Optimize-VHD` or `diskpart`.

---

## 3. Docker / CROPS / `kas` Named Volumes (Windows)

When using the **Docker** provider instead of WSL2, never bind-mount Windows host folders (`C:\...`) as `TMPDIR` or `SSTATE_DIR`. Yocto Studio enforces Linux Docker **named volumes** (`yocto-sstate`, `yocto-dl`, `yocto-tmp`) ensuring pure `ext4` container performance alongside `crops/poky` or `ghcr.io/siemens/kas`.

---

## 4. Driver-Free Host-Native USB, Ethernet & UART Flashing

Yocto Studio does **not** require `usbipd-win`. All hardware I/O runs natively inside the Rust Tauri core on Windows:

1. **Automatic Staging:** Artifacts built inside WSL2/Docker/Remote SSH (`.wic`, `.wic.bz2`, `.wic.zst`, `.swu`, `.raucb`, `.dtb`, `Image`, `.bmap`, `.sha256`) are streamed once into `%APPDATA%\dev.yoctostudio.desktop\staging\<project>\<machine>\` and verified by SHA-256 (skipped on subsequent runs if SHA-256 matches).
2. **USB Flashers (`PATH` or Tool Settings):**
   - `uuu` (NXP Universal Update Utility for i.MX6/7/8/9)
   - `fastboot` (Android Platform Tools)
   - `dfu-util`
   - `STM32_Programmer_CLI`
   - **Removable Raw Disk / UMS Writer:** Built directly in Rust with streaming `.gz`/`.bz2`/`.zst` decompression and strict OS-disk exclusion (`PhysicalDrive0` / `C:\` can never be selected).
3. **Ethernet & UART:** Embedded Windows host **TFTP server**, SSH/SWUpdate/RAUC OTA triggers, and native **COM port UART Serial Console** with `115200` baud and one-click U-Boot autoboot interrupt macros.
