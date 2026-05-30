process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  combineAdvantageMode,
  resolveD20Test,
  rollD20WithMode,
} = require('../src/d20RollEngine');

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('rolls advantage and disadvantage through one shared d20 pipeline', () => {
  const advantage = resolveD20Test({
    modifier: 4,
    advantageMode: 'advantage',
    rollDie: sequenceRolls([3, 15]),
  });
  const disadvantage = resolveD20Test({
    modifier: 4,
    advantageMode: 'disadvantage',
    rollDie: sequenceRolls([3, 15]),
  });

  assert.equal(advantage.natural, 15);
  assert.equal(advantage.total, 19);
  assert.equal(disadvantage.natural, 3);
  assert.equal(disadvantage.total, 7);
});

test('combines advantage and disadvantage by cancelling both', () => {
  assert.equal(combineAdvantageMode({ advantage: true, disadvantage: true }), null);
  assert.equal(combineAdvantageMode({ advantage: true }), 'advantage');
  assert.equal(combineAdvantageMode({ disadvantage: true }), 'disadvantage');
});

test('applies automatic natural-1 rerolls such as Halfling Luck', () => {
  const result = rollD20WithMode(sequenceRolls([1, 14]), null, [{
    id: 'halfling_luck',
    source: 'Halfling Luck',
    trigger: 'natural_1',
  }]);

  assert.equal(result.natural, 14);
  assert.deepEqual(result.rerolls.map((reroll) => reroll.source), ['Halfling Luck']);
  assert.match(result.text, /rerolled 1->14/);
});

test('applies primed reroll resources only when the total fails', () => {
  const failed = resolveD20Test({
    modifier: 3,
    dc: 15,
    rollDie: sequenceRolls([4, 16]),
    rerollRules: [{ id: 'heroic_inspiration', source: 'Heroic Inspiration', trigger: 'failed_total' }],
  });
  const passed = resolveD20Test({
    modifier: 3,
    dc: 15,
    rollDie: sequenceRolls([15, 2]),
    rerollRules: [{ id: 'heroic_inspiration', source: 'Heroic Inspiration', trigger: 'failed_total' }],
  });

  assert.equal(failed.natural, 16);
  assert.equal(failed.total, 19);
  assert.equal(failed.rerolls[0].source, 'Heroic Inspiration');
  assert.equal(passed.natural, 15);
  assert.equal(passed.total, 18);
  assert.equal(passed.rerolls.length, 0);
});

test('adds bonus dice in the same result object as the d20', () => {
  const result = resolveD20Test({
    modifier: 2,
    bonusDice: [{ die: '1d4', label: 'Bless', effectId: 'bless', expiresOnUse: true }],
    rollDie: sequenceRolls([10, 3]),
  });

  assert.equal(result.total, 15);
  assert.equal(result.bonusDice.total, 3);
  assert.deepEqual(result.expireEffectIds, ['bless']);
  assert.match(result.rollText, /Bless 1d4=3/);
});
