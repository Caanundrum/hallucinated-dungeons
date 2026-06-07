process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldAllowModerationFalsePositive } = require('../src/safetyFalsePositive');

test('allows likely self-harm moderation false positive for mundane rope safety use', () => {
  assert.equal(
    shouldAllowModerationFalsePositive(
      'i tie rope from my pack to the bridge rail before leaning over',
      ['self-harm']
    ),
    true
  );
});

test('does not bypass moderation for explicit self-harm language or non-self-harm categories', () => {
  assert.equal(
    shouldAllowModerationFalsePositive('I tie rope around my neck', ['self-harm/intent']),
    false
  );
  assert.equal(
    shouldAllowModerationFalsePositive('I tie rope to the bridge rail', ['violence/graphic']),
    false
  );
});
