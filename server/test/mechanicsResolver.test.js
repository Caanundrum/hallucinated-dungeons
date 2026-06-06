process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveIntent } = require('../src/intentResolver');
const { resolvePreNarration } = require('../src/mechanicsResolver');

test('classifies rules actions before spatial checks', () => {
  const intent = resolveIntent('I stand my ground and take the Dodge action.');
  assert.equal(intent.ruleAction, 'dodge');
  assert.equal(intent.skipSpatialGuard, undefined);
  assert.equal(intent.mayNeedSpatialGuard, false);
});

test('leaves skill-check gating to referee core', () => {
  const result = resolvePreNarration({
    message: "I study the ledger-keeper's face to see whether he is hiding something.",
    worldState: {},
  });

  assert.equal(result.handled, false);
  assert.equal(result.skipSpatialGuard, true);
  assert.equal(result.narrativeFrame, '');
});

test('rejects manual roll totals when no server roll is pending', () => {
  const result = resolvePreNarration({
    message: '[ROLL RESULT: 0] I rolled a 0 (Persuasion Check: natural 1; 1d20 - 1 = 0; CHA only = -1)',
    worldState: {},
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'manual_roll_rejected');
  assert.equal(result.worldState.current_location, undefined);
  assert.equal(result.skipSpatialGuard, true);
  assert.equal(result.narrativeFrame, '');
  assert.match(result.response, /server-owned pending roll/);
  assert.match(result.response, /Typed roll results do not count/);
});

test('rejects manual roll totals during combat when no server roll is pending', () => {
  const result = resolvePreNarration({
    message: '[ROLL RESULT: 14] I rolled a 14 (Insight Check: 1d20 + 2 = 14)',
    worldState: { combat_state: { active: true, round: 1 } },
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'manual_roll_rejected');
  assert.equal(result.skipSpatialGuard, true);
  assert.deepEqual(result.worldState.combat_state, { active: true, round: 1 });
  assert.match(result.response, /Declare an action first/);
});

test('passes combat actions through with a mechanics frame', () => {
  const result = resolvePreNarration({
    message: 'I take the Dodge action.',
    worldState: { combat_state: { active: true, round: 2 } },
  });

  assert.equal(result.handled, false);
  assert.equal(result.skipSpatialGuard, true);
  assert.match(result.narrativeFrame, /DODGE action/);
  assert.match(result.narrativeFrame, /Combat is active/);
  assert.match(result.narrativeFrame, /end only at the start of the next player character turn/);
  assert.match(result.narrativeFrame, /Do not end with an NPC or monster "up next"/);
});

test('frames movement during active combat as turn-bound instead of free exploration', () => {
  const result = resolvePreNarration({
    message: 'I follow the fresh drag marks into town.',
    worldState: { combat_state: { active: true, round: 1 } },
  });

  assert.equal(result.handled, false);
  assert.equal(result.skipSpatialGuard, false);
  assert.match(result.narrativeFrame, /Combat is active/);
  assert.match(result.narrativeFrame, /Do not allow ordinary exploration travel/);
  assert.match(result.narrativeFrame, /opportunity attacks/);
  assert.match(result.narrativeFrame, /Resolve the combat turn before returning control/);
});

test('records present object interactions before narration while keeping DM narration active', () => {
  const result = resolvePreNarration({
    message: 'I take the wax-sealed note.',
    worldState: {
      current_location: 'Morrowgate',
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        location_type: 'gate',
        present_npcs: ['older gate guard'],
        present_objects: ['wax-sealed note', 'palisade gate'],
        available_exits: ['town square'],
        nearby_locations: [],
      },
      object_states: {},
      inventory_state: { carried_objects: [] },
    },
  });

  assert.equal(result.handled, false);
  assert.equal(result.skipSpatialGuard, true);
  assert.equal(result.worldState.object_states.wax_sealed_note.carried_by, 'player');
  assert.deepEqual(result.worldState.scene_presence.present_objects, ['palisade gate']);
  assert.match(result.narrativeFrame, /OBJECT INTERACTION/);
});

test('blocks impossible present object takes before narration', () => {
  const result = resolvePreNarration({
    message: 'I take the palisade gate.',
    worldState: {
      current_location: 'Morrowgate',
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        location_type: 'gate',
        present_npcs: ['older gate guard'],
        present_objects: ['palisade gate'],
        available_exits: ['town square'],
        nearby_locations: [],
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'object_interaction_blocked');
  assert.match(result.response, /not a portable object/);
});
