# Tasks: Scorpion, a fifth office character

Feature doc for ODD. Branch `feat-scorpion-character`, off `main` @ `9d56a56`.

## Why

The maintainer asked for a sprite redesign with better definition and better animation, inspired by
Scorpion from Mortal Kombat. Two decisions were taken with them before any code:

1. **A fifth character**, not a reskin of an existing one. Accepted consequence: `resolveCharacterId`
   maps projects by hash into `CHARACTER_IDS`, so going from four to five ids changes which character
   EVERY existing project draws as. That was stated and accepted.
2. **Animation only, contract intact.** `FRAMES` stays 6, the 16 clip rows keep their order, the sheet
   stays 384x1024, the origin stays (32,60). So `character-sprite.test.ts`'s pack assertions are not
   loosened, and the only test change is the one the new character forces (below).

## What the AI contributed, and what it did not

Nano Banana 2 generated a Scorpion concept (`/tmp/scorpion/char-1.png`, kept out of the repo) through
the `nanobanana` MCP. It is excellent as a DESIGN REFERENCE and wrong as an ASSET:

- It is hi-bit pixel art at 848x1264 with gradients and fine outlines. The pack is flat shapes at
  64x64 with an auto-outline and a limited palette.
- The office draws a worker with a ~54px body at scale 2 in a 1672x941 room (palette.mjs's own words),
  so at draw size only the SILHOUETTE survives. Shrinking 848px of detail into 64px destroys it.
- Style anchoring did not transfer: passing the shipped `alex_spritesheet_v3.png` as an input image
  did not make the output match the pack.

So the design is implemented in the generator, which is what `scripts/gen-characters/README.md`
already tells you to do by hand. The AI image stays a reference, and may be used directly for the
256x256 tooltip portrait, where there is no grid and no frame count.

## Design to implement (from the reference image)

A ninja silhouette, read at 54px: pointed hood over the head, a saturated yellow headband with two
trailing tails, a black face mask leaving a narrow band of skin at the eyes, a yellow tabard over the
chest carrying a small scorpion emblem, yellow forearm guards, a rope belt, long black hair below the
hood, and black boots with a yellow flash.

Palette rules to respect (palette.mjs): silhouette first, and ONE saturated accent on a desaturated
base. Scorpion's accent is yellow, and Elena already owns amber `#ffb84d`, so Scorpion's yellow must be
hotter and colder than hers and sit on a near-black base, or the two characters will read alike.

## Tasks

- [x] 1 RED: add `'scorpion'` to `CHARACTER_IDS` in `character-sprite.ts`, capture the failing tests
      before any art exists. Observed RED: 8 failed / 32 passed — six `loadMeta('scorpion')` failures
      on the missing `scorpion.json`, `lists exactly the characters the shipped manifest declares`,
      and the file guard. Then a second RED after the guard was rewritten (8 failed / 34 passed),
      because the guard now names the URL the CODE builds.
- [x] 2 Decide and document the v2 assertion. Delivered exactly as decided: the uniform guard now
      reads `characterSheetUrl(id)`/`characterPortraitUrl(id)` (the v3 files the runtime fetches), and
      a SEPARATE guard names the four legacy v2 pairs and asserts that no `_v2` file exists for the
      v3-born character. No fake v2 art, no v2 file deleted.
- [x] 3 GREEN: `palette.mjs` gained the `scorpion` entry and `body.mjs` gained five new
      `p.feature === 'scorpion'` branches (torso, leg flash, arm, head). The four original features
      were not edited. Proof rather than assertion, stated precisely:
      **CURRENT `palette.mjs` + CURRENT `body.mjs` + HEAD's `poses.mjs` reproduces
      `git show HEAD:public/characters/<id>/<id>_spritesheet_v3.png` byte for byte** for all four
      originals (alex `27b2d7d26f79`, marcus `1aff10dbb1e8`, sophia `ebdf7568151e`, elena
      `6df1c0d1039a`, all MATCH). The reference is the committed PNG from git, not a re-render of my
      own code, so the whole palette+body delta is pinned as inert for those four.
- [x] 4 `resolveCharacterId` already derived its modulus from `CHARACTER_IDS.length`; no literal `4`
      anywhere. Added the coverage pin (`can reach EVERY shipped character`), because a project
      silently losing its character is the failure mode. It is a PIN, not a bug fix: it could not be
      RED against the shipped code, so it was made RED by mutation instead (`% CHARACTER_IDS.length`
      -> `% 4`), which the test catches by reporting `scorpion` as unreachable.
- [x] 5 Better mechanics, same contract. `FRAMES` is still 6 and the 16 rows kept their order. Row
      level proof that the change is confined to the intended clips: rendering every frame of every
      clip with OLD versus NEW poses changes rows 5 (walk/side), 7 (typing), 8-10 (talk), 11-13
      (point) and 14 (celebrate) and NOTHING else — idle, walk/down, walk/up, work and sit come out
      byte-identical for all four existing characters.
      - walk/side: authored six-key table, 12px stride against the old 8, two real contact frames with
        both feet planted, a stance leg that stays planted through the passing position, and a down/up
        body bob. Arms are derived from the OPPOSITE leg, so arms and legs cannot drift apart.
      - typing: a real two-frame tick — the pressing hand drops 4px, its shoulder drops 1px with it,
        the other hand rides 1px higher (was a 1px jitter).
      - talk: the mouth opens 2-2-1 frames instead of flipping every frame (a 3Hz flicker at 6 fps),
        and the gesturing hand rides the same envelope as the mouth.
      - point: wind-up below rest, most of the travel in one frame, a 2px overshoot, then a settle —
        five distinct poses where there were three near-identical ones.
      - celebrate: anticipation, a real jump (body rises and both feet tuck), an apex overshoot, and a
        landing back to rest on the last frame the runtime holds.
- [x] 6 Regenerated with `npm run gen:characters` and reviewed by eye at 10x, 8x and 4x zoom,
      including after the face rewrite, the emblem rewrite and the accent ruling. Final previews:
      `/tmp/preview-scorpion-final.png` and `/tmp/preview-scorpion-final-vs-elena.png`. Intermediate
      ones kept for the record: `/tmp/preview-scorpion.png`, `/tmp/preview-scorpion-detail.png`,
      `/tmp/preview-alex.png`, `/tmp/pose-compare.png`, `/tmp/accent-variants-side-by-side.png`.
- [ ] 7 Optional portrait: still NOT done, and explicitly left open. `index.mjs` writes a procedural
      256x256 `_portrait_v3.png`, which is what ships. Using the AI image directly would put an
      848px-detailed face above a 64px flat sprite, and the maintainer has not asked for it, so the
      task stays open rather than being closed as "declined".

## Decisions taken during implementation

- **The yellow.** `#ffe23d`, canary: on the hue wheel 51 degrees against Elena's amber `#ffb84d` at 36
  (colder, toward green) and at relative luminance ~0.76 against her ~0.61, on a near-black base
  instead of her dark plum. The two overlap in the room and both dim to `IDLE_CHARACTER_ALPHA`; a
  second amber would have made them one character with two hair styles.
- **Build-time guard.** The uniform v2 loop became "v3 for everyone, v2 for the four named originals",
  plus an assertion that a v3-born character has NO v2 pair — the honest shape, and the one that keeps
  a future cleanup from deleting the legacy files.
- **The accent AREA is the pack's rule, ruled on by the maintainer.** The first pass spread the yellow
  over a solid tabard and solid guards; the maintainer chose the reduced reading, so the accent now
  marks EDGES and small areas only (tabard border, emblem, one stripe per guard, a 2px boot flash).
  Reason, in `palette.mjs`'s own words: one saturated accent on a desaturated base, and a hue spread
  over a whole garment is what made the v2 pack read as blobs of colour. See the ruling section below.
- **The emblem is a glyph, not a legible scorpion.** Eight pixels cannot describe an animal. Three
  iterations were needed: a legs bar that read as a bird's beak, an asymmetric blob, and the shipped
  glyph (mirrored claw pincers, arms angling in, a 3x2 body, a segmented tail hooking back in at the
  stinger). Anyone who wants a real emblem should hand-edit the sheet in Aseprite, which the generator
  README already invites.
- **A masked character has no mouth.** Scorpion's head branch draws its own face and does not call
  `drawFace`, so `talk` reads through the gesturing arm and the body bob, not the mouth.
- **`role: 'Security Reviewer'`**: invented when the palette needed a string, since nothing names a
  role for a fifth character. APPROVED by the maintainer and left exactly as it was. It is inert
  metadata (no runtime code reads it) but it is product-visible in the manifest.

## Accepted, and FIXED in the follow-up round

`src/ui/components/organisms/project-roster.test.ts:107` hardcoded the four-id list
(`expect(['alex', 'marcus', 'sophia', 'elena']).toContain(view.rows[0]?.character)`) for
`/a/pixel-agents`, which hashes to `scorpion`. It was reported instead of edited because it was
outside the first round's allowed surfaces; the maintainer authorized the fix, so it is now in scope
and the assertion reads against `CHARACTER_IDS` and the resolver itself:

```ts
expect(CHARACTER_IDS).toContain(view.rows[0]?.character);
expect(view.rows[0]?.character).toBe(resolveCharacterId('/a/pixel-agents'));
```

The second assertion is the one the test's own name promises: the roster must resolve the SAME
character the scene draws, from the same hash, not merely "some id we ship".

## Second round: the face, the emblem, and the accent ruling

### The face, rewritten (it read as a visor)

The first version painted a wide PALE band across the eyes with two small dark marks inside it. At
zoom that is goggles; the review called it out correctly. The pale area was the wrong element to make
large, so the structure is inverted: a dark hood, a dark mask from the eye line down, and only TWO
NARROW PALE SLITS (2x1 each, five pixels of dark mask between them), with the 1px yellow headband
sitting one dark row above them. Contrast now comes from the ORDER of the elements — bright bar, dark
brow, slit, near-black cloth — instead of from a big lit area.

The slits use `p.skin` deliberately: a warm tone against near-black cloth reads as EYES, where pure
white or grey would read as a machine's indicators. The mask keeps a small step up from the hood
(`shift(top, 0.08)`) so the cloth separates from the hood in a zoomed sheet without breaking the
dark silhouette at 54px.

### The emblem, third iteration (it read as a squiggle)

A scorpion is not drawable in 8x8. The shipped glyph is: two claw pincers mirrored at the top, sym-
metric arms angling in, a 3x2 body, and a segmented tail leaving the right flank, curling down and
hooking back in at the stinger. The symmetry at the top broken by an off-centre tail is what makes it
read as a creature; the pixel map is in the function's own comment so the shape can be reviewed as a
shape. It is still a GLYPH and not an animal, and the version that reads best is the shipped one,
where the emblem is the brightest thing on a dark panel.

### The accent: RULED — the reduced area, and it is now the only behaviour

The maintainer chose the reduced accent ("variant B"), so it is no longer a variant: the temporary
`SCORPION_ACCENT` switch, the `SCORPION_REDUCED_ACCENT` constant and all three conditional sites were
deleted, the reduced geometry became the plain unconditional drawing code, and the pack was
regenerated. The bold version is deliberately NOT kept behind a flag — two behaviours in one shipped
generator is exactly the dead configuration that was flagged as a risk in the previous round.

What ships, and why it is the pack's own rule rather than a preference: `palette.mjs` opens with "ONE
ACCENT PER CHARACTER, on a desaturated base" and warns that spreading a saturated hue over a whole
garment is what made the v2 pack read as blobs of colour. A solid yellow tabard is exactly that spread
— roughly 176 saturated pixels on a 64px chest — and it made the figure read as a yellow person with
black sleeves instead of as a near-black silhouette marked with yellow. The accent is therefore spent
on EDGES and small marks, each of which has to justify its pixels:

| Element | Ruling |
|---|---|
| Tabard | DARK panel with a 1px yellow border |
| Emblem | yellow, on the dark panel — on dark cloth the mark has to be the bright thing |
| Forearm guards | dark cloth with ONE 1px yellow stripe each, following the arm |
| Boot flash | a 2px yellow mark at the toe end |
| Headband + tails | unchanged |

**The shipped `public/characters/scorpion/scorpion_spritesheet_v3.png` IS this costume**
(`7c34a7009652`), and there is no longer any environment influence on the generator at all —
`grep -rn "SCORPION_ACCENT"` over `scripts/`, `src/`, `test/` and `public/` returns nothing.

Final previews: `/tmp/preview-scorpion-final.png` (shipped Scorpion at zoom 4: idle/down, walk/side,
point/down, celebrate) and `/tmp/preview-scorpion-final-vs-elena.png` (Elena beside the shipped
Scorpion at the same zoom, same rows, for the cohesion check).

### The role: RULED — approved as it stands

`role: 'Security Reviewer'` is confirmed approved by the maintainer and is unchanged. It remains
invented-by-me in origin and product-visible in `characters_manifest.json` and `scorpion.json`, which
is now a documented choice rather than an open question.

Previews of the two candidates as they stood before the ruling:
`/tmp/accent-variant-a.png`, `/tmp/accent-variant-b.png`,
`/tmp/accent-variant-a-vs-elena.png`, `/tmp/accent-variant-b-vs-elena.png` and
`/tmp/accent-variants-side-by-side.png`. They are kept only as the record of what was chosen between;
both files were produced by the same source through the switch, which no longer exists.

## Verification

### Final round (switch removal)

- `npm test`: 1165 passed across 100 files, 0 failed.
- `npm run typecheck`: clean. `npm run lint:deps`: no dependency violations (222 modules, 782
  dependencies).
- The switch is GONE, verified by search rather than by memory: `grep -rn "SCORPION" scripts/ src/
  test/ public/` returns no hit inside any source or asset file, `grep -rn "SCORPION_ACCENT"` over the
  whole tree matches only this document, and `grep -rn "process.env" scripts/` returns 0 — the
  generator now reads no environment at all.
- Isolation re-run after the switch removal, against committed bytes: CURRENT `palette.mjs` +
  CURRENT `body.mjs` + HEAD poses still reproduces `git show HEAD:`'s sheets byte for byte for all four
  originals (alex `27b2d7d26f79`, marcus `1aff10dbb1e8`, sophia `ebdf7568151e`, elena
  `6df1c0d1039a`, all MATCH), and the row-level diff is unchanged (rows 5, 7, 8-10, 11-13, 14).
  Removing the switch did not disturb them.
- Determinism: `node scripts/gen-characters/index.mjs --out /tmp/gen-final2` reproduces every
  generator-produced file under `public/characters/` byte for byte, including
  `scorpion/scorpion_spritesheet_v3.png` = `7c34a7009652`, which is therefore the shipped reduced
  accent with no environment influence left. (The only files `diff -r` reports as "only in" the tree
  are the ones the generator never writes and must never write: the eight legacy `_v2` files,
  `sentinel/`, and `.DS_Store`.)
- Assets: `ls public/characters/*/*_v2.png | wc -l` -> 8, all four v2 pairs present; `find
  public/characters/scorpion -type f` -> exactly `scorpion.json`, `scorpion_spritesheet_v3.png`,
  `scorpion_portrait_v3.png`; `git status --porcelain | grep -c '^ D'` -> 0 deletions.

### Earlier rounds

- `src/ui/scene/character/character-sprite.test.ts`: 42 passed (from 8 failed / 34 passed at RED).
- Isolation, stated so a reader can weigh it: HEAD's `poses.mjs` is re-imported from the committed
  blob's text through a `data:` URL (`git show HEAD:scripts/gen-characters/poses.mjs`), which is what
  makes it HEAD's real source and also the limit of the claim — it is a re-import of one file, not a
  checkout, and it works only because that file has no relative imports. `body.mjs` does have them and
  could NOT be re-imported that way, so the body/palette side of the claim is verified against the
  committed PNG BYTES instead:
  - CURRENT `palette.mjs` + CURRENT `body.mjs` + HEAD poses reproduces HEAD's committed sheets
    byte for byte for all four original characters. That pins the whole palette+body delta — including
    the face rewrite, the emblem rewrite and the accent ruling — as inert for those four.
  - Frame by frame, HEAD poses vs shipped poses changes exactly rows 5 (walk/side), 7 (typing),
    8-10 (talk), 11-13 (point), 14 (celebrate), and NOTHING else: idle, walk/down, walk/up, work and
    sit are byte-identical. Re-run after the face, emblem and accent work: unchanged, same nine rows.
  - The four existing characters' shipped sheets still carry the same hashes as after the pose work
    (`a7bfb6ed5002`, `2edc23ee5cf3`, `2d94bc921fb7`, `af15441dfe4b`) across every round since.
- Mutation checks, all restored to GREEN afterwards:
  - `characterSheetUrl` -> `_v2.png` breaks `ships a spritesheet and a portrait file for every
    character, at the URLs the code builds` (proves the guard follows the URL builder).
  - a bogus legacy filename (`_portrait_v2X.png`) breaks `keeps the four original v2 pairs on disk,
    and fabricates no v2 art for a v3-born character`.
  - `% CHARACTER_IDS.length` -> `% 4` breaks `can reach EVERY shipped character`.
  - the roster assertion pointed at `/a/quiet` instead of `/a/pixel-agents` breaks `carries the
    character the scene draws that project as` with `expected 'scorpion' to be 'sophia'`.

## Honest limits

- The ART is verified by eye, not by tests. Tests can pin the contract (rows, frames, origin, ids,
  files) and the pose math, but nobody can assert "this reads as Scorpion".
- The fifth character changes the look of every existing project. That is accepted, not a bug.
  `/a/pixel-agents` itself now draws Scorpion.
- The emblem is a glyph that reads as a creature at 8px and not as an animal; the eye slits are two
  pixels wide because anything wider merges back into the visor this round removed. Both were tuned
  against the ASCII pixel dump and zoomed previews, three iterations for the emblem and two for the
  face.
- Scorpion's accent covers LESS area than any of the other four characters' single accent — border,
  one stripe per guard and a 2px boot flash. That is the ruling, and it is why the figure reads as a
  black silhouette with yellow edges rather than as a yellow figure with black sleeves.
- Task 7 (the optional AI tooltip portrait) is still open and undone by the maintainer's choice, not
  by omission: the shipped portrait is the procedural flat one.
