process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { adjudicate } = require('../src/refereeCore');
const { inferSocialTarget } = require('../src/socialStateEngine');

const characterSheet = {
  identity: { name: 'Silver', level: 1, class: 'bard', class_name: 'Bard' },
  abilities: {
    modifiers: { cha: 3, wis: 1 },
  },
  derived_stats: {
    hp: 9,
    max_hp: 9,
    armor_class: 13,
    skill_modifiers: {
      persuasion: { total: 5, ability: 'cha', proficient: true },
      deception: { total: 5, ability: 'cha', proficient: true },
      intimidation: { total: 3, ability: 'cha', proficient: false },
      performance: { total: 5, ability: 'cha', proficient: true },
    },
  },
};

function worldState(overrides = {}) {
  return {
    current_location: 'Morrowgate town hall',
    scene_presence: {
      exact_location: 'town hall steps',
      location_type: 'street',
      present_npcs: ['clerk', 'guard'],
      present_objects: ['heavy door'],
      available_exits: ['square'],
      nearby_locations: [],
    },
    player_stats: { hp: 9, max_hp: 9, armor_class: 13 },
    pending_roll: null,
    combat_state: null,
    npc_states: {},
    npcs_encountered: [],
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

test('successful persuasion updates the targeted NPC attitude state', () => {
  const prompt = adjudicate({
    message: 'I politely convince the clerk to let me speak with the reeve.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 4,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([10]),
  });

  assert.equal(prompt.worldState.pending_roll.skill, 'persuasion');
  assert.equal(prompt.worldState.pending_roll.social_target_name, 'clerk');
  assert.equal(resolved.worldState.npc_states.clerk.attitude, 'cooperative');
  assert.equal(resolved.worldState.npc_states.clerk.leverage, 'more willing to help within reason');
  assert.equal(resolved.worldState.npcs_encountered[0].name, 'clerk');
  assert.equal(resolved.worldState.npcs_encountered[0].disposition, 'cooperative');
  assert.match(resolved.reply, /Influence/);
});

test('failed deception makes the targeted NPC distrustful', () => {
  const prompt = adjudicate({
    message: 'I lie to the guard about having official papers.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 5,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([1]),
  });

  assert.equal(prompt.worldState.pending_roll.skill, 'deception');
  assert.equal(prompt.worldState.pending_roll.social_target_name, 'guard');
  assert.equal(resolved.worldState.npc_states.guard.attitude, 'distrustful');
  assert.equal(resolved.worldState.npc_states.guard.leverage, 'caught or resisted the deception');
  assert.match(resolved.reply, /distrustful/);
});

test('unclear social target does not mutate a random NPC', () => {
  const prompt = adjudicate({
    message: 'I perform a stirring song for everyone nearby.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 6,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([15]),
  });

  assert.equal(prompt.worldState.pending_roll.skill, 'performance');
  assert.equal(prompt.worldState.pending_roll.social_target_name, null);
  assert.deepEqual(resolved.worldState.npc_states, {});
  assert.match(resolved.reply, /no specific present NPC/);
});

test('single present NPC becomes the target for an otherwise vague social check', () => {
  const prompt = adjudicate({
    message: 'I reassure them that I can help.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'town hall steps',
        location_type: 'street',
        present_npcs: ['nervous clerk'],
        present_objects: ['heavy door'],
        available_exits: ['square'],
        nearby_locations: [],
      },
    }),
    characterSheet,
    currentTurn: 7,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([14]),
  });

  assert.equal(prompt.worldState.pending_roll.skill, 'persuasion');
  assert.equal(prompt.worldState.pending_roll.social_target_name, 'nervous clerk');
  assert.equal(resolved.worldState.npc_states.nervous_clerk.attitude, 'cooperative');
});

test('target inference does not match NPC names inside unrelated words', () => {
  assert.equal(inferSocialTarget({
    message: 'I give a guarded speech to calm everyone nearby.',
    worldState: worldState(),
  }), null);
});
