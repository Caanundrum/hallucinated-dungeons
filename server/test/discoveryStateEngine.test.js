process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { adjudicate } = require('../src/refereeCore');
const { inferDiscoveryTarget } = require('../src/discoveryStateEngine');

const characterSheet = {
  identity: { name: 'Lumen', level: 1, class: 'wizard', class_name: 'Wizard' },
  abilities: {
    modifiers: { int: 3, wis: 2 },
  },
  derived_stats: {
    hp: 8,
    max_hp: 8,
    armor_class: 12,
    skill_modifiers: {
      insight: { total: 4, ability: 'wis', proficient: true },
      investigation: { total: 5, ability: 'int', proficient: true },
      perception: { total: 4, ability: 'wis', proficient: true },
      survival: { total: 2, ability: 'wis', proficient: false },
    },
  },
};

function worldState(overrides = {}) {
  return {
    current_location: 'Morrowgate',
    scene_presence: {
      exact_location: 'Morrowgate town gate',
      location_type: 'gate',
      present_npcs: ['older gate guard', 'younger gate guard'],
      present_objects: ['wax-sealed note', 'palisade gate', 'muddy road'],
      available_exits: ['town square', 'east road'],
      nearby_locations: ['the inn'],
    },
    player_stats: { hp: 8, max_hp: 8, armor_class: 12 },
    pending_roll: null,
    combat_state: null,
    discovery_state: { searches: {}, studies: {} },
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

test('successful Search records the current area as discovered without inventing clue text', () => {
  const prompt = adjudicate({
    message: 'I search the area for tracks.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 8,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([14]),
  });
  const search = resolved.worldState.discovery_state.searches.morrowgate_town_gate;

  assert.equal(prompt.worldState.pending_roll.discovery_action, 'search');
  assert.equal(prompt.worldState.pending_roll.discovery_target, 'Morrowgate town gate');
  assert.equal(prompt.worldState.pending_roll.skill, 'survival');
  assert.equal(search.target_type, 'location');
  assert.equal(search.discovered, true);
  assert.equal(search.last_check.total, 16);
  assert.match(resolved.reply, /successful search result/);
});

test('successful Study records object knowledge on the visible target', () => {
  const prompt = adjudicate({
    message: 'I inspect the writing on the wax-sealed note.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 9,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([12]),
  });
  const study = resolved.worldState.discovery_state.studies.wax_sealed_note;

  assert.equal(prompt.worldState.pending_roll.skill, 'investigation');
  assert.equal(prompt.worldState.pending_roll.discovery_action, 'study');
  assert.equal(prompt.worldState.pending_roll.discovery_target, 'wax-sealed note');
  assert.equal(study.target_type, 'object');
  assert.equal(study.discovered, true);
  assert.equal(study.history[0].skill, 'investigation');
});

test('Insight study records the targeted NPC state after the roll resolves', () => {
  const prompt = adjudicate({
    message: "I study the older gate guard's face for a hidden motive.",
    worldState: worldState(),
    characterSheet,
    currentTurn: 10,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([13]),
  });
  const study = resolved.worldState.discovery_state.studies.older_gate_guard;

  assert.equal(prompt.worldState.pending_roll.skill, 'insight');
  assert.equal(prompt.worldState.pending_roll.discovery_target, 'older gate guard');
  assert.equal(study.target_type, 'npc');
  assert.equal(study.best_outcome, 'success');
});

test('failed Search records the attempt without establishing a discovery', () => {
  const prompt = adjudicate({
    message: 'I look around for hidden signs.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 11,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([2]),
  });
  const search = resolved.worldState.discovery_state.searches.morrowgate_town_gate;

  assert.equal(search.last_outcome, 'failure');
  assert.equal(search.discovered, false);
  assert.equal(search.attempts, 1);
  assert.match(resolved.reply, /No reliable new discovery/);
});

test('older sessions with null discovery state are normalized before writes', () => {
  const prompt = adjudicate({
    message: 'I look around for hidden signs.',
    worldState: worldState({ discovery_state: null }),
    characterSheet,
    currentTurn: 12,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([15]),
  });

  assert.equal(resolved.worldState.discovery_state.searches.morrowgate_town_gate.discovered, true);
});

test('target inference does not match visible target names inside unrelated words', () => {
  assert.deepEqual(inferDiscoveryTarget({
    message: 'I inspect my noted habits and keep walking.',
    action: 'study',
    skill: 'investigation',
    worldState: worldState(),
  }), { name: null, type: null });
});
