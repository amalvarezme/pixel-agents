/**
 * Office scenery geometry — a tiny pixel-art office built entirely from primitive rectangles.
 * Pure data + pure functions, deliberately OUTSIDE `ui/scene/pixi/` so every colour/position
 * DECISION stays canvas-free and unit-testable (dependency-cruiser's `pixi-only-in-scene-pixi`
 * rule forbids importing PixiJS here) — `ui/scene/pixi/scenery-renderer.ts` is the only place a
 * `SceneryLayer[]` becomes an actual PixiJS draw call.
 *
 * Replaces the old bare background (a flat floor rect, a plain wall band, a single 100x100
 * "cabinet" square) with a tile-grid office: a decorated back wall with windows, a wall clock and
 * a whiteboard, a two-tone tiled floor, office props kept clear of the desk lanes, and a proper
 * filing-cabinet archive unit. Everything here is an ORIGINAL procedural composition of rectangles
 * — no binary asset, spritesheet, or font, and no reference to any third-party tileset's bytes.
 *
 * Built on a `TILE`-unit grid so it genuinely reads as small pixel art rather than arbitrary
 * rectangles: the fixed 1920x1080 floor plan (`office-layout.ts`) is exactly 48x27 tiles.
 */
import { FLOOR_HEIGHT, FLOOR_WIDTH } from '../layout/office-layout';
import { ARCHIVE_DESTINATION } from '../layout/archive-path';

export interface SceneryShape {
  /** Top-left corner, in absolute scene units on the fixed 1920x1080 plan. */
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
}

export interface SceneryLayer {
  name: string;
  shapes: SceneryShape[];
}

/** The tile grid every position in this module is derived from. 1920/40 = 48 columns,
 * 1080/40 = 27 rows — exact, no remainder. */
export const TILE = 40;

// --- Palette -----------------------------------------------------------------------------------
// Every new tone here is a derivative of the existing dark-office family (`office-scene-renderer`'s
// former FLOOR_COLOR 0x24242e / WALL_COLOR 0x1a1a22 / cabinet 0x4a4a5c / desk 0x4a4038 / accent
// 0xffd166) — kept deliberately muted so nothing here competes with the characters for attention.

const WALL_UPPER_COLOR = 0x1a1a22;
const WALL_LOWER_COLOR = 0x202028;
const WALL_BASEBOARD_COLOR = 0x33333c;

const WINDOW_SKY_COLOR = 0x2a3550;
const WINDOW_SILL_COLOR = 0x55566a;
const WINDOW_MULLION_COLOR = 0x1a1a22;
const CLOCK_FRAME_COLOR = 0x33333c;
const CLOCK_FACE_COLOR = 0x2a2a34;
const CLOCK_HAND_COLOR = 0xffd166;
/** Deliberately a MUTED panel, not a near-white one. A 280x140 block of 0xdedee6 was the
 * brightest thing in the whole frame — brighter than the characters' own skin tone and the
 * 0xffd166 accent — which is the exact defect the desk-colour fix already had to undo once
 * ("the loudest thing on screen, pulling focus away from the character"). Background scenery
 * must stay quieter than anything a person is meant to read. */
const WHITEBOARD_COLOR = 0x6e6e80;
const WHITEBOARD_LINE_COLOR = 0x4a4a58;

const FLOOR_BASE_COLOR = 0x24242e;
/** Deliberately low-contrast against FLOOR_BASE_COLOR — a checkerboard delta, not a second
 * competing colour, so the floor "must never out-shout the characters". */
const FLOOR_ALT_COLOR = 0x27272f;
const RUG_COLOR = 0x2e2b3d;
const RUG_BORDER_COLOR = 0x3d382f;

const SHELF_BODY_COLOR = 0x353542;
const SHELF_DIVIDER_COLOR = 0x24242e;
const SHELF_BOOK_COLORS = [0x4a4038, 0x55566a, 0x2e6f8f, 0xffd166];

const COOLER_BODY_COLOR = 0x3a3a44;
const COOLER_JUG_COLOR = 0x55566a;
const COOLER_WATER_COLOR = 0x2a3550;
const COOLER_DETAIL_COLOR = 0x24242e;

const POT_COLOR = 0x5c4a3a;
const FOLIAGE_COLOR = 0x3a5a45;
const FOLIAGE_ACCENT_COLOR = 0x4a6f55;

