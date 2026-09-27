/**
 * The 16 clips of the pack, as functions from frame index to a skeleton pose.
 *
 * The row order is INHERITED from the v2 pack and must not be reshuffled: `character-sprite.ts`
 * reads rows out of the per-character JSON, but `character-sprite.test.ts` asserts the full clip
 * table, and the whole point of this generation is to be a drop-in replacement whose only breaking
 * change is its resolution.
 *
 * Every cycle is driven by one phase angle rather than by hand-authored frames, so a clip can be
 * re-timed or re-framed by changing `FRAMES` alone. Six frames, not four: at four frames a walk
 * reads as a shuffle because the passing position has to double as a contact position.
 */
export const FRAMES = 6;

const TAU = Math.PI * 2;

/** Arms hanging at rest, per direction. Index 0 is the FAR arm in profile. */
function restArms(dir) {
  if (dir === 'side') {
    // Far arm behind the back edge of the torso, near arm on the chest edge. Any closer together
    // and the two merge into one skin-coloured blob down the middle of the profile.
    return [
      { shoulder: [29, 31], elbow: [28, 37], hand: [29, 43] },
      { shoulder: [36, 31], elbow: [37, 37], hand: [36, 43] },
    ];
  }
  return [
    { shoulder: [23, 31], elbow: [21, 37], hand: [22, 43] },
    { shoulder: [41, 31], elbow: [43, 37], hand: [42, 43] },
  ];
}

function offsetArm(arm, dx, dy, handDx = dx, handDy = dy) {
  return {
    shoulder: arm.shoulder,
    elbow: [arm.elbow[0] + dx, arm.elbow[1] + dy],
    hand: [arm.hand[0] + handDx, arm.hand[1] + handDy],
  };
}

const restLegs = () => [
  { dx: 0, lift: 0 },
  { dx: 0, lift: 0 },
];

// ---------------------------------------------------------------------------- clips

/** Breathing plus a single blink. The blink is what keeps a stationary agent from reading as a
 * frozen render — it is the cheapest possible sign of life and costs one frame. */
function idle(dir, t) {
  const phase = (t / FRAMES) * TAU;
  const bob = Math.sin(phase) > 0.5 ? -1 : 0;
  const arms = restArms(dir).map((a) => offsetArm(a, 0, bob === 0 ? 0 : -1));
  return { dir, bob, legs: restLegs(), arms, eyes: t === 4 ? 'closed' : 'open', mouth: 'neutral' };
}

/**
 * Profile walk, as six AUTHORED key frames instead of one sine.
 *
 * A walk reads through its CONTACTS — the frames where both feet are on the floor and the stride is
 * widest — and a sine has no such frames: it holds both feet at the same height at every phase, so
 * the legs scissor through each other and the figure skates.
 *
 * What this gained: a 12px stride against the old 8 (a step you can see at 54px, not a shuffle), two
 * real contact frames (0 and 3) with both feet planted, a stance leg that STAYS planted through the
 * passing position, and a body that drops on the two recoil frames — the down/up pair that makes a
 * walk read as weight instead of as a spin.
 *
 * Index 0 is the FAR leg (drawn first, darkened) and index 1 the NEAR one, the order `drawLegs` takes.
 */
const SIDE_WALK = [
  { legs: [{ dx: 6, lift: 0 }, { dx: -6, lift: 0 }], bob: 0 }, // contact: widest stride, both planted
  { legs: [{ dx: 4, lift: 0 }, { dx: -5, lift: 1 }], bob: -1 }, // recoil: the body drops onto the far foot
  { legs: [{ dx: 1, lift: 0 }, { dx: 0, lift: 3 }], bob: 0 }, // passing: the near leg swings through, lifted
  { legs: [{ dx: -6, lift: 0 }, { dx: 6, lift: 0 }], bob: 0 }, // contact, opposite legs
  { legs: [{ dx: -5, lift: 1 }, { dx: 4, lift: 0 }], bob: -1 }, // recoil
  { legs: [{ dx: 0, lift: 3 }, { dx: 1, lift: 0 }], bob: 0 }, // passing
];

