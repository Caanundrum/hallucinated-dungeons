process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCombatMovement,
  resolveDashAction,
  resolveDisengageAction,
} = require('../src/combatMovementEngine');

const characterSheet = {
  identity: { name: 'Ari', level: 1 },
  derived_stats: {
    hp: 12,
    max_hp: 12,
    armor_class: 14,
    speed: 30,
  },
};

function combatWorld(overrides = {}) {
  return {
    player_stats: { hp: 12, max_hp: 12, armor_class: 14, speed: 30 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 12, max_hp: 12, ac: 14, is_player: true },
        {
          name: 'Cultist',
          hp: 8,
          max_hp: 8,
          ac: 12,
          is_player: false,
          attack: { name: 'dagger', attack_bonus: 3, damage_formula: '1d4+1' },
        },
      ],
      ...(overrides.combat_state || {}),
    },
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('Dash spends an Action and grants extra movement equal to Speed', () => {
  const result = resolveDashAction({
    message: 'I Dash.',
    worldState: combatWorld(),
    characterSheet,
  });

  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.movement_remaining, 60);
  assert.match(result.reply, /gain 30 feet of movement/);
});

test('Disengage suppresses a scene-zone Opportunity Attack while moving away', () => {
  const result = resolveDisengageAction({
    message: 'I Disengage and move 20 feet away.',
    worldState: combatWorld(),
    characterSheet,
    rollDie: sequenceRolls([20, 4]),
  });
  const cultist = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Cultist');

  assert.equal(result.worldState.player_stats.hp, 12);
  assert.equal(result.worldState.combat_state.turn_resources.disengaged, true);
  assert.equal(result.worldState.combat_state.turn_resources.movement_remaining, 10);
  assert.equal(cultist.reaction_available, undefined);
  assert.doesNotMatch(result.reply, /\*\*Opportunity Attack:\*\*/);
});

test('moving away from a scene-zone melee enemy provokes one Opportunity Attack', () => {
  const result = resolveCombatMovement({
    message: 'I move 10 feet away from the cultist.',
    worldState: combatWorld(),
    characterSheet,
    rollDie: sequenceRolls([12, 4]),
  });
  const cultist = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Cultist');

  assert.equal(result.worldState.player_stats.hp, 7);
  assert.equal(result.worldState.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(cultist.reaction_available, false);
  assert.match(result.reply, /Opportunity Attack/);
  assert.match(result.reply, /theater-of-mind positioning/);
});

test('ambiguous scene-zone movement conservatively provokes while approaching movement does not', () => {
  const ambiguous = resolveCombatMovement({
    message: 'I move 10 feet north.',
    worldState: combatWorld(),
    characterSheet,
    rollDie: sequenceRolls([12, 2]),
  });
  const approaching = resolveCombatMovement({
    message: 'I move 10 feet toward the cultist.',
    worldState: combatWorld(),
    characterSheet,
    rollDie: sequenceRolls([20, 4]),
  });

  assert.equal(ambiguous.worldState.player_stats.hp, 9);
  assert.match(ambiguous.reply, /Opportunity Attack/);
  assert.equal(approaching.worldState.player_stats.hp, 12);
  assert.doesNotMatch(approaching.reply, /\*\*Opportunity Attack:\*\*/);
});

test('a ranged-only enemy cannot make an Opportunity Attack', () => {
  const result = resolveCombatMovement({
    message: 'I retreat 10 feet.',
    worldState: combatWorld({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 14, is_player: true },
          {
            name: 'Archer',
            hp: 8,
            max_hp: 8,
            ac: 12,
            is_player: false,
            attack: { name: 'shortbow shot', attack_kind: 'ranged', attack_bonus: 4, damage_formula: '1d6+2' },
          },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([20, 6]),
  });

  assert.equal(result.worldState.player_stats.hp, 12);
  assert.doesNotMatch(result.reply, /\*\*Opportunity Attack:\*\*/);
});

test('a creature cannot make a second Opportunity Attack before its Reaction resets', () => {
  const first = resolveCombatMovement({
    message: 'I move 5 feet away.',
    worldState: combatWorld(),
    characterSheet,
    rollDie: sequenceRolls([12, 2]),
  });
  const second = resolveCombatMovement({
    message: 'I move another 5 feet away.',
    worldState: first.worldState,
    characterSheet,
    rollDie: sequenceRolls([20, 4]),
  });

  assert.equal(first.worldState.player_stats.hp, 9);
  assert.equal(second.worldState.player_stats.hp, 9);
  assert.doesNotMatch(second.reply, /Opportunity Attack/);
});

test('hex movement provokes only when the destination leaves melee reach', () => {
  const worldState = combatWorld({
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 12, max_hp: 12, ac: 14, is_player: true, position: { map_id: 'crypt', q: 0, r: 0 } },
        {
          name: 'Cultist',
          hp: 8,
          max_hp: 8,
          ac: 12,
          is_player: false,
          position: { map_id: 'crypt', q: 1, r: 0 },
          attack: { name: 'dagger', attack_bonus: 3, damage_formula: '1d4+1' },
        },
      ],
    },
  });
  const result = resolveCombatMovement({
    message: 'I move away.',
    worldState,
    characterSheet,
    destination: { map_id: 'crypt', q: -2, r: 0 },
    rollDie: sequenceRolls([12, 4]),
  });
  const player = result.worldState.combat_state.combatants.find((combatant) => combatant.is_player);

  assert.equal(result.worldState.player_stats.hp, 7);
  assert.deepEqual(player.position, { map_id: 'crypt', q: -2, r: 0 });
  assert.equal(result.worldState.player_stats.last_movement.mode, 'hex');
  assert.match(result.reply, /Opportunity Attack/);
});

test('an occupied hex blocks movement before spending feet or provoking reactions', () => {
  const worldState = combatWorld({
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Ari', hp: 12, max_hp: 12, ac: 14, is_player: true, position: { map_id: 'crypt', q: 0, r: 0 } },
        { name: 'Cultist', hp: 8, max_hp: 8, ac: 12, is_player: false, position: { map_id: 'crypt', q: 1, r: 0 } },
      ],
    },
  });
  const result = resolveCombatMovement({
    message: 'I move away.',
    worldState,
    characterSheet,
    destination: { map_id: 'crypt', q: 1, r: 0 },
  });

  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /destination is occupied/);
});

test('an Opportunity Attack that drops the player stops movement before feet are spent', () => {
  const result = resolveCombatMovement({
    message: 'I flee 10 feet away.',
    worldState: combatWorld({
      player_stats: { hp: 3, max_hp: 12, armor_class: 14, speed: 30 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 3, max_hp: 12, ac: 14, is_player: true },
          {
            name: 'Cultist',
            hp: 8,
            max_hp: 8,
            ac: 12,
            is_player: false,
            attack: { name: 'dagger', attack_bonus: 3, damage_formula: '1d4+1' },
          },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([12, 4]),
  });

  assert.equal(result.worldState.player_stats.hp, 0);
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.equal(result.worldState.player_stats.last_movement, undefined);
  assert.match(result.reply, /stops your movement before you leave reach/);
});
