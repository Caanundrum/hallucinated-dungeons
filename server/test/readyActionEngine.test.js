process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { adjudicate } = require('../src/refereeCore');

const fighterSheet = {
  identity: { name: 'Bran', level: 1, class: 'fighter', class_name: 'Fighter' },
  abilities: { modifiers: { str: 3, dex: 1 } },
  equipped: { main_hand: 'longsword', off_hand: null },
  derived_stats: {
    hp: 12,
    max_hp: 12,
    armor_class: 16,
    initiative: 1,
    attack_breakdowns: [
      { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
    ],
  },
};

function combatWorld(overrides = {}) {
  return {
    active_effects: [],
    player_stats: { hp: 12, max_hp: 12, armor_class: 16 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      turn_resources: {
        actor: 'player',
        action_available: true,
        bonus_action_available: true,
        reaction_available: true,
        movement_remaining: 30,
        used: [],
      },
      combatants: [
        { name: 'Bran', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
        creature('Skeleton', { position: { map_id: 'road', q: 3, r: 0 }, speed: 10 }),
      ],
      ...(overrides.combat_state || {}),
    },
    ...overrides,
  };
}

function creature(name, overrides = {}) {
  return {
    name,
    initiative: 8,
    hp: 8,
    max_hp: 8,
    ac: 12,
    conditions: [],
    is_player: false,
    attack: { name: 'claw', attack_bonus: 3, damage_formula: '1d4+1' },
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('Ready stores a weapon attack as a prepared Reaction while leaving the turn open', () => {
  const result = adjudicate({
    message: 'I ready an attack against the Skeleton if it comes close.',
    worldState: combatWorld(),
    characterSheet: fighterSheet,
  });
  const resources = result.worldState.combat_state.turn_resources;

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'referee_ready_action');
  assert.equal(resources.action_available, false);
  assert.equal(resources.reaction_available, true);
  assert.equal(resources.readied_action.type, 'weapon_attack');
  assert.equal(resources.readied_action.target_name, 'Skeleton');
  assert.match(result.reply, /Ready/);
  assert.match(result.reply, /Your turn remains open/);
});

test('readied weapon attack triggers after a creature moves into reach before it attacks', () => {
  const ready = adjudicate({
    message: 'I ready an attack against the Skeleton if it comes close.',
    worldState: combatWorld(),
    characterSheet: fighterSheet,
  });
  const resolved = adjudicate({
    message: 'end turn',
    worldState: ready.worldState,
    characterSheet: fighterSheet,
    rollDie: sequenceRolls([10, 4, 5]),
  });
  const skeleton = resolved.worldState.combat_state.combatants.find((entry) => entry.name === 'Skeleton');

  assert.equal(skeleton.hp, 1);
  assert.deepEqual(skeleton.position, { map_id: 'road', q: 1, r: 0 });
  assert.equal(resolved.worldState.player_stats.hp, 12);
  assert.equal(resolved.worldState.combat_state.turn_resources.readied_action, undefined);
  assert.match(resolved.reply, /Readied action/);
  assert.match(resolved.reply, /Hit for 7 damage/);
  assert.match(resolved.reply, /Skeleton uses claw/);
});

test('readied weapon attack that drops the creature prevents its attack and can end combat', () => {
  const ready = adjudicate({
    message: 'I ready an attack against the Skeleton if it comes close.',
    worldState: combatWorld({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Bran', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [], position: { map_id: 'road', q: 0, r: 0 } },
          creature('Skeleton', { hp: 6, max_hp: 6, position: { map_id: 'road', q: 3, r: 0 }, speed: 10 }),
        ],
      },
    }),
    characterSheet: fighterSheet,
  });
  const resolved = adjudicate({
    message: 'end turn',
    worldState: ready.worldState,
    characterSheet: fighterSheet,
    rollDie: sequenceRolls([10, 4]),
  });

  assert.equal(resolved.worldState.combat_state, null);
  assert.match(resolved.reply, /Readied action/);
  assert.match(resolved.reply, /falls before leaving your reach|falls/);
  assert.match(resolved.reply, /Combat ends/);
  assert.doesNotMatch(resolved.reply, /Skeleton uses claw/);
});

test('unsupported readied spells are blocked until spell-ready rules exist', () => {
  const result = adjudicate({
    message: 'I ready a spell if the Skeleton moves.',
    worldState: combatWorld(),
    characterSheet: fighterSheet,
  });

  assert.equal(result.logType, 'referee_ready_action_unsupported');
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.match(result.reply, /Readied spells/);
});
