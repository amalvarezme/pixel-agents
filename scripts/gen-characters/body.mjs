/**
 * Draws ONE character frame. Everything is expressed against a fixed skeleton in 64x64 frame
 * pixels, so every clip of every character anchors identically and the pack's `origin` contract
 * (feet centre, guide section 5) holds without per-pose fudging.
 *
 * Why a skeleton and not 64 hand-placed sprites: the pack needs 4 characters x 16 rows x 6 frames
 * = 384 frames. The only way to keep those consistent — same eye line, same shoulder height, same
 * foot plane — is to derive them all from one set of joints and vary the joints. The cost is that
 * the art is systematic rather than expressive, which is exactly why the output is meant to be
 * opened in Aseprite and pushed further by hand.
 *
 * Layer order matters and is direction-dependent: in profile the FAR limbs are drawn first and
 * darkened, so an arm reads as being behind the torso instead of painted onto it.
 */
import { Frame, shift } from './pixel.mjs';
import { OUTLINE } from './palette.mjs';

export const FRAME_SIZE = 64;
export const ORIGIN = { x: 32, y: 60 };

const GROUND_Y = 59;
const HEAD_CY = 17;
const HEAD_RX = 8;
const HEAD_RY = 9;
const NECK_Y = 26;
const SHOULDER_Y = 29;
const HIP_Y = 46;
const FOOT_Y = 55;

/** How much a far-side limb is darkened so depth reads without a second palette. */
const FAR = -0.28;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------- torso

function torsoSpan(dir, y) {
  const t = (y - SHOULDER_Y) / (HIP_Y - SHOULDER_Y);
  // Profile faces right: the chest edge sits forward of centre and the back edge behind it, so
  // the torso reads as having a direction even before the face is visible.
  if (dir === 'side') return [Math.round(lerp(26, 27, t)), Math.round(lerp(39, 37, t))];
  return [Math.round(lerp(22, 25, t)), Math.round(lerp(41, 38, t))];
}

function drawTorso(f, p, { dir, bob }) {
  const base = p.feature === 'cardigan' ? HIP_Y + 3 : HIP_Y;
  for (let y = SHOULDER_Y; y <= base; y++) {
    const [x0, x1] = torsoSpan(dir, Math.min(y, HIP_Y));
    f.rect(x0, y + bob, x1, y + bob, p.top);
  }

  // Neck, drawn before the collar so every feature can cover it.
  if (dir !== 'up') f.rect(30, NECK_Y + bob, 33, SHOULDER_Y + bob, shift(p.skin, -0.1));

  const [sx0, sx1] = torsoSpan(dir, SHOULDER_Y);
  f.rect(sx0 + 4, SHOULDER_Y + bob, sx1 - 4, SHOULDER_Y + bob, shift(p.top, -0.25));

  if (p.feature === 'hoodie') {
    // Hood bunched at the back of the neck: the lump that gives Alex his silhouette.
    f.ellipse(32, SHOULDER_Y - 1 + bob, dir === 'side' ? 6 : 8, 4, p.topAlt);
    if (dir === 'down') {
      f.rect(30, SHOULDER_Y + 3 + bob, 30, SHOULDER_Y + 8 + bob, p.accent);
      f.rect(34, SHOULDER_Y + 3 + bob, 34, SHOULDER_Y + 7 + bob, p.accent);
      f.rect(27, HIP_Y - 5 + bob, 37, HIP_Y - 3 + bob, shift(p.top, -0.12)); // front pocket
    }
  }

  if (p.feature === 'bomber') {
    f.rect(sx0, SHOULDER_Y + bob, sx1, SHOULDER_Y + 1 + bob, shift(p.topAlt, 0.1)); // collar band
    f.rect(sx0, HIP_Y + bob, sx1, HIP_Y + bob, shift(p.accent, -0.25)); // waistband
    if (dir === 'down') f.rect(32, SHOULDER_Y + 2 + bob, 32, HIP_Y - 2 + bob, shift(p.top, -0.2)); // zip
  }

  if (p.feature === 'cardigan') {
    // Open front over a light tee: two panels plus a gap, which is what widens her silhouette.
    if (dir === 'down') {
      f.rect(29, SHOULDER_Y + 1 + bob, 34, base + bob, shift(p.skin, 0.32));
      f.rect(29, SHOULDER_Y + 1 + bob, 29, base + bob, shift(p.accent, -0.2));
      f.rect(34, SHOULDER_Y + 1 + bob, 34, base + bob, shift(p.accent, -0.2));
    } else if (dir === 'side') {
      f.rect(35, SHOULDER_Y + 1 + bob, 37, base + bob, shift(p.skin, 0.32));
      f.rect(35, SHOULDER_Y + 1 + bob, 35, base + bob, shift(p.accent, -0.2));
    }
  }

  if (p.feature === 'overshirt') {
    f.rect(30, NECK_Y + bob, 33, SHOULDER_Y + 1 + bob, p.accent); // turtleneck collar
    if (dir === 'down') f.rect(30, SHOULDER_Y + 2 + bob, 33, HIP_Y + bob, shift(p.top, 0.16));
    else if (dir === 'side') f.rect(35, SHOULDER_Y + 2 + bob, 37, HIP_Y + bob, shift(p.top, 0.16));
  }

  if (p.feature === 'scorpion') drawScorpionTorso(f, p, { dir, bob });
}

