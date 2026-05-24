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

const townHallDoorState = {
  current_location: 'Morrowgate town hall',
  scene_presence: {
    exact_location: 'Town hall, main door on the south side of Morrowgate (in front of heavy stone entry door)',
    location_type: 'town hall door',
    present_npcs: ['middle-aged clerk at the cracked door'],
    present_objects: ['heavy stone entry door', 'iron latch', 'rain-slick steps'],
    available_exits: ['town square', 'inside town hall'],
    nearby_locations: ['reeve office'],
  },
  npcs_encountered: [
    { name: 'middle-aged clerk', last_seen: 'town hall door' },
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
  assert.match(guardMessage('I pet the dragon in the cellar.'), /no specific cellar has been established here/);
  assert.doesNotMatch(guardMessage('I pet the dragon in the cellar.'), /head there/);
});

test('does not treat previously encountered NPCs as present when scene presence exists', () => {
  assert.match(guardMessage('I ask the innkeeper for ale.'), /innkeeper is not here/);
});

test('allows social phrasing toward present NPCs', () => {
  assert.equal(
    guardMessage('Introduce myself as friendly as possible. I want to disarm the guy so he is not so annoyed. Be nice.', townHallDoorState),
    null
  );
  assert.equal(
    guardMessage('Introduce myself to the clerk as friendly as possible and ask about the reeve.', townHallDoorState),
    null
  );
  assert.equal(guardMessage('Ask for the reeve.', townHallDoorState), null);
  assert.equal(guardMessage('Ask about the missing girl.', townHallDoorState), null);
});

test('does not confuse other keeper NPCs with innkeepers', () => {
  assert.equal(
    guardMessage("I study the ledger-keeper's face to see whether he is hiding something.", {
      current_location: 'Brackenfell town gate',
      scene_presence: {
        exact_location: 'Brackenfell town gate',
        location_type: 'gate',
        present_npcs: ['spear guard', 'ledger-keeper'],
        present_objects: ['open gate', 'ledger'],
        available_exits: ['road into Brackenfell'],
        nearby_locations: ['inn'],
      },
      npcs_encountered: [],
    }),
    null
  );
});

test('allows recently established objects, doors, and NPC aliases in the scene summary', () => {
  const state = {
    current_location: 'Brackenford town proper darker-heart lane',
    scene_presence: {
      exact_location: 'Brackenford town proper deeper-in lane toward the darker heart (rain-slick narrow lane between shuttered houses; lantern-light under a crooked awning where the stranger stands)',
      location_type: 'street',
      present_npcs: ['Unknown lantern-figure'],
      present_objects: ['notice board', 'missing-person notice', 'charcoal bell scrap', 'nearest lit door', 'crooked awning'],
      available_exits: ['deeper lane', 'gate road'],
      nearby_locations: [],
    },
    npcs_encountered: [],
  };

  assert.equal(guardMessage('I read the missing-person notice and the charcoal bell scrap carefully.', state), null);
  assert.equal(guardMessage('I knock on the nearest lit door and call out.', state), null);
  assert.equal(guardMessage('I approach the lantern-lit figure carefully.', state), null);
  assert.equal(guardMessage('I attack the hooded stranger with my longsword.', state), null);
});

test('extracts the real target instead of intent or reason phrases', () => {
  const state = {
    current_location: 'Brackenford lane',
    scene_presence: {
      exact_location: 'Brackenford lane where the stranger stands under the awning',
      location_type: 'street',
      present_npcs: ['stranger'],
      present_objects: ['awning'],
      available_exits: ['deeper lane'],
      nearby_locations: [],
    },
    npcs_encountered: [],
  };

  assert.equal(guardMessage('I decide the risk is too high and attack the hooded stranger with my longsword.', state), null);
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

test('merges time state and replaces active effects without wiping other state', () => {
  const merged = mergeWorldState({
    ...db.DEFAULT_WORLD_STATE,
    active_quest: 'Find the missing scout',
    active_effects: [{ id: 'old_effect', name: 'Old Effect' }],
    time_state: { elapsed_rounds: 1, elapsed_minutes: 0, scene_time: 'round 1' },
  }, {
    time_state: { elapsed_rounds: 2, scene_time: 'round 2' },
    active_effects: [{
      id: 'shield_of_faith',
      name: 'Shield of Faith',
      target: 'Aveline',
      duration: '1 minute',
      remaining_rounds: 9,
      concentration: true,
      mechanical_effect: '+2 AC',
    }],
  });

  assert.equal(merged.active_quest, 'Find the missing scout');
  assert.deepEqual(merged.time_state, { elapsed_rounds: 2, elapsed_minutes: 0, scene_time: 'round 2' });
  assert.deepEqual(merged.active_effects.map((effect) => effect.id), ['shield_of_faith']);
});

test('preserves deterministic active effect rules when utility model updates duration text', () => {
  const merged = mergeWorldState({
    ...db.DEFAULT_WORLD_STATE,
    active_effects: [{
      id: 'shield_of_faith',
      name: 'Shield of Faith',
      remaining_rounds: 100,
      rules_effects: [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }],
    }],
  }, {
    active_effects: [{
      id: 'shield_of_faith',
      name: 'Shield of Faith',
      remaining_rounds: 99,
    }],
  });

  assert.equal(merged.active_effects[0].remaining_rounds, 99);
  assert.deepEqual(merged.active_effects[0].rules_effects, [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }]);
});