function walk(dir, t) {
  if (dir === 'side') {
    const key = SIDE_WALK[t];
    const base = restArms('side');
    const arms = [0, 1].map((i) => {
      // The arm counter-swings the leg on the OTHER side, derived from that leg rather than from a
      // second sine, so the arms and the legs cannot drift apart in timing.
      const swing = key.legs[1 - i].dx;
      return offsetArm(base[i], Math.round(-swing * 0.6), 0, Math.round(-swing * 0.8), -Math.round(Math.abs(swing) / 3));
    });
    return { dir, bob: key.bob, legs: key.legs, arms, eyes: 'open', mouth: 'neutral' };
  }

  const phase = (t / FRAMES) * TAU;
  const swing = Math.sin(phase);
  const bob = Math.abs(Math.cos(phase)) > 0.7 ? 0 : -1;

  // Head-on there is no forward travel to show, so the cycle lives in the lift and a 1px stride.
  const legs = [
    { dx: Math.round(swing), lift: Math.max(0, Math.round(swing * 3)) },
    { dx: Math.round(-swing), lift: Math.max(0, Math.round(-swing * 3)) },
  ];

  const base = restArms(dir);
  // 1px, not the profile's 3: head-on there is no forward travel to show, so an arm swinging 3px
  // sideways reads as a shrug. Left exactly as it was — this clip is not one of the four the
  // maintainer asked to re-time, and the row-level diff proves it stays byte-identical.
  const reach = 1;
  const arms = [
    offsetArm(base[0], Math.round(swing * reach), 0, Math.round(swing * (reach + 1)), Math.round(-Math.abs(swing))),
    offsetArm(base[1], Math.round(-swing * reach), 0, Math.round(-swing * (reach + 1)), Math.round(-Math.abs(swing))),
  ];

  return { dir, bob, legs, arms, eyes: 'open', mouth: 'neutral' };
}

/**
 * Typing at a keyboard that belongs to the ENVIRONMENT, not to the sprite (v2 sprites are
 * furniture-free), so the pose implies the desk purely through where the hands stop.
 *
 * What it gained: the tick is a real two-frame alternation instead of a one-pixel jitter. The
 * pressing hand drops 4px onto the keys, the SHOULDER above it drops a pixel with it — the micro-move
 * that makes the hands look attached to a body rather than pasted over one — and the hand that is not
 * pressing rides a pixel higher. At 9 fps that reads as a regular keystroke; before, the difference
 * between the two states was small enough to disappear at draw size.
 *
 * Still six frames, still `dir: 'up'`: at the desk the worker faces its laptop with its back to the
 * room, so the whole read is elbows and shoulder blades.
 */
function typing(t) {
  const base = restArms('up');
  const pressLeft = t % 2 === 0;

  const arm = (i) => {
    const rest = base[i];
    const dx = i === 0 ? 3 : -3;
    const down = (i === 0) === pressLeft;
    return {
      shoulder: [rest.shoulder[0] + dx, rest.shoulder[1] + (down ? 1 : 0)],
      elbow: [rest.elbow[0] + dx, rest.elbow[1] + (down ? 2 : 1)],
      hand: [rest.hand[0] + dx + 2, rest.hand[1] + (down ? 2 : -2)],
    };
  };

  return { dir: 'up', bob: 0, legs: restLegs(), arms: [arm(0), arm(1)], eyes: 'focus', mouth: 'neutral' };
}

/**
 * Thinking between tools, read from BEHIND and — critically — from behind a DESK. At a workstation
 * the furniture occludes everything below the waist, so a pose that differs from `typing` only in
 * where the hands rest is invisible in the room: the first version of this clip moved the hands by
 * two pixels and was indistinguishable on screen.
 *
 * The difference therefore lives entirely in the SILHOUETTE ABOVE THE DESK — one elbow juts out and
 * that hand comes up to the head. That outline change reads at a glance even at the scale the
 * office draws, and survives whatever the desk hides.
 */
function work(t) {
  const base = restArms('up');
  const drift = t < 2 ? 0 : t < 4 ? -1 : 0;
  return {
    dir: 'up',
    bob: t < 3 ? 0 : -1,
    legs: restLegs(),
    arms: [
      offsetArm(base[0], -1, 1, -2, 1),
      { shoulder: base[1].shoulder, elbow: [46, 34], hand: [41, 25 + drift] },
    ],
    eyes: 'focus',
    mouth: 'neutral',
  };
}