/**
 * Scorpion's chest: the tabard, its emblem, and the rope belt. A NEW branch, not a variation of the
 * four above it — none of their code is reused or edited, and none of them reaches this one.
 *
 * The accent AREA here is the maintainer's ruling, and it is the pack's own rule applied, not a
 * preference: `palette.mjs` opens with "ONE ACCENT PER CHARACTER, on a desaturated base", and says
 * plainly that spreading a saturated hue over a whole garment is what made the v2 pack read as four
 * blobs of colour. A solid yellow tabard on a 64px chest is exactly that spread — 176 pixels of hue
 * on a figure that is otherwise black — so the costume is drawn the strict way: near-black cloth
 * with the accent as BORDER, one stripe per guard and a small boot flash. Same hue, a fraction of
 * the area, which is what keeps the silhouette (and not the colour) the first thing a viewer resolves.
 *
 * The tabard is a NARROW panel (8px on a 20px chest) rather than a full-width one, for the same
 * reason. From BEHIND there is no tabard at all: the back stays near-black, which is what makes the
 * front/back reads differ by more than the face.
 */
function drawScorpionTorso(f, p, { dir, bob }) {
  // The hood's cloth continues over the neck. Without this the generic skin neck would show as a
  // bright patch between a black head and a black tunic.
  f.rect(30, NECK_Y + bob, 33, SHOULDER_Y + bob, p.top);

  if (dir !== 'up') {
    const [tx0, tx1] = dir === 'side' ? [32, 36] : [28, 35];
    const top = SHOULDER_Y + 1 + bob;
    const bottom = HIP_Y + 6 + bob;

    // Dark cloth for the panel, with the accent spent on its EDGE. The border is what makes the
    // tabard read as a garment at 54px; the fill is what keeps the figure black.
    f.rect(tx0, top, tx1, bottom, p.topAlt);
    f.rect(tx0, top, tx1, top, p.accent);
    f.rect(tx0, bottom, tx1, bottom, p.accent);
    f.rect(tx0, top, tx0, bottom, p.accent);
    f.rect(tx1, top, tx1, bottom, p.accent);

    // Emblem, front only, and in the accent: on dark cloth the mark has to be the bright thing.
    // Eight pixels is all a scorpion can be at this size — at 54px this is the mark on the tabard
    // rather than a legible animal.
    if (dir === 'down') drawScorpionEmblem(f, 31, SHOULDER_Y + 9 + bob, p.accent);
  }

  // Rope belt. Derived from the skin tone rather than hand-picked, like every other shade here: at
  // -0.45 the skin turns into the greyish brown the reference's twisted rope actually is.
  const rope = shift(p.skin, -0.45);
  const [bx0, bx1] = torsoSpan(dir, HIP_Y);
  f.rect(bx0, HIP_Y - 1 + bob, bx1, HIP_Y + bob, rope);
  if (dir === 'down') {
    f.rect(30, HIP_Y + 1 + bob, 33, HIP_Y + 2 + bob, rope); // knot
    f.rect(30, HIP_Y + 3 + bob, 30, HIP_Y + 6 + bob, rope); // the two loose ends
    f.rect(33, HIP_Y + 3 + bob, 33, HIP_Y + 6 + bob, rope);
  }
}

