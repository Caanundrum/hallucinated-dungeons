process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRulesContext,
  canInteract,
  findEntity,
  summarizeRulesContextForPrompt,
} = require('../src/rulesContext');

function characterSheet(overrides = {}) {
  return {
    identity: {
      name: 'Ari',
      class: 'paladin',
      class_name: 'Paladin',
      level: 1,
    },
    derived_stats: {
      character_id: 'char_ari',
      armor_class: 18,
      hp: 12,
      max_hp: 12,
    },
    ...overrides,
  };
}

function worldState(overrides = {}) {
  return {
    current_location: 'Morrowgate',
    scene_presence: {
      exact_location: 'Morrowgate town gate',
      location_type: 'gate',
      present_npcs: ['older gate guard', 'younger gate guard'],
      present_objects: ['wax-sealed note', 'palisade gate'],
      available_exits: ['town square', 'east road'],
      nearby_locations: ['the inn'],
    },
    player_stats: {
      character_id: 'char_ari',
      hp: 12,
      max_hp: 12,
      armor_class: 18,
    },
    active_effects: [
      {
        id: 'shield_of_faith',
        name: 'Shield of Faith',
        source: 'Ari',
        target: 'Ari',
        duration: 'Concentration, up to 10 minutes',
        remaining_rounds: 100,
        concentration: true,
      },
    ],
    time_state: { elapsed_rounds: 1 },
    ...overrides,
  };
}

test('adapts scene_presence into future-ready entity state', () => {
  const context = buildRulesContext({
    sessionId: 'session_1',
    worldState: worldState(),
    characterSheet: characterSheet(),
  });

  assert.equal(context.version, '4C.6-H29');
  assert.equal(context.position_state.mode, 'scene_zone');
  assert.equal(context.actor.entity_id, 'pc:char_ari');
  assert.ok(context.entity_state.some((entity) => entity.id === 'npc:older_gate_guard'));
  assert.ok(context.entity_state.some((entity) => entity.id === 'object:wax_sealed_note'));
  assert.ok(context.entity_state.some((entity) => entity.id === 'effect:shield_of_faith_ari'));
  assert.ok(context.visibility_state.visible_entity_ids.includes('object:wax_sealed_note'));
  assert.ok(context.interaction_state.reachable_entity_ids.includes('object:wax_sealed_note'));
});

test('supports entity lookup and interaction checks without relying on narration text', () => {
  const context = buildRulesContext({
    worldState: worldState(),
    characterSheet: characterSheet(),
  });

  const note = findEntity(context, 'read the note', { requirePresent: true });
  const guard = findEntity(context, 'gate guard', { requirePresent: true });
  const inn = findEntity(context, 'the inn');

  assert.equal(note.id, 'object:wax_sealed_note');
  assert.equal(guard.type, 'npc');
  assert.equal(inn.type, 'known_location');
  assert.equal(canInteract(context, 'wax sealed note', 'read').ok, true);
  assert.equal(canInteract(context, 'the inn', 'read').ok, false);
  assert.equal(canInteract(context, 'the inn', 'move').ok, true);
});

test('treats carried objects as reachable rules entities', () => {
  const context = buildRulesContext({
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        location_type: 'gate',
        present_npcs: ['older gate guard'],
        present_objects: ['palisade gate'],
        available_exits: ['town square'],
        nearby_locations: [],
      },
      object_states: {
        wax_sealed_note: { name: 'wax-sealed note', carried_by: 'player', location: 'carried_by_player', is_read: true },
      },
      inventory_state: {
        carried_objects: [{ name: 'wax-sealed note', source_location: 'Morrowgate town gate' }],
      },
    }),
    characterSheet: characterSheet(),
  });

  const note = findEntity(context, 'wax sealed note', { requirePresent: true });
  assert.equal(note.id, 'object:wax_sealed_note');
  assert.equal(note.object_state.carried_by, 'player');
  assert.equal(note.position.relation, 'carried_by_player');
  assert.equal(canInteract(context, 'wax sealed note', 'read').ok, true);
});

test('merges combatants into the same entity model instead of a separate rules island', () => {
  const context = buildRulesContext({
    worldState: worldState({
      combat_state: {
        active: true,
        round: 2,
        turn_index: 0,
        combatants: [
          { character_id: 'char_ari', name: 'Ari', hp: 10, max_hp: 12, ac: 20, initiative: 15, is_player: true },
          { name: 'Gate Wolf', hp: 7, max_hp: 7, ac: 13, initiative: 11, is_player: false },
        ],
      },
    }),
    characterSheet: characterSheet(),
  });

  const player = context.entity_state.find((entity) => entity.id === 'pc:char_ari');
  const wolf = context.entity_state.find((entity) => entity.id === 'creature:gate_wolf');

  assert.equal(context.combat_state.active, true);
  assert.equal(context.combat_state.round, 2);
  assert.equal(player.combat.hp, 10);
  assert.equal(wolf.combat.ac, 13);
  assert.equal(canInteract(context, 'Gate Wolf', 'attack').ok, true);
});

test('preserves future map coordinates when map state appears', () => {
  const context = buildRulesContext({
    worldState: worldState({
      map_state: {
        mode: 'hex',
        map_id: 'morrowgate_gate_map',
        q: 3,
        r: -1,
        zone_id: 'gate_road',
      },
    }),
    characterSheet: characterSheet(),
  });

  assert.equal(context.position_state.mode, 'hex');
  assert.equal(context.position_state.map_id, 'morrowgate_gate_map');
  assert.equal(context.position_state.q, 3);
  assert.equal(context.position_state.r, -1);
});

test('preserves combatant-specific map coordinates for future reach and adjacency rules', () => {
  const context = buildRulesContext({
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { character_id: 'char_ari', name: 'Ari', hp: 12, max_hp: 12, ac: 18, is_player: true, position: { map_id: 'gate', q: 0, r: 0 } },
          { name: 'Gate Wolf', hp: 7, max_hp: 7, ac: 13, is_player: false, position: { map_id: 'gate', q: 1, r: 0 } },
        ],
      },
    }),
    characterSheet: characterSheet(),
  });

  const wolf = context.entity_state.find((entity) => entity.id === 'creature:gate_wolf');
  assert.deepEqual(wolf.position, { map_id: 'gate', q: 1, r: 0 });
});

test('summarizes rules context for DM prompts without handing rules authority to the DM', () => {
  const context = buildRulesContext({
    worldState: worldState(),
    characterSheet: characterSheet(),
  });
  const summary = summarizeRulesContextForPrompt(context);

  assert.match(summary, /Rules context version: 4C\.6-H29/);
  assert.match(summary, /Actor: pc:char_ari/);
  assert.match(summary, /object:wax_sealed_note=wet wax-sealed note|object:wax_sealed_note=wax-sealed note/);
  assert.match(summary, /presence, reachability, visibility, and interactions/);
});