/**
 * Talking, with a SHAPED mouth instead of an alternating one.
 *
 * What it gained: the old version flipped the mouth open/closed on every single frame (`t % 2`),
 * which at 6 fps is a 3Hz flicker and reads as a twitch rather than as speech. Here the mouth opens
 * for TWO frames, shuts for two, opens for one, shuts for one — three syllables per second-shaped
 * loop instead of six irrelevant flips. The gesturing hand rides the same envelope as the mouth
 * instead of an unrelated sine, so the two agree about where the emphasis is, and the body lifts a
 * pixel on the stressed frames.
 */
const TALK_KEYS = [
  { open: false, gesture: 0, bob: 0 }, // rest
  { open: true, gesture: -3, bob: -1 }, // first stressed syllable: hand and head both come up
  { open: true, gesture: -3, bob: -1 }, // held, so the mouth reads as OPEN FOR TWO FRAMES
  { open: false, gesture: -1, bob: 0 }, // settle
  { open: true, gesture: -2, bob: 0 }, // second, shorter syllable
  { open: false, gesture: 0, bob: 0 }, // rest
];

function talk(dir, t) {
  const base = restArms(dir);
  const key = TALK_KEYS[t];
  return {
    dir,
    bob: key.bob,
    legs: restLegs(),
    arms: [base[0], offsetArm(base[1], -2, key.gesture - 2, -3, key.gesture - 4)],
    eyes: 'open',
    mouth: key.open ? 'talk' : 'neutral',
  };
}

/**
 * The archive gesture. The scene pins this to `up`, so the raised arm has to read from behind.
 *
 * What it gained: anticipation and follow-through. The old clip was three monotone steps (0, -1, -2
 * spread over six frames) — the arm crept upward, never snapped, and never settled. Now it winds
 * DOWN past rest for two frames, takes most of its travel in one frame (the snap that makes a
 * gesture read as deliberate), overshoots the target by two pixels, and comes back onto it: five
 * distinct poses where there used to be three barely distinguishable ones.
 *
 * `k` interpolates the raised arm between rest (0) and full extension (1), so a negative k is a
 * wind-up below rest and k above 1 an overshoot past it.
 */
const POINT_KEYS = [
  { k: -0.1, bob: 0 }, // wind-up: the arm drops below rest before it lifts
  { k: -0.2, bob: 0 }, // deepest anticipation, hand down by the thigh
  { k: 0.65, bob: -1 }, // the snap: most of the travel happens in this one frame
  { k: 0.96, bob: -1 }, // arrives just short of full extension
  { k: 1.12, bob: -1 }, // overshoot, two pixels beyond the target
  { k: 1.0, bob: 0 }, // follow-through, settling onto the target
];

function point(dir, t) {
  const base = restArms(dir);
  const key = POINT_KEYS[t];
  const rest = base[1];
  const full = { elbow: [rest.elbow[0] + 1, rest.elbow[1] - 9], hand: [rest.hand[0] + 3, rest.hand[1] - 18] };
  const at = (a, b) => Math.round(a + (b - a) * key.k);

  const raised = {
    shoulder: rest.shoulder,
    elbow: [at(rest.elbow[0], full.elbow[0]), at(rest.elbow[1], full.elbow[1])],
    hand: [at(rest.hand[0], full.hand[0]), at(rest.hand[1], full.hand[1])],
  };
  // The free arm dips a pixel during the wind-up: an arm that does nothing at all while the other
  // one throws itself upward is what makes a gesture look pasted onto the body.
  const free = key.k < 0 ? offsetArm(base[0], 0, 1, 0, 1) : base[0];

  return { dir, bob: key.bob, legs: restLegs(), arms: [free, raised], eyes: 'open', mouth: 'neutral' };
}

/**
 * The one-shot celebration. `loop: false`, so frame 5 is where it RESTS — the runtime holds the last
 * frame rather than wrapping.
 *
 * What it gained: anticipation, a real jump, and follow-through. The old clip raised the arms across
 * its first two frames and then held, which is a pose and not a movement. Now frame 1 winds the arms
 * down and back past rest, frame 2 throws them up as the feet leave the floor, frame 3 is the apex
 * with the arms overshooting past vertical, frame 4 hangs there, and frame 5 lands and settles back
 * onto rest. The `lift` is why it reads as a jump at all: the whole body rises AND both feet tuck.
 */