const CABINET_BODY_COLOR = 0x4a4a5c;
const CABINET_TRIM_COLOR = 0x5c5c70;
const CABINET_DRAWER_COLOR = 0x3d3d4a;
const CABINET_HANDLE_COLOR = 0xffd166;

// --- Wall ----------------------------------------------------------------------------------------

/** Back wall band across the top — the same total height the old flat band used, split into a
 * subtly different upper/lower tone plus a baseboard strip along its bottom edge. */
const WALL_HEIGHT = 220;
const WALL_UPPER_HEIGHT = 160;
const WALL_LOWER_HEIGHT = 50;
const WALL_BASEBOARD_HEIGHT = 10; // 160 + 50 + 10 = 220 = WALL_HEIGHT

function buildWallShapes(): SceneryShape[] {
  return [
    { x: 0, y: 0, width: FLOOR_WIDTH, height: WALL_UPPER_HEIGHT, color: WALL_UPPER_COLOR },
    { x: 0, y: WALL_UPPER_HEIGHT, width: FLOOR_WIDTH, height: WALL_LOWER_HEIGHT, color: WALL_LOWER_COLOR },
    { x: 0, y: WALL_UPPER_HEIGHT + WALL_LOWER_HEIGHT, width: FLOOR_WIDTH, height: WALL_BASEBOARD_HEIGHT, color: WALL_BASEBOARD_COLOR },
  ];
}

// --- Windows (+ wall clock + whiteboard) ---------------------------------------------------------

const WINDOW_WIDTH = 160;
const WINDOW_HEIGHT = 120;
const WINDOW_Y = 20;
const WINDOW_SILL_HEIGHT = 10;
const WINDOW_MULLION_THICKNESS = 8;
/** Three windows spread across the wall, clear of the clock and the whiteboard panel. */
const WINDOW_X_POSITIONS = [160, 880, 1600];

const CLOCK_X = 560;
const CLOCK_Y = 40;
const CLOCK_SIZE = 48;
const CLOCK_FACE_INSET = 6;

const WHITEBOARD_X = 1160;
const WHITEBOARD_Y = 40;
const WHITEBOARD_WIDTH = 280;
const WHITEBOARD_HEIGHT = 140;

function buildWindowShapes(): SceneryShape[] {
  const shapes: SceneryShape[] = [];

  for (const x of WINDOW_X_POSITIONS) {
    // Sky/night fill.
    shapes.push({ x, y: WINDOW_Y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT, color: WINDOW_SKY_COLOR });
    // Lighter sill beneath the pane.
    shapes.push({ x, y: WINDOW_Y + WINDOW_HEIGHT, width: WINDOW_WIDTH, height: WINDOW_SILL_HEIGHT, color: WINDOW_SILL_COLOR });
    // Mullion bars splitting the pane into four panes.
    shapes.push({
      x: x + WINDOW_WIDTH / 2 - WINDOW_MULLION_THICKNESS / 2,
      y: WINDOW_Y,
      width: WINDOW_MULLION_THICKNESS,
      height: WINDOW_HEIGHT,
      color: WINDOW_MULLION_COLOR,
    });
    shapes.push({
      x,
      y: WINDOW_Y + WINDOW_HEIGHT / 2 - WINDOW_MULLION_THICKNESS / 2,
      width: WINDOW_WIDTH,
      height: WINDOW_MULLION_THICKNESS,
      color: WINDOW_MULLION_COLOR,
    });
  }

  // Wall clock: frame, inset face, one hand.
  shapes.push({ x: CLOCK_X, y: CLOCK_Y, width: CLOCK_SIZE, height: CLOCK_SIZE, color: CLOCK_FRAME_COLOR });
  shapes.push({
    x: CLOCK_X + CLOCK_FACE_INSET,
    y: CLOCK_Y + CLOCK_FACE_INSET,
    width: CLOCK_SIZE - CLOCK_FACE_INSET * 2,
    height: CLOCK_SIZE - CLOCK_FACE_INSET * 2,
    color: CLOCK_FACE_COLOR,
  });
  shapes.push({ x: CLOCK_X + CLOCK_SIZE / 2 - 2, y: CLOCK_Y + CLOCK_SIZE / 2 - 14, width: 4, height: 14, color: CLOCK_HAND_COLOR });

  // Whiteboard/poster panel with a few "text line" strips.
  shapes.push({ x: WHITEBOARD_X, y: WHITEBOARD_Y, width: WHITEBOARD_WIDTH, height: WHITEBOARD_HEIGHT, color: WHITEBOARD_COLOR });
  const lineWidth = WHITEBOARD_WIDTH - 40;
  shapes.push({ x: WHITEBOARD_X + 20, y: WHITEBOARD_Y + 30, width: lineWidth, height: 8, color: WHITEBOARD_LINE_COLOR });
  shapes.push({ x: WHITEBOARD_X + 20, y: WHITEBOARD_Y + 55, width: lineWidth * 0.7, height: 8, color: WHITEBOARD_LINE_COLOR });
  shapes.push({ x: WHITEBOARD_X + 20, y: WHITEBOARD_Y + 80, width: lineWidth * 0.5, height: 8, color: WHITEBOARD_LINE_COLOR });

  return shapes;
}

