/** Dev-only: renders selected clips at an integer zoom so a generation can be judged by eye. */
import { writeFileSync } from 'node:fs';
import { encodePng } from './png.mjs';
import { blit, Frame, frameToRgba } from './pixel.mjs';
import { CHARACTERS } from './palette.mjs';
import { FRAME_SIZE, renderFrame } from './body.mjs';
import { CLIPS } from './poses.mjs';

const rows = (process.argv[3] ?? "0,3,5,7").split(",").map(Number);
const cols = (process.argv[5] ?? "0,1,2,3,4,5").split(",").map(Number);
const zoom = Number(process.argv[4] ?? 4);
const ids = (process.argv[6] ?? Object.keys(CHARACTERS).join(',')).split(',');

const cellW = FRAME_SIZE * cols.length;
const cellH = FRAME_SIZE * rows.length;
const sheet = new Frame(cellW * ids.length, cellH);

ids.forEach((id, ci) => {
  rows.forEach((row, ri) => {
    const clip = CLIPS.find((c) => c.row === row);
    cols.forEach((t, ti) => blit(sheet, renderFrame(CHARACTERS[id], clip.pose(t)), ci * cellW + ti * FRAME_SIZE, ri * FRAME_SIZE));
  });
});

const out = new Frame(sheet.width * zoom, sheet.height * zoom);
for (let y = 0; y < out.height; y++) {
  for (let x = 0; x < out.width; x++) {
    out.set(x, y, sheet.get(Math.floor(x / zoom), Math.floor(y / zoom)) ?? '#20202c');
  }
}
writeFileSync(process.argv[2], encodePng(out.width, out.height, frameToRgba(out)));
console.log(`${out.width}x${out.height}`);
