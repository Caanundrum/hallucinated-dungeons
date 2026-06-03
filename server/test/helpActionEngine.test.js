process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { adjudicate } = require('../src/refereeCore');

const rowanSheet = {
  identity: { id: 'char_rowan', name: 'Rowan', level: 1, class: 'fighter', class_name: 'Fighter' },
  abilities: { modifiers: { str: 3, dex: 1, wis: 0 } },
  equipped: { main_hand: 'longsword', off_hand: null },
  derived_stats: {
    hp: 12,
    max_hp: 12,
    armor_class: 16,
    initiative: 1,
    skill_modifiers: {
      insight: { ability: 'wis', proficient: false, total: 0 },
    },
    attack_breakdowns: [
      { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
    ],
  },
};

const miraSheet = {
  ...rowanSheet,
  identity: { id: 'char_mira', name: 'Mira', level: 1, class: 'fighter', class_name: 'Fighter' },
};

function combatWorld(overrides = {}) {
  const { combat_state: combatOverrides = {}, ...worldOverrides } = overrides;
  return {
    active_effects: [],
    player_stats: { hp: 12, max_hp: 12, armor_class: 16 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      turn_resources: {
        actor: 'player',
        action_available: true,
        bonus_action_available: true,
        reaction_available: true,
        movement_remaining: 30,
        used: [],
      },
      combatants: [
        { name: 'Rowan', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
        { name: 'Goblin', initiative: 8, hp: 10, max_hp: 10, ac: 16, conditions: [], is_player: false, position: { map_id: 'road', q: 1, r: 0 } },
      ],
      ...combatOverrides,
    },
    ...worldOverrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('Help stores an attack assist and spends the Action while leaving the turn open', () => {
  const result = adjudicate({
    message: 'I help Rowan attack the Goblin.',
    worldState: combatWorld({
      combat_state: {
        combatants: [
          { name: 'Mira', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
          { name: 'Goblin', initiative: 8, hp: 10, max_hp: 10, ac: 16, conditions: [], is_player: false, position: { map_id: 'road', q: 1, r: 0 } },
        ],
      },
    }),
    characterSheet: miraSheet,
  });
  const resources = result.worldState.combat_state.turn_resources;

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'referee_help_action');
  assert.equal(resources.action_available, false);
  assert.equal(resources.help_actions.length, 1);
  assert.equal(resources.help_actions[0].type, 'attack');
  assert.equal(resources.help_actions[0].target_name, 'Goblin');
  assert.equal(resources.help_actions[0].beneficiary_name, 'Rowan');
  assert.match(result.reply, /Help/);
  assert.match(result.reply, /Your turn remains open/);
});

test('vague Help does not spend the Action', () => {
  const result = adjudicate({
    message: 'I take the Help action.',
    worldState: combatWorld(),
    characterSheet: rowanSheet,
  });

  assert.equal(result.logType, 'referee_help_action_needs_detail');
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.help_actions, undefined);
  assert.match(result.reply, /beneficiary and task/);
});

test('attack Help requires the target within 5 feet when hex positions are known', () => {
  const result = adjudicate({
    message: 'I help Rowan attack the Goblin.',
    worldState: combatWorld({
      combat_state: {
        combatants: [
          { name: 'Mira', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
          { name: 'Goblin', initiative: 8, hp: 10, max_hp: 10, ac: 16, conditions: [], is_player: false, position: { map_id: 'road', q: 3, r: 0 } },
        ],
      },
    }),
    characterSheet: miraSheet,
  });

  assert.equal(result.logType, 'referee_help_action_out_of_reach');
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.match(result.reply, /within 5 feet/);
});

test('matching attack consumes Help and rolls with Advantage', () => {
  const result = adjudicate({
    message: 'I attack the Goblin.',
    worldState: combatWorld({
      combat_state: {
        turn_resources: {
          actor: 'player',
          action_available: true,
          bonus_action_available: true,
          reaction_available: true,
          movement_remaining: 30,
          used: [],
          help_actions: [{
            id: 'help_attack_1',
            type: 'attack',
            helper_name: 'Mira',
            beneficiary_name: 'Rowan',
            target_name: 'Goblin',
          }],
        },
      },
    }),
    characterSheet: rowanSheet,
    rollDie: sequenceRolls([4, 18, 5]),
  });
  const goblin = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Goblin');

  assert.equal(goblin.hp, 2);
  assert.equal(result.worldState.combat_state.turn_resources.help_actions, undefined);
  assert.match(result.reply, /4\/18 with advantage, using 18/);
  assert.match(result.reply, /advantage from Help/);
});

test('matching check consumes Help and prompts an advantaged pending roll', () => {
  const result = adjudicate({
    message: "I study the goblin's face.",
    worldState: combatWorld({
      combat_state: {
        turn_resources: {
          actor: 'player',
          action_available: true,
          bonus_action_available: true,
          reaction_available: true,
          movement_remaining: 30,
          used: [],
          help_actions: [{
            id: 'help_check_1',
            type: 'check',
            helper_name: 'Mira',
            beneficiary_name: 'Rowan',
            skill: 'insight',
            ability: 'wis',
            label: 'Wisdom (Insight)',
          }],
        },
      },
    }),
    characterSheet: rowanSheet,
    currentTurn: 12,
  });

  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.pending_roll.advantage_mode, 'advantage');
  assert.deepEqual(result.worldState.pending_roll.advantage_sources, ['Help']);
  assert.equal(result.worldState.combat_state.turn_resources.help_actions, undefined);
  assert.match(result.reply, /Roll with advantage from Help/);
});
