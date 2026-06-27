process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  completeResolvedEventDelivery,
  enforceRequiredEnding,
  isUsableNarration,
} = require('../src/resolvedEventDelivery');

test('receipt echo triggers recovery narration and persists and emits that narration', async () => {
  const fallback = 'You cast Thaumaturgy. The effect is active on Vex.';
  const persisted = [];
  const emitted = [];
  const result = await completeResolvedEventDelivery({
    primaryGenerate: async () => ({ text: fallback, inputTokens: 100, outputTokens: 20 }),
    recoveryGenerate: async () => ({
      text: 'Your next breath gathers an unnatural weight. When you speak, your voice will roll across the bridge like near thunder. What do you call out?',
      inputTokens: 60,
      outputTokens: 32,
    }),
    moderate: async (reply) => reply,
    fallbackReply: fallback,
    persist: async (reply, metadata) => {
      persisted.push({ reply, metadata });
      return 42;
    },
    emit: async (reply, metadata) => emitted.push({ reply, metadata }),
  });

  assert.equal(result.source, 'recovery');
  assert.equal(result.persistenceResult, 42);
  assert.match(result.reply, /voice will roll across the bridge/i);
  assert.equal(persisted[0].reply, result.reply);
  assert.equal(emitted[0].reply, result.reply);
  assert.notEqual(result.reply, fallback);
});

test('empty primary narration recovers supplied dialogue instead of emitting an empty GM turn', async () => {
  const persisted = [];
  const emitted = [];
  const result = await completeResolvedEventDelivery({
    primaryGenerate: async () => ({ text: '' }),
    recoveryGenerate: async () => ({ text: 'Your voice breaks over the gate in a supernatural boom: **"Open the gate!"**' }),
    moderate: async (reply) => reply,
    fallbackReply: 'You cast Thaumaturgy.',
    persist: async (reply) => persisted.push(reply),
    emit: async (reply) => emitted.push(reply),
  });

  assert.equal(result.source, 'recovery');
  assert.match(result.reply, /Open the gate!/);
  assert.equal(persisted[0], result.reply);
  assert.equal(emitted[0], result.reply);
  assert.ok(result.reply.trim());
});

test('double generation failure still persists and emits a non-empty deterministic fallback', async () => {
  const fallback = 'You cast Light. The effect is active on your shield.';
  const persisted = [];
  const emitted = [];
  const result = await completeResolvedEventDelivery({
    primaryGenerate: async () => { throw new Error('primary unavailable'); },
    recoveryGenerate: async () => { throw new Error('recovery unavailable'); },
    moderate: async (reply) => reply,
    fallbackReply: fallback,
    persist: async (reply) => persisted.push(reply),
    emit: async (reply) => emitted.push(reply),
  });

  assert.equal(result.source, 'deterministic_fallback');
  assert.equal(result.reply, fallback);
  assert.equal(persisted[0], fallback);
  assert.equal(emitted[0], fallback);
  assert.equal(result.errors.length, 2);
});

test('receipt comparison ignores markdown and whitespace-only differences', () => {
  assert.equal(isUsableNarration('  You cast **Light**.  ', 'You cast Light.'), false);
  assert.equal(isUsableNarration('Your shield blooms with steady gold light.', 'You cast Light.'), true);
});

test('focused ending replaces a generic GM question and is persisted and emitted', async () => {
  const persisted = [];
  const emitted = [];
  const result = await completeResolvedEventDelivery({
    primaryGenerate: async () => ({
      text: 'Your voice swells with supernatural force, ready to roll across the gate.\n\nWhat do you do?',
    }),
    recoveryGenerate: async () => ({ text: 'unused' }),
    moderate: async (reply) => reply,
    fallbackReply: 'You cast Thaumaturgy.',
    requiredEnding: 'What do you call out?',
    persist: async (reply) => persisted.push(reply),
    emit: async (reply) => emitted.push(reply),
  });

  assert.doesNotMatch(result.reply, /What do you do\?/i);
  assert.match(result.reply, /What do you call out\?$/i);
  assert.equal(persisted[0], result.reply);
  assert.equal(emitted[0], result.reply);
});

test('focused ending is not duplicated when narration already uses it', () => {
  const reply = 'Your voice becomes thunder.\n\nWhat do you call out?';
  assert.equal(enforceRequiredEnding(reply, 'What do you call out?'), reply);
});
