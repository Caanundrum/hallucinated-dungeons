process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFeatureAction } = require('../src/classFeatureEngine');

function sheet(classId, overrides = {}) {
  return {
    identity: { name: 'Ari', class: classId, level: 1 },
    abilities: { modifiers: { str: 3, dex: 1, con: 2, cha: 3 } },
    derived_stats: { hp: 12, max_hp: 12, armor_class: 16, proficiency_bonus: 2 },
    ...overrides,
  };
}

function combatWorld(overrides = {}) {
  return {
    player_stats: { hp: 5, max_hp: 12, armor_class: 16 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 5, max_hp: 12, ac: 16, is_player: true },
        { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
      ],
    },
    active_effects: [],
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('Rage spends a Bonus Action and creates a rules-readable active effect', () => {
  const result = resolveFeatureAction({
    message: 'I enter Rage.',
    worldState: combatWorld(),
    characterSheet: sheet('barbarian'),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.rage.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.active_effects[0].id, 'rage');
  assert.equal(result.worldState.active_effects[0].rules_effects.some((rule) => rule.target === 'damage_resistance'), true);
  assert.match(result.reply, /physical damage resistance/);
});

test('Second Wind heals the active fighter and spends its resource', () => {
  const result = resolveFeatureAction({
    message: 'I use Second Wind.',
    worldState: combatWorld(),
    characterSheet: sheet('fighter'),
    rollDie: sequenceRolls([6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 12);
  assert.equal(result.worldState.combat_state.combatants[0].hp, 12);
  assert.equal(result.worldState.player_stats.resources.second_wind.remaining, 1);
  assert.match(result.reply, /Second Wind/);
});

test('unavailable feature resources do not spend the combat Bonus Action', () => {
  const result = resolveFeatureAction({
    message: 'I use Second Wind.',
    worldState: {
      ...combatWorld(),
      player_stats: {
        hp: 5,
        max_hp: 12,
        armor_class: 16,
        resources: {
          second_wind: { name: 'Second Wind', remaining: 0, max: 2, reset: 'long_rest', recover_on_short_rest: 1 },
        },
      },
    },
    characterSheet: sheet('fighter'),
    rollDie: sequenceRolls([6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 5);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /not available/);
});

test('Second Wind at full HP does not spend the use or Bonus Action', () => {
  const result = resolveFeatureAction({
    message: 'I use Second Wind.',
    worldState: combatWorld({
      player_stats: { hp: 12, max_hp: 12, armor_class: 16 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: sheet('fighter'),
    rollDie: sequenceRolls([6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 12);
  assert.equal(result.worldState.player_stats.resources.second_wind.remaining, 2);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /No use is spent/);
});


test('Lay on Hands spends healing pool without exceeding missing HP', () => {
  const result = resolveFeatureAction({
    message: 'I use Lay on Hands to heal 3 HP on myself.',
    worldState: combatWorld(),
    characterSheet: sheet('paladin'),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 8);
  assert.equal(result.worldState.player_stats.resources.lay_on_hands.remaining, 2);
  assert.match(result.reply, /Healing pool left: 2 HP/);
});

test('Innate Sorcery creates spell DC and spell attack advantage effects', () => {
  const result = resolveFeatureAction({
    message: 'I activate Innate Sorcery.',
    worldState: combatWorld(),
    characterSheet: sheet('sorcerer'),
  });

  const rules = result.worldState.active_effects[0].rules_effects;
  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.innate_sorcery.remaining, 1);
  assert.equal(rules.some((rule) => rule.target === 'spell_save_dc_bonus'), true);
  assert.equal(rules.some((rule) => rule.target === 'spell_attack_advantage'), true);
});

test('Bardic Inspiration requires another present creature target', () => {
  const noTarget = resolveFeatureAction({
    message: 'I use Bardic Inspiration.',
    worldState: combatWorld(),
    characterSheet: sheet('bard'),
  });
  const targeted = resolveFeatureAction({
    message: 'I give Bardic Inspiration to the guard.',
    worldState: {
      ...combatWorld(),
      scene_presence: { present_npcs: ['guard'] },
    },
    characterSheet: sheet('bard'),
  });

  assert.equal(noTarget.handled, true);
  assert.match(noTarget.reply, /needs another creature/);
  assert.equal(targeted.worldState.player_stats.resources.bardic_inspiration.remaining, 2);
  assert.equal(targeted.worldState.active_effects[0].target, 'guard');
});
