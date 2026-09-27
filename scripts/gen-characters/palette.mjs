/**
 * The six agents, as palettes plus silhouette features.
 *
 * Two rules decide everything here, and both exist because a character has to be identifiable at
 * the size the office actually draws it (a 54px body at scale 2 in a 1672x941 room):
 *
 * 1. SILHOUETTE FIRST. Colour is the second thing a viewer resolves, never the first. Each
 *    character therefore owns a distinct outline — a hood lump, a beanie, a top bun, hair past the
 *    shoulders, a pointed hood, a ponytail over one shoulder — so the six stay apart even when they
 *    overlap or dim to `IDLE_CHARACTER_ALPHA`.
 * 2. ONE ACCENT PER CHARACTER, on a desaturated base. The bases are slate/teal/plum/aubergine/navy
 *    at low saturation (and, for Scorpion, near-black); the single saturated hue per character
 *    (cyan, lime, magenta, amber, yellow, royal blue) is spent only on deliberate areas — a
 *    drawstring, a sleeve stripe, glasses, a collar, a tabard and its guards, a headband and a
 *    sash. Spreading a saturated hue over a whole garment is what made the v2 pack read as four
 *    blobs of colour.
 *
 * Shades are derived with `shift()` rather than hand-picked so a palette edit stays coherent.
 */
export const OUTLINE = '#161327';

