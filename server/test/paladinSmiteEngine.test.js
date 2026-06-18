process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePaladinSmiteOnHit } = require('../src/paladinSmiteEngine');

function paladin(overrides = {}) {
  return {
    identity: { name: 'Ari', class: 'paladin', class_name: 'Paladin', level: 2 },
    derived_stats: { level: 2, proficiency_bonus: 2 },
    resources: {
      paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
    },
    spellcasting: { ability: 'cha', slots: { 1: 2 } },
    ...overrides,
  };
}

function combatState(overrides = {}) {
  return {
    player_stats: {
      spell_slots: { 1: 2 },
      resources: {
        paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
      },
    },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 20, max_hp: 20, ac: 18, is_player: true },
        { name: 'Cultist', hp: 30, max_hp: 30, ac: 12, is_player: false },
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

test("Divine Smite spends Paladin's Smite free use before spell slots", () => {
  const result = resolvePaladinSmiteOnHit({
    message: 'I use Divine Smite on the hit.',
    worldState: combatState(),
    characterSheet: paladin(),
    targetName: 'Cultist',
    attack: { attackKind: 'melee', isWeapon: true },
    rollDie: sequenceRolls([5, 6]),
  });
  const target = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(target.hp, 19);
  assert.equal(result.worldState.player_stats.resources.paladins_smite.remaining, 0);
  assert.equal(result.worldState.player_stats.spell_slots[1], 2);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.match(result.lines[0], /free Paladin's Smite use/);
});

test('Divine Smite spends a level 1 slot after its free use is gone', () => {
  const result = resolvePaladinSmiteOnHit({
    message: 'Smite the Cultist.',
    worldState: combatState({
      player_stats: {
        spell_slots: { 1: 2 },
        resources: {
          paladins_smite: { name: "Paladin's Smite", remaining: 0, max: 1, reset: 'long_rest' },
        },
      },
    }),
    characterSheet: paladin({
      resources: {
        paladins_smite: { name: "Paladin's Smite", remaining: 0, max: 1, reset: 'long_rest' },
      },
    }),
    targetName: 'Cultist',
    attack: { attackKind: 'melee', isWeapon: true },
    rollDie: sequenceRolls([4, 4]),
  });

  assert.equal(result.worldState.player_stats.spell_slots[1], 1);
  assert.equal(result.worldState.player_stats.resources.paladins_smite.remaining, 0);
  assert.match(result.lines[0], /level 1 spell slot/);
});

test('critical Divine Smite doubles dice and adds the Fiend or Undead die', () => {
  const result = resolvePaladinSmiteOnHit({
    message: 'I use Divine Smite.',
    worldState: combatState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 20, max_hp: 20, ac: 18, is_player: true },
          { name: 'Skeleton', hp: 40, max_hp: 40, ac: 12, is_player: false, creature_type: 'undead' },
        ],
      },
    }),
    characterSheet: paladin(),
    targetName: 'Skeleton',
    attack: { attackKind: 'melee', isWeapon: true },
    crit: true,
    rollDie: sequenceRolls([1, 2, 3, 4, 5, 6]),
  });
  const target = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(target.hp, 19);
  assert.match(result.lines[0], /6d8 including the Fiend\/Undead bonus/);
});

test('Divine Smite cannot spend resources when the weapon hit already drops the target', () => {
  const state = combatState();
  state.combat_state.combatants[1].hp = 0;
  const result = resolvePaladinSmiteOnHit({
    message: 'I use Divine Smite.',
    worldState: state,
    characterSheet: paladin(),
    targetName: 'Cultist',
    attack: { attackKind: 'melee', isWeapon: true },
    rollDie: sequenceRolls([8, 8]),
  });

  assert.equal(result.worldState.player_stats.resources.paladins_smite.remaining, 1);
  assert.equal(result.worldState.player_stats.spell_slots[1], 2);
  assert.match(result.lines[0], /already finished the target/);
});

test('Divine Smite rejects ranged hits without spending its free use or Bonus Action', () => {
  const result = resolvePaladinSmiteOnHit({
    message: 'I use Divine Smite on my longbow hit.',
    worldState: combatState(),
    characterSheet: paladin(),
    targetName: 'Cultist',
    attack: { attackKind: 'ranged', isWeapon: true },
    rollDie: sequenceRolls([8, 8]),
  });

  assert.equal(result.worldState.player_stats.resources.paladins_smite.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.lines[0], /Melee weapon or Unarmed Strike/);
});
