"""Pro Suite modules (Kernel/DT, Runtime QA/Boot, EU CRA/OpenVEX, Secure Boot, buildstats, CI/CD)."""

from bridge.pro_suite.buildstats_parser import analyze_buildstats_records, parse_buildstats_dir
from bridge.pro_suite.cicd_generator import generate_cicd_pipeline
from bridge.pro_suite.cra_vex import build_openvex_document, export_cra_compliance_bundle
from bridge.pro_suite.kernel_dt import (
    diff_kernel_config,
    generate_kernel_bbappend_fragment,
    parse_dts_tree,
    parse_kernel_config,
    update_dts_node_status,
    validate_dts_syntax,
)
from bridge.pro_suite.qa_runner import (
    build_hardware_smoke_report,
    parse_ptest_output,
    parse_systemd_analyze,
    parse_uart_boot_timestamps,
)
from bridge.pro_suite.secure_boot import generate_secure_boot_inc

__all__ = [
    "analyze_buildstats_records",
    "build_hardware_smoke_report",
    "build_openvex_document",
    "diff_kernel_config",
    "export_cra_compliance_bundle",
    "generate_cicd_pipeline",
    "generate_kernel_bbappend_fragment",
    "generate_secure_boot_inc",
    "parse_buildstats_dir",
    "parse_dts_tree",
    "parse_kernel_config",
    "parse_ptest_output",
    "parse_systemd_analyze",
    "parse_uart_boot_timestamps",
    "update_dts_node_status",
    "validate_dts_syntax",
]
