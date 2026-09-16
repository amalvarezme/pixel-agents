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
  }
}

// ---------------------------------------------------------------------------- arms

/** One arm as upper + forearm, with an accent cuff for the characters whose jacket has one. */
function drawArm(f, p, { shoulder, elbow, hand, far, sleeveTo }) {
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

function drawHead(f, p, { dir, bob, headDx, headDy, eyes, mouth }) {
  // In profile the skull rides forward of the spine; without this the face sits on top of the
  // back and the nose lands in the middle of the chest.
  const cx = ORIGIN.x + headDx + (dir === 'side' ? 1 : 0);
  const cy = HEAD_CY + headDy;

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
