/**
 * The five agents, as palettes plus silhouette features.
 *
 * Two rules decide everything here, and both exist because a character has to be identifiable at
 * the size the office actually draws it (a 54px body at scale 2 in a 1672x941 room):
 *
 * 1. SILHOUETTE FIRST. Colour is the second thing a viewer resolves, never the first. Each
 *    character therefore owns a distinct outline — a hood lump, a beanie, a top bun, hair past the
 *    shoulders, a pointed hood — so the five stay apart even when they overlap or dim to
 *    `IDLE_CHARACTER_ALPHA`.
 * 2. ONE ACCENT PER CHARACTER, on a desaturated base. The bases are slate/teal/plum/aubergine at
 *    low saturation (and, for Scorpion, near-black); the single saturated hue per character (cyan,
 *    lime, magenta, amber, yellow) is spent only on deliberate areas — a drawstring, a sleeve
 *    stripe, glasses, a collar, a tabard and its guards. Spreading a saturated hue over a whole
 *    garment is what made the v2 pack read as four blobs of colour.
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
  },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS);
