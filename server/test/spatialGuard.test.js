process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkSpatialAction } = require('../src/spatialGuard');
const { mergeWorldState } = require('../src/worldStateExtractor');
const db = require('../src/db');

const gateState = {
  current_location: 'Brackenford',
  scene_presence: {
    exact_location: 'Brackenford town gate',
    location_type: 'gate',
    present_npcs: ['older gate guard', 'younger gate guard'],
    present_objects: ['palisade gate', 'muddy road', 'watchtower'],
    available_exits: ['town road', 'forest road'],
    nearby_locations: ["Ma Venn's inn", 'smithy', 'market', 'temple'],
  },
  npcs_encountered: [
    { name: 'Ma Venn the innkeeper', last_seen: "Ma Venn's inn" },
  ],
};

function guardMessage(message, state = gateState) {
  return checkSpatialAction(message, state)?.message || null;
}

test('blocks known absent service NPCs using scene presence', () => {
  assert.match(guardMessage('I ask the blacksmith to repair my axe.'), /blacksmith is not here/);
  assert.match(guardMessage('I buy rope from the merchant.'), /shopkeeper is not here/);
  assert.match(guardMessage('I ask the priest for healing.'), /priest is not here/);
  assert.match(guardMessage('I talk to the innkeeper about rooms.'), /innkeeper is not here/);
});

test('allows present targets and movement intent', () => {
  assert.equal(guardMessage('I ask the guard what happened here.'), null);
  assert.equal(guardMessage('I inspect the palisade gate.'), null);
  assert.equal(guardMessage('I head to the smithy.'), null);
  assert.equal(guardMessage('I look around the gate.'), null);
});

test('blocks clear generic interactions with absent places and objects', () => {
  assert.match(guardMessage('I open the chest in the room.'), /chest is not here/);
  assert.match(guardMessage('I pet the dragon in the cellar.'), /cellar is not here/);
});

test('does not treat previously encountered NPCs as present when scene presence exists', () => {
  assert.match(guardMessage('I ask the innkeeper for ale.'), /innkeeper is not here/);
});

test('merges scene presence as a full normalized scene snapshot', () => {
  const merged = mergeWorldState(db.DEFAULT_WORLD_STATE, {
    current_location: 'Brackenford town gate',
    scene_presence: {
      location_type: 'gate',
      present_npcs: ['guard'],
      present_objects: ['gate'],
      available_exits: ['town road'],
      nearby_locations: ['inn'],
    },
  });

  assert.equal(merged.scene_presence.exact_location, 'Brackenford town gate');
  assert.deepEqual(merged.scene_presence.present_npcs, ['guard']);
  assert.deepEqual(merged.scene_presence.present_objects, ['gate']);
});
