process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCreatureTurns,
  getActingIndexes,
  getTurnSkipReason,
} = require('../src/creatureTurnEngine');

const characterSheet = {
  identity: { name: 'Ari' },
  derived_stats: {
    hp: 12,
    max_hp: 12,
    armor_class: 16,
  },
};

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

function combatant(name, initiative, overrides = {}) {
  return {
    name,
    initiative,
    hp: 8,
    max_hp: 8,
    ac: 12,
    conditions: [],
    is_player: false,
    attack: { name: 'claw', attack_bonus: 4, damage_formula: '1d4+1' },
    ...overrides,
  };
}

test('creature turns after the player follow initiative order until the next player turn', () => {
  const result = resolveCreatureTurns({
    worldState: {
      player_stats: { hp: 12, max_hp: 12, armor_class: 16 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 1,
        combatants: [
          combatant('Bandit Captain', 18),
          { name: 'Ari', initiative: 12, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          combatant('Wolf', 5),
        ],
      },
    },
    characterSheet,
    rollDie: sequenceRolls([8, 20, 2, 3]),
  });

  assert.equal(result.combat.round, 2);
  assert.equal(result.combat.turn_index, 1);
  assert.match(result.lines[0], /^Wolf uses claw/);
  assert.match(result.lines[1], /^Bandit Captain uses claw/);
  assert.match(result.lines[1], /Critical hit/);
  assert.equal(result.player.hp, 6);
});

test('enemy-first initiative resolves only enemies before the player and keeps round one', () => {
  const result = resolveCreatureTurns({
    worldState: {
      player_stats: { hp: 12, max_hp: 12, armor_class: 16 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          combatant('Bandit Captain', 18),
          { name: 'Ari', initiative: 12, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          combatant('Wolf', 5),
        ],
      },
    },
    characterSheet,
    rollDie: sequenceRolls([15, 2]),
    advanceRound: false,
  });

  assert.equal(result.combat.round, 1);
  assert.equal(result.combat.turn_index, 1);
  assert.equal(result.lines.length, 1);
  assert.match(result.lines[0], /^Bandit Captain uses claw/);
});

test('disabled creatures lose their turn and clear one-round command', () => {
  const result = resolveCreatureTurns({
    worldState: {
      player_stats: { hp: 12, max_hp: 12, armor_class: 16 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          combatant('Cultist', 8, { conditions: ['command'] }),
        ],
      },
    },
    characterSheet,
  });

  const cultist = result.combat.combatants.find((entry) => entry.name === 'Cultist');
  assert.match(result.lines[0], /loses its turn/);
  assert.equal(getTurnSkipReason({ conditions: ['unconscious'] }), 'it is unable to act');
  assert.deepEqual(cultist.conditions, []);
});

test('acting indexes support player-middle and enemy-first initiative flows', () => {
  assert.deepEqual(getActingIndexes([{}, {}, {}], 1, 1, true), [2, 0]);
  assert.deepEqual(getActingIndexes([{}, {}, {}], 0, 1, false), [0]);
});

test('creature damage applies player resistance and temporary HP through shared damage math', () => {
  const result = resolveCreatureTurns({
    worldState: {
      player_stats: { hp: 12, max_hp: 12, armor_class: 10, temp_hp: 3, resistances: ['fire'] },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 12, max_hp: 12, ac: 10, temp_hp: 3, is_player: true, conditions: [] },
          combatant('Ember Imp', 8, { attack: { name: 'spark', attack_bonus: 4, damage_formula: '1d6+2', damage_type: 'fire' } }),
        ],
      },
    },
    characterSheet: { ...characterSheet, resistances: ['fire'] },
    rollDie: sequenceRolls([12, 4]),
  });

  assert.equal(result.player.temp_hp, 0);
  assert.equal(result.player.hp, 12);
  assert.match(result.lines[0], /fire resistance/);
});

test('active class feature effects can grant damage resistance during creature turns', () => {
  const result = resolveCreatureTurns({
    worldState: {
      active_effects: [{
        id: 'rage',
        name: 'Rage',
        rules_effects: [
          { target: 'damage_resistance', damage_types: ['bludgeoning', 'piercing', 'slashing'], label: 'Rage' },
        ],
      }],
      player_stats: { hp: 12, max_hp: 12, armor_class: 10 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 12, max_hp: 12, ac: 10, is_player: true, conditions: [] },
          combatant('Wolf', 8, { attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d6+2', damage_type: 'piercing' } }),
        ],
      },
    },
    characterSheet,
    rollDie: sequenceRolls([12, 4]),
  });

  assert.equal(result.player.hp, 9);
  assert.match(result.lines[0], /piercing resistance/);
});

test('Orc Relentless Endurance keeps the player at 1 HP and persists the spent resource', () => {
  const result = resolveCreatureTurns({
    worldState: {
      player_stats: { hp: 4, max_hp: 12, armor_class: 10 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 4, max_hp: 12, ac: 10, is_player: true, conditions: [] },
          combatant('Ogre', 8, { attack: { name: 'club', attack_bonus: 8, damage_formula: '1d10+4', damage_type: 'bludgeoning' } }),
        ],
      },
    },
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', species: 'orc' },
    },
    rollDie: sequenceRolls([12, 8]),
  });

  assert.equal(result.player.hp, 1);
  assert.equal(result.worldState.player_stats.resources.relentless_endurance.remaining, 0);
  assert.match(result.lines[0], /Relentless Endurance/);
});
