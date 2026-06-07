process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyObjectChallengeOutcome,
  resolveObjectChallenge,
  resolveObjectInteraction,
} = require('../src/objectInteractionEngine');

function worldState(overrides = {}) {
  return {
    current_location: 'Morrowgate',
    scene_presence: {
      exact_location: 'Morrowgate town gate',
      location_type: 'gate',
      present_npcs: ['older gate guard'],
      present_objects: ['wax-sealed note', 'torn satchel', 'palisade gate'],
      available_exits: ['town square'],
      nearby_locations: [],
    },
    object_states: {},
    inventory_state: { carried_objects: [] },
    ...overrides,
  };
}

test('taking a portable present object moves it into carried object state', () => {
  const result = resolveObjectInteraction({
    message: 'I take the wax-sealed note.',
    worldState: worldState(),
  });

  assert.equal(result.handled, false);
  assert.equal(result.skipSpatialGuard, true);
  assert.equal(result.worldState.object_states.wax_sealed_note.carried_by, 'player');
  assert.equal(result.worldState.object_states.wax_sealed_note.taken, true);
  assert.deepEqual(result.worldState.scene_presence.present_objects, ['torn satchel', 'palisade gate']);
  assert.deepEqual(result.worldState.inventory_state.carried_objects, [
    { name: 'wax-sealed note', source_location: 'Morrowgate town gate' },
  ]);
  assert.match(result.narrativeFrame, /verified as present/);
});

test('reading a carried object records read state without inventing contents', () => {
  const state = worldState({
    scene_presence: {
      exact_location: 'Morrowgate town gate',
      location_type: 'gate',
      present_npcs: ['older gate guard'],
      present_objects: ['torn satchel', 'palisade gate'],
      available_exits: ['town square'],
      nearby_locations: [],
    },
    object_states: {
      wax_sealed_note: { name: 'wax-sealed note', carried_by: 'player', location: 'carried_by_player' },
    },
    inventory_state: { carried_objects: [{ name: 'wax-sealed note', source_location: 'Morrowgate town gate' }] },
  });
  const result = resolveObjectInteraction({
    message: 'Read the note.',
    worldState: state,
  });

  assert.equal(result.worldState.object_states.wax_sealed_note.is_read, true);
  assert.match(result.narrativeFrame, /Narrate visible text/);
  assert.match(result.narrativeFrame, /Do not invent a rules effect/);
});

test('reading a present object still targets it when the player names its source', () => {
  const result = resolveObjectInteraction({
    message: 'Read the note from the boy.',
    worldState: worldState(),
  });

  assert.equal(result.worldState.object_states.wax_sealed_note.is_read, true);
  assert.equal(result.target.name, 'wax-sealed note');
});

test('consuming carried pack food decrements inventory quantity before narration', () => {
  const state = worldState({
    inventory_state: {
      carried_objects: [
        { name: "Dungeoneer's Pack", source: 'character_sheet' },
        { name: 'Rations', quantity: 10, source: 'pack_contents', source_container: "Dungeoneer's Pack" },
      ],
    },
  });
  const result = resolveObjectInteraction({
    message: 'I eat a ration from my pack.',
    worldState: state,
  });
  const ration = result.worldState.inventory_state.carried_objects.find((item) => item.name === 'Rations');

  assert.equal(result.handled, false);
  assert.equal(result.target.name, 'Rations');
  assert.equal(ration.quantity, 9);
  assert.equal(ration.consumed_quantity, 1);
  assert.match(result.narrativeFrame, /Inventory quantity has already been reduced/);
});

test('using rope from a pack resolves to carried Hempen Rope', () => {
  const state = worldState({
    scene_presence: {
      exact_location: 'Lantern Bridge',
      location_type: 'bridge',
      present_npcs: [],
      present_objects: ['bridge rail', 'dark water'],
      available_exits: ['far bank'],
      nearby_locations: [],
    },
    inventory_state: {
      carried_objects: [
        { name: "Dungeoneer's Pack", source: 'character_sheet' },
        { name: 'Hempen Rope (50 feet)', quantity: 1, source: 'pack_contents', source_container: "Dungeoneer's Pack" },
      ],
    },
  });
  const result = resolveObjectInteraction({
    message: 'I tie rope from my pack to the bridge rail before leaning over.',
    worldState: state,
  });

  assert.equal(result.handled, false);
  assert.equal(result.target.name, 'Hempen Rope (50 feet)');
  assert.equal(result.worldState.object_states.hempen_rope_50_feet.used, true);
  assert.match(result.narrativeFrame, /mundane use/);
});

test('opening a visible container records open state', () => {
  const result = resolveObjectInteraction({
    message: 'Open the torn satchel.',
    worldState: worldState(),
  });

  assert.equal(result.worldState.object_states.torn_satchel.is_open, true);
  assert.equal(result.worldState.object_states.torn_satchel.present, true);
  assert.match(result.narrativeFrame, /object opening/);
});