// --- Floor -----------------------------------------------------------------------------------

/** Where the tiled floor begins — directly below the wall band, matching the old layout exactly. */
const FLOOR_TOP = WALL_HEIGHT;

const RUG_X = 800;
const RUG_Y = 900;
const RUG_WIDTH = 320;
const RUG_HEIGHT = 70;
const RUG_BORDER = 8;

/** A checkerboard floor tile is exactly `TILE`x`TILE` (or the one full-floor base rect underneath
 * it) — helper shared with the test suite's "no discrete prop overlaps a desk lane" assertion,
 * which must ignore the base tiling (which necessarily spans the whole floor, including under the
 * desks) and only check genuinely placed props like the rug. */
export function isFloorTilingShape(shape: SceneryShape): boolean {
  const isBaseFill = shape.x === 0 && shape.y === FLOOR_TOP && shape.width === FLOOR_WIDTH && shape.height === FLOOR_HEIGHT - FLOOR_TOP;
  const isCheckerTile = shape.width === TILE && shape.height === TILE;
  return isBaseFill || isCheckerTile;
}

function buildFloorShapes(): SceneryShape[] {
  const shapes: SceneryShape[] = [];

  // Base fill first, so the checkerboard overlay and any gap at the very bottom row both read as
  // one continuous floor.
  shapes.push({ x: 0, y: FLOOR_TOP, width: FLOOR_WIDTH, height: FLOOR_HEIGHT - FLOOR_TOP, color: FLOOR_BASE_COLOR });

  const cols = Math.floor(FLOOR_WIDTH / TILE);
  const rows = Math.floor((FLOOR_HEIGHT - FLOOR_TOP) / TILE);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if ((r + c) % 2 === 0) {
        shapes.push({ x: c * TILE, y: FLOOR_TOP + r * TILE, width: TILE, height: TILE, color: FLOOR_ALT_COLOR });
      }
    }
  }

  // Rug near the centre-bottom, in the margin below the child lane.
  shapes.push({ x: RUG_X, y: RUG_Y, width: RUG_WIDTH, height: RUG_HEIGHT, color: RUG_COLOR });
  shapes.push({ x: RUG_X, y: RUG_Y, width: RUG_WIDTH, height: RUG_BORDER, color: RUG_BORDER_COLOR });
  shapes.push({ x: RUG_X, y: RUG_Y + RUG_HEIGHT - RUG_BORDER, width: RUG_WIDTH, height: RUG_BORDER, color: RUG_BORDER_COLOR });
  shapes.push({ x: RUG_X, y: RUG_Y, width: RUG_BORDER, height: RUG_HEIGHT, color: RUG_BORDER_COLOR });
  shapes.push({ x: RUG_X + RUG_WIDTH - RUG_BORDER, y: RUG_Y, width: RUG_BORDER, height: RUG_HEIGHT, color: RUG_BORDER_COLOR });

  return shapes;
}

// --- Props -----------------------------------------------------------------------------------
// All placed in the margins the desk lanes never reach: against the left wall (back-wall band),
// the bottom strip below the child lane, and the far-right column past x=1600.

const SHELF_X = 20;
const SHELF_Y = FLOOR_TOP;
const SHELF_WIDTH = 140;
/** Deliberately SHORT — real desk heights (`components/molecules/desk.ts`: ROOT_DESK_SIZE=160 ->
 * height 40, SINGLE_AGENT_DESK_SIZE=240 -> height 60) put a standing character's head as high as
 * ~y=378 above the root lane for the tallest (single-agent) desk. Keeping the shelf's own bottom
 * edge well above that (well inside the "back wall band" margin) means it never reads as
 * colliding with a character even at the leftmost desk column, right beside this shelf. */
