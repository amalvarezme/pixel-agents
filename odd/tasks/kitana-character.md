# Tasks: Kitana, a sixth office character

Feature doc for ODD. Branch `feat-kitana-character`, off `main` after the Scorpion default change.

## Why

The maintainer asked for Kitana as a second character, "with the same strategies used for Scorpion",
and asked for her to be the SECOND one to rise: slot 1 of `CHARACTER_IDS`, right after Scorpion.

## The same strategies, applied again

1. **An AI concept image as the design brief.** Generated through the `nanobanana` MCP
   (`/tmp/kitana/char-1.png`, kept out of the repo).
2. **The style reference was CHANGED and it worked.** For Scorpion the reference was the shipped
   `alex_spritesheet_v3.png` and style transfer FAILED, because a 64px sheet is not readable to an
   image model. This time the reference was `/tmp/preview-scorpion-final.png`, the ZOOMED preview of
   the shipped pack, and the style transferred: the result is flat, limited-palette, one dark
   silhouette with a single saturated accent, like the pack.
3. **It over-transferred the PALETTE**, which is fine by design. The brief asked for royal blue and
   the model returned Scorpion's black-and-yellow, copying the reference's colours. In this
   architecture colour lives in `palette.mjs`, not in the reference image, so the reference is used
   for SILHOUETTE and COMPOSITION only and the palette is decided in code.
4. **Implement in the generator, never paste the raster in.** The office draws a ~54px body at scale
   2, so only the silhouette survives and the pack's contract (64px frames, nearest scaling, feet
   origin, one accent) has to hold.
5. **TDD for the contract, eyes for the art.** Tests can pin ids, rows, frames, origin and files;
   nobody can assert that a sprite reads as Kitana.
6. **Validate the artifact, not just the tests**: sheet size, binary alpha, origin, all 16 rows with
   content, and the BODY ENVELOPE against the four characters that were calibrated first
   (columns 17..49, feet row 60), because the hover box and depth occlusion were measured from them.

## Design to implement (from the reference image)

Long black ponytail sweeping down past one shoulder (the strongest silhouette marker, and what
separates her from Alex), a cloth mask over the nose and mouth with only the eyes visible, a fitted
bodysuit, steel forearm guards, thigh-high boots, a sash at the waist, and a pair of open steel war
fans held one in each hand with the blades fanned outward.

## Palette problem to solve honestly

Alex already owns a slate-blue base with a CYAN accent, so "Kitana is the blue one" collides with an
existing character. Her identity has to come from the silhouette first (the ponytail plus the fans are
unmistakable even in one flat colour) and from a blue that is clearly different in hue from Alex's
cyan. The fans give a second, non-saturated cue: STEEL, which no other character has.

## Tasks

- [x] 1 RED: added `'kitana'` to `CHARACTER_IDS` at slot 1 before any art existed. Observed RED:
      `9 failed | 1157 passed` over the whole suite, and `9 failed | 34 passed (43)` in
      `character-sprite.test.ts` alone (six `loadMeta('kitana')` ENOENT failures plus the manifest
      list, the URL-file guard and the v2 guard). Then GREEN.
- [x] 2 Checked the v2 guard. It ENUMERATED ONE ID (`expect(bornAtV3).toEqual(['scorpion'])`), so it
      silently stopped guarding Kitana the moment she landed. Changed the enumeration to
      `['scorpion', 'kitana']` and, while there, made the negative assert BOTH legacy filenames
      (`_spritesheet_v2.png` and `_portrait_v2.png`) instead of only the spritesheet, so Kitana's
      negative is the same shape as the legacy positive. Mutation-proved below.
- [x] 3 GREEN: `palette.mjs` gained the `kitana` entry; `body.mjs` gained NEW `p.feature === 'kitana'`
      branches (torso/sash, thigh-high boots, arm with fan, head with ponytail and mask). No existing
      feature branch was edited and no shared drawing code was changed beyond passing the already-known
      `dir` and arm index through `drawArms -> drawArm`. The five existing characters regenerate byte
      for byte (hashes in Verification).
- [x] 4 `resolveCharacterId` still derives its modulus from `CHARACTER_IDS.length` (no literal
      anywhere) and the reachability pin now reaches all SIX ids: `npm test` green, and the pin is
      mutation-proved below.
- [x] 5 Regenerated with `npm run gen:characters` and verified: the five existing sheets are
      byte-identical, Kitana's sheet is 384x1024, binary alpha, origin (32,60), all 16 rows hold
      content, and her body stays inside the calibrated envelope x[17..49] with the feet on row 60.
      `poses.mjs` is byte-identical to HEAD.
