process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adjudicate,
  advanceEnemyTurns,
} = require('../src/refereeCore');

const wizardSheet = {
  identity: { name: 'Mira', level: 1, class: 'wizard', class_name: 'Wizard' },
  abilities: { modifiers: { dex: 2, int: 3 } },
  derived_stats: {
    hp: 8,
    max_hp: 8,
    armor_class: 12,
    initiative: 2,
  },
  spellcasting: {
    ability: 'int',
    cantrips_known: ['fire_bolt'],
    spells_prepared: ['shield'],
    slots: { 1: 1 },
  },
};

function combatant(name, initiative, overrides = {}) {
  return {
    name,
    initiative,
    hp: 8,
    max_hp: 8,
    ac: 12,
    conditions: [],
    is_player: false,
    attack: { name: 'claw', attack_bonus: 3, damage_formula: '1d4+1' },
    ...overrides,
  };
}

function combatWorld({ slots = 1, combatants = null, turnIndex = 0 } = {}) {
  return {
    active_effects: [],
    player_stats: {
      hp: 8,
      max_hp: 8,
      armor_class: 12,
      base_armor_class: 12,
      spell_slots: { 1: slots },
    },
    combat_state: {
      active: true,
      round: 1,
      turn_index: turnIndex,
      turn_resources: {
        actor: 'player',
        action_available: false,
        bonus_action_available: true,
        reaction_available: true,
        movement_remaining: 30,
        used: [{ resource: 'action', label: 'Fire Bolt' }],
      },
      combatants: combatants || [
        { name: 'Mira', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
        combatant('Skeleton', 8),
      ],
    },
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('Shield pauses a creature hit, spends the Reaction and slot, then turns the hit into a miss', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(pending.worldState.combat_state.round, 1);
  assert.equal(pending.worldState.player_stats.hp, 8);
  assert.equal(pending.worldState.pending_reaction.trigger, 'attack_hit');
  assert.match(pending.reply, /Reaction window/);
  assert.equal(resolved.worldState.player_stats.hp, 8);
  assert.equal(resolved.worldState.player_stats.spell_slots[1], 0);
  assert.equal(resolved.worldState.combat_state.round, 2);
  assert.equal(resolved.worldState.combat_state.turn_resources.reaction_available, true);
  assert.equal(resolved.worldState.player_stats.armor_class, 12);
  assert.deepEqual(resolved.worldState.active_effects, []);
  assert.match(resolved.reply, /Shield turns the triggering hit into a miss/);
});

test('declining a Shield window resumes the stored attack and applies damage', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Decline reaction.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([3]),
  });

  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.equal(resolved.worldState.player_stats.spell_slots[1], 1);
  assert.match(resolved.reply, /decline the Reaction/);
  assert.match(resolved.reply, /Hit for 4 damage/);
});

test('an unrelated action cannot skip an open Reaction window', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const blocked = adjudicate({
    message: 'I attack the skeleton.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
  });

  assert.equal(blocked.worldState.pending_reaction.id, pending.worldState.pending_reaction.id);
  assert.match(blocked.reply, /Reaction window/);
});

test('Shield cannot cancel a creature critical hit', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld(),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([20]),
  });
  const resolved = adjudicate({
    message: 'Use Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([2, 3]),
  });

  assert.equal(resolved.worldState.player_stats.hp, 2);
  assert.match(resolved.reply, /Critical hit/);
});

test('Shield protects against later creature attacks until the player turn starts', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld({
      combatants: [
        { name: 'Mira', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
        combatant('Skeleton', 8),
        combatant('Cultist', 6),
      ],
    }),
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([12]),
  });

  assert.equal(resolved.worldState.player_stats.hp, 8);
  assert.match(resolved.reply, /Skeleton uses claw: rolls 12\+3 = 15 vs AC 17/);
  assert.match(resolved.reply, /Cultist uses claw: rolls 12\+3 = 15 vs AC 17.*Miss/);
});

test('Shield expires when enemy-first initiative reaches the player without advancing the round', () => {
  const pending = advanceEnemyTurns({
    worldState: combatWorld({
      combatants: [
        combatant('Skeleton', 18),
        { name: 'Mira', initiative: 8, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
      ],
      turnIndex: 0,
    }),
    characterSheet: wizardSheet,
    playerTurnNote: 'Skeleton moves first.',
    advanceRound: false,
    rollDie: sequenceRolls([12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: pending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(resolved.worldState.combat_state.round, 1);
  assert.equal(resolved.worldState.player_stats.armor_class, 12);
  assert.deepEqual(resolved.worldState.active_effects, []);
  assert.match(resolved.reply, /Round 1 begins\. It is your turn/);
});

test('a creature hit resolves normally when Shield has no remaining slot', () => {
  const resolved = advanceEnemyTurns({
    worldState: combatWorld({ slots: 0 }),
    characterSheet: {
      ...wizardSheet,
      spellcasting: { ...wizardSheet.spellcasting, slots: { 1: 0 } },
    },
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12, 3]),
  });

  assert.equal(resolved.worldState.pending_reaction, null);
  assert.equal(resolved.worldState.player_stats.hp, 4);
  assert.match(resolved.reply, /Hit for 4 damage/);
});

test('damage before a later Reaction pause still prompts the eventual concentration save', () => {
  const state = combatWorld({
    combatants: [
      { name: 'Mira', initiative: 18, hp: 8, max_hp: 8, ac: 12, is_player: true, conditions: [] },
      combatant('Skeleton', 8),
      combatant('Cultist', 6),
    ],
  });
  state.active_effects = [{
    id: 'detect_magic',
    name: 'Detect Magic',
    concentration: true,
    remaining_rounds: 100,
  }];
  const firstPending = advanceEnemyTurns({
    worldState: state,
    characterSheet: wizardSheet,
    playerTurnNote: 'You end your turn.',
    rollDie: sequenceRolls([12]),
  });
  const secondPending = adjudicate({
    message: 'Decline reaction.',
    worldState: firstPending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([3, 12]),
  });
  const resolved = adjudicate({
    message: 'Cast Shield.',
    worldState: secondPending.worldState,
    characterSheet: wizardSheet,
    rollDie: sequenceRolls([4]),
  });

  assert.equal(secondPending.worldState.player_stats.hp, 4);
  assert.equal(secondPending.worldState.pending_reaction.trigger, 'attack_hit');
  assert.equal(resolved.worldState.pending_roll.kind, 'concentration_save');
  assert.match(resolved.reply, /Concentration is at risk/);
});
