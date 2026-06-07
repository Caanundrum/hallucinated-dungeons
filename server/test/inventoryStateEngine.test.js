process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const {
  buildSheetCarriedObjects,
  syncInventoryStateFromCharacterSheet,
} = require('../src/inventoryStateEngine');

function fighterSheet() {
  return {
    inventory: [
      { id: 'longsword', name: 'Longsword', type: 'weapon', quantity: 1 },
      { id: 'chain_mail', name: 'Chain Mail', type: 'armor', quantity: 1 },
      { id: 'shield', name: 'Shield', type: 'shield', quantity: 1 },
      { id: 'dungeoneer_pack', name: "Dungeoneer's Pack", type: 'pack', quantity: 1 },
    ],
  };
}

test('starting equipment pack contents are available as carried objects', () => {
  const carried = buildSheetCarriedObjects(fighterSheet(), getContentBundle());
  const names = carried.map((item) => item.name);

  assert.ok(names.includes("Dungeoneer's Pack"));
  assert.ok(names.includes('Torch'));
  assert.ok(names.includes('Hempen Rope (50 feet)'));
  assert.ok(names.includes('Tinderbox'));
  assert.equal(carried.find((item) => item.name === 'Torch').quantity, 10);
  assert.equal(carried.find((item) => item.name === 'Torch').source_container, "Dungeoneer's Pack");
});

test('syncing inventory preserves existing carried objects while adding pack contents', () => {
  const result = syncInventoryStateFromCharacterSheet({
    inventory_state: {
      character_id: 'char_fighter',
      carried_objects: [{ name: 'wax-sealed note', source_location: 'Morrowgate gate' }],
    },
    object_states: {},
  }, fighterSheet(), getContentBundle(), { characterId: 'char_fighter' });
  const names = result.inventory_state.carried_objects.map((item) => item.name);

  assert.equal(result.inventory_state.character_id, 'char_fighter');
  assert.ok(names.includes('wax-sealed note'));
  assert.ok(names.includes('Torch'));
  assert.ok(names.includes('Hempen Rope (50 feet)'));
});

test('syncing inventory does not refill already-tracked pack contents for the same character', () => {
  const result = syncInventoryStateFromCharacterSheet({
    inventory_state: {
      character_id: 'char_fighter',
      carried_objects: [{ name: 'Torch', quantity: 7, source: 'pack_contents', source_container: "Dungeoneer's Pack" }],
    },
    object_states: {},
  }, fighterSheet(), getContentBundle(), { characterId: 'char_fighter' });
  const torch = result.inventory_state.carried_objects.find((item) => item.name === 'Torch');

  assert.equal(torch.quantity, 7);
});

test('syncing inventory resets carried objects when a different character becomes active', () => {
  const result = syncInventoryStateFromCharacterSheet({
    inventory_state: {
      character_id: 'char_rogue',
      carried_objects: [{ name: 'lockbox key', source: 'story' }],
    },
    object_states: {},
  }, fighterSheet(), getContentBundle(), { characterId: 'char_fighter', resetCarriedObjects: true });
  const names = result.inventory_state.carried_objects.map((item) => item.name);

  assert.equal(result.inventory_state.character_id, 'char_fighter');
  assert.ok(!names.includes('lockbox key'));
  assert.ok(names.includes("Dungeoneer's Pack"));
});