/**
 * The tabard's scorpion. Eight pixels cannot draw an animal, so this is a GLYPH built to be read in
 * one glance rather than an anatomically faithful scorpion:
 *
 *     P P . . . P P    two claw pincers raised SYMMETRICALLY — the only part the eye resolves,
 *      P . . . . P      with the tips hooked outward so they read as claws and not as antennae
 *       P . P
 *       B B B
 *       B B B T        body, with a segmented tail leaving the right flank
 *         B B T
 *             T        tail curling down
 *           S          and hooking back in at the stinger
 *
 * What makes it read as a creature and not as a squiggle: reflective symmetry at the top (mirrored
 * pincers over a body) broken by an OFF-CENTRE tail, which is the shape of the real thing and the
 * one cue that survives at 54px. Its predecessor was an asymmetric blob with a legs bar that read as
 * a bird's beak. Single colour on purpose — a second colour would make it a garment, not a mark.
 *
 * `cx`, `cy` is the centre of the BODY; the glyph spans 8 columns and 8 rows around it.
 */
function drawScorpionEmblem(f, cx, cy, ink) {
  f.rect(cx - 3, cy - 3, cx - 3, cy - 3, ink); // left claw tip, hooked outward
  f.rect(cx - 2, cy - 3, cx - 2, cy - 2, ink); // left pincer stem
  f.rect(cx + 3, cy - 3, cx + 3, cy - 3, ink); // right claw tip
  f.rect(cx + 2, cy - 3, cx + 2, cy - 2, ink); // right pincer stem
  f.rect(cx - 1, cy - 1, cx - 1, cy - 1, ink); // left arm, angling in
  f.rect(cx + 1, cy - 1, cx + 1, cy - 1, ink); // right arm, angling in
  f.rect(cx - 1, cy, cx + 1, cy + 1, ink); // body
  f.rect(cx + 2, cy + 1, cx + 2, cy + 1, ink); // tail, first segment
  f.rect(cx + 3, cy + 2, cx + 3, cy + 3, ink); // tail, curving down
  f.rect(cx + 2, cy + 4, cx + 2, cy + 4, ink); // stinger, hooking back in
}

// ---------------------------------------------------------------------------- legs

/** `legs` is `[far, near]`; each entry is `{ dx, lift }` in frame pixels. */
function drawLegs(f, p, { dir, bob, legs, sitting }) {
  const hip = HIP_Y + bob;
  const order = dir === 'side' ? [0, 1] : [0, 1];

  for (const i of order) {
    const { dx, lift } = legs[i];
    const far = dir === 'side' && i === 0;
    const pants = far ? shift(p.pants, FAR) : p.pants;
    const shoes = far ? shift(p.shoes, FAR) : p.shoes;

    if (sitting) {
      // Seated, read from the front: the thigh is foreshortened to a knee block pointing at the
      // viewer and the shin drops from it. Drawn with a deliberate gap between the legs — the first
      // version butted them together and the two shoes merged into one slab.
      if (dir === 'side') {
        f.rect(30 + i, hip, 39 + i, hip + 4, pants); // thigh forward
        f.rect(36 + i, hip + 4, 40 + i, hip + 10, pants); // shin down
        f.rect(36 + i, hip + 10, 42 + i, hip + 12, shoes);
      } else {
        const x0 = 26 + i * 7;
        f.rect(x0, hip, x0 + 5, hip + 4, pants); // knee toward the viewer
        f.rect(x0 + 1, hip + 4, x0 + 4, hip + 9, pants);
        f.rect(x0 + 1, hip + 9, x0 + 4, hip + 11, shoes);
      }
      continue;
    }

    const cx = (dir === 'side' ? 28 + i * 3 : 27 + i * 6) + dx;
    const foot = FOOT_Y + bob - lift;
    f.rect(cx, hip, cx + 4, foot, pants);
    // Shoe: extends toward the facing direction, which is what stops the profile reading as a post.
    if (dir === 'side') f.rect(cx, foot, cx + 6, GROUND_Y + bob - lift, shoes);
    else f.rect(cx, foot, cx + 4, GROUND_Y + bob - lift, shoes);
    // Scorpion's boot flash: a 2px mark at the boot's toe end, not a band across the whole boot.
    // A full-width band reads as yellow boots with a black sole — the opposite of the reference — and
    // even one full-width pixel spends more accent on the floor than the ruling allows. Darkened with
    // the boot when the leg is the far one, so depth still reads.
    if (p.feature === 'scorpion') {
      const flash = far ? shift(p.accent, FAR) : p.accent;
      f.rect(cx, foot, cx + 1, foot, flash);
    }
  }
}

