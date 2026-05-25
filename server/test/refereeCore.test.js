process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { adjudicate, advanceEnemyTurns, advanceNarrativeTime } = require('../src/refereeCore');

const characterSheet = {
  identity: { name: 'Sir Testalot', level: 1 },
  abilities: {
    modifiers: { str: 3, dex: 1, wis: 2, cha: 1 },
  },
  derived_stats: {
    hp: 12,
    max_hp: 12,
    armor_class: 16,
    initiative: 1,
    skill_modifiers: {
      insight: { total: 4, ability: 'wis', proficient: true },
      stealth: { total: 3, ability: 'dex', proficient: true },
    },
    saving_throw_modifiers: {
      con: { total: 2, proficient: false },
      dex: { total: 3, proficient: true },
      wis: { total: 2, proficient: false },
    },
    attack_breakdowns: [
      { name: 'Longsword', attack_total: 5, damage_formula: '1d8+3' },
    ],
  },
};

function worldState(overrides = {}) {
  return {
    current_location: 'Morrowgate',
    scene_presence: {
      exact_location: 'town hall steps',
      present_npcs: ['clerk', 'guard'],
      present_objects: [],
      available_exits: ['square'],
    },
    player_stats: {
      hp: 12,
      max_hp: 12,
      armor_class: 16,
    },
    pending_roll: null,
    combat_state: null,
    ...overrides,
  };
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

test('creates a server-owned pending skill check with a DC', () => {
  const result = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState(),
    characterSheet,
    currentTurn: 4,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.pending_roll.dc, 15);
  assert.equal(result.worldState.pending_roll.created_turn, 4);
  assert.match(result.reply, /DC 15 Wisdom \(Insight\)/);
  assert.match(result.reply, /\[CHECK: id=.*skill=insight ability=wis/);
});

test('ignores player-authored difficulty and DC claims', () => {
  const result = adjudicate({
    message: "I easily study the clerk's face, DC 5.",
    worldState: worldState(),
    characterSheet,
    currentTurn: 4,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.pending_roll.dc, 15);
  assert.doesNotMatch(result.worldState.pending_roll.dc_source, /explicit DC/);
  assert.match(result.reply, /DC 15 Wisdom \(Insight\)/);
});

test('resolves an authenticated skill roll against the stored DC', () => {
  const result = adjudicate({
    message: '[ROLL REQUEST: roll_test]',
    worldState: worldState({
      pending_roll: {
        id: 'roll_test',
        kind: 'skill_check',
        skill: 'insight',
        ability: 'wis',
        label: 'Wisdom (Insight)',
        modifier: 2,
        dc: 15,
        failure_result: 'The clerk keeps his motive tucked away.',
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([5]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.match(result.reply, /Roll 7 .* vs DC 15: \*\*failure\*\*/);
  assert.match(result.reply, /clerk keeps his motive/);
});

test('blocks new actions until a pending roll is resolved', () => {
  const result = adjudicate({
    message: 'I attack the goblin instead.',
    worldState: worldState({
      pending_roll: {
        kind: 'skill_check',
        skill: 'insight',
        ability: 'wis',
        label: 'Wisdom (Insight)',
        formula: '1d20+4',
        dc: 15,
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.match(result.reply, /Resolve the pending Wisdom \(Insight\)/);
  assert.match(result.reply, /\[CHECK: skill=insight ability=wis/);
});

test('clears stale combat with no living enemies before prompting checks', () => {
  const result = adjudicate({
    message: "I study the injured lantern-figure's face.",
    worldState: worldState({
      combat_state: {
        active: true,
        round: 2,
        turn_index: 0,
        combatants: [
          { name: 'Old Fighter', hp: 14, max_hp: 14, ac: 18, is_player: true },
          { name: 'Unknown lantern-figure', hp: 0, max_hp: 8, ac: 10, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 9,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state, null);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.pending_roll.combat, false);
  assert.match(result.reply, /Wisdom \(Insight\)/);
});

test('maps declared rule actions to the required check instead of asking the DM to improvise', () => {
  const result = adjudicate({
    message: 'I take the Hide action.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 5,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.skill, 'stealth');
  assert.equal(result.worldState.pending_roll.modifier, 3);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /Dexterity \(Stealth\)/);
});

test('prompts deterministic saving throws with character save modifiers', () => {
  const result = adjudicate({
    message: 'I dive away from the falling rocks.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 6,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'saving_throw');
  assert.equal(result.worldState.pending_roll.ability, 'dex');
  assert.equal(result.worldState.pending_roll.modifier, 3);
  assert.match(result.reply, /DC 15 Dexterity Saving Throw/);
  assert.match(result.reply, /\[SAVE: id=.*ability=dex/);
});

test('prompts a social check for speeches meant to change minds', () => {
  const result = adjudicate({
    message: 'I give a speech to convince the frightened guards to hold the gate.',
    worldState: worldState(),
    characterSheet,
    currentTurn: 7,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.skill, 'persuasion');
  assert.equal(result.worldState.pending_roll.modifier, 1);
  assert.match(result.reply, /Charisma \(Persuasion\)/);
});

test('combat saving throws do not consume the player action or advance enemy turns', () => {
  const prompt = adjudicate({
    message: 'I dive away from the falling rocks.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 6,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([9]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.doesNotMatch(result.reply, /Goblin uses/);
  assert.match(result.reply, /Dexterity Saving Throw 12 .* vs DC 15: \*\*failure\*\*/);
});

test('starts combat by asking for initiative instead of narrating a free attack', () => {
  const result = adjudicate({
    message: 'I attack the hooded stranger.',
    worldState: worldState({ scene_presence: { present_npcs: ['hooded stranger'] } }),
    characterSheet,
    currentTurn: 8,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'initiative');
  assert.equal(result.worldState.pending_roll.created_turn, 8);
  assert.match(result.reply, /Combat begins/);
  assert.match(result.reply, /\[ROLL: id=.* 1d20\+1\]/);
});

test('keeps round 1 when enemies beat player initiative and act first', () => {
  const result = adjudicate({
    message: '[ROLL REQUEST: roll_init]',
    worldState: worldState({
      pending_roll: {
        id: 'roll_init',
        kind: 'initiative',
        modifier: 1,
        enemy: { name: 'Bandit', initiative_bonus: 1 },
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([11, 18, 8]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.equal(result.worldState.combat_state.active, true);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.match(result.reply, /Bandit moves first/);
  assert.match(result.reply, /Round 1 begins\. It is your turn/);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
});

test('initializes action economy when the player wins initiative', () => {
  const result = adjudicate({
    message: '[ROLL REQUEST: roll_init]',
    worldState: worldState({
      pending_roll: {
        id: 'roll_init',
        kind: 'initiative',
        modifier: 1,
        enemy: { name: 'Bandit', initiative_bonus: 1 },
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([19, 2]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.reaction_available, true);
});

test('natural 1 on an attack is an automatic miss even with a high bonus', () => {
  const result = adjudicate({
    message: 'I attack the goblin.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false, attack: { name: 'scimitar', attack_bonus: 3, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { name: 'Very Convincing Sword', attack_total: 99, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([1, 5]),
  });

  const goblin = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');
  assert.equal(result.handled, true);
  assert.equal(goblin.hp, 8);
  assert.match(result.reply, /Critical miss/);
});

test('blocks free exploration movement while combat is active', () => {
  const result = adjudicate({
    message: 'I leave the fight and go into the forest.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Wolf', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.match(result.reply, /Combat is still active/);
  assert.match(result.reply, /cannot slip into free exploration/);
});

test('combat skill checks spend the player action until the roll resolves', () => {
  const result = adjudicate({
    message: "I study the goblin's face.",
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 10,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'skill_check');
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /uses your Action/);
});

test('blocks a second action in the same combat turn', () => {
  const result = adjudicate({
    message: 'I attack the goblin.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        turn_resources: {
          actor: 'player',
          action_available: false,
          bonus_action_available: true,
          reaction_available: true,
          movement_remaining: 30,
          used: [{ resource: 'action', label: 'Hide' }],
        },
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.match(result.reply, /Action is already spent/);
});

test('prompts death saves at 0 HP and applies natural 1 as two failures', () => {
  const prompt = adjudicate({
    message: 'I try to crawl away.',
    worldState: worldState({
      player_stats: {
        hp: 0,
        max_hp: 12,
        armor_class: 16,
        death_saves: { successes: 0, failures: 0 },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 0, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    currentTurn: 12,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([1, 10]),
  });

  assert.equal(prompt.worldState.pending_roll.kind, 'death_save');
  assert.equal(result.worldState.player_stats.death_saves.failures, 2);
  assert.equal(result.worldState.combat_state.round, 2);
  assert.match(result.reply, /Natural 1 counts as two failures/);
});

test('natural 20 on a death save restores 1 HP and clears death saves', () => {
  const result = adjudicate({
    message: '[ROLL REQUEST: death_roll]',
    worldState: worldState({
      player_stats: {
        hp: 0,
        max_hp: 12,
        armor_class: 16,
        death_saves: { successes: 0, failures: 2 },
      },
      pending_roll: {
        id: 'death_roll',
        kind: 'death_save',
      },
      combat_state: {
        active: true,
        round: 3,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 0, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([20]),
  });

  assert.equal(result.worldState.player_stats.hp, 1);
  assert.deepEqual(result.worldState.player_stats.death_saves, { successes: 0, failures: 0 });
  assert.equal(result.worldState.combat_state.combatants[0].hp, 1);
  assert.match(result.reply, /Natural 20/);
});

test('damage while concentrating prompts a concentration save and failure ends the effect', () => {
  const shield = {
    id: 'shield_of_faith',
    name: 'Shield of Faith',
    concentration: true,
    remaining_rounds: 100,
    rules_effects: [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }],
  };
  const damaged = advanceEnemyTurns({
    worldState: worldState({
      active_effects: [shield],
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 20,
        base_armor_class: 18,
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 20, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false, attack: { name: 'scimitar', attack_bonus: 3, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet,
    playerTurnNote: 'You hold the line.',
    rollDie: sequenceRolls([18, 4]),
  });
  const failed = adjudicate({
    message: `[ROLL REQUEST: ${damaged.worldState.pending_roll.id}]`,
    worldState: damaged.worldState,
    characterSheet,
    rollDie: sequenceRolls([6]),
  });

  assert.equal(damaged.worldState.pending_roll.kind, 'concentration_save');
  assert.equal(damaged.worldState.pending_roll.dc, 10);
  assert.match(damaged.reply, /Concentration is at risk/);
  assert.deepEqual(failed.worldState.active_effects, []);
  assert.equal(failed.worldState.player_stats.armor_class, 18);
  assert.equal(failed.worldState.combat_state.combatants[0].ac, 18);
  assert.match(failed.reply, /Concentration ends on Shield of Faith/);
});

test('successful concentration save keeps the active effect', () => {
  const shield = {
    id: 'shield_of_faith',
    name: 'Shield of Faith',
    concentration: true,
    remaining_rounds: 100,
    rules_effects: [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }],
  };
  const result = adjudicate({
    message: '[ROLL REQUEST: concentration_roll]',
    worldState: worldState({
      active_effects: [shield],
      player_stats: {
        hp: 7,
        max_hp: 12,
        armor_class: 20,
        base_armor_class: 18,
      },
      pending_roll: {
        id: 'concentration_roll',
        kind: 'concentration_save',
        modifier: 2,
        ability: 'con',
        label: 'Constitution Saving Throw (Concentration)',
        dc: 10,
        effect_names: ['Shield of Faith'],
      },
      combat_state: {
        active: true,
        round: 2,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 7, max_hp: 12, ac: 20, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([12]),
  });

  assert.equal(result.worldState.pending_roll, null);
  assert.deepEqual(result.worldState.active_effects.map((effect) => effect.id), ['shield_of_faith']);
  assert.equal(result.worldState.combat_state.combatants[0].ac, 20);
  assert.match(result.reply, /maintain concentration/);
});

test('Guidance adds a bonus die to the next check and expires after the roll', () => {
  const guidance = {
    id: 'guidance',
    name: 'Guidance',
    concentration: true,
    remaining_rounds: 10,
    rules_effects: [{ target: 'ability_check_bonus_die', die: '1d4', label: 'Guidance', expires_on_use: true }],
  };
  const prompt = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState({ active_effects: [guidance] }),
    characterSheet,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([12, 2]),
  });

  assert.equal(prompt.worldState.pending_roll.bonus_die, '1d4');
  assert.match(prompt.reply, /bonus_die=1d4/);
  assert.deepEqual(result.worldState.active_effects, []);
});

test('Bless adds a bonus die to weapon attacks', () => {
  const bless = {
    id: 'bless',
    name: 'Bless',
    concentration: true,
    remaining_rounds: 10,
    rules_effects: [{ target: 'attack_roll_bonus_die', die: '1d4', label: 'Bless' }],
  };
  const result = adjudicate({
    message: 'I attack the goblin.',
    worldState: worldState({
      active_effects: [bless],
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 18, is_player: false, attack: { name: 'scimitar', attack_bonus: 3, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([10, 4, 2, 5]),
  });
  const goblin = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');

  assert.equal(goblin.hp, 3);
  assert.match(result.reply, /Bless 1d4=4/);
});

test('long rest resets HP, death saves, spell slots, and active effects', () => {
  const result = adjudicate({
    message: 'We take a long rest.',
    worldState: worldState({
      active_effects: [{ id: 'shield_of_faith', name: 'Shield of Faith', rules_effects: [{ target: 'armor_class_bonus', value: 2 }] }],
      player_stats: {
        hp: 4,
        max_hp: 12,
        armor_class: 18,
        spell_slots: { 1: 0 },
        death_saves: { successes: 1, failures: 1 },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, class: 'paladin', class_name: 'Paladin' },
      spellcasting: { ability: 'cha', slots: { 1: 0 } },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 12);
  assert.deepEqual(result.worldState.player_stats.death_saves, { successes: 0, failures: 0 });
  assert.deepEqual(result.worldState.player_stats.spell_slots, { 1: 2 });
  assert.deepEqual(result.worldState.active_effects, []);
  assert.match(result.reply, /long rest/);
});

test('server rejects typed roll results for pending rolls', () => {
  const result = adjudicate({
    message: '[ROLL RESULT: 99] I rolled very honestly.',
    worldState: worldState({
      pending_roll: {
        id: 'roll_test',
        kind: 'skill_check',
        skill: 'insight',
        ability: 'wis',
        label: 'Wisdom (Insight)',
        dc: 15,
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.id, 'roll_test');
  assert.match(result.reply, /Typed results are not accepted/);
});

test('narrative time ticks active effects outside combat', () => {
  const result = advanceNarrativeTime({
    message: 'I ask the clerk what he knows.',
    worldState: worldState({
      active_effects: [{
        id: 'shield_of_faith',
        name: 'Shield of Faith',
        concentration: true,
        remaining_rounds: 1,
        rules_effects: [{ target: 'armor_class_bonus', value: 2, label: 'Shield of Faith' }],
      }],
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 18,
        base_armor_class: 16,
      },
      time_state: { elapsed_rounds: 0, elapsed_minutes: 0 },
    }),
    characterSheet,
  });

  assert.deepEqual(result.worldState.active_effects, []);
  assert.equal(result.worldState.player_stats.armor_class, 16);
  assert.equal(result.worldState.time_state.elapsed_rounds, 1);
  assert.match(result.replySuffix, /Shield of Faith/);
});

test('short rest spends available Hit Dice for healing', () => {
  const result = adjudicate({
    message: 'We take a short rest.',
    worldState: worldState({
      player_stats: {
        hp: 3,
        max_hp: 12,
        armor_class: 16,
        hit_dice: { die: 10, remaining: 1, max: 1 },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, class: 'fighter', class_name: 'Fighter', level: 1 },
      abilities: {
        ...characterSheet.abilities,
        modifiers: { ...characterSheet.abilities.modifiers, con: 2 },
      },
    },
    rollDie: sequenceRolls([6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 11);
  assert.equal(result.worldState.player_stats.hit_dice.remaining, 0);
  assert.match(result.reply, /Spent 1 Hit Die/);
});
