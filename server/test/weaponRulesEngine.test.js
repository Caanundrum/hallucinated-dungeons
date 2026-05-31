process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getAttackMode } = require('../src/conditionEngine');
const {
  applyWeaponMasteryOnHit,
  applyWeaponMasteryOnMiss,
  consumeSapAfterAttack,
  consumeVexAdvantage,
  expireMasteryEffects,
  getSelectedWeaponMastery,
  getWeaponDamageFormula,
  getWeaponMasteryAdvantageSources,
  getWeaponPropertyAttackMode,
  stripPositiveAbilityModifier,
} = require('../src/weaponRulesEngine');

function sheet(weaponId, mastery, overrides = {}) {
  return {
    identity: { level: 1 },
    abilities: {
      final_scores: { str: 16, dex: 12 },
      modifiers: { str: 3, dex: 1 },
    },
    derived_stats: { proficiency_bonus: 2 },
    weapon_masteries: mastery ? [{ weapon_id: weaponId, mastery }] : [],
    ...overrides,
  };
}

function attack(weaponId, overrides = {}) {
  return {
    isWeapon: true,
    weaponId,
    ability: 'str',
    properties: [],
    damageFormula: '1d8+3',
    damageType: 'slashing',
    ...overrides,
  };
}

test('mastery only unlocks for a weapon selected on the character sheet', () => {
  assert.equal(getSelectedWeaponMastery(sheet('longsword', 'sap'), attack('longsword')), 'sap');
  assert.equal(getSelectedWeaponMastery(sheet('longsword', 'sap'), attack('warhammer')), null);
});

test('Heavy weapon property imposes the correct minimum ability disadvantage', () => {
  const weak = sheet(null, null, {
    abilities: { final_scores: { str: 12, dex: 12 }, modifiers: { str: 1, dex: 1 } },
  });
  assert.equal(getWeaponPropertyAttackMode({ attack: attack('maul', { properties: ['heavy'] }), characterSheet: weak }), 'disadvantage');
  assert.equal(getWeaponPropertyAttackMode({ attack: attack('longbow', { properties: ['heavy'], attackKind: 'ranged' }), characterSheet: weak }), 'disadvantage');
  assert.equal(getWeaponPropertyAttackMode({ attack: attack('maul', { properties: ['heavy'] }), characterSheet: sheet() }), null);
});

test('Versatile weapons use their two-handed damage only when declared', () => {
  const longsword = attack('longsword', { properties: ['versatile'], versatileDamage: '1d10' });
  assert.equal(getWeaponDamageFormula({ attack: longsword, message: 'I attack the cultist.' }), '1d8+3');
  assert.equal(getWeaponDamageFormula({ attack: longsword, message: 'I attack with both hands.' }), '1d10+3');
  assert.equal(getWeaponDamageFormula({
    attack: longsword,
    message: 'I attack with both hands.',
    characterSheet: { equipped: { off_hand: 'shield' } },
  }), '1d8+3');
});

test('reduced extra-attack damage removes a positive ability modifier but preserves weapon magic', () => {
  assert.equal(stripPositiveAbilityModifier('1d12 + 4', 3), '1d12 + 1');
  assert.equal(stripPositiveAbilityModifier('1d12 + 1', 3), '1d12 - 2');
  assert.equal(stripPositiveAbilityModifier('1d12 - 1', -1), '1d12 - 1');
});

test('Graze mastery deals only the attack ability modifier on a miss', () => {
  const target = { name: 'Cultist', hp: 8 };
  const result = applyWeaponMasteryOnMiss({
    attack: attack('greatsword'),
    target,
    characterSheet: sheet('greatsword', 'graze'),
  });
  assert.equal(target.hp, 5);
  assert.match(result.lines[0], /Graze mastery/);
});

test('Push mastery moves Large or smaller targets but not Huge targets', () => {
  const eligible = { name: 'Cultist', hp: 8, size: 'medium' };
  const huge = { name: 'Giant', hp: 30, size: 'huge' };
  const characterSheet = sheet('warhammer', 'push');
  const weapon = attack('warhammer');
  applyWeaponMasteryOnHit({ attack: weapon, target: eligible, characterSheet });
  applyWeaponMasteryOnHit({ attack: weapon, target: huge, characterSheet });
  assert.equal(eligible.forced_movement.feet, 10);
  assert.equal(huge.forced_movement, undefined);
});

test('Sap mastery affects one creature attack and is then consumed', () => {
  const target = { name: 'Cultist', hp: 8, conditions: [] };
  applyWeaponMasteryOnHit({
    attack: attack('longsword'),
    target,
    combat: { round: 1 },
    characterSheet: sheet('longsword', 'sap'),
  });
  assert.equal(getAttackMode({ attacker: target, target: {} }), 'disadvantage');
  const resolved = consumeSapAfterAttack(target);
  assert.equal(getAttackMode({ attacker: resolved, target: {} }), null);
});

test('Slow mastery stores a capped penalty until the next player turn', () => {
  const target = { name: 'Cultist', hp: 8, conditions: [] };
  applyWeaponMasteryOnHit({
    attack: attack('whip'),
    target,
    combat: { round: 1 },
    characterSheet: sheet('whip', 'slow'),
    damageDealt: 4,
  });
  assert.equal(target.speed_penalty, 10);
  const combat = expireMasteryEffects({ combatants: [target] }, { timing: 'start_of_player_turn', round: 2 });
  assert.equal(combat.combatants[0].speed_penalty, 0);
  assert.deepEqual(combat.combatants[0].conditions, []);
});

test('Topple mastery uses an ability-based DC and knocks a failed target prone', () => {
  const target = { name: 'Cultist', hp: 8, conditions: [], saves: { con: 1 } };
  const result = applyWeaponMasteryOnHit({
    attack: attack('battleaxe'),
    target,
    combat: { round: 1 },
    characterSheet: sheet('battleaxe', 'topple'),
    rollDie: () => 3,
  });
  assert.deepEqual(target.conditions, ['prone']);
  assert.match(result.lines[0], /vs DC 13/);
});

test('Vex mastery grants and consumes advantage against the same target', () => {
  const target = { name: 'Cultist', hp: 8 };
  applyWeaponMasteryOnHit({
    attack: attack('rapier'),
    target,
    combat: { round: 1 },
    characterSheet: sheet('rapier', 'vex'),
    damageDealt: 4,
  });
  assert.deepEqual(getWeaponMasteryAdvantageSources(target), ['Vex mastery']);
  assert.deepEqual(getWeaponMasteryAdvantageSources(consumeVexAdvantage(target)), []);
});

test('Slow and Vex do not apply when a hit deals no damage', () => {
  const slowed = { name: 'Cultist', hp: 8, conditions: [] };
  const vexed = { name: 'Cultist', hp: 8 };
  applyWeaponMasteryOnHit({
    attack: attack('whip'),
    target: slowed,
    combat: { round: 1 },
    characterSheet: sheet('whip', 'slow'),
    damageDealt: 0,
  });
  applyWeaponMasteryOnHit({
    attack: attack('rapier'),
    target: vexed,
    combat: { round: 1 },
    characterSheet: sheet('rapier', 'vex'),
    damageDealt: 0,
  });
  assert.equal(slowed.speed_penalty, undefined);
  assert.deepEqual(getWeaponMasteryAdvantageSources(vexed), []);
});
