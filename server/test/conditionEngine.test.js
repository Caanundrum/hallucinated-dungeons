process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getAttackMode,
  getAttackModeSources,
  getD20ConditionMode,
  getD20ConditionSources,
  getSensoryCheckBlock,
  getExhaustionLevel,
  getConditionD20Modifier,
  getConditionSpeedPenalty,
  applyConditionSpeedPenalty,
  resolveSavingThrow,
} = require('../src/conditionEngine');

test('conditions feed attack advantage and disadvantage', () => {
  assert.equal(getAttackMode({ attacker: { conditions: ['poisoned'] }, target: {} }), 'disadvantage');
  assert.equal(getAttackMode({ attacker: {}, target: { conditions: ['restrained'] } }), 'advantage');
  assert.equal(getAttackMode({ attacker: { conditions: ['poisoned'] }, target: { conditions: ['restrained'] } }), null);
});

test('attack condition modes can ignore sight penalties supplied by another rule', () => {
  const mode = getAttackMode({
    attacker: { conditions: ['blinded'] },
    target: { conditions: ['invisible'] },
    ignoreAttackerConditions: ['blinded'],
    ignoreTargetConditions: ['invisible'],
  });
  const sources = getAttackModeSources({
    attacker: { conditions: ['blinded'] },
    target: { conditions: ['invisible'] },
    ignoreAttackerConditions: ['blinded'],
    ignoreTargetConditions: ['invisible'],
  });

  assert.equal(mode, null);
  assert.deepEqual(sources, []);
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

test('Deafened blocks hearing-dependent checks without affecting other perception', () => {
  const hearingMode = getD20ConditionMode({
    subject: { conditions: ['deafened'] },
    testType: 'skill_check',
    ability: 'wis',
    skill: 'perception',
    reason: 'I listen at the door for footsteps.',
  });
  const sightMode = getD20ConditionMode({
    subject: { conditions: ['deafened'] },
    testType: 'skill_check',
    ability: 'wis',
    skill: 'perception',
    reason: 'I scan the road for tracks.',
  });

  assert.equal(hearingMode, null);
  assert.equal(sightMode, null);
  assert.deepEqual(getSensoryCheckBlock({
    subject: { conditions: ['deafened'] },
    ability: 'wis',
    skill: 'perception',
    reason: 'I listen for voices.',
  }), {
    blocked: true,
    condition: 'deafened',
    source: 'Deafened condition',
    sense: 'hearing',
    reason: 'the task depends on hearing',
  });
  assert.deepEqual(getD20ConditionSources({
    subject: { conditions: ['deafened'] },
    testType: 'skill_check',
    ability: 'wis',
    skill: 'perception',
    reason: 'I listen for voices.',
  }), []);
});

test('Blinded blocks sight-dependent checks but not touch-first checks', () => {
  assert.deepEqual(getSensoryCheckBlock({
    subject: { conditions: ['blinded'] },
    ability: 'int',
    skill: 'investigation',
    reason: 'I inspect the writing on the wall.',
  }), {
    blocked: true,
    condition: 'blinded',
    source: 'Blinded condition',
    sense: 'sight',
    reason: 'the task depends on sight',
  });
  assert.equal(getSensoryCheckBlock({
    subject: { conditions: ['blinded'] },
    ability: 'int',
    skill: 'investigation',
    reason: 'I feel along the wall for a seam.',
  }), null);
});

test('Exhaustion parses level and applies d20 and speed penalties', () => {
  assert.equal(getExhaustionLevel({ conditions: ['exhaustion_2'] }), 2);
  assert.equal(getExhaustionLevel({ exhaustion_level: 3, conditions: ['exhaustion'] }), 3);
  assert.equal(getExhaustionLevel({ conditions: [{ id: 'exhaustion', level: 9 }] }), 6);
  assert.equal(getConditionD20Modifier({ conditions: ['exhaustion_2'] }), -4);
  assert.equal(getConditionSpeedPenalty({ conditions: ['exhaustion_2'] }), 10);
  assert.equal(applyConditionSpeedPenalty(30, { conditions: ['exhaustion_2'] }), 20);
});

test('Exhaustion applies to saving throw rolls resolved by the condition engine', () => {
  const result = resolveSavingThrow({
    target: { conditions: ['exhaustion_2'] },
    ability: 'wis',
    dc: 10,
    bonus: 3,
    rollDie: () => 10,
  });

  assert.equal(result.total, 9);
  assert.equal(result.success, false);
  assert.match(result.text, /Exhaustion level 2 -4/);
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
