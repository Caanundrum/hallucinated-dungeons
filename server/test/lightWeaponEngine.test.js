process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getLightExtraAttack } = require('../src/lightWeaponEngine');

function sheet(overrides = {}) {
  return {
    identity: { class: 'rogue', level: 1 },
    abilities: { modifiers: { str: 0, dex: 3 } },
    derived_stats: {
      proficiency_bonus: 2,
      attack_breakdowns: [
        { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
        { weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 5, damage_formula: '1d4 + 3' },
      ],
    },
    equipped: { main_hand: 'shortsword', off_hand: 'dagger' },
    weapon_masteries: [],
    ...overrides,
  };
}

function shortsword() {
  return {
    name: 'Shortsword',
    weaponId: 'shortsword',
    ability: 'dex',
    properties: ['finesse', 'light'],
    damageFormula: '1d6 + 3',
    isWeapon: true,
  };
}

test('Light property only grants an extra attack when the player declares a paired attack', () => {
  assert.equal(getLightExtraAttack({
    characterSheet: sheet(),
    primaryAttack: shortsword(),
    message: 'Attack the Cultist with my shortsword.',
  }), null);
  assert.equal(getLightExtraAttack({
    characterSheet: sheet(),
    primaryAttack: shortsword(),
    message: 'Attack the Cultist with both weapons.',
  }).attack.weaponId, 'dagger');
});

test('Light extra attack omits a positive ability modifier and normally spends a Bonus Action', () => {
  const extra = getLightExtraAttack({
    characterSheet: sheet(),
    primaryAttack: shortsword(),
    message: 'Attack with my shortsword and dagger.',
  });

  assert.equal(extra.attack.damageFormula, '1d4');
  assert.equal(extra.usesBonusAction, true);
});

test('Nick mastery folds the Light extra attack into the Attack action', () => {
  const extra = getLightExtraAttack({
    characterSheet: sheet({ weapon_masteries: [{ weapon_id: 'dagger', mastery: 'nick' }] }),
    primaryAttack: shortsword(),
    message: 'Attack with both weapons.',
  });

  assert.equal(extra.mastery, 'nick');
  assert.equal(extra.usesBonusAction, false);
});

test('Two-Weapon Fighting restores the ability modifier to Light extra-attack damage', () => {
  const extra = getLightExtraAttack({
    characterSheet: sheet({ class_choices: { fighting_style: 'two_weapon_fighting' } }),
    primaryAttack: shortsword(),
    message: 'Attack with both weapons.',
  });

  assert.equal(extra.attack.damageFormula, '1d4 + 3');
  assert.equal(extra.twoWeaponFighting, true);
});
