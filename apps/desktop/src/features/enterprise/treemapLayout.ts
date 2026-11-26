import type { RootfsPackageItem } from "@yocto-studio/shared-protocol";

export interface TreemapRect {
  item: RootfsPackageItem;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Deterministic binary-split Treemap layout normalized to [0..100, 0..100] percentage coordinates.
 * Guarantees zero overlap and area conservation proportional to `size_bytes`.
 */
export function computeTreemapLayout(
  items: RootfsPackageItem[],
  x = 0,
  y = 0,
  width = 100,
  height = 100
): TreemapRect[] {
  const valid = items.filter((i) => i.size_bytes > 0);
  if (valid.length === 0 || width <= 0 || height <= 0) {
    return [];
  }
  if (valid.length === 1) {
    return [{ item: valid[0], x, y, width, height }];
  }

  const sorted = [...valid].sort((a, b) => b.size_bytes - a.size_bytes);
  const total = sorted.reduce((acc, p) => acc + p.size_bytes, 0);
  if (total <= 0) return [];

  // Partition into two roughly balanced halves by cumulative bytes
  let leftSum = 0;
  let splitIdx = 1;
  const half = total / 2;
  for (let i = 0; i < sorted.length - 1; i++) {
    leftSum += sorted[i].size_bytes;
    splitIdx = i + 1;
    if (leftSum >= half) break;
  }

  const leftItems = sorted.slice(0, splitIdx);
  const rightItems = sorted.slice(splitIdx);
  const ratio = leftSum / total;

  if (width >= height) {
    const lw = width * ratio;
    return [
      ...computeTreemapLayout(leftItems, x, y, lw, height),
      ...computeTreemapLayout(rightItems, x + lw, y, width - lw, height),
    ];
  }
  const lh = height * ratio;
  return [
    ...computeTreemapLayout(leftItems, x, y, width, lh),
    ...computeTreemapLayout(rightItems, x, y + lh, width, height - lh),
  ];
}