const SHELF_HEIGHT = 100;

function buildBookshelfShapes(): SceneryShape[] {
  const shapes: SceneryShape[] = [
    { x: SHELF_X, y: SHELF_Y, width: SHELF_WIDTH, height: SHELF_HEIGHT, color: SHELF_BODY_COLOR },
    { x: SHELF_X, y: SHELF_Y + 30, width: SHELF_WIDTH, height: 6, color: SHELF_DIVIDER_COLOR },
    { x: SHELF_X, y: SHELF_Y + 64, width: SHELF_WIDTH, height: 6, color: SHELF_DIVIDER_COLOR },
  ];

  const compartmentTops = [SHELF_Y + 2, SHELF_Y + 36, SHELF_Y + 70];
  for (let i = 0; i < compartmentTops.length; i += 1) {
    const bookX = SHELF_X + 10 + i * 4;
    shapes.push({ x: bookX, y: compartmentTops[i]!, width: 14, height: 22, color: SHELF_BOOK_COLORS[i % SHELF_BOOK_COLORS.length]! });
    shapes.push({ x: bookX + 18, y: compartmentTops[i]!, width: 14, height: 22, color: SHELF_BOOK_COLORS[(i + 1) % SHELF_BOOK_COLORS.length]! });
  }

  return shapes;
}

const COOLER_X = 1500;
const COOLER_JUG_Y = 890;
const COOLER_JUG_WIDTH = 44;
const COOLER_JUG_HEIGHT = 70;
const COOLER_BASE_WIDTH = 54;
const COOLER_BASE_HEIGHT = 26;

function buildWaterCoolerShapes(): SceneryShape[] {
  const jugX = COOLER_X + (COOLER_BASE_WIDTH - COOLER_JUG_WIDTH) / 2;
  const baseY = COOLER_JUG_Y + COOLER_JUG_HEIGHT;
  return [
    { x: jugX, y: COOLER_JUG_Y, width: COOLER_JUG_WIDTH, height: COOLER_JUG_HEIGHT, color: COOLER_JUG_COLOR },
    { x: jugX + 6, y: COOLER_JUG_Y + 6, width: COOLER_JUG_WIDTH - 12, height: 20, color: COOLER_WATER_COLOR },
    { x: COOLER_X, y: baseY, width: COOLER_BASE_WIDTH, height: COOLER_BASE_HEIGHT, color: COOLER_BODY_COLOR },
    { x: COOLER_X + COOLER_BASE_WIDTH / 2 - 4, y: baseY - 6, width: 8, height: 6, color: COOLER_DETAIL_COLOR },
  ];
}

const PLANT_POT_WIDTH = 40;
const PLANT_POT_HEIGHT = 35;
const PLANT_FOLIAGE_WIDTH = 56;
const PLANT_FOLIAGE_HEIGHT = 32;
const PLANT_ACCENT_WIDTH = 32;
const PLANT_ACCENT_HEIGHT = 20;

/** A potted plant: pot + foliage blocks, positioned by the pot's own top-left corner. */
function buildPottedPlant(potX: number, potY: number): SceneryShape[] {
  const foliageY = potY - PLANT_FOLIAGE_HEIGHT + 5;
  const accentY = foliageY - PLANT_ACCENT_HEIGHT + 5;
  return [
    { x: potX, y: potY, width: PLANT_POT_WIDTH, height: PLANT_POT_HEIGHT, color: POT_COLOR },
    { x: potX - (PLANT_FOLIAGE_WIDTH - PLANT_POT_WIDTH) / 2, y: foliageY, width: PLANT_FOLIAGE_WIDTH, height: PLANT_FOLIAGE_HEIGHT, color: FOLIAGE_COLOR },
    { x: potX + (PLANT_POT_WIDTH - PLANT_ACCENT_WIDTH) / 2, y: accentY, width: PLANT_ACCENT_WIDTH, height: PLANT_ACCENT_HEIGHT, color: FOLIAGE_ACCENT_COLOR },
  ];
}

