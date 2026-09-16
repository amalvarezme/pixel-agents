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

function walk(dir, t) {
  const phase = (t / FRAMES) * TAU;
  const swing = Math.sin(phase);
  const bob = Math.abs(Math.cos(phase)) > 0.7 ? 0 : -1;

  let legs;
  if (dir === 'side') {
    // In profile the legs travel along x; the leg swinging forward also lifts off the floor.
    legs = [
      { dx: Math.round(-swing * 4), lift: Math.max(0, Math.round(-swing * 2)) },
      { dx: Math.round(swing * 4), lift: Math.max(0, Math.round(swing * 2)) },
    ];
  } else {
    // Head-on there is no forward travel to show, so the cycle lives in the lift and a 1px stride.
    legs = [
      { dx: Math.round(swing), lift: Math.max(0, Math.round(swing * 3)) },
      { dx: Math.round(-swing), lift: Math.max(0, Math.round(-swing * 3)) },
    ];
  }

  const base = restArms(dir);
  const reach = dir === 'side' ? 3 : 1;
  const arms = [
    offsetArm(base[0], Math.round(swing * reach), 0, Math.round(swing * (reach + 1)), Math.round(-Math.abs(swing))),
    offsetArm(base[1], Math.round(-swing * reach), 0, Math.round(-swing * (reach + 1)), Math.round(-Math.abs(swing))),
  ];

  return { dir, bob, legs, arms, eyes: 'open', mouth: 'neutral' };
}

/** Hands on a surface that belongs to the ENVIRONMENT, not to the sprite (v2 sprites are
 * furniture-free) — so the pose has to imply the desk purely through where the hands stop. */
function typing(t) {
  const base = restArms('up');
  const tick = t % 2 === 0;
  return {
    dir: 'up',
    bob: 0,
    legs: restLegs(),
    // Elbows tucked in and low, hands just below the waist line: from behind, a person at a
    // keyboard is mostly a pair of tucked elbows. Reaching upward reads as surrender, not as work.
    arms: [
      offsetArm(base[0], 3, 2, 5, tick ? -1 : 0),
      offsetArm(base[1], -3, 2, -5, tick ? 0 : -1),
    ],
    eyes: 'focus',
    mouth: 'neutral',
  };
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

function talk(dir, t) {
  const base = restArms(dir);
  const open = t % 2 === 0;
  const gesture = Math.round(Math.sin((t / FRAMES) * TAU) * 2);
  return {
    dir,
    bob: open ? 0 : -1,
    legs: restLegs(),
    arms: [base[0], offsetArm(base[1], -2, -4 + gesture, -3, -6 + gesture)],
    eyes: 'open',
    mouth: open ? 'talk' : 'neutral',
  };
}

/** The archive gesture. The scene pins this to `up`, so the raised arm has to read from behind. */
function point(dir, t) {
  const base = restArms(dir);
  const reach = t < 2 ? 0 : t < 4 ? -1 : -2;
  const raised = {
    shoulder: base[1].shoulder,
    elbow: [base[1].elbow[0] + 1, base[1].elbow[1] - 9],
    hand: [base[1].hand[0] + 3, base[1].hand[1] - 18 + reach],
  };
  return { dir, bob: reach === -2 ? -1 : 0, legs: restLegs(), arms: [base[0], raised], eyes: 'open', mouth: 'neutral' };
}

function celebrate(t) {
  const base = restArms('down');
  const up = t < 2 ? 0 : t < 4 ? -3 : -2;
  const lift = t >= 2 && t < 5 ? -2 : 0;
  return {
    dir: 'down',
    bob: lift,
    legs: restLegs(),
    arms: [
      { shoulder: base[0].shoulder, elbow: [21, 26 + up], hand: [20, 18 + up] },
      { shoulder: base[1].shoulder, elbow: [43, 26 + up], hand: [44, 18 + up] },
    ],
    eyes: 'closed',
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
