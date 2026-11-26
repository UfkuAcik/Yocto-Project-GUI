import { describe, expect, it } from "vitest";
import { OPENVEX_JUSTIFICATIONS } from "@/features/pro-suite/CraSecurityHub";
import {
  DEFAULT_AI_SETTINGS,
  redactLogClientFallback,
} from "@/lib/proSuiteApi";

describe("Pro Suite AI privacy defaults, redaction, and OpenVEX constants", () => {
  it("keeps AI failure triage opt-in disabled by default", () => {
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_AI_SETTINGS.provider).toBe("disabled");
  });

  it("masks secrets and internal IPs cleanly in client redaction fallback", () => {
    const raw =
      "ERROR: Bearer my-secret-token-123 OPENAI_KEY=sk-proj-secretkey9988 from 192.168.10.22 password=topsecret";
    const res = redactLogClientFallback(raw);
    expect(res.replacements_count).toBeGreaterThanOrEqual(4);
    expect(res.redacted_text).not.toContain("my-secret-token-123");
    expect(res.redacted_text).not.toContain("sk-proj-secretkey9988");
    expect(res.redacted_text).not.toContain("192.168.10.22");
    expect(res.redacted_text).not.toContain("topsecret");
  });

  it("exposes standard OpenVEX justifications", () => {
    expect(OPENVEX_JUSTIFICATIONS).toContain("vulnerable_code_not_in_execute_path");
    expect(OPENVEX_JUSTIFICATIONS).toContain("inline_mitigations_already_exist");
  });
});