const CELEBRATE_KEYS = [
  { raise: 0, lift: 0, bob: 0, eyes: 'open' }, // ready
  { raise: -0.18, lift: 0, bob: 0, eyes: 'open' }, // anticipation: arms swing down and back
  { raise: 0.6, lift: 1, bob: -1, eyes: 'closed' }, // launch: arms thrown up, feet leave the floor
  { raise: 1.18, lift: 2, bob: -2, eyes: 'closed' }, // apex, arms overshooting past vertical
  { raise: 1.0, lift: 1, bob: -1, eyes: 'closed' }, // hangs at the top
  { raise: 0.1, lift: 0, bob: 0, eyes: 'open' }, // landing, arms travelling back to rest
];

function celebrate(t) {
  const base = restArms('down');
  const key = CELEBRATE_KEYS[t];
  const at = (a, b) => Math.round(a + (b - a) * key.raise);

  const arm = (side) => {
    const rest = base[side];
    const elbow = [rest.elbow[0], rest.elbow[1] - 11];
    const hand = [rest.hand[0] + (side === 0 ? -2 : 2), rest.hand[1] - 25];
    return {
      shoulder: rest.shoulder,
      elbow: [at(rest.elbow[0], elbow[0]), at(rest.elbow[1], elbow[1])],
      hand: [at(rest.hand[0], hand[0]), at(rest.hand[1], hand[1])],
    };
  };

  return {
    dir: 'down',
    bob: key.bob,
    legs: restLegs().map(() => ({ dx: 0, lift: key.lift })),
    arms: [arm(0), arm(1)],
    eyes: key.eyes,
    mouth: 'smile',
  };
}

function sit(t) {
  const base = restArms('down');
  const bob = t === 2 || t === 3 ? -1 : 0;
  return {
    dir: 'down',
    bob,
    sitting: true,
    legs: restLegs(),
    arms: [offsetArm(base[0], 3, -3, 4, -4), offsetArm(base[1], -3, -3, -4, -4)],
    eyes: 'open',
    mouth: 'neutral',
  };
}

/**
 * Row -> clip, in the v2 pack's exact order. `frames`, `fps` and `loop` here become the shipped
 * JSON, which is the runtime's only source of truth for timing.
 */
export const CLIPS = [
  { row: 0, action: 'idle', direction: 'down', fps: 5, loop: true, pose: (t) => idle('down', t) },
  { row: 1, action: 'idle', direction: 'up', fps: 5, loop: true, pose: (t) => idle('up', t) },
  { row: 2, action: 'idle', direction: 'side', fps: 5, loop: true, pose: (t) => idle('side', t) },
  { row: 3, action: 'walk', direction: 'down', fps: 10, loop: true, pose: (t) => walk('down', t) },
  { row: 4, action: 'walk', direction: 'up', fps: 10, loop: true, pose: (t) => walk('up', t) },
  { row: 5, action: 'walk', direction: 'side', fps: 10, loop: true, pose: (t) => walk('side', t) },
  { row: 6, action: 'work', direction: 'up', fps: 4, loop: true, pose: work },
  { row: 7, action: 'typing', direction: 'up', fps: 9, loop: true, pose: typing },
  { row: 8, action: 'talk', direction: 'down', fps: 6, loop: true, pose: (t) => talk('down', t) },
  { row: 9, action: 'talk', direction: 'up', fps: 6, loop: true, pose: (t) => talk('up', t) },
  { row: 10, action: 'talk', direction: 'side', fps: 6, loop: true, pose: (t) => talk('side', t) },
  { row: 11, action: 'point', direction: 'down', fps: 6, loop: true, pose: (t) => point('down', t) },
  { row: 12, action: 'point', direction: 'up', fps: 6, loop: true, pose: (t) => point('up', t) },
  { row: 13, action: 'point', direction: 'side', fps: 6, loop: true, pose: (t) => point('side', t) },
  { row: 14, action: 'celebrate', direction: 'down', fps: 8, loop: false, pose: celebrate },
  { row: 15, action: 'sit', direction: 'down', fps: 4, loop: true, pose: sit },
];