// ---------------------------------------------------------------------------- arms

/**
 * Scorpion's arm: charcoal sleeve, a black glove, and the forearm guard carrying the ONE yellow
 * stripe the accent budget allows. The stripe marks a small area that follows the gesture, which is
 * the job `palette.mjs`'s rule gives a saturated hue on a near-black figure. A separate branch: the
 * four original features go on drawing skin and sleeve exactly as before.
 */
function drawScorpionArm(f, p, { shoulder, elbow, hand, far }) {
  const sleeve = far ? shift(p.topAlt, FAR) : p.topAlt;
  const guard = far ? shift(p.accent, FAR) : p.accent;
  const glove = far ? shift(p.top, FAR) : shift(p.top, 0.18);

  f.line(shoulder[0], shoulder[1], elbow[0], elbow[1], sleeve, 4);
  // The guard is cloth like the rest of the sleeve, with ONE stripe down it. The stripe is a 1px line
  // along the same elbow->hand segment the sleeve is built from, so it follows the arm in every pose
  // instead of being a decal pinned to one frame.
  f.line(elbow[0], elbow[1], hand[0], hand[1], sleeve, 4);
  f.line(elbow[0], elbow[1], hand[0], hand[1], guard, 1);
  f.ellipse(hand[0], hand[1], 2, 2, glove);
}

/** One arm as upper + forearm, with an accent cuff for the characters whose jacket has one. */
function drawArm(f, p, { shoulder, elbow, hand, far, sleeveTo }) {
  if (p.feature === 'scorpion') {
    drawScorpionArm(f, p, { shoulder, elbow, hand, far });
    return;
  }

  const sleeve = far ? shift(p.topAlt, FAR) : p.topAlt;
  const skin = far ? shift(p.skin, FAR) : p.skin;

  f.line(shoulder[0], shoulder[1], elbow[0], elbow[1], sleeve, 4);
  const forearmIsSleeve = sleeveTo === 'hand';
  f.line(elbow[0], elbow[1], hand[0], hand[1], forearmIsSleeve ? sleeve : skin, forearmIsSleeve ? 4 : 3);
  if (p.feature === 'bomber') f.ellipse(hand[0], hand[1] - 3, 2, 1, far ? shift(p.accent, FAR) : shift(p.accent, -0.15));
  f.ellipse(hand[0], hand[1], 2, 2, skin);
}

function drawArms(f, p, { dir, bob, arms, only = 'both' }) {
  const sleeveTo = dir === 'up' || p.feature === 'cardigan' || p.feature === 'overshirt' ? 'hand' : 'elbow';
  let entries = dir === 'side' ? [[0, true], [1, false]] : [[0, false], [1, false]];
  if (only === 'far') entries = entries.filter(([, far]) => far);
  if (only === 'near') entries = entries.filter(([, far]) => !far);
  for (const [i, far] of entries) {
    const a = arms[i];
    drawArm(f, p, {
      shoulder: [a.shoulder[0], a.shoulder[1] + bob],
      elbow: [a.elbow[0], a.elbow[1] + bob],
      hand: [a.hand[0], a.hand[1] + bob],
      far,
      sleeveTo,
    });
  }
}