test('opening a locked object requires a referee lock check instead of opening it', () => {
  const state = worldState({
    scene_presence: {
      exact_location: 'Morrowgate town gate',
      location_type: 'gate',
      present_npcs: [],
      present_objects: ['iron chest'],
      available_exits: [],
    },
    object_states: {
      iron_chest: { name: 'iron chest', present: true, locked: true, lock_dc: 17 },
    },
  });

  const challenge = resolveObjectChallenge({
    message: 'Open the iron chest.',
    worldState: state,
  });
  const interaction = resolveObjectInteraction({
    message: 'Open the iron chest.',
    worldState: state,
  });

  assert.equal(challenge.requiresRoll, true);
  assert.equal(challenge.type, 'lock');
  assert.equal(challenge.dc, 17);
  assert.equal(interaction.handled, true);
  assert.equal(interaction.logType, 'object_interaction_requires_referee_check');
  assert.equal(state.object_states.iron_chest.is_open, undefined);
});

test('known armed traps block opening until disarmed', () => {
  const state = worldState({
    scene_presence: {
      exact_location: 'Morrowgate town gate',
      location_type: 'gate',
      present_npcs: [],
      present_objects: ['iron chest'],
      available_exits: [],
    },
    object_states: {
      iron_chest: { name: 'iron chest', present: true, trap: { armed: true, known: true, dc: 16 } },
    },
  });
  const blocked = resolveObjectInteraction({
    message: 'Open the iron chest.',
    worldState: state,
  });
  const challenge = resolveObjectChallenge({
    message: 'Disarm the trap on the iron chest.',
    worldState: state,
  });

  assert.equal(blocked.handled, true);
  assert.equal(blocked.logType, 'object_interaction_trap_blocks_open');
  assert.match(blocked.response, /armed trap/);
  assert.equal(challenge.requiresRoll, true);
  assert.equal(challenge.type, 'trap');
  assert.equal(challenge.dc, 16);
});

test('a single known trap can be disarmed without restating the container name', () => {
  const state = worldState({
    scene_presence: {
      exact_location: 'Morrowgate town gate',
      location_type: 'gate',
      present_npcs: [],
      present_objects: ['iron chest'],
      available_exits: [],
    },
    object_states: {
      iron_chest: { name: 'iron chest', present: true, trap: { armed: true, known: true, dc: 16 } },
    },
  });

  const challenge = resolveObjectChallenge({
    message: 'Disarm the trap.',
    worldState: state,
  });

  assert.equal(challenge.requiresRoll, true);
  assert.equal(challenge.target.name, 'iron chest');
  assert.equal(challenge.type, 'trap');
});

test('object challenge outcomes mutate lock and trap state', () => {
  const locked = worldState({
    object_states: {
      iron_chest: { name: 'iron chest', present: true, locked: true },
    },
  });
  const unlocked = applyObjectChallengeOutcome({
    pending: {
      object_challenge: true,
      object_challenge_type: 'lock',
      object_action: 'unlock',
      object_target_key: 'iron_chest',
      object_target_name: 'iron chest',
      dc: 15,
      intent: 'Unlock the iron chest.',
    },
    result: { total: 18 },
    outcome: 'success',
    worldState: locked,
  });
  const trapped = applyObjectChallengeOutcome({
    pending: {
      object_challenge: true,
      object_challenge_type: 'trap',
      object_action: 'disarm',
      object_target_key: 'iron_chest',
      object_target_name: 'iron chest',
      dc: 15,
      intent: 'Disarm the trap on the iron chest.',
    },
    result: { total: 7 },
    outcome: 'failure',
    worldState: unlocked.worldState,
  });

  assert.equal(unlocked.worldState.object_states.iron_chest.locked, false);
  assert.equal(unlocked.worldState.object_states.iron_chest.unlocked, true);
  assert.match(unlocked.lines.join('\n'), /now unlocked/);
  assert.equal(trapped.worldState.object_states.iron_chest.trap_armed, true);
  assert.equal(trapped.worldState.object_states.iron_chest.trap_attempts.failures, 1);
  assert.match(trapped.lines.join('\n'), /remains armed/);
});

test('taking a non-portable object is blocked deterministically', () => {
  const state = worldState();
  const result = resolveObjectInteraction({
    message: 'I take the palisade gate.',
    worldState: state,
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'object_interaction_blocked');
  assert.equal(result.worldState, state);
  assert.match(result.response, /not a portable object/);
});

test('absent objects are left for spatial guard instead of being invented', () => {
  const result = resolveObjectInteraction({
    message: 'I read the missing diary.',
    worldState: worldState(),
  });

  assert.equal(result, null);
});
