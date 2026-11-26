import { describe, expect, it } from "vitest";
import en from "@/i18n/en.json";
import tr from "@/i18n/tr.json";
import { sanitizeSnapshotObject } from "@/lib/enterpriseApi";
import { computeTreemapLayout } from "./treemapLayout";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenKeys(v as Record<string, unknown>, next));
    } else {
      out[next] = String(v ?? "");
    }
  }
  return out;
}

function extractPlaceholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
}

describe("Modül 11: TR/EN i18n, Treemap Layout & Snapshot Sanitization", () => {
  it("keeps 100% key parity and interpolation placeholders between tr.json and en.json", () => {
    const trFlat = flattenKeys(tr);
    const enFlat = flattenKeys(en);
    const trKeys = Object.keys(trFlat).sort();
    const enKeys = Object.keys(enFlat).sort();

    expect(trKeys).toEqual(enKeys);
    for (const key of trKeys) {
      expect(trFlat[key].trim().length, `Empty TR key: ${key}`).toBeGreaterThan(0);
      expect(enFlat[key].trim().length, `Empty EN key: ${key}`).toBeGreaterThan(0);
      expect(
        extractPlaceholders(trFlat[key]),
        `Placeholder mismatch for ${key}`
      ).toEqual(extractPlaceholders(enFlat[key]));
      if (key !== "palette.toggleLanguage") {
        expect(
          /[ğĞşŞıİçÇöÖüÜ]/.test(enFlat[key]),
          `Unexpected Turkish diacritic in en.json key "${key}": ${enFlat[key]}`
        ).toBe(false);
      }
    }
  });

  it("computes non-overlapping proportional treemap rectangles for 44 packages", () => {
    const items = Array.from({ length: 44 }, (_, idx) => ({
      name: `pkg-${idx}`,
      recipe: `recipe-${idx}`,
      category: idx % 2 === 0 ? "Shared Libraries" : "Systemd & Core OS",
      size_bytes: (44 - idx) * 1024 * 512,
      size_kb: (44 - idx) * 512,
      percent: 0,
      file_count: 3,
      sample_files: [],
    }));
    const rects = computeTreemapLayout(items);
    expect(rects).toHaveLength(44);
    const totalArea = rects.reduce((acc, r) => acc + r.width * r.height, 0);
    expect(totalArea).toBeCloseTo(10000, 3);
    for (const r of rects) {
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("strips private keys, tokens, passwords and credentials from snapshot objects", () => {
    const cleaned = sanitizeSnapshotObject({
      project: { name: "edge-iot", target_ip: "192.168.10.50" },
      ssh_key_ref: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret",
      swupdate_url: "https://admin:superpass@192.168.10.50:8443/upload",
      openvex: [{ cve_id: "CVE-2025-1", api_key: "sk-1234567890abcdef" }],
    });
    const text = JSON.stringify(cleaned);
    expect(text).not.toContain("OPENSSH PRIVATE KEY");
    expect(text).not.toContain("superpass");
    expect(text).not.toContain("sk-1234567890abcdef");
    expect(cleaned.swupdate_url).toBe("https://192.168.10.50:8443/upload");
  });
});
