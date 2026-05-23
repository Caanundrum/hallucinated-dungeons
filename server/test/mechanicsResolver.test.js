process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveIntent } = require('../src/intentResolver');
const { resolvePreNarration } = require('../src/mechanicsResolver');

test('classifies rules actions before spatial checks', () => {
  const intent = resolveIntent('I stand my ground and take the Dodge action.');
  assert.equal(intent.ruleAction, 'dodge');
  assert.equal(intent.skipSpatialGuard, undefined);
  assert.equal(intent.mayNeedSpatialGuard, false);
});

test('gates hidden insight behind a deterministic check prompt', () => {
  const result = resolvePreNarration({
    message: "I study the ledger-keeper's face to see whether he is hiding something.",
    worldState: {},
  });

  assert.equal(result.handled, true);
  assert.equal(result.skipSpatialGuard, true);
  assert.match(result.response, /Wisdom \(Insight\)/);
  assert.match(result.response, /\[CHECK: skill=insight ability=wis\]/);
});

test('passes combat actions through with a mechanics frame', () => {
  const result = resolvePreNarration({
    message: 'I take the Dodge action.',
    worldState: { combat_state: { active: true, round: 2 } },
  });

  assert.equal(result.handled, false);
  assert.equal(result.skipSpatialGuard, true);
  assert.match(result.narrativeFrame, /DODGE action/);
  assert.match(result.narrativeFrame, /Combat is active/);
  assert.match(result.narrativeFrame, /end only at the start of the next player character turn/);
  assert.match(result.narrativeFrame, /Do not end with an NPC or monster "up next"/);
});