export const CHARACTERS = {
  alex: {
    displayName: 'Alex',
    role: 'Software Developer',
    skin: '#eab88c',
    hair: '#3a2b26',
    hairLight: '#54403a',
    top: '#31405f',
    topAlt: '#5470a3',
    accent: '#3ad6e6',
    pants: '#262b3d',
    shoes: '#e6ebf5',
    feature: 'hoodie',
    /** Headphones resting on the neck — the one accessory drawn in every direction. */
    headphones: true,
    hairStyle: 'short',
  },
  marcus: {
    displayName: 'Marcus',
    role: 'IT / DevOps Engineer',
    skin: '#8d5a3c',
    hair: '#1f1713',
    hairLight: '#332622',
    top: '#24443c',
    topAlt: '#3f7f6d',
    accent: '#7ee787',
    pants: '#2b3140',
    shoes: '#232838',
    feature: 'bomber',
    beanie: '#2f5c4f',
    hairStyle: 'buzz',
  },
  sophia: {
    displayName: 'Sophia',
    role: 'UX/UI Designer',
    skin: '#f2c9a4',
    hair: '#5a2f46',
    hairLight: '#7a4360',
    top: '#4b3055',
    topAlt: '#7e5290',
    accent: '#f06fc4',
    pants: '#2e2838',
    shoes: '#f3e4ef',
    feature: 'cardigan',
    glasses: true,
    hairStyle: 'bun',
  },
  elena: {
    displayName: 'Elena',
    role: 'Data Scientist / AI Engineer',
    skin: '#d99f72',
    hair: '#2a1d2b',
    hairLight: '#43304a',
    top: '#3b2c44',
    topAlt: '#6b4f79',
    accent: '#ffb84d',
    pants: '#282434',
    shoes: '#3a3348',
    feature: 'overshirt',
    hairStyle: 'long',
  },
  /**
   * Scorpion. The fifth, and the only one whose base is NEAR-BLACK cloth rather than a desaturated
   * hue: this file's first rule is silhouette first, and nothing states a silhouette louder than
   * black on a floor that is not black. The pointed hood is what has to survive the shrink to 54px,
   * so everything else — mask, gloves, boots, hair — is the same near-black family, and only the
   * edges separate them.
   *
   * The accent is a canary yellow, picked AGAINST Elena's amber `#ffb84d` rather than next to it,
   * because the two of them overlap in the room and both dim to `IDLE_CHARACTER_ALPHA`. Measured as
   * hue, amber sits at 36 degrees (orange-yellow) and this one at 51 (COLDER, closer to green);
   * measured as relative luminance it is roughly 0.76 against amber's 0.61, so it stays brighter and
   * greener at the same time. A second amber in the same room would read as one character with two
   * hair styles — a colder, brighter yellow on black does not.
   *
   * The yellow is spent on EDGES and small marks only — the headband, the tabard's border and its
   * emblem, one stripe down each forearm guard, and a 2px flash at each boot. A solid yellow tabard
   * was drawn and rejected: it puts ~176 pixels of saturated hue on a 64px chest, which is precisely
   * the spread of colour the rule at the top of this file warns about, and it made the figure read as
   * a yellow person with black sleeves rather than as a black silhouette marked with yellow.
   */
  scorpion: {
    displayName: 'Scorpion',
    role: 'Security Reviewer',
    skin: '#e9bb8f',
    hair: '#0c0c11',
    hairLight: '#1c1c24',
    top: '#15151c',
    topAlt: '#2a2a35',
    accent: '#ffe23d',
    pants: '#121218',
    shoes: '#191922',
    feature: 'scorpion',
    /**
     * Scorpion is the ONE character whose tooltip portrait is a shipped ASSET instead of a portrait
     * the generator draws (task 7 of `odd/tasks/scorpion-character.md`). `index.mjs` copies this file
     * byte-for-byte to `public/characters/scorpion/scorpion_portrait_v3.png`; it never decodes or
     * re-encodes it, because the generator has a PNG encoder only and a decoder is out of scope.
     *
     * Provenance, so the file is not a mystery raster in ten months:
     * 1. Generated with Nano Banana 2 at 1024x1024 from a prompt plus two input images: the shipped
     *    Scorpion sheet preview (for character and palette) and `alex_portrait_v3.png` (for bust
     *    framing).
     * 2. Downscaled 1024 -> 256 by an exact 4x NEAREST resize, which keeps hard pixel blocks instead
     *    of introducing anti-aliasing the rest of the pack does not have.
     * 3. QUANTIZED to the 40 colours of the shipped `scorpion_spritesheet_v3.png`, so no colour in
     *    the portrait falls outside the sprite's own palette. That is a MEASURED property, not a
     *    hope — `character-sprite.test.ts` decodes both PNGs and fails if any portrait colour is
     *    absent from the sheet.
     *
     * Why an asset and not a generated portrait: the maintainer chose the AI illustration for the
     * 256x256 tooltip, where there is no grid and no frame count and the extra detail reads. The
     * honest limit is that its pixel GRANULARITY is finer than the generator's, so at tooltip size it
     * reads as a more detailed illustration than the flat sprite on the floor; the shared palette is
     * what stops the two from reading as different characters in COLOUR.
     */
    portraitAsset: 'assets/scorpion-portrait.png',
  },
  /**
   * Kitana. The sixth character, and the second to rise.
   *
   * THE BLUE COLLISION, resolved deliberately. Alex already owns a slate base with a CYAN accent
   * (`#31405f` / `#3ad6e6`), so "Kitana is the blue one" cannot mean "a blue like Alex's" or the
   * two read as the same figure in two poses. Three choices keep them apart, in order of how much
   * each one carries:
   *
   * 1. THE SILHOUETTE CARRIES THE IDENTITY. A long ponytail sweeping over one shoulder plus two
   *    open fans, one per hand, are unmistakable even in one flat colour — which is what `palette`'s
   *    first rule asks for. Nothing about her depends on being read as blue.
   * 2. THE HUE IS FAR FROM ALEX'S CYAN, not merely darker. Cyan sits at hue 186 and is a green-leaning
   *    blue; this accent is a royal blue at hue ~232, an indigo-leaning blue 46 degrees away. They
   *    are different blues, not one blue at two brightnesses, which is the only kind of difference
   *    that survives `IDLE_CHARACTER_ALPHA` and the room's dim band.
   * 3. THE FANS ADD A SECOND, NON-ACCENT CUE: STEEL. A low-saturation grey is not a second accent
   *    under rule 2 — it is a neutral — but no other character carries it, so it separates her from
   *    everyone while the single saturated hue stays spent on the headband, the sash and the boot
   *    tops alone.
   *
   * The base is a deep desaturated navy (much darker and bluer than Alex's slate) so the figure is
   * still one dark silhouette marked with one bright hue, which is the pack's rule rather than a
   * preference. Verified by rendering her beside Alex and beside Scorpion, not by reasoning alone.
   */
  kitana: {
    displayName: 'Kitana',
    role: 'Delivery Lead',
    skin: '#e9bb8f',
    hair: '#0d0e14',
    hairLight: '#242a40',
    top: '#1a2036',
    topAlt: '#31446b',
    accent: '#4a63ff',
    pants: '#161c2b',
    shoes: '#1d2740',
    /** Neutral steel for the two war fans — the low-saturation cue no other character owns. Not a
     * second accent (see rule 2): it is a grey, so it never competes with the royal blue. */
    steel: '#98a1b3',
    feature: 'kitana',
  },
};

/**
 * Generation order, NOT the hash table.
 *
 * There are TWO independently ordered id lists in this generator and a reader WILL mistake one for
 * the other:
 * - THIS one is only the order `index.mjs` writes characters into `public/characters/` and into
 *   `characters_manifest.json` (which stores a keyed object, so its own order is cosmetic). It
 *   drives nothing at runtime.
 * - The RUNTIME mapping table is `CHARACTER_IDS` in
 *   `src/ui/scene/character/character-sprite.ts`, where `resolveCharacterId` maps a project onto
 *   `CHARACTER_IDS[hash % length]`. That order is a hash table, not a display order, and reordering
 *   it silently reassigns every project's character.
 * The two already DIFFER: the runtime list leads with Scorpion (the no-project default), while this
 * one keeps the original generation order. That is fine, because the only consumer here is the
 * generator loop. Do NOT reorder this list to "match" the runtime one, and do NOT treat it as the
 * mapping table.
 */
export const CHARACTER_IDS = Object.keys(CHARACTERS);