- [x] 6 Eye check done at 6x, and in three-way comparison with Alex and Scorpion. Previews:
      `/tmp/kitana/preview-kitana.png`, `/tmp/kitana/threeway.png`,
      `/tmp/kitana/kitana-vs-alex.png`, `/tmp/kitana/kitana-vs-scorpion.png`,
      plus the pixel-level crops `/tmp/kitana/face-kitana.png`, `/tmp/kitana/fan-down.png`,
      `/tmp/kitana/fan-side.png`.

## The blue collision, resolved (and verified by eye, not by reasoning)

Alex owns a slate-blue base with a CYAN accent; Scorpion owns near-black with canary. Kitana is
resolved in three layers, in order of how much each carries:

1. **Silhouette first.** A ponytail mass beside the head plus two open fans, one per hand, are
   unmistakable in one flat colour. The head also gains a topknot over the crown, so the head outline
   is asymmetric in a way neither Alex's hoodie lump nor Scorpion's hood is.
2. **A different HUE, not a darker cyan.** Alex's accent `#3ad6e6` sits at hue ~186 (green-leaning
   cyan); Kitana's `#4a63ff` sits at hue ~232 (indigo-leaning royal blue), 46 degrees away. They are
   different blues, which is the only kind of difference that survives `IDLE_CHARACTER_ALPHA`.
3. **STEEL, the second cue.** The fans are a low-saturation grey (`#98a1b3`) that no other character
   carries. Under `palette.mjs`'s rule 2 a grey is a neutral, not a second accent, so the single
   saturated hue stays spent on the headband, the sash's top edge, the wrist mark and the boot tops.

All three were checked by rendering her beside Alex and beside Scorpion and looking at the result,
not by argument.

## Decisions taken during implementation

- **The ponytail hangs BESIDE the head, not across the face.** The first pass swept it through the
  middle of the face and it read as a black bar down the head and chest. It now uses the same 2-3px
  channel beside the skull that Elena's long hair uses, but longer and with a topknot.
- **The mask is nearly the same value as the suit** (`shift(top, 0.05)`). A lighter cloth read as a
  grey beard in the first pass; the separation only needs to be enough to read as cloth in a zoomed
  sheet.
- **The eyes are ONE row of skin with two pupils.** Two rows of pale skin is the visor that Scorpion's
  first head had to be rewritten to remove; one row with pupils reads as eyes.
- **The fans are radius-5 sectors, hinged at the hand, opening outward**, with the hand drawn SMALL
  (radius 1) so the blades clear it. The hinge is biased toward the body ONLY as far as the calibrated
  envelope demands (`celebrate` t3 puts the near hand at x=20; `point/up` t4 puts the far hand at
  x=45), and the bias collapses to zero everywhere the pose leaves room. The fan bends to the envelope
  rather than the reverse.
- **The forearm accent is a WRIST mark, not a stripe down the whole guard.** A full-length 1px stripe
  put a bright blue line down both arms and read as a blue arm rather than a blue edge.
- **`role: 'Delivery Lead'`** is invented here, the same way Scorpion's `'Security Reviewer'` was:
  nothing names a role for a sixth character and the meta builder needs a string. It is inert metadata
  (no runtime code reads it) but product-visible in the manifest, so it is called out for approval.
- **The two id lists drift trap.** `scripts/gen-characters/palette.mjs` exports its own
  `CHARACTER_IDS = Object.keys(CHARACTERS)` in a second, independently ordered list that already no
  longer matches the runtime order (the runtime leads with Scorpion as the no-project default; the
  generator keeps the original order). Nothing breaks: `index.mjs` iterates `Object.entries(CHARACTERS)`
  and the manifest is a keyed object, and `character-sprite.test.ts` compares sorted key sets. A short
  comment now states which list is the mapping table and which is merely generation order.
  **More than a comment may be warranted:** that exported `CHARACTER_IDS` is in fact UNUSED anywhere
  (`grep -rn CHARACTER_IDS scripts/` finds only the declaration and the comment). Deleting it would
  remove the trap outright. It was NOT deleted because this unit scoped the item to a comment; it is
  reported as a candidate cleanup instead.

## Verification

### Commands

- `npm test`: **1167 passed across 100 files, 0 failed** (was 1166 before the new slot-1 pin).
- `npm run typecheck`: clean. `npm run lint:deps`: no dependency violations (222 modules, 782
  dependencies).
- `npm run gen:characters`: regenerated all six characters.

### Byte-identity proof for the five existing characters

Committed bytes BEFORE and AFTER a full regeneration are identical for every generator-produced file
of the five existing characters (`characters_manifest.json` and the three new Kitana files are the only
differences):

