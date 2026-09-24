/**
 * ============================================================================
 * TURBO KART — additive item-layer events (Agent 3)
 * ============================================================================
 * Names that are NOT in the frozen `EVENTS` map but are needed for the AI to
 * steer around hazards without importing the item subsystem (cross-subsystem
 * communication must go through the bus only).
 *
 *   ITEM_HAZARDS: 'item:hazards'
 *     payload: { hazards: Array<{x, y, z, radius, kind, from}> }
 *     Emitted by ItemSystem at ~8 Hz while hazards are alive. AIDriver listens
 *     and biases its racing line away from them.
 *
 * These are additive: nothing in the frozen contract changes.
 * ============================================================================
 */

/** @type {'item:hazards'} */
export const ITEM_HAZARDS = 'item:hazards';
