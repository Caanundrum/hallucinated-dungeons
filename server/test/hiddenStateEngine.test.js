process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adjudicate,
  advanceEnemyTurns,
} = require('../src/refereeCore');

const rogueSheet = {
  identity: { name: 'Shade', level: 1, class: 'rogue', class_name: 'Rogue' },
  abilities: { modifiers: { dex: 3, str: 0 } },
  equipped: { main_hand: 'shortsword', off_hand: null },
  derived_stats: {
    hp: 10,
    max_hp: 10,
    armor_class: 14,
    initiative: 3,
    skill_modifiers: {
      stealth: { total: 3, ability: 'dex', proficient: true },
    },
    attack_breakdowns: [
      { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6+3' },
    ],
  },
};

function combatWorld(overrides = {}) {
  const { combat_state: combatOverrides = {}, ...worldOverrides } = overrides;
  return {
    active_effects: [],
    player_stats: { hp: 10, max_hp: 10, armor_class: 14 },
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
        { name: 'Shade', initiative: 18, hp: 10, max_hp: 10, ac: 14, is_player: true, conditions: [] },
        { name: 'Goblin', initiative: 8, hp: 10, max_hp: 10, ac: 16, conditions: [], is_player: false, attack: { name: 'scimitar', attack_bonus: 4, damage_formula: '1d6+2' } },
      ],
      ...combatOverrides,
    },
    ...worldOverrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

function playerFrom(state) {
  return state.combat_state.combatants.find((combatant) => combatant.is_player);
}

test('successful Hide action uses fixed DC 15 and applies hidden state', () => {
  const prompted = adjudicate({
    message: 'I take the Hide action.',
    worldState: combatWorld(),
    characterSheet: rogueSheet,
    currentTurn: 3,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompted.worldState.pending_roll.id}]`,
    worldState: prompted.worldState,
    characterSheet: rogueSheet,
    rollDie: sequenceRolls([12]),
  });
  const player = playerFrom(resolved.worldState);

  assert.equal(prompted.worldState.pending_roll.dc, 15);
  assert.equal(prompted.worldState.pending_roll.dc_source, 'Hide action fixed DC 15');
  assert.equal(prompted.worldState.combat_state.turn_resources.action_available, false);
  assert.ok(player.conditions.includes('hidden'));
  assert.equal(player.hidden_state.active, true);
  assert.equal(resolved.worldState.player_stats.hidden.active, true);
  assert.match(resolved.reply, /Hidden/);
});

test('failed Hide action does not apply hidden state', () => {
  const prompted = adjudicate({
    message: 'I take the Hide action.',
    worldState: combatWorld(),
    characterSheet: rogueSheet,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompted.worldState.pending_roll.id}]`,
    worldState: prompted.worldState,
    characterSheet: rogueSheet,
    rollDie: sequenceRolls([5]),
  });
  const player = playerFrom(resolved.worldState);

  assert.equal(player.conditions.includes('hidden'), false);
  assert.equal(resolved.worldState.player_stats.hidden, undefined);
  assert.match(resolved.reply, /not hidden/);
});

test('attacking from hidden grants Advantage and then reveals the player', () => {
  const result = adjudicate({
    message: 'I attack the Goblin.',
    worldState: combatWorld({
      player_stats: {
        hp: 10,
        max_hp: 10,
        armor_class: 14,
        hidden: { active: true, source: 'Hide', check_total: 18, dc: 15 },
      },
      combat_state: {
        combatants: [
          { name: 'Shade', initiative: 18, hp: 10, max_hp: 10, ac: 14, is_player: true, conditions: ['hidden'], hidden_state: { active: true, source: 'Hide' } },
          { name: 'Goblin', initiative: 8, hp: 30, max_hp: 30, ac: 16, conditions: [], is_player: false },
        ],
      },
    }),
    characterSheet: rogueSheet,
    rollDie: sequenceRolls([4, 18, 5, 1]),
  });
  const player = playerFrom(result.worldState);
  const goblin = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');

  assert.equal(goblin.hp, 21);
  assert.equal(player.conditions.includes('hidden'), false);
  assert.equal(result.worldState.player_stats.hidden, undefined);
  assert.match(result.reply, /4\/18 with advantage, using 18/);
  assert.match(result.reply, /Hidden attacker/);
  assert.match(result.reply, /Hidden ends/);
});

test('creature attacks against a hidden player have Disadvantage', () => {
  const result = advanceEnemyTurns({
    worldState: combatWorld({
      player_stats: {
        hp: 10,
        max_hp: 10,
        armor_class: 14,
        hidden: { active: true, source: 'Hide', check_total: 18, dc: 15 },
      },
      combat_state: {
        combatants: [
          { name: 'Shade', initiative: 18, hp: 10, max_hp: 10, ac: 14, is_player: true, conditions: ['hidden'], hidden_state: { active: true, source: 'Hide' } },
          { name: 'Goblin', initiative: 8, hp: 10, max_hp: 10, ac: 16, conditions: [], is_player: false, attack: { name: 'scimitar', attack_bonus: 4, damage_formula: '1d6+2' } },
        ],
      },
    }),
    characterSheet: rogueSheet,
    rollDie: sequenceRolls([18, 3]),
    playerTurnNote: 'You end your turn.',
  });

  assert.equal(result.worldState.player_stats.hp, 10);
  assert.match(result.reply, /18\/3 with disadvantage, using 3/);
  assert.match(result.reply, /Hidden target/);
});

test('natural Cunning Action Hide applies hidden state before creature attacks', () => {
  const rogueLevel2 = {
    ...rogueSheet,
    identity: { ...rogueSheet.identity, level: 2 },
  };
  const prompted = adjudicate({
    message: 'I use my bonus action to hide behind the bridge support.',
    worldState: combatWorld({
      scene_presence: {
        exact_location: 'Lantern Bridge',
        present_npcs: [],
        present_objects: ['bridge support'],
        available_exits: [],
      },
    }),
    characterSheet: rogueLevel2,
    currentTurn: 7,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompted.worldState.pending_roll.id}]`,
    worldState: prompted.worldState,
    characterSheet: rogueLevel2,
    rollDie: sequenceRolls([12]),
  });
  const enemyTurn = advanceEnemyTurns({
    worldState: resolved.worldState,
    characterSheet: rogueLevel2,
    rollDie: sequenceRolls([18, 3]),
    playerTurnNote: 'You end your turn.',
  });

  assert.equal(prompted.worldState.pending_roll.consumes, 'bonus_action');
  assert.equal(prompted.worldState.combat_state.turn_resources.action_available, true);
  assert.ok(playerFrom(resolved.worldState).conditions.includes('hidden'));
  assert.match(enemyTurn.reply, /18\/3 with disadvantage, using 3/);
  assert.match(enemyTurn.reply, /Hidden target/);
});
