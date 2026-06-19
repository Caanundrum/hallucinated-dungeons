process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { answerResourceCountQuestion } = require('../src/rulesResourceAnswers');

const worldState = {
  player_stats: {
    class: 'Fighter',
    level: 2,
    spell_slots: { 1: 2 },
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

test('includes spell slots in combined resource questions', () => {
  const reply = answerResourceCountQuestion(
    'What are my exact Channel Divinity, Lucky, and spell slots remaining?',
    {
      player_stats: {
        class: 'Druid',
        level: 2,
        spell_slots: { 1: 1, 2: 0 },
        resources: {
          channel_divinity: { name: 'Channel Divinity', remaining: 1, max: 2, reset: 'long_rest' },
          luck_points: { name: 'Luck Points', remaining: 2, max: 2, reset: 'long_rest' },
        },
      },
    }
  );

  assert.match(reply, /Channel Divinity 1\/2 uses left/);
  assert.match(reply, /Luck Points 2\/2 uses left/);
  assert.match(reply, /Spell slots remaining: level 1: 1\/3, level 2: 0/);
});

test('answers direct spell-slot questions from current sheet state', () => {
  const reply = answerResourceCountQuestion(
    'How many spell slots do I have left?',
    {
      player_stats: {
        class: 'Druid',
        level: 2,
        spell_slots: { 1: 3 },
        resources: {},
      },
    }
  );

  assert.match(reply, /Spell slots remaining: level 1: 3\/3/);
});

test("answers Paladin's Smite resource questions by feature or spell name", () => {
  const state = {
    player_stats: {
      resources: {
        paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
      },
    },
  };

  assert.match(answerResourceCountQuestion("How many Paladin's Smite uses remain?", state), /Paladin's Smite 1\/1 uses left/);
  assert.match(answerResourceCountQuestion('Is my Divine Smite free use available?', state), /Paladin's Smite 1\/1 uses left/);
});

test("includes nested class spell uses with spell slots in combined questions", () => {
  const state = {
    player_stats: {
      class: 'Ranger',
      level: 2,
      spell_slots: { 1: 2 },
      resources: {
        spell_uses: {
          'class_feature:favored_enemy:hunter_mark': {
            name: "Hunter's Mark",
            remaining: 2,
            max: 2,
            reset: 'long_rest',
          },
        },
      },
    },
  };

  const reply = answerResourceCountQuestion(
    "What are my exact current Hunter's Mark uses and spell slots remaining and max?",
    state
  );

  assert.match(reply, /Hunter's Mark 2\/2 uses left/);
  assert.match(reply, /Spell slots remaining: level 1: 2\/2/);
});

test('ignores non-resource questions', () => {
  assert.equal(answerResourceCountQuestion('What is my AC?', worldState), '');
  assert.equal(answerResourceCountQuestion('How many doors are in the room?', worldState), '');
});
