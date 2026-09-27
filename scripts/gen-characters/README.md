# Character pack generator (v3)

Builds `public/characters/<id>/` — one 384x1024 spritesheet, one metadata JSON and one portrait per
character — from a parametric skeleton rather than from hand-placed pixels.

```
npm run gen:characters                 # writes the pack into public/characters/
npm run gen:characters -- --out /tmp/x --preview /tmp/pack.png
npm run gen:characters:preview -- out.png <rows> <zoom> <frames> <ids>
```

## Why a generator and not four PNGs

The pack is 4 characters x 16 clips x 6 frames = 384 frames. Nothing but a shared skeleton keeps
that many frames on the same eye line, shoulder height and foot plane. The cost is that the art is
systematic rather than expressive.

**This output is a starting point, not a destination.** Open the sheets in Aseprite and push them:
hand-placed highlights, cloth folds, per-character facial character, and cleaner walk contacts are
all things a person does better than a formula. If you take a sheet over by hand, say so in that
character's `runtimeNotes` and stop regenerating it — the generator overwrites without asking.

## What the runtime requires of anything this writes

`src/ui/scene/character/character-sprite.ts` is the contract, and `character-sprite.test.ts`
enforces it against the shipped files:

| Requirement | Value |
|---|---|
| Frame size | 64x64 |
| Sheet | 384x1024 — 16 rows, 6 frames each |
| Row order | idle down/up/side, walk down/up/side, work, typing, talk down/up/side, point down/up/side, celebrate, sit |
| Origin | (32, 60), the centre of the feet — NOT the frame corner |
| `side` clips | drawn facing RIGHT; `left` is a runtime mirror, never separate art |
| Furniture | none. Desks, laptops and chairs belong to the room |
| Alpha | all-or-nothing; the renderer pins `scaleMode = 'nearest'` |

Changing the frame size means changing `CHARACTER_BODY_HALF_WIDTH`, `CHARACTER_BODY_HEIGHT` and
`READABILITY_BONUS` in `character-sprite.ts` too — those are in frame pixels and the scene's whole
sense of scale rides on them.

## Files

- `png.mjs` — RGBA PNG encoder over `node:zlib`. No image dependency enters `package.json` for a
  build-time job whose output is committed.
- `pixel.mjs` — the canvas, plus the auto-outline and shading passes that make composed shapes read
  as pixel art.
- `palette.mjs` — the six characters: colours and silhouette features. Silhouette first, one
  saturated accent each on a desaturated base. Its own `CHARACTER_IDS` export is GENERATION order
  only; the runtime hash table lives in `src/ui/scene/character/character-sprite.ts`.
- `body.mjs` — the skeleton and every drawing decision.
- `poses.mjs` — the 16 clips as functions from frame index to pose.
- `index.mjs` — assembly and output.
- `inspect.mjs` — dev-only zoomed contact sheets for judging a generation by eye.
