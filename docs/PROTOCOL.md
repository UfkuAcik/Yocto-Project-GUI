# Yocto Studio — JSON-RPC 2.0 & WebSocket Protokol Sözleşmesi

Protokol kaynağı: `packages/shared-protocol/`

## Taşıma Uç Noktaları
- `GET /health` — Köprü sağlığı, çalışma modu (`mock` | `live`), Yocto sürümü, PID ve bağlı istemci sayısı.
- `POST /rpc` — Tekil HTTP JSON-RPC 2.0 isteği.
- `GET /ws` — RFC 6455 WebSocket çift yönlü JSON-RPC 2.0 + sunucu olay akışı (notifications).

## Hata Kodları
- `-32700` Parse error
- `-32600` Invalid Request
- `-32601` Method not found
- `-32602` Invalid params
- `-32603` Internal error
- `-32001` `NTFS_PATH_FORBIDDEN` (`/mnt/c`, Windows veya UNC yolları WSL2/Linux üzerinde engellendi)
- `-32002` `PROVIDER_UNAVAILABLE`
- `-32003` `BUILD_ALREADY_RUNNING`
- `-32004` `BUILD_NOT_FOUND`
- `-32005` `BITBAKE_ERROR`

## RPC Metot Grupları
- **Bridge:** `bridge.ping`, `bridge.info`, `bridge.shutdown`
- **Ortam:** `env.doctor`, `env.validate_path`
- **Çalışma Alanı & `kas`:** `workspace.list`, `workspace.get`, `workspace.create`, `workspace.select`, `workspace.import`, `workspace.setup_status`, `workspace.setup_update`, `workspace.update_caches`, `kas.parse`, `kas.serialize`, `kas.run`
- **Katmanlar:** `layers.list`, `layers.search_index` (canlı OE Layer Index API), `layers.add`, `layers.remove`, `layers.create_layer`, `layers.show_appends`, `layers.show_overlayed`, `layers.check_compat`, `layers.fetch_from_index`
- **Konfigürasyon:** `config.get_local_conf`, `config.preview_diff`, `config.apply_changes`, `config.list_fragments`, `config.toggle_fragment`, `config.create_fragment`, `config.inspect_variable`
- **Tarifler, `devtool` & `recipetool`:** `recipes.list`, `recipes.get`, `recipes.save`, `recipes.create_bbappend`, `devtool.status`, `devtool.add`, `devtool.modify`, `devtool.build`, `devtool.deploy_target`, `devtool.upgrade`, `devtool.finish`, `devtool.reset`, `recipetool.create`
- **Derleme & DAG:** `build.start`, `build.cancel`, `build.status`, `build.get_task_log`, `build.run_task_action`, `dag.generate`, `dag.explain_why`
- **İmaj, SBOM, WIC, QEMU, SDK & Geçmiş:** `artifacts.list_images`, `artifacts.get_sbom`, `artifacts.get_cves`, `artifacts.export_licenses`, `artifacts.copy_to_host`, `artifacts.get_buildhistory_diff`, `wic.list_wks`, `wic.parse_wks`, `wic.serialize_wks`, `wic.create_image`, `qemu.launch`, `qemu.stop`, `sdk.list`, `sdk.build`
- **Pre-Flight & İmaj Danışmanı (Modül 9):** `preflight.runAudit`, `preflight.getVersionMatrix`, `preflight.checkUpgrades`, `preflight.probeSstate`, `preflight.getOptimizationPlan`, `preflight.applyFix`
- **Pro Suite (Modül 10):** `pro.kernel.diffConfig`, `pro.kernel.saveFragment`, `pro.dt.listFiles`, `pro.dt.parseTree`, `pro.dt.updateNodeStatus`, `pro.qa.runSuite`, `pro.qa.runHardwareSmoke`, `pro.cra.listVex`, `pro.cra.updateVex`, `pro.cra.exportBundle`, `pro.secboot.generateConfig`, `pro.buildstats.analyze`, `pro.cicd.generate`
- **Enterprise & Completeness Pack (Modül 11):** `enterprise.multiconfig.list`, `enterprise.multiconfig.save`, `enterprise.multiconfig.delete`, `enterprise.offline.scanAutorev`, `enterprise.offline.pinAutorev`, `enterprise.offline.prepareMirror`, `enterprise.offline.configureArchiver`, `enterprise.rootfs.getTreemap`, `enterprise.rootfs.findPath`, `enterprise.rootfs.diffSigs`, `enterprise.debug.exportIdeConfig`, `enterprise.debug.startGdbserver`, `enterprise.debug.getLiveTelemetry`, `enterprise.migration.scan`, `enterprise.migration.applyAll`, `enterprise.git.statusAll`, `enterprise.git.runAction`, `enterprise.sstate.getRunnerAnalytics`
- **PTY:** `pty.open`, `pty.write`, `pty.resize`, `pty.close`

## Sunucu Bildirimleri (Notifications)
- `build.started`, `build.task_started`, `build.task_progress`, `build.task_succeeded`, `build.task_failed`, `build.log`, `build.completed`
- `telemetry.sample`
- `command.executed` (her arka plan CLI çağrısının şeffaf kaydı)
- `pty.output`, `pty.exit`
