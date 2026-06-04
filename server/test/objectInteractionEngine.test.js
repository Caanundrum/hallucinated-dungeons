process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveObjectInteraction } = require('../src/objectInteractionEngine');

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

test('opening a visible container records open state', () => {
  const result = resolveObjectInteraction({
    message: 'Open the torn satchel.',
    worldState: worldState(),
  });

  assert.equal(result.worldState.object_states.torn_satchel.is_open, true);
  assert.equal(result.worldState.object_states.torn_satchel.present, true);
  assert.match(result.narrativeFrame, /object opening/);
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
