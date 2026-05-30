process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getAttackMode,
  getD20ConditionMode,
  getD20ConditionSources,
  resolveSavingThrow,
} = require('../src/conditionEngine');

test('conditions feed attack advantage and disadvantage', () => {
  assert.equal(getAttackMode({ attacker: { conditions: ['poisoned'] }, target: {} }), 'disadvantage');
  assert.equal(getAttackMode({ attacker: {}, target: { conditions: ['restrained'] } }), 'advantage');
  assert.equal(getAttackMode({ attacker: { conditions: ['poisoned'] }, target: { conditions: ['restrained'] } }), null);
});

test('conditions feed d20 check and save modes', () => {
  const checkMode = getD20ConditionMode({
    subject: { conditions: ['poisoned'] },
    testType: 'skill_check',
    ability: 'dex',
    skill: 'stealth',
  });
  const saveMode = getD20ConditionMode({
    subject: { conditions: ['restrained'] },
    testType: 'saving_throw',
    ability: 'dex',
  });
  const stealthMode = getD20ConditionMode({
    subject: { conditions: ['invisible'] },
    testType: 'skill_check',
    ability: 'dex',
    skill: 'stealth',
  });

  assert.equal(checkMode, 'disadvantage');
  assert.equal(saveMode, 'disadvantage');
  assert.equal(stealthMode, 'advantage');
  assert.deepEqual(getD20ConditionSources({
    subject: { conditions: ['restrained'] },
    testType: 'saving_throw',
    ability: 'dex',
  }), ['Restrained condition']);
});

test('incapacitating conditions automatically fail strength and dexterity saves', () => {
  const result = resolveSavingThrow({
    target: { conditions: ['unconscious'] },
    ability: 'dex',
    dc: 10,
    bonus: 8,
    rollDie: () => 20,
  });

  assert.equal(result.success, false);
  assert.equal(result.automaticFailure, true);
  assert.match(result.text, /automatically fails/);
});
