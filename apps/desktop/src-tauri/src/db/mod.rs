use crate::providers::ProviderProfile;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedProjectRecord {
    pub id: String,
    pub name: String,
    pub yocto_codename: String,
    pub workspace_path: String,
    pub machine: String,
    pub distro: String,
    pub provider: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildRunRecord {
    pub id: String,
    pub project_id: String,
    pub target: String,
    pub status: String,
    pub duration_ms: i64,
    pub sstate_hits: i64,
    pub sstate_misses: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TargetProfileRecord {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub machine: String,
    pub preferred_method: String,
    pub usb_flasher: String,
    pub target_ip: String,
    pub ssh_user: String,
    pub ssh_key_ref: String,
    pub swupdate_url: String,
    pub uart_port: String,
    pub uart_baud: u32,
    pub ab_slots_json: String,
    pub custom_cli_template: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QaRunRecord {
    pub id: String,
    pub project_id: String,
    pub suite: String,
    pub total: i64,
    pub passed: i64,
    pub failed: i64,
    pub skipped: i64,
    pub total_boot_ms: i64,
    pub created_at: String,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open_at(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        Self::init_conn(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init_conn(conn)
    }

    fn init_conn(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                yocto_codename TEXT NOT NULL,
                workspace_path TEXT NOT NULL,
                machine TEXT NOT NULL,
                distro TEXT NOT NULL,
                provider TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS build_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                target TEXT NOT NULL,
                status TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                sstate_hits INTEGER NOT NULL,
                sstate_misses INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS provider_profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                config_json TEXT NOT NULL,
                is_default INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS target_profiles (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                machine TEXT NOT NULL,
                config_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS qa_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                suite TEXT NOT NULL,
                total INTEGER NOT NULL,
                passed INTEGER NOT NULL,
                failed INTEGER NOT NULL,
                skipped INTEGER NOT NULL,
                total_boot_ms INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            ",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn upsert_project(&self, rec: &SavedProjectRecord) -> rusqlite::Result<()> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.execute(
            "INSERT OR REPLACE INTO projects
             (id, name, yocto_codename, workspace_path, machine, distro, provider, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                rec.id,
                rec.name,
                rec.yocto_codename,
                rec.workspace_path,
                rec.machine,
                rec.distro,
                rec.provider,
                rec.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list_projects(&self) -> rusqlite::Result<Vec<SavedProjectRecord>> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT id, name, yocto_codename, workspace_path, machine, distro, provider, created_at
             FROM projects ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SavedProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                yocto_codename: row.get(2)?,
                workspace_path: row.get(3)?,
                machine: row.get(4)?,
                distro: row.get(5)?,
                provider: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn record_build_run(&self, rec: &BuildRunRecord) -> rusqlite::Result<()> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.execute(
            "INSERT OR REPLACE INTO build_runs
             (id, project_id, target, status, duration_ms, sstate_hits, sstate_misses, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                rec.id,
                rec.project_id,
                rec.target,
                rec.status,
                rec.duration_ms,
                rec.sstate_hits,
                rec.sstate_misses,
                rec.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list_build_runs(&self, limit: usize) -> rusqlite::Result<Vec<BuildRunRecord>> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT id, project_id, target, status, duration_ms, sstate_hits, sstate_misses, created_at
             FROM build_runs ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(BuildRunRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                target: row.get(2)?,
                status: row.get(3)?,
                duration_ms: row.get(4)?,
                sstate_hits: row.get(5)?,
                sstate_misses: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_provider_profile(&self, profile: &ProviderProfile) -> rusqlite::Result<()> {
        let json = serde_json::to_string(profile).unwrap_or_else(|_| "{}".to_string());
        let kind_str = serde_json::to_string(&profile.kind).unwrap_or_else(|_| "\"mock\"".to_string());
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.execute(
            "INSERT OR REPLACE INTO provider_profiles (id, name, kind, config_json, is_default)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                profile.id,
                profile.name,
                kind_str.trim_matches('"'),
                json,
                if profile.is_default.unwrap_or(false) { 1 } else { 0 }
            ],
        )?;
        Ok(())
    }

    pub fn list_provider_profiles(&self) -> rusqlite::Result<Vec<ProviderProfile>> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT config_json FROM provider_profiles ORDER BY is_default DESC, name ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let raw: String = row.get(0)?;
            Ok(serde_json::from_str::<ProviderProfile>(&raw).ok())
        })?;
        let mut result = Vec::new();
        for item in rows {
            if let Ok(Some(prof)) = item {
                result.push(prof);
            }
        }
        Ok(result)
    }

    pub fn delete_provider_profile(&self, id: &str) -> rusqlite::Result<()> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.execute("DELETE FROM provider_profiles WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn upsert_target_profile(&self, profile: &TargetProfileRecord) -> rusqlite::Result<()> {
        let json = serde_json::to_string(profile).unwrap_or_else(|_| "{}".to_string());
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.execute(
            "INSERT OR REPLACE INTO target_profiles (id, project_id, name, machine, config_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                profile.id,
                profile.project_id,
                profile.name,
                profile.machine,
                json,
                profile.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list_target_profiles(&self, project_id: Option<&str>) -> rusqlite::Result<Vec<TargetProfileRecord>> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = if project_id.is_some() {
            guard.prepare(
                "SELECT config_json FROM target_profiles WHERE project_id = ?1 ORDER BY created_at DESC",
            )?
        } else {
            guard.prepare("SELECT config_json FROM target_profiles ORDER BY created_at DESC")?
        };
        let mut result = Vec::new();
        if let Some(pid) = project_id {
            let rows = stmt.query_map(params![pid], |row| {
                let raw: String = row.get(0)?;
                Ok(serde_json::from_str::<TargetProfileRecord>(&raw).ok())
            })?;
            for item in rows.flatten().flatten() {
                result.push(item);
            }
        } else {
            let rows = stmt.query_map([], |row| {
                let raw: String = row.get(0)?;
                Ok(serde_json::from_str::<TargetProfileRecord>(&raw).ok())
            })?;
            for item in rows.flatten().flatten() {
                result.push(item);
            }
        }
        Ok(result)
    }

    pub fn delete_target_profile(&self, id: &str) -> rusqlite::Result<()> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.execute("DELETE FROM target_profiles WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |row| row.get::<_, String>(0))?;
        match rows.next() {
            Some(val) => Ok(Some(val?)),
            None => Ok(None),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn record_qa_run(&self, rec: &QaRunRecord) -> rusqlite::Result<()> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        guard.execute(
            "INSERT OR REPLACE INTO qa_runs
             (id, project_id, suite, total, passed, failed, skipped, total_boot_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                rec.id,
                rec.project_id,
                rec.suite,
                rec.total,
                rec.passed,
                rec.failed,
                rec.skipped,
                rec.total_boot_ms,
                rec.created_at
            ],
        )?;
        Ok(())
    }

    pub fn list_qa_runs(&self, limit: usize) -> rusqlite::Result<Vec<QaRunRecord>> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = guard.prepare(
            "SELECT id, project_id, suite, total, passed, failed, skipped, total_boot_ms, created_at
             FROM qa_runs ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(QaRunRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                suite: row.get(2)?,
                total: row.get(3)?,
                passed: row.get(4)?,
                failed: row.get(5)?,
                skipped: row.get(6)?,
                total_boot_ms: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderKind;

    #[test]
    fn sqlite_project_and_build_roundtrip() {
        let db = Database::open_in_memory().expect("in-memory sqlite");
        db.upsert_project(&SavedProjectRecord {
            id: "p1".into(),
            name: "poky-wrynose".into(),
            yocto_codename: "wrynose".into(),
            workspace_path: "/home/yocto/poky-wrynose".into(),
            machine: "imx8mp-lpddr4-evk".into(),
            distro: "poky".into(),
            provider: "wsl2".into(),
            created_at: "2026-11-25T09:00:00Z".into(),
        })
        .unwrap();

        db.record_build_run(&BuildRunRecord {
            id: "b1".into(),
            project_id: "p1".into(),
            target: "core-image-minimal".into(),
            status: "succeeded".into(),
            duration_ms: 8200,
            sstate_hits: 8,
            sstate_misses: 24,
            created_at: "2026-11-25T09:01:00Z".into(),
        })
        .unwrap();

        db.upsert_provider_profile(&ProviderProfile {
            id: "ssh-corp".into(),
            name: "Corporate Build Host".into(),
            kind: ProviderKind::Ssh,
            wsl_distro: None,
            docker_image: None,
            docker_sstate_vol: None,
            docker_dl_vol: None,
            docker_tmp_vol: None,
            ssh_host: Some("10.0.0.15".into()),
            ssh_port: Some(22),
            ssh_user: Some("yocto".into()),
            ssh_key_path: Some("~/.ssh/id_ed25519".into()),
            ssh_use_agent: Some(true),
            remote_workspace_root: Some("/srv/yocto".into()),
            is_default: Some(true),
        })
        .unwrap();

        assert_eq!(db.list_projects().unwrap().len(), 1);
        assert_eq!(db.list_build_runs(10).unwrap().len(), 1);
        assert_eq!(db.list_provider_profiles().unwrap().len(), 1);
        db.delete_provider_profile("ssh-corp").unwrap();
        assert_eq!(db.list_provider_profiles().unwrap().len(), 0);
    }

    #[test]
    fn sqlite_target_profile_and_settings_roundtrip() {
        let db = Database::open_in_memory().expect("in-memory sqlite");
        let profile = TargetProfileRecord {
            id: "tp-imx8mp".into(),
            project_id: "p1".into(),
            name: "i.MX8MP-EVK-TestBench".into(),
            machine: "imx8mp-lpddr4-evk".into(),
            preferred_method: "usb".into(),
            usb_flasher: "nxp_uuu".into(),
            target_ip: "192.168.10.50".into(),
            ssh_user: "root".into(),
            ssh_key_ref: "keyring://yocto/imx8mp-evk".into(),
            swupdate_url: "http://192.168.10.50:8080".into(),
            uart_port: "COM4".into(),
            uart_baud: 115_200,
            ab_slots_json: r#"{"a":"/dev/mmcblk2p2","b":"/dev/mmcblk2p3"}"#.into(),
            custom_cli_template: "uuu -b emmc_all {IMAGE_PATH}".into(),
            created_at: "2026-11-25T10:50:00Z".into(),
        };
        db.upsert_target_profile(&profile).unwrap();
        let listed = db.list_target_profiles(Some("p1")).unwrap();
        assert_eq!(listed, vec![profile]);

        db.set_setting("tool.uuu", "C:\\tools\\uuu.exe").unwrap();
        assert_eq!(
            db.get_setting("tool.uuu").unwrap().as_deref(),
            Some("C:\\tools\\uuu.exe")
        );

        db.delete_target_profile("tp-imx8mp").unwrap();
        assert!(db.list_target_profiles(None).unwrap().is_empty());
    }

    #[test]
    fn sqlite_qa_run_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let rec = QaRunRecord {
            id: "qa-1".into(),
            project_id: "p1".into(),
            suite: "testimage".into(),
            total: 5,
            passed: 4,
            failed: 0,
            skipped: 1,
            total_boot_ms: 4190,
            created_at: "2026-11-25T11:15:00Z".into(),
        };
        db.record_qa_run(&rec).unwrap();
        let runs = db.list_qa_runs(10).unwrap();
        assert_eq!(runs, vec![rec]);
    }
}
