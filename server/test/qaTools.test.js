process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLevelUpReadySheet,
  getQaSecretFromRequest,
  hasValidQaToolsSecret,
  isQaToolsEnabled,
} = require('../src/qaTools');

function request(headers = {}) {
  return {
    headers,
    get(name) {
      return headers[String(name).toLowerCase()] || headers[name] || '';
    },
  };
}

function fighterSheet(overrides = {}) {
  return {
    identity: {
      name: 'QA Smoke',
      class: 'fighter',
      class_name: 'Fighter',
      level: 1,
      experience_points: 25,
      next_level_xp: 300,
      level_up_available: false,
      ...(overrides.identity || {}),
    },
    derived_stats: {
      level: 1,
      max_hp: 12,
      hp: 12,
      ...(overrides.derived_stats || {}),
    },
    progression: {
      experience_points: 25,
      next_level_xp: 300,
      xp_awards: [],
      ...(overrides.progression || {}),
    },
  };
}

test('QA tools stay disabled unless a server secret is configured', () => {
  assert.equal(isQaToolsEnabled({}), false);
  assert.equal(isQaToolsEnabled({ QA_TOOLS_SECRET: '  ' }), false);
  assert.equal(isQaToolsEnabled({ QA_TOOLS_SECRET: 'secret' }), true);
});

test('QA tools accept either explicit header or bearer secret', () => {
  const env = { QA_TOOLS_SECRET: 'very-secret' };

  assert.equal(hasValidQaToolsSecret(request({ 'x-qa-tools-secret': 'very-secret' }), env), true);
  assert.equal(hasValidQaToolsSecret(request({ authorization: 'Bearer very-secret' }), env), true);
  assert.equal(hasValidQaToolsSecret(request({ 'x-qa-tools-secret': 'wrong-secret' }), env), false);
  assert.equal(getQaSecretFromRequest(request({ authorization: 'Bearer very-secret' })), 'very-secret');
});

test('buildLevelUpReadySheet raises the active character to the next threshold', () => {
  const result = buildLevelUpReadySheet(fighterSheet(), {
    sourceId: 'qa:level_up_ready:character:level_2',
  });

  assert.equal(result.ok, true);
  assert.equal(result.currentLevel, 1);
  assert.equal(result.nextLevel, 2);
  assert.equal(result.threshold, 300);
  assert.equal(result.targetXp, 300);
  assert.equal(result.characterSheet.identity.experience_points, 300);
  assert.equal(result.characterSheet.identity.level_up_available, true);
  assert.equal(result.characterSheet.progression.xp_awards[0].amount, 275);
});

test('buildLevelUpReadySheet never lowers an explicit high QA XP target', () => {
  const result = buildLevelUpReadySheet(fighterSheet(), {
    xp: 450,
    sourceId: 'qa:level_up_ready:character:level_2',
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetXp, 450);
  assert.equal(result.characterSheet.identity.experience_points, 450);
});