// ---------------------------------------------------------------------------- head

function drawHair(f, p, { dir, bob, cx, cy }) {
  const hair = p.hair;
  const lit = p.hairLight;

  if (p.beanie) {
    f.ellipse(cx, cy - 4 + bob, HEAD_RX, HEAD_RY - 3, p.beanie);
    f.rect(cx - HEAD_RX, cy - 2 + bob, cx + HEAD_RX, cy + bob, shift(p.beanie, -0.15));
    return;
  }

  // Cap of hair over the CROWN only. It stops two rows above the eye line on purpose: the first
  // generation drew the cap through the eyes and every character came out blindfolded.
  f.ellipse(cx, cy - 5 + bob, HEAD_RX, HEAD_RY - 4, hair);
  f.rect(cx - HEAD_RX, cy - HEAD_RY + 1 + bob, cx + HEAD_RX, cy - 3 + bob, hair);
  f.rect(cx - HEAD_RX + 1, cy - HEAD_RY + bob, cx + 2, cy - HEAD_RY + bob, lit); // top highlight

  if (dir === 'up') {
    // From behind there is no face to protect, so the hair covers the whole skull.
    f.ellipse(cx, cy - 1 + bob, HEAD_RX, HEAD_RY - 1, hair);
  }

  if (dir === 'side') {
    // Back of the skull down to the nape. Without it the profile shows a bald patch behind the ear.
    f.rect(cx - HEAD_RX, cy - 5 + bob, cx - 4, cy + 2 + bob, hair);
  }

  if (p.hairStyle === 'short' && dir !== 'up') {
    f.rect(cx - HEAD_RX, cy - 4 + bob, cx - HEAD_RX + 2, cy + 1 + bob, hair); // sideburn
    f.rect(cx + HEAD_RX - 2, cy - 4 + bob, cx + HEAD_RX, cy + bob, hair);
  }

  if (p.hairStyle === 'bun') {
    const bx = cx + (dir === 'side' ? -5 : 0);
    f.ellipse(bx, cy - HEAD_RY - 1 + bob, 4, 4, hair);
    f.ellipse(bx - 1, cy - HEAD_RY - 2 + bob, 2, 1, lit);
    f.rect(cx - HEAD_RX, cy - 3 + bob, cx - HEAD_RX + 1, cy + bob, hair); // wisp at the temple
    f.rect(cx + HEAD_RX - 1, cy - 3 + bob, cx + HEAD_RX, cy + bob, hair);
  }

  if (p.hairStyle === 'long') {
    // Falls to just below the shoulder, 2px wide. Any wider and it covers the arms, which is what
    // made the first generation read as a hooded figure rather than as a person with long hair.
    const drop = SHOULDER_Y + 4 + bob;
    if (dir === 'side') {
      f.rect(cx - HEAD_RX - 1, cy - 3 + bob, cx - HEAD_RX + 1, drop, hair);
      f.rect(cx - HEAD_RX, cy + 1 + bob, cx - HEAD_RX, cy + 6 + bob, lit);
    } else {
      f.rect(cx - HEAD_RX - 1, cy - 3 + bob, cx - HEAD_RX, drop, hair);
      f.rect(cx + HEAD_RX, cy - 3 + bob, cx + HEAD_RX + 1, drop, hair);
      if (dir === 'up') f.rect(cx - HEAD_RX, cy - 3 + bob, cx + HEAD_RX, drop + 2, hair);
      f.rect(cx - HEAD_RX, cy + 1 + bob, cx - HEAD_RX, cy + 6 + bob, lit);
    }
  }
}

