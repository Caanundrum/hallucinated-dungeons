process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  answerInventoryCountQuestion,
  formatCarriedInventoryForRules,
} = require('../src/rulesInventoryAnswers');

test('answers current carried consumable count from world inventory state', () => {
  const reply = answerInventoryCountQuestion('how many rations do i have left after eating that ration', {
    inventory_state: {
      carried_objects: [
        { name: "Dungeoneer's Pack", quantity: 1 },
        { name: 'Rations', quantity: 9, consumed_quantity: 1, source_container: "Dungeoneer's Pack" },
      ],
    },
  });

  assert.match(reply, /\*\*9 Rations\*\*/);
  assert.match(reply, /in your Dungeoneer's Pack/);
  assert.match(reply, /used 1/);
});

test('formats carried inventory with zero and consumed counts for rules context', () => {
  const summary = formatCarriedInventoryForRules([
    { name: 'Rations', quantity: 0, consumed_quantity: 10, source_container: "Dungeoneer's Pack" },
    { name: 'Torch', quantity: 9, consumed_quantity: 1, source_container: "Dungeoneer's Pack" },
  ]);

  assert.match(summary, /Rations x0 in Dungeoneer's Pack, 10 used, depleted/);
  assert.match(summary, /Torch x9 in Dungeoneer's Pack, 1 used/);
});