| Sheet | hash (before = after) |
|---|---|
| alex | `a7bfb6ed5002a395…` |
| marcus | `2edc23ee5cf3a0ba…` |
| sophia | `2d94bc921fb79cf4…` |
| elena | `af15441dfe4b4f92…` |
| scorpion | `7c34a70096525234…` |

Full trees were hashed before and after (`find public/characters -name '*_v3.png' -o -name '*.json'`);
the only diff lines are `characters_manifest.json` and the added `kitana/` files. `poses.mjs` is
byte-identical to HEAD (`git diff --quiet scripts/gen-characters/poses.mjs` returns clean).

### Kitana's sheet, read back from the SHIPPED PNG (not from the generator)

A standalone decoder (inflate + unfilter) over `public/characters/kitana/kitana_spritesheet_v3.png`:

- 384x1024, `nonBinaryAlpha = 0` (every alpha is exactly 0 or 255).
- Per-row local bounding boxes all inside x[17..49]; every non-`sit` row reaches y=60, and `sit`
  reaches y=58 (the same as every other character). All 16 rows carry content.
- `origin = (32,60)`, `sheetWidth/sheetHeight = 384/1024` in `kitana.json`.

### Mutation checks (each restored to GREEN afterwards)

| Mutation | Test that went RED |
|---|---|
| `CHARACTER_IDS` reordered so Kitana is last instead of slot 1 | `resolveCharacterId > places Kitana SECOND: the maintainer asked for her right after the default` |
| `% CHARACTER_IDS.length` -> `% 4` | `resolveCharacterId > can reach EVERY shipped character…` (reported `sophia` and `elena` unreachable) |
| a fabricated `kitana/kitana_spritesheet_v2.png` | `shipped asset pack > keeps the four original v2 pairs on disk, and fabricates no v2 art for a v3-born character` |
| a fabricated `kitana/kitana_portrait_v2.png` | same test — proves the portrait half of the negative is load-bearing |

### Mapping table, rendered by importing the real `resolveCharacterId`

| Path | BEFORE | AFTER |
|---|---|---|
| `/Users/andresalvarez/Documents/pixel-agents` | `scorpion` | `kitana` |
| `/Users/andresalvarez/Documents` | `scorpion` | `kitana` |
| `/Users/andresalvarez/Documents/EsperanzaIA_UNAL` | `alex` | `sophia` |
| `/a/pixel-agents` | `elena` | `scorpion` |

`CHARACTER_IDS` after: `['scorpion', 'kitana', 'alex', 'marcus', 'sophia', 'elena']`. Every project
moves once, exactly as the consequence section below warned.

## Consequence the maintainer was told about

Going from five ids to six changes the hash modulus again, so every project moves once more. The
maintainer's own checkout (`/Users/andresalvarez/Documents/pixel-agents`) hashes to index 1, which is
where Kitana goes, so after this change THEIR OWN OFFICE DRAWS KITANA and Scorpion stays the
no-project default. The alternative (swapping the first two slots so their office keeps Scorpion) was
offered and is a one-line change plus a manifest regeneration, with no art implications.

**Realized and verified:** the AFTER mapping table above confirms it —
`/Users/andresalvarez/Documents/pixel-agents -> kitana`.

## Honest limits

- The blue-versus-Alex collision was the main risk. It was checked by eye (three-way render) and the
  two read apart: Alex is a lighter slate figure with a bright green-leaning cyan, Kitana is a dark
  navy figure with an indigo-leaning royal blue, plus the ponytail, mask and steel fans none of the
  others have. If a future review disagrees at room scale, the fix is a hue shift of `accent`, not
  more detail.
- The fans are two new props. They stay inside the envelope (verified per row) and read as held
  objects, but at radius 5 they are small — smaller than the reference's fans, because the shared
  poses hold the hands at the hips and the calibrated envelope is only 33 columns wide. The envelope
  won.
- The art is verified by eye. No test can assert "this reads as Kitana".
- **`role: 'Delivery Lead'` is unapproved.** Invented to fill the meta builder's string, inert at
  runtime, product-visible in `characters_manifest.json`. Flagged for the maintainer exactly as
  Scorpion's role was; rename it if it should be something else.
- **Out-of-surface observation, not fixed:** `scripts/gen-characters/README.md` still says
  "`palette.mjs` — the four characters" (stale since Scorpion, and outside this unit's edit
  surfaces). It should say six.
- **`scripts/gen-characters/palette.mjs`'s exported `CHARACTER_IDS` is dead code** (unused anywhere).
  The drift-trap comment was the requested fix and it is in place; deleting the export is the stronger
  cleanup and is reported rather than done, because this unit scoped the item to a comment.