function drawFace(f, p, { dir, bob, cx, cy, eyes, mouth }) {
  if (dir === 'up') return;

  const ink = OUTLINE;
  const eyeY = cy + 1 + bob;

  if (dir === 'side') {
    if (eyes !== 'closed') f.rect(cx + 3, eyeY, cx + 4, eyeY + 1, ink);
    else f.rect(cx + 3, eyeY + 1, cx + 5, eyeY + 1, ink);
    f.rect(cx + 5, cy + 5 + bob, cx + 6, cy + 5 + bob, shift(p.skin, -0.3));
    if (mouth === 'talk') f.rect(cx + 5, cy + 5 + bob, cx + 6, cy + 6 + bob, ink);
    if (p.glasses) {
      f.rect(cx + 2, eyeY - 1, cx + 6, eyeY - 1, p.accent);
      f.rect(cx + 6, eyeY - 1, cx + 6, eyeY + 2, p.accent);
    }
    return;
  }

  const lx = cx - 4;
  const rx = cx + 3;
  if (eyes === 'closed') {
    f.rect(lx, eyeY + 1, lx + 1, eyeY + 1, ink);
    f.rect(rx, eyeY + 1, rx + 1, eyeY + 1, ink);
  } else {
    f.rect(lx, eyeY, lx + 1, eyeY + 1, ink);
    f.rect(rx, eyeY, rx + 1, eyeY + 1, ink);
    if (eyes === 'focus') {
      f.rect(lx, eyeY, lx + 1, eyeY, p.accent);
      f.rect(rx, eyeY, rx + 1, eyeY, p.accent);
    }
  }

  if (p.glasses) {
    f.rect(lx - 1, eyeY - 1, lx + 2, eyeY - 1, p.accent);
    f.rect(rx - 1, eyeY - 1, rx + 2, eyeY - 1, p.accent);
    f.rect(lx - 1, eyeY - 1, lx - 1, eyeY + 2, p.accent);
    f.rect(rx + 2, eyeY - 1, rx + 2, eyeY + 2, p.accent);
    f.rect(lx + 2, eyeY, rx - 1, eyeY, p.accent);
  }

  const my = cy + 5 + bob;
  if (mouth === 'smile') f.rect(cx - 2, my, cx + 1, my, shift(p.skin, -0.42));
  else if (mouth === 'talk') f.rect(cx - 1, my, cx + 1, my + 1, ink);
  else f.rect(cx - 1, my, cx, my, shift(p.skin, -0.36));
}

/**
 * Scorpion's head. A new branch: the generic path draws skin, a cap of hair and a mouth, and none of
 * those are visible on a masked ninja, so rather than teach `drawFace` about masks this draws its
 * own head.
 *
 * What carries over from the reference at 54px is only the order of the masses: the POINT of the hood
 * above everything (the one shape that survives the shrink), then the headband, then the narrow band
 * of skin at the eyes, then the black mask below it. The mouth is deliberately absent: it is under
 * the mask, so `talk` reads by the gesturing arm rather than by a mouth that this costume cannot show.
 *
 * The FACE was rewritten once. The second pass gets its contrast from structure — a bright headband
 * directly above two separated slits, with near-black cloth everywhere else — instead of from a broad
 * pale area, which is what made the first version read as a visor.
 *
 * Long hair falls BEHIND the hood and is drawn first, which is what keeps the hood's edge crisp.
 */
