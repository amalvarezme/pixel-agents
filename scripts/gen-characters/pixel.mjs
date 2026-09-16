/**
 * A tiny mutable pixel canvas plus the two quality tricks that make procedurally drawn pixel art
 * read as pixel art instead of as blurry vector shapes:
 *
 * - `outline()` walks the finished silhouette and paints a 1px dark border AROUND it. Hand-drawn
 *   sprites get this for free from the artist; a shape-composition pipeline has to do it as a pass,
 *   and without it limbs dissolve into the background the moment the room behind them is light.
 * - `shade()` darkens the pixels on the side away from the light and lightens a thin rim on the lit
 *   side, from the SAME palette, so a 64px body still reads as volume at a glance.
 *
 * Colours are `#rrggbb` strings everywhere; alpha is all-or-nothing. Pixel art with a soft alpha
 * ramp cannot be scaled by an integer with nearest-neighbour filtering without fringing, and the
 * renderer (`sprite-character-renderer.ts`) pins `scaleMode = 'nearest'`.
 */

export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** Mixes toward white (`amount > 0`) or black (`amount < 0`) — how every shade in the pack is
 * derived from its base colour, so a palette stays coherent by construction. */
export function shift(hex, amount) {
  const rgb = hexToRgb(hex);
  const target = amount >= 0 ? 255 : 0;
  const t = Math.abs(amount);
  return rgbToHex(rgb.map((c) => c + (target - c) * t));
}

export class Frame {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    /** `null` means transparent. One entry per pixel, row-major. */
    this.cells = new Array(width * height).fill(null);
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x, y) {
    return this.inside(x, y) ? this.cells[y * this.width + x] : null;
  }

  set(x, y, hex) {
    if (!this.inside(x, y) || !hex) return;
    this.cells[y * this.width + x] = hex;
  }

  /** Inclusive on both corners — sprite work is easier to reason about in "from row a to row b". */
  rect(x0, y0, x1, y1, hex) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, hex);
    }
  }

  /** Filled axis-aligned ellipse. The `+ 0.5` centres it on the pixel grid rather than on the
   * lattice, which is what stops a symmetric head from coming out one pixel wider on one side. */
  ellipse(cx, cy, rx, ry, hex) {
    for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
      for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / (rx + 0.5);
        const dy = (y + 0.5 - cy) / (ry + 0.5);
        if (dx * dx + dy * dy <= 1) this.set(x, y, hex);
      }
    }
  }

  /** Bresenham line with an optional thickness, used for limbs. */
  line(x0, y0, x1, y1, hex, thickness = 1) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    const half = Math.floor((thickness - 1) / 2);
    for (;;) {
      for (let oy = -half; oy <= thickness - 1 - half; oy++) {
        for (let ox = -half; ox <= thickness - 1 - half; ox++) this.set(x + ox, y + oy, hex);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  /** Paints `hex` on every transparent pixel that touches (4-neighbour) a filled one. */
  outline(hex) {
    const additions = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) {
          additions.push([x, y]);
        }
      }
    }
    for (const [x, y] of additions) this.set(x, y, hex);
  }

  /**
   * Volume pass. A filled pixel whose neighbour on the `-lightX` side is transparent or outline
   * gets a darker tone; one on the `+lightX` side gets a lighter one. Runs off a SNAPSHOT so the
   * pass cannot feed on its own output and smear a gradient across the whole body.
   */
  shade(protectedColors, lightX = -1, dark = -0.22, light = 0.16) {
    const before = this.cells.slice();
    const at = (x, y) => (this.inside(x, y) ? before[y * this.width + x] : null);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = at(x, y);
        if (!c || protectedColors.has(c)) continue;
        const lit = at(x + lightX, y);
        const away = at(x - lightX, y);
        if (!lit || protectedColors.has(lit)) this.set(x, y, shift(c, light));
        else if (!away || protectedColors.has(away)) this.set(x, y, shift(c, dark));
      }
    }
  }

  /** Mirrors the frame about its vertical centre — used only to build the pack's own preview, never
   * at runtime, where `left` is a negative sprite scale. */
  mirrored() {
    const out = new Frame(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) out.set(this.width - 1 - x, y, this.get(x, y));
    }
    return out;
  }
}

/** A sheet is just a big frame; blitting keeps the row/column arithmetic in one place. */
export function blit(sheet, frame, dx, dy) {
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const c = frame.get(x, y);
      if (c) sheet.set(dx + x, dy + y, c);
    }
  }
}

export function frameToRgba(frame) {
  const out = new Uint8Array(frame.width * frame.height * 4);
  for (let i = 0; i < frame.cells.length; i++) {
    const c = frame.cells[i];
    if (!c) continue;
    const [r, g, b] = hexToRgb(c);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}
