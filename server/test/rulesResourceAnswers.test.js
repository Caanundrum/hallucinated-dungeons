process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { answerResourceCountQuestion } = require('../src/rulesResourceAnswers');

const worldState = {
  player_stats: {
    resources: {
      second_wind: { name: 'Second Wind', remaining: 1, max: 2, reset: 'long_rest', recover_on_short_rest: 1 },
      action_surge: { name: 'Action Surge', remaining: 0, max: 1, reset: 'short_rest' },
      luck_points: { name: 'Luck Points', remaining: 2, max: 2, reset: 'long_rest' },
    },
  },
};

test('answers Second Wind from authoritative resource state after Tactical Mind wording', () => {
  const reply = answerResourceCountQuestion(
    'How many Second Wind uses do I have left after that Tactical Mind attempt?',
    worldState
  );

  assert.match(reply, /Second Wind 1\/2 uses left/);
  assert.match(reply, /Tactical Mind uses this same Second Wind resource/);
});

test('maps Tactical Mind-only resource questions to Second Wind', () => {
  const reply = answerResourceCountQuestion('How many uses are left after Tactical Mind?', worldState);

  assert.match(reply, /Second Wind 1\/2 uses left/);
});

test('answers Action Surge and other named resource counts generically', () => {
  const actionSurge = answerResourceCountQuestion('How many Action Surge uses are remaining?', worldState);
  const luck = answerResourceCountQuestion('How many Luck Points do I have left?', worldState);

  assert.match(actionSurge, /Action Surge 0\/1 uses left/);
  assert.match(actionSurge, /short rest/);
  assert.match(luck, /Luck Points 2\/2 uses left/);
});

test('answers every named resource in a combined exact resource question', () => {
  const reply = answerResourceCountQuestion(
    'What are my exact current Action Surge and Second Wind resource entries, remaining and max? Do not infer from prior text.',
    worldState
  );

  assert.match(reply, /Action Surge 0\/1 uses left/);
  assert.match(reply, /Second Wind 1\/2 uses left/);
  assert.ok(reply.indexOf('Action Surge') < reply.indexOf('Second Wind'));
});

test('ignores non-resource questions', () => {
  assert.equal(answerResourceCountQuestion('What is my AC?', worldState), '');
  assert.equal(answerResourceCountQuestion('How many doors are in the room?', worldState), '');
});
