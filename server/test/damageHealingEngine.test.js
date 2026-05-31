process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyDamage,
  applyHealing,
  applyTemporaryHp,
  rollDamageFormula,
} = require('../src/damageHealingEngine');

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('rolls damage formulas with modifiers and critical dice', () => {
  const damage = rollDamageFormula('1d8+3', sequenceRolls([4, 5]), { crit: true });

  assert.deepEqual(damage.rolls, [4, 5]);
  assert.equal(damage.total, 12);
  assert.equal(damage.modifier, 3);
});

test('applies resistance, vulnerability, immunity, and temporary HP in one place', () => {
  const resisted = applyDamage({
    target: { hp: 12, max_hp: 12, temp_hp: 3, resistances: ['fire'] },
    amount: 9,
    damageType: 'fire',
  });
  const vulnerable = applyDamage({
    target: { hp: 12, max_hp: 12, vulnerabilities: ['cold'] },
    amount: 4,
    damageType: 'cold',
  });
  const immune = applyDamage({
    target: { hp: 12, max_hp: 12, immunities: ['poison'] },
    amount: 10,
    damageType: 'poison',
  });

  assert.equal(resisted.amount, 4);
  assert.equal(resisted.absorbed, 3);
  assert.equal(resisted.target.hp, 11);
  assert.equal(vulnerable.amount, 8);
  assert.equal(vulnerable.target.hp, 4);
  assert.equal(immune.amount, 0);
  assert.equal(immune.target.hp, 12);
});

test('healing caps at max HP and temporary HP keeps the higher value', () => {
  const healed = applyHealing({ target: { hp: 3, max_hp: 10 }, amount: 12 });
  const temp = applyTemporaryHp({ target: { hp: 10, max_hp: 10, temp_hp: 4 }, amount: 2 });

  assert.equal(healed.target.hp, 10);
  assert.equal(healed.applied, 7);
  assert.equal(temp.target.temp_hp, 4);
  assert.equal(temp.applied, 0);
});

test('dice formulas can reroll results of 1 once for Healer and Tavern Brawler hooks', () => {
  const result = rollDamageFormula('2d4+2', sequenceRolls([1, 3, 1, 4]), { rerollOnes: true });

  assert.deepEqual(result.rolls, [3, 4]);
  assert.equal(result.total, 9);
  assert.deepEqual(result.rerolls, [{ from: 1, to: 3 }, { from: 1, to: 4 }]);
});
