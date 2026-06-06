process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyFightingStyleToAttack,
  buildUnarmedFightingAttack,
  getBlindFightingAttackOptions,
  getFightingStyleArmorBonus,
  getFightingStyleAttackBonus,
  getFightingStyleDamageBonus,
  getFightingStyleSenses,
  getRuntimeArmorClass,
} = require('../src/fightingStyleEngine');

function sheet(styleId, overrides = {}) {
  return {
    class_choices: { fighting_style: styleId },
    abilities: { modifiers: { str: 3, dex: 1 } },
    equipped: { main_hand: 'longsword', off_hand: 'shield' },
    ...overrides,
  };
}

function attack(overrides = {}) {
  return {
    isWeapon: true,
    weaponId: 'longsword',
    attackKind: 'melee',
    attackBonus: 5,
    damageFormula: '1d8+3',
    properties: ['versatile'],
    ...overrides,
  };
}

test('Defense and Archery expose their static character math', () => {
  assert.equal(getFightingStyleArmorBonus({ styleId: 'defense', wearingArmor: true }), 1);
  assert.equal(getFightingStyleArmorBonus({ styleId: 'defense', wearingArmor: false }), 0);
  assert.equal(getFightingStyleAttackBonus({ styleId: 'archery', attack: { attackKind: 'ranged' } }), 2);
  assert.equal(getFightingStyleAttackBonus({ styleId: 'archery', attack: { attackKind: 'melee' } }), 0);
});

test('legacy Defense sheets gain their missing AC once without stacking it repeatedly', () => {
  const legacySheet = sheet('defense', {
    equipped: { armor: 'chain_mail', main_hand: 'longsword', off_hand: 'shield' },
    derived_stats: { armor_class: 18, armor_class_breakdown: [] },
  });
  const first = getRuntimeArmorClass({ characterSheet: legacySheet, armorClass: 18 });
  const second = getRuntimeArmorClass({
    characterSheet: legacySheet,
    armorClass: first.armorClass,
    defenseApplied: first.defenseApplied,
  });
  assert.equal(first.armorClass, 19);
  assert.equal(second.armorClass, 19);
});

test('Archery is applied at runtime only when an older sheet has not already included it', () => {
  const oldSheetAttack = applyFightingStyleToAttack({
    characterSheet: sheet('archery'),
    attack: attack({ attackKind: 'ranged', attackBonus: 4 }),
  });
  const currentSheetAttack = applyFightingStyleToAttack({
    characterSheet: sheet('archery'),
    attack: attack({ attackKind: 'ranged', attackBonus: 6, fightingStyleAttackBonus: 2 }),
  });
  assert.equal(oldSheetAttack.attackBonus, 6);
  assert.equal(currentSheetAttack.attackBonus, 6);
});

test('Dueling applies to a one-handed melee weapon even when the other hand holds a shield', () => {
  const oneHanded = getFightingStyleDamageBonus({
    characterSheet: sheet('dueling'),
    attack: attack(),
    message: 'Attack with my longsword.',
  });
  const twoHanded = getFightingStyleDamageBonus({
    characterSheet: sheet('dueling'),
    attack: attack(),
    message: 'Attack with my longsword using both hands.',
  });
  assert.equal(oneHanded.total, 2);
  assert.equal(twoHanded.total, 0);
});

test('Great Weapon Fighting marks qualifying two-handed melee attacks with a damage floor', () => {
  const greatsword = applyFightingStyleToAttack({
    characterSheet: sheet('great_weapon_fighting', { equipped: { main_hand: 'greatsword', off_hand: null } }),
    attack: attack({ weaponId: 'greatsword', properties: ['heavy', 'two-handed'], damageFormula: '2d6+3' }),
  });
  const longsword = applyFightingStyleToAttack({
    characterSheet: sheet('great_weapon_fighting', { equipped: { main_hand: 'longsword', off_hand: null } }),
    attack: attack(),
    message: 'Attack using both hands.',
  });
  assert.equal(greatsword.minimumDamageDieRoll, 3);
  assert.equal(longsword.minimumDamageDieRoll, 3);
});

test('a shield blocks two-handed Fighting Style claims', () => {
  const longsword = applyFightingStyleToAttack({
    characterSheet: sheet('great_weapon_fighting'),
    attack: attack(),
    message: 'Attack using both hands.',
  });
  assert.equal(longsword.minimumDamageDieRoll, undefined);
});

test('Thrown Weapon Fighting adds damage to a declared thrown attack', () => {
  const thrown = getFightingStyleDamageBonus({
    characterSheet: sheet('thrown_weapon_fighting'),
    attack: attack({ weaponId: 'javelin', properties: ['thrown'] }),
    message: 'Throw my javelin.',
  });
  assert.equal(thrown.total, 2);
});

test('Unarmed Fighting builds the 2024 Strength-based unarmed strike', () => {
  const occupiedHands = buildUnarmedFightingAttack({
    characterSheet: sheet('unarmed_fighting'),
    proficiency: 2,
  });
  const freeHands = buildUnarmedFightingAttack({
    characterSheet: sheet('unarmed_fighting', { equipped: { main_hand: null, off_hand: null } }),
    proficiency: 2,
  });

  assert.equal(occupiedHands.attackBonus, 5);
  assert.equal(occupiedHands.damageFormula, '1d6+3');
  assert.equal(freeHands.damageFormula, '1d8+3');
});

test('Blind Fighting exposes 10-foot blindsight and ignores nearby sight penalties', () => {
  assert.deepEqual(getFightingStyleSenses(sheet('blind_fighting')), [
    { type: 'blindsight', range_feet: 10, source: 'Blind Fighting' },
  ]);

  const options = getBlindFightingAttackOptions({
    characterSheet: sheet('blind_fighting'),
    attack: attack(),
    attacker: { conditions: ['blinded'], position: { map_id: 'road', q: 0, r: 0 } },
    target: { conditions: ['invisible', 'hidden'], position: { map_id: 'road', q: 1, r: 0 } },
  });

  assert.deepEqual(options.ignoreAttackerConditions, ['blinded']);
  assert.deepEqual(options.ignoreTargetConditions, ['hidden', 'invisible']);
  assert.deepEqual(options.sources, ['Blind Fighting']);
});

test('Blind Fighting does not ignore sight penalties beyond 10 feet', () => {
  const options = getBlindFightingAttackOptions({
    characterSheet: sheet('blind_fighting'),
    attack: attack({ attackKind: 'ranged' }),
    attacker: { conditions: ['blinded'], position: { map_id: 'road', q: 0, r: 0 } },
    target: { conditions: ['invisible'], position: { map_id: 'road', q: 3, r: 0 } },
  });

  assert.deepEqual(options.ignoreAttackerConditions, []);
  assert.deepEqual(options.ignoreTargetConditions, []);
});