function drawScorpionHead(f, p, { dir, bob, cx, cy, eyes }) {
  const hood = p.top;
  const mask = shift(p.top, 0.08); // see the mask comment below for why it is not flat black
  const hair = p.hair;
  const nape = SHOULDER_Y + 5 + bob;

  if (dir === 'side') {
    f.rect(cx - HEAD_RX - 1, cy - 2 + bob, cx - HEAD_RX + 1, nape, hair);
    f.rect(cx - HEAD_RX, cy + 2 + bob, cx - HEAD_RX, cy + 7 + bob, p.hairLight);
  } else {
    f.rect(cx - HEAD_RX - 1, cy - 2 + bob, cx - HEAD_RX, nape, hair);
    f.rect(cx + HEAD_RX, cy - 2 + bob, cx + HEAD_RX + 1, nape, hair);
    if (dir === 'up') f.rect(cx - HEAD_RX, cy - 2 + bob, cx + HEAD_RX, nape, hair);
    f.rect(cx - HEAD_RX, cy + 2 + bob, cx - HEAD_RX, cy + 7 + bob, p.hairLight);
  }

  // Hood shell: an ellipse one pixel wider than the skull, tapered to a point. In profile the peak
  // leans back, which is what stops both directions sharing one silhouette.
  f.ellipse(cx, cy + bob, HEAD_RX + 1, HEAD_RY, hood);
  if (dir === 'side') {
    f.rect(cx - 4, cy - HEAD_RY - 2 + bob, cx + 1, cy - HEAD_RY + 1 + bob, hood);
    f.rect(cx - 6, cy - HEAD_RY - 3 + bob, cx - 1, cy - HEAD_RY - 2 + bob, hood);
  } else {
    f.rect(cx - 2, cy - HEAD_RY - 2 + bob, cx + 2, cy - HEAD_RY + 1 + bob, hood);
    f.rect(cx - 1, cy - HEAD_RY - 4 + bob, cx + 1, cy - HEAD_RY - 2 + bob, hood);
  }

  const eyeY = cy + 1 + bob;

  // MASK: everything from the eye line down, on every direction that shows a face. The first pass
  // painted a WIDE PALE BAND across the eyes with two dark dots inside it, and at any size it read
  // as goggles or a VR visor rather than as a mask — the pale area was the wrong element to make
  // large. The mask is now one dark mass and the pale area is only the slits.
  // The tone is one small step up from the hood (`shift(top, 0.08)`, a 16-point lift in red): enough
  // that the cloth separates from the hood in a zoomed sheet and so that the mask reads as a garment
  // rather than as a hole in the head, and little enough that at 54px the head is still one dark
  // silhouette. `shift` rather than a hand-picked grey, like every other shade in the pack.
  if (dir !== 'up') {
    if (dir === 'side') f.rect(cx - 1, eyeY, cx + HEAD_RX - 1, cy + 6 + bob, mask);
    else f.rect(cx - HEAD_RX, eyeY, cx + HEAD_RX, cy + 6 + bob, mask);

    // TWO NARROW SLITS, deliberately separated by a five-pixel gap of dark mask. This is the whole
    // face the costume shows, and it is `skin` on purpose: a warm tone against the near-black cloth
    // is what makes the slits read as EYES instead of as a machine's indicator lights, which is what
    // pure white or grey would give. Two pixels wide and one tall each: any taller and they merge
    // into a band again, which is the visor this rewrite exists to remove.
    const slitY = eyes === 'closed' ? eyeY + 1 : eyeY;
    if (dir === 'side') {
      // Profile: one slit, kept close to the face edge, or it reads as an eye on the cheek.
      f.rect(cx + 5, slitY, cx + 6, slitY, p.skin);
    } else {
      f.rect(cx - 4, slitY, cx - 3, slitY, p.skin);
      f.rect(cx + 3, slitY, cx + 4, slitY, p.skin);
    }
  }

  // Headband: the band sits ONE dark row above the slits, which is what gives the eye area its
  // contrast now that the mask is dark — a bright bar above, near-black around the slits. One pixel
  // tall on purpose: two made a yellow helmet around a black face rather than a band under a hood.
  // The tails are the reference's clearest small detail and the only accent the BACK view gets,
  // which is what keeps a black-clad figure from being a black rectangle from behind.
  if (dir === 'up') {
    f.rect(cx - HEAD_RX, eyeY - 2, cx + HEAD_RX, eyeY - 2, p.accent);
    f.rect(cx - HEAD_RX + 1, eyeY - 1, cx - HEAD_RX + 1, eyeY + 4, p.accent);
    f.rect(cx + HEAD_RX - 1, eyeY - 1, cx + HEAD_RX - 1, eyeY + 4, p.accent);
  } else if (dir === 'side') {
    f.rect(cx - HEAD_RX + 1, eyeY - 2, cx + HEAD_RX - 1, eyeY - 2, p.accent);
    f.rect(cx - HEAD_RX - 1, eyeY - 1, cx - HEAD_RX - 1, eyeY + 2, p.accent);
    f.rect(cx - HEAD_RX - 3, eyeY + 3, cx - HEAD_RX - 3, eyeY + 5, p.accent);
  } else {
    f.rect(cx - HEAD_RX - 1, eyeY - 2, cx + HEAD_RX + 1, eyeY - 2, p.accent);
    f.rect(cx - HEAD_RX - 2, eyeY - 1, cx - HEAD_RX - 2, eyeY + 4, p.accent);
    f.rect(cx + HEAD_RX + 2, eyeY - 1, cx + HEAD_RX + 2, eyeY + 4, p.accent);
  }
}

