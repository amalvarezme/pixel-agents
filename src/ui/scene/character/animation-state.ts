/**
 * Character animation state selection — pure decision, no PixiJS (dependency-cruiser's
 * `pixi-only-in-scene-pixi` rule forbids importing pixi.js outside `ui/scene/pixi/`). Derives
 * ONE of three drawable states from view-model data the scene already computes: the worker's
 * desk-bound `activity` (`domain/office/office.ts`) and whether it is currently mid archive-trip.
 */
import type { WorkerActivity } from '../../../domain/office/office';

export type CharacterAnimationState = 'idle' | 'working' | 'walking';

export interface CharacterAnimationInput {
  /** Absent for a hand-built view model that never specified it — degrades to idle, never
   * invented as "working". */
  activity?: WorkerActivity;
  /** True while a worker's archive-trip is actively in transit (walking-out/walking-back), i.e.
   * NOT while dwelling/highlighted at the cabinet — see office-scene-renderer.ts. */
  isWalking: boolean;
}

/** Walking always wins over the desk-bound activity: a worker cannot be shown typing while mid
 * archive-trip transit. */
export function selectCharacterAnimationState(input: CharacterAnimationInput): CharacterAnimationState {
  if (input.isWalking) return 'walking';
  return input.activity === 'working' ? 'working' : 'idle';
}
