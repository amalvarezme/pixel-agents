/**
 * Model accent colour — "the model should be distinguishable at a glance (a small badge or
 * colour accent)". A fixed lookup TABLE keyed by a deterministic hash of the model string, not a
 * branch per known model name (the same shape of fix `buildCaption` already applies for harness:
 * a table, never an `if (model === ...)` chain) — so an unfamiliar model name still gets a
 * consistent, distinct colour without this file needing to know every model that will ever exist.
 */
const ACCENT_PALETTE = [0xff6b6b, 0x4ecdc4, 0xffe66d, 0x8338ec, 0x3a86ff, 0xfb5607, 0x06d6a0, 0xef476f] as const;

/** One fixed neutral colour for a worker whose model has not resolved yet — never invented from
 * other data, and deliberately outside the palette above so it can never collide with a real,
 * named model's colour. */
const DEFAULT_ACCENT_COLOR = 0x9aa0a6;

function hashModelName(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function resolveModelAccentColor(model?: string): number {
  if (!model) return DEFAULT_ACCENT_COLOR;
  return ACCENT_PALETTE[hashModelName(model) % ACCENT_PALETTE.length]!;
}