function drawHead(f, p, { dir, bob, headDx, headDy, eyes, mouth }) {
  // In profile the skull rides forward of the spine; without this the face sits on top of the
  // back and the nose lands in the middle of the chest.
  const cx = ORIGIN.x + headDx + (dir === 'side' ? 1 : 0);
  const cy = HEAD_CY + headDy;

  if (p.feature === 'scorpion') {
    drawScorpionHead(f, p, { dir, bob, cx, cy, eyes });
    return;
  }

  if (dir === 'side') {
    f.ellipse(cx - 1, cy + bob, HEAD_RX - 1, HEAD_RY, p.skin);
    f.rect(cx + HEAD_RX - 2, cy + 2 + bob, cx + HEAD_RX - 1, cy + 3 + bob, p.skin); // nose bridge
    f.rect(cx + HEAD_RX - 1, cy + 3 + bob, cx + HEAD_RX - 1, cy + 3 + bob, p.skin); // nose tip
    f.rect(cx - 4, cy + 2 + bob, cx - 3, cy + 4 + bob, shift(p.skin, -0.2)); // ear
  } else {
    f.ellipse(cx, cy + bob, HEAD_RX, HEAD_RY, p.skin);
  }

  drawHair(f, p, { dir, bob, cx, cy });
  drawFace(f, p, { dir, bob, cx, cy, eyes, mouth });

  if (p.headphones) {
    // Worn around the neck, never on the head: it keeps the silhouette but leaves the face clear.
    const y = SHOULDER_Y - 3 + bob;
    const span = dir === 'side' ? 4 : 7;
    f.rect(cx - span, y, cx + span, y + 1, shift(p.accent, -0.35));
    f.ellipse(cx - span, y + 1, 2, 2, p.accent);
    f.ellipse(cx + span, y + 1, 2, 2, p.accent);
  }
}

// ---------------------------------------------------------------------------- frame assembly

const PROTECTED = new Set([OUTLINE]);

/**
 * Renders one frame from a fully-resolved pose. The passes run in a fixed order — silhouette,
 * outline, shading — because outlining a half-drawn body leaves seams inside it and shading before
 * the outline exists has nothing to read an edge from.
 */
export function renderFrame(palette, pose) {
  const f = new Frame(FRAME_SIZE, FRAME_SIZE);
  const bob = pose.bob ?? 0;

  if (pose.dir === 'side') drawArms(f, palette, { dir: pose.dir, bob, arms: pose.arms, only: 'far' });
  drawLegs(f, palette, { dir: pose.dir, bob, legs: pose.legs, sitting: pose.sitting });
  drawTorso(f, palette, { dir: pose.dir, bob });
  drawArms(f, palette, { dir: pose.dir, bob, arms: pose.arms, only: pose.dir === 'side' ? 'near' : 'both' });
  drawHead(f, palette, {
    dir: pose.dir,
    bob,
    headDx: pose.headDx ?? 0,
    headDy: pose.headDy ?? 0,
    eyes: pose.eyes ?? 'open',
    mouth: pose.mouth ?? 'neutral',
  });

  if (pose.decorate) pose.decorate(f, palette, bob);

  f.shade(PROTECTED, pose.dir === 'side' ? -1 : -1);
  f.outline(OUTLINE);
  return f;
}