/** Bottom-left plant, in the margin below the child lane (kept well clear of the y=880 band edge). */
const PLANT_LEFT_X = 40;
const PLANT_LEFT_Y = 935;
/** Far-right column plant — safely past x=1600, clear of the archive cabinet's own footprint. */
const PLANT_RIGHT_X = 1830;
const PLANT_RIGHT_Y = 650;

function buildPropShapes(): SceneryShape[] {
  return [
    ...buildBookshelfShapes(),
    ...buildWaterCoolerShapes(),
    ...buildPottedPlant(PLANT_LEFT_X, PLANT_LEFT_Y),
    ...buildPottedPlant(PLANT_RIGHT_X, PLANT_RIGHT_Y),
  ];
}

// --- Archive (filing cabinet) ------------------------------------------------------------------

const CABINET_WIDTH = 90;
const CABINET_HEIGHT = 130;
const CABINET_TRIM_HEIGHT = 8;
const CABINET_TRIM_OVERHANG = 2;
const CABINET_DRAWER_HEIGHT = 36;
const CABINET_DRAWER_GAP = 6;
const CABINET_DRAWER_MARGIN_X = 6;
const CABINET_HANDLE_WIDTH = 20;
const CABINET_HANDLE_HEIGHT = 6;

/** A filing cabinet — body, top surface, a matching base trim, 3 drawer fronts with handles — all
 * symmetric around `ARCHIVE_DESTINATION`, so the layer's own bounding box stays centred there
 * exactly, replacing the old single flat 100-unit square. Comparable footprint, slightly taller. */
function buildArchiveShapes(): SceneryShape[] {
  const bodyX = ARCHIVE_DESTINATION.x - CABINET_WIDTH / 2;
  const bodyY = ARCHIVE_DESTINATION.y - CABINET_HEIGHT / 2;
  const trimWidth = CABINET_WIDTH + CABINET_TRIM_OVERHANG * 2;
  const trimX = bodyX - CABINET_TRIM_OVERHANG;

  const shapes: SceneryShape[] = [
    { x: bodyX, y: bodyY, width: CABINET_WIDTH, height: CABINET_HEIGHT, color: CABINET_BODY_COLOR },
    { x: trimX, y: bodyY - CABINET_TRIM_HEIGHT, width: trimWidth, height: CABINET_TRIM_HEIGHT, color: CABINET_TRIM_COLOR },
    { x: trimX, y: bodyY + CABINET_HEIGHT, width: trimWidth, height: CABINET_TRIM_HEIGHT, color: CABINET_TRIM_COLOR },
  ];

  const drawerWidth = CABINET_WIDTH - CABINET_DRAWER_MARGIN_X * 2;
  const drawerX = bodyX + CABINET_DRAWER_MARGIN_X;
  const drawerCount = 3;
  const drawersHeight = drawerCount * CABINET_DRAWER_HEIGHT + (drawerCount - 1) * CABINET_DRAWER_GAP;
  const drawerTopMargin = (CABINET_HEIGHT - drawersHeight) / 2;

  for (let i = 0; i < drawerCount; i += 1) {
    const drawerY = bodyY + drawerTopMargin + i * (CABINET_DRAWER_HEIGHT + CABINET_DRAWER_GAP);
    shapes.push({ x: drawerX, y: drawerY, width: drawerWidth, height: CABINET_DRAWER_HEIGHT, color: CABINET_DRAWER_COLOR });
    shapes.push({
      x: ARCHIVE_DESTINATION.x - CABINET_HANDLE_WIDTH / 2,
      y: drawerY + CABINET_DRAWER_HEIGHT / 2 - CABINET_HANDLE_HEIGHT / 2,
      width: CABINET_HANDLE_WIDTH,
      height: CABINET_HANDLE_HEIGHT,
      color: CABINET_HANDLE_COLOR,
    });
  }

  return shapes;
}

/** Builds the full static office background, back-to-front: wall, windows (cut into the wall),
 * the tiled floor, floor-level props, and the archive filing cabinet. Pure and deterministic — the
 * same call always produces the same shapes, no randomness, no `Date`, no global state. */
export function buildOfficeScenery(): SceneryLayer[] {
  return [
    { name: 'wall', shapes: buildWallShapes() },
    { name: 'windows', shapes: buildWindowShapes() },
    { name: 'floor', shapes: buildFloorShapes() },
    { name: 'props', shapes: buildPropShapes() },
    { name: 'archive', shapes: buildArchiveShapes() },
  ];
}

// --- Desk props (monitor, keyboard, mouse, mug) -------------------------------------------------

const MONITOR_STAND_COLOR = 0x33333d;
const MONITOR_BEZEL_COLOR = 0x1c1c24;
const MONITOR_SCREEN_COLOR = 0x2e6f8f;
const CODE_LINE_COLOR = 0x9fd8ef;
const KEYBOARD_COLOR = 0x3a3a44;
const MOUSE_COLOR = 0x3a3a44;
const MUG_COLOR = 0xe0b088;

export interface DeskPropsInput {
  width: number;
  height: number;
}

/**
 * Builds the desk-top props for one desk group — monitor (bezel + lit screen + a couple of "code
 * line" strips), monitor stand, keyboard, mouse, and a mug. Shapes are relative to the desk
 * group's own origin (desk centre); negative y is up, matching `character-pose.ts`'s convention so
 * both are anchored the same way in `office-scene-renderer.ts`.
 *
 * Every horizontal offset/size below is a fraction of `desk.width`, and every vertical size that
 * must stay within the desk's own footprint is a fraction of `desk.height` — so these scale with
 * any desk instead of assuming the current 160x160 default. The monitor itself is allowed to rise
 * above the desk's back edge (same convention the character and the archive-trip document already
 * use to stand "on" the desk) so it can occlude the character standing behind it; the desk-top
 * items (keyboard/mouse/mug) are kept strictly within the desk's own front edge.
 */
export function buildDeskProps(desk: DeskPropsInput): SceneryShape[] {
  const { width, height } = desk;
  const deskTop = -height / 2;
  const deskFront = height / 2;

  const monitorWidth = width * 0.34;
  const monitorHeight = monitorWidth * 0.62;
  const standWidth = monitorWidth * 0.18;
  const standHeight = monitorHeight * 0.32;
  const monitorCenterX = -width * 0.14;

  const standTop = deskTop - standHeight;
  const monitorTop = standTop - monitorHeight;

  const shapes: SceneryShape[] = [
    { x: monitorCenterX - standWidth / 2, y: standTop, width: standWidth, height: standHeight, color: MONITOR_STAND_COLOR },
    { x: monitorCenterX - monitorWidth / 2, y: monitorTop, width: monitorWidth, height: monitorHeight, color: MONITOR_BEZEL_COLOR },
  ];

  const screenInset = monitorWidth * 0.08;
  const screenWidth = monitorWidth - screenInset * 2;
  const screenHeight = monitorHeight - screenInset * 2;
  const screenX = monitorCenterX - screenWidth / 2;
  const screenY = monitorTop + screenInset;
  shapes.push({ x: screenX, y: screenY, width: screenWidth, height: screenHeight, color: MONITOR_SCREEN_COLOR });

  const codeLineHeight = screenHeight * 0.14;
  shapes.push({ x: screenX + screenWidth * 0.12, y: screenY + screenHeight * 0.25, width: screenWidth * 0.5, height: codeLineHeight, color: CODE_LINE_COLOR });
  shapes.push({ x: screenX + screenWidth * 0.12, y: screenY + screenHeight * 0.55, width: screenWidth * 0.35, height: codeLineHeight, color: CODE_LINE_COLOR });

  // Keyboard sits on the desk in front of the monitor, with a fixed clearance (proportional to
  // width) from the desk's own front edge — guaranteeing it never crosses that edge.
  const keyboardWidth = width * 0.4;
  const keyboardHeight = Math.min(height * 0.12, width * 0.06);
  const keyboardY = deskFront - keyboardHeight - width * 0.02;
  shapes.push({ x: monitorCenterX - keyboardWidth / 2, y: keyboardY, width: keyboardWidth, height: keyboardHeight, color: KEYBOARD_COLOR });

  const mouseWidth = width * 0.07;
  shapes.push({ x: monitorCenterX + keyboardWidth / 2 + width * 0.03, y: keyboardY, width: mouseWidth, height: keyboardHeight, color: MOUSE_COLOR });

  const mugWidth = width * 0.06;
  const mugHeight = keyboardHeight * 1.3;
  shapes.push({
    x: monitorCenterX - keyboardWidth / 2 - width * 0.05 - mugWidth,
    y: keyboardY - (mugHeight - keyboardHeight),
    width: mugWidth,
    height: mugHeight,
    color: MUG_COLOR,
  });

  return shapes;
}
