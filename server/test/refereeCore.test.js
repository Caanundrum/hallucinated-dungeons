process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  adjudicate,
  advanceEnemyTurns,
  advanceNarrativeTime,
  finishPlayerCombatAction,
} = require('../src/refereeCore');

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

test('contextual phrasing maps present targets to referee checks', () => {
  const npcStudy = adjudicate({
    message: 'I study the clerk.',
    worldState: worldState(),
    characterSheet,
  });
  const objectStudy = adjudicate({
    message: 'I look over the wax-sealed note.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'town hall steps',
        present_npcs: ['clerk'],
        present_objects: ['wax-sealed note'],
        available_exits: ['square'],
      },
    }),
    characterSheet,
  });
  const socialApproach = adjudicate({
    message: 'I introduce myself warmly to the clerk and ask for the reeve.',
    worldState: worldState(),
    characterSheet,
  });

  assert.equal(npcStudy.worldState.pending_roll.skill, 'insight');
  assert.match(npcStudy.reply, /Wisdom \(Insight\)/);
  assert.equal(objectStudy.worldState.pending_roll.skill, 'investigation');
  assert.match(objectStudy.reply, /Intelligence \(Investigation\)/);
  assert.equal(socialApproach.worldState.pending_roll.skill, 'persuasion');
  assert.match(socialApproach.reply, /Charisma \(Persuasion\)/);
});

test('outside-combat end turn after Wild Companion stays deterministic', () => {
  const druidSheet = {
    ...characterSheet,
    identity: { ...characterSheet.identity, class: 'druid', class_name: 'Druid', level: 2 },
    resources: {
      wild_shape: { name: 'Wild Shape', remaining: 2, max: 2, reset: 'short_rest' },
    },
  };
  const companion = adjudicate({
    message: 'I use Wild Companion.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Lantern Bridge',
        present_npcs: [],
        present_objects: ['bridge rail', 'dark water'],
        available_exits: ['far bank'],
      },
      player_stats: {
        hp: 10,
        max_hp: 10,
        armor_class: 13,
        resources: {
          wild_shape: { name: 'Wild Shape', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
      active_effects: [],
    }),
    characterSheet: druidSheet,
  });
  const ended = adjudicate({
    message: 'I end my turn.',
    worldState: companion.worldState,
    characterSheet: druidSheet,
  });

  assert.equal(companion.handled, true);
  assert.equal(companion.worldState.player_stats.resources.wild_shape.remaining, 1);
  assert.equal(ended.handled, true);
  assert.equal(ended.logType, 'referee_no_combat_turn_to_end');
  assert.equal(ended.worldState.combat_state, null);
  assert.ok(ended.worldState.active_effects.some((effect) => effect.id === 'wild_companion'));
  assert.match(ended.reply, /No initiative is running/);
});

test('hazardous swimming and climbing in heavy armor prompt Athletics instead of free narration', () => {
  const armoredSheet = {
    ...characterSheet,
    equipped: { armor: 'chain_mail', off_hand: 'shield' },
    inventory: [
      { id: 'chain_mail', name: 'Chain Mail', type: 'armor', armor_category: 'heavy' },
      { id: 'shield', name: 'Shield', type: 'shield' },
      { id: 'dungeoneer_pack', name: "Dungeoneer's Pack", type: 'pack' },
    ],
    derived_stats: {
      ...characterSheet.derived_stats,
      skill_modifiers: {
        ...characterSheet.derived_stats.skill_modifiers,
        athletics: { total: 5, ability: 'str', proficient: true },
      },
    },
  };
  const bridgeState = worldState({
    current_location: 'Lantern Bridge',
    scene_presence: {
      exact_location: 'Lantern Bridge over dark water',
      location_type: 'slick bridge',
      present_npcs: [],
      present_objects: ['dark water', 'bridge support', 'bridge rail'],
      available_exits: ['far bank'],
    },
  });

  const jump = adjudicate({
    message: 'I jump into the dark water.',
    worldState: bridgeState,
    characterSheet: armoredSheet,
  });
  const climb = adjudicate({
    message: 'I climb back up onto the bridge.',
    worldState: bridgeState,
    characterSheet: armoredSheet,
  });

  assert.equal(jump.handled, true);
  assert.equal(jump.worldState.pending_roll.skill, 'athletics');
  assert.ok(jump.worldState.pending_roll.dc >= 25);
  assert.match(jump.worldState.pending_roll.dc_source, /heavy armor/);
  assert.match(jump.reply, /Strength \(Athletics\)/);
  assert.equal(climb.worldState.pending_roll.skill, 'athletics');
  assert.match(climb.worldState.pending_roll.dc_source, /shield and carried gear/);
});

test('failed hazardous Athletics roll applies concrete water consequence state', () => {
  const armoredSheet = {
    ...characterSheet,
    equipped: { armor: 'chain_mail', off_hand: 'shield' },
    inventory: [
      { id: 'chain_mail', name: 'Chain Mail', type: 'armor', armor_category: 'heavy' },
      { id: 'shield', name: 'Shield', type: 'shield' },
      { id: 'dungeoneer_pack', name: "Dungeoneer's Pack", type: 'pack' },
    ],
    derived_stats: {
      ...characterSheet.derived_stats,
      skill_modifiers: {
        ...characterSheet.derived_stats.skill_modifiers,
        athletics: { total: 5, ability: 'str', proficient: true },
      },
    },
  };
  const prompt = adjudicate({
    message: 'I jump into the dark water.',
    worldState: worldState({
      current_location: 'Lantern Bridge',
      scene_presence: {
        exact_location: 'Lantern Bridge over dark water',
        location_type: 'slick bridge',
        present_npcs: [],
        present_objects: ['dark water', 'bridge support', 'bridge rail'],
        available_exits: ['far bank'],
      },
    }),
    characterSheet: armoredSheet,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet: armoredSheet,
    rollDie: sequenceRolls([1]),
  });

  assert.equal(resolved.handled, true);
  assert.equal(resolved.worldState.pending_roll, null);
  assert.equal(resolved.worldState.hazard_state.active, true);
  assert.equal(resolved.worldState.hazard_state.status, 'struggling_in_water');
  assert.match(resolved.worldState.scene_presence.exact_location, /dark water below Lantern Bridge/);
  assert.match(resolved.reply, /struggling below Lantern Bridge/);
  assert.doesNotMatch(resolved.reply, /another consequence that fits the scene/);
});

test('successful hazardous water entry updates location without failure consequence', () => {
  const armoredSheet = {
    ...characterSheet,
    equipped: { armor: 'chain_mail', off_hand: 'shield' },
    inventory: [
      { id: 'chain_mail', name: 'Chain Mail', type: 'armor', armor_category: 'heavy' },
      { id: 'shield', name: 'Shield', type: 'shield' },
      { id: 'dungeoneer_pack', name: "Dungeoneer's Pack", type: 'pack' },
    ],
    derived_stats: {
      ...characterSheet.derived_stats,
      skill_modifiers: {
        ...characterSheet.derived_stats.skill_modifiers,
        athletics: { total: 12, ability: 'str', proficient: true },
      },
    },
  };
  const prompt = adjudicate({
    message: 'I jump into the dark water.',
    worldState: worldState({
      current_location: 'Lantern Bridge',
      scene_presence: {
        exact_location: 'Lantern Bridge over dark water',
        location_type: 'slick bridge',
        present_npcs: [],
        present_objects: ['dark water', 'bridge support', 'bridge rail'],
        available_exits: ['far bank'],
      },
    }),
    characterSheet: armoredSheet,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet: armoredSheet,
    rollDie: sequenceRolls([20]),
  });

  assert.match(resolved.reply, /under control/);
  assert.equal(resolved.worldState.hazard_state.status, 'in_water_under_control');
  assert.match(resolved.worldState.scene_presence.exact_location, /dark water below Lantern Bridge/);
});

test('condition modes are stored on pending checks and saves for the server roller', () => {
  const poisonedCheck = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, conditions: ['poisoned'] } }),
    characterSheet,
  });
  const restrainedSave = adjudicate({
    message: 'I dodge the falling stones with a dex save.',
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, conditions: ['restrained'] } }),
    characterSheet,
  });

  assert.equal(poisonedCheck.worldState.pending_roll.advantage_mode, 'disadvantage');
  assert.match(poisonedCheck.reply, /Roll with disadvantage/);
  assert.equal(restrainedSave.worldState.pending_roll.advantage_mode, 'disadvantage');
  assert.match(restrainedSave.reply, /Restrained condition/);
});

test('species save advantages enter the authoritative pending-roll pipeline', () => {
  const result = adjudicate({
    message: 'I resist the spell with a wisdom save.',
    worldState: worldState(),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'gnome' },
    },
  });

  assert.equal(result.worldState.pending_roll.advantage_mode, 'advantage');
  assert.deepEqual(result.worldState.pending_roll.advantage_sources, ['Gnomish Cunning']);
  assert.match(result.reply, /Gnomish Cunning/);
});

test('Dragonborn Breath Weapon resolves through the referee and leaves the turn open', () => {
  const result = adjudicate({
    message: 'Use Breath Weapon on the Cultist.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 8, max_hp: 8, ac: 12, is_player: false, conditions: [], saves: { dex: 0 }, attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'dragonborn' },
      species_choices: { draconic_ancestry: 'blue' },
    },
    rollDie: sequenceRolls([4, 7]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 1);
  assert.equal(result.worldState.player_stats.resources.breath_weapon.remaining, 1);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /7 lightning damage/);
  assert.match(result.reply, /Your turn remains open/);
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

test('DC assessment reacts to scene pressure and favorable evidence', () => {
  const guardedSocial = adjudicate({
    message: 'I politely convince the suspicious clerk to let me inside.',
    worldState: worldState({
      npc_states: {
        clerk: { attitude: 'suspicious' },
      },
    }),
    characterSheet,
  });
  const obviousEvidence = adjudicate({
    message: 'I inspect the obvious clue on the open ledger.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'town hall steps',
        present_npcs: ['clerk'],
        present_objects: ['open ledger', 'obvious clue'],
        available_exits: ['square'],
      },
    }),
    characterSheet,
  });

  assert.equal(guardedSocial.worldState.pending_roll.dc, 20);
  assert.match(guardedSocial.worldState.pending_roll.dc_source, /target resistance or fear/);
  assert.equal(obviousEvidence.worldState.pending_roll.dc, 10);
  assert.match(obviousEvidence.worldState.pending_roll.dc_source, /straightforward evidence/);
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

test('Tactical Mind can turn a failed ability check into a success and spends Second Wind only then', () => {
  const fighter = {
    ...characterSheet,
    identity: { ...characterSheet.identity, class: 'fighter', class_name: 'Fighter', level: 2 },
    resources: {
      second_wind: { name: 'Second Wind', remaining: 2, max: 2, reset: 'long_rest', recover_on_short_rest: 1 },
    },
  };
  const failed = adjudicate({
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
        success_result: 'You read the clerk clearly.',
      },
    }),
    characterSheet: fighter,
    rollDie: sequenceRolls([5]),
  });
  const used = adjudicate({
    message: 'Use Tactical Mind.',
    worldState: failed.worldState,
    characterSheet: fighter,
    rollDie: sequenceRolls([8]),
  });

  assert.equal(failed.handled, true);
  assert.equal(failed.worldState.pending_roll, null);
  assert.equal(failed.worldState.pending_tactical_mind.pending.id, 'roll_test');
  assert.match(failed.reply, /Tactical Mind is available/);
  assert.equal(used.worldState.pending_tactical_mind, null);
  assert.equal(used.worldState.player_stats.resources.second_wind.remaining, 1);
  assert.match(used.reply, /Revised total 15 vs DC 15: \*\*success\*\*/);
  assert.match(used.reply, /You read the clerk clearly/);
});

test('Tactical Mind does not spend Second Wind when the bonus still fails', () => {
  const fighter = {
    ...characterSheet,
    identity: { ...characterSheet.identity, class: 'fighter', class_name: 'Fighter', level: 2 },
    resources: {
      second_wind: { name: 'Second Wind', remaining: 2, max: 2, reset: 'long_rest', recover_on_short_rest: 1 },
    },
  };
  const failed = adjudicate({
    message: '[ROLL REQUEST: roll_test]',
    worldState: worldState({
      pending_roll: {
        id: 'roll_test',
        kind: 'ability_check',
        ability: 'str',
        label: 'Strength Check',
        modifier: 3,
        dc: 20,
        failure_result: 'The gate does not budge.',
      },
    }),
    characterSheet: fighter,
    rollDie: sequenceRolls([5]),
  });
  const used = adjudicate({
    message: 'Use Tactical Mind.',
    worldState: failed.worldState,
    characterSheet: fighter,
    rollDie: sequenceRolls([3]),
  });

  assert.equal(used.worldState.player_stats.resources.second_wind.remaining, 2);
  assert.match(used.reply, /still fails/);
  assert.match(used.reply, /No Second Wind use is spent/);
  assert.match(used.reply, /gate does not budge/);
});

test('declining Tactical Mind applies the original failed result without spending Second Wind', () => {
  const fighter = {
    ...characterSheet,
    identity: { ...characterSheet.identity, class: 'fighter', class_name: 'Fighter', level: 2 },
    resources: {
      second_wind: { name: 'Second Wind', remaining: 2, max: 2, reset: 'long_rest', recover_on_short_rest: 1 },
    },
  };
  const failed = adjudicate({
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
    characterSheet: fighter,
    rollDie: sequenceRolls([5]),
  });
  const declined = adjudicate({
    message: 'Decline Tactical Mind.',
    worldState: failed.worldState,
    characterSheet: fighter,
  });

  assert.equal(declined.worldState.pending_tactical_mind, null);
  assert.equal(declined.worldState.player_stats.resources, undefined);
  assert.match(declined.reply, /Roll 7 .* vs DC 15: \*\*failure\*\*/);
  assert.match(declined.reply, /clerk keeps his motive/);
});

test('plain-language Tactical Mind decline does not accidentally spend the feature', () => {
  const fighter = {
    ...characterSheet,
    identity: { ...characterSheet.identity, class: 'fighter', class_name: 'Fighter', level: 2 },
    resources: {
      second_wind: { name: 'Second Wind', remaining: 2, max: 2, reset: 'long_rest', recover_on_short_rest: 1 },
    },
  };
  const failed = adjudicate({
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
    characterSheet: fighter,
    rollDie: sequenceRolls([5]),
  });
  const declined = adjudicate({
    message: "Don't use Tactical Mind.",
    worldState: failed.worldState,
    characterSheet: fighter,
  });

  assert.equal(declined.worldState.pending_tactical_mind, null);
  assert.equal(declined.worldState.player_stats.resources, undefined);
  assert.match(declined.reply, /clerk keeps his motive/);
});

test('spends Heroic Inspiration to reroll a failed pending d20 test', () => {
  const prompt = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        resources: {
          heroic_inspiration: { name: 'Heroic Inspiration', remaining: 1, max: 1 },
        },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'human' },
      features: [
        { source: 'species', name: 'Resourceful', description: 'Gain Heroic Inspiration whenever you finish a Long Rest.' },
      ],
    },
    currentTurn: 4,
  });
  const primed = adjudicate({
    message: 'Use heroic inspiration.',
    worldState: prompt.worldState,
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'human' },
      features: [
        { source: 'species', name: 'Resourceful', description: 'Gain Heroic Inspiration whenever you finish a Long Rest.' },
      ],
    },
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${primed.worldState.pending_roll.id}]`,
    worldState: primed.worldState,
    characterSheet,
    rollDie: sequenceRolls([4, 16]),
  });

  assert.equal(primed.worldState.player_stats.resources.heroic_inspiration.remaining, 0);
  assert.equal(result.handled, true);
  assert.match(result.reply, /Heroic Inspiration reroll 4->16/);
  assert.match(result.reply, /\*\*success\*\*/);
});

test('Halfling Luck automatically rerolls a natural 1 on a pending d20 test', () => {
  const prompt = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState(),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'halfling' },
    },
    currentTurn: 4,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([1, 14]),
  });

  assert.equal(result.handled, true);
  assert.match(result.reply, /Halfling Luck rerolled 1->14/);
  assert.match(result.reply, /\*\*success\*\*/);
});

test('Halfling Luck applies to initiative rolls', () => {
  const prompt = adjudicate({
    message: 'I attack the hooded stranger.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'gate',
        present_npcs: ['hooded stranger'],
        present_objects: [],
        available_exits: [],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'halfling' },
    },
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'halfling' },
    },
    rollDie: sequenceRolls([1, 14, 10]),
  });

  assert.equal(prompt.worldState.pending_roll.kind, 'initiative');
  assert.match(result.reply, /Halfling Luck rerolled 1->14/);
  assert.match(result.reply, /Sir Testalot \(15\).*Hooded Stranger \(11\)/);
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

test('level 2 Rogue uses Cunning Action to Hide as a Bonus Action', () => {
  const result = adjudicate({
    message: 'I take the Hide action.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Quickstep', hp: 10, max_hp: 10, ac: 15, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Quickstep', class: 'rogue', class_name: 'Rogue', level: 2 },
    },
    currentTurn: 5,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.skill, 'stealth');
  assert.equal(result.worldState.pending_roll.consumes, 'bonus_action');
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.match(result.reply, /Cunning Action/);
});

test('natural bonus-action hide wording routes to Cunning Action instead of object interaction', () => {
  const result = adjudicate({
    message: 'I use my bonus action to hide behind the bridge support.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Lantern Bridge',
        present_npcs: [],
        present_objects: ['bridge support'],
        available_exits: ['bridge span'],
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Quickstep', hp: 10, max_hp: 10, ac: 15, is_player: true },
          { name: 'Dark Shape', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Quickstep', class: 'rogue', class_name: 'Rogue', level: 2 },
    },
    currentTurn: 5,
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'referee_pending_roll');
  assert.equal(result.worldState.pending_roll.skill, 'stealth');
  assert.equal(result.worldState.pending_roll.consumes, 'bonus_action');
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.match(result.reply, /Cunning Action/);
  assert.doesNotMatch(result.reply, /Utilize/);
});

test('explicit weapon attack with an on-hit feature beats carried-object Utilize routing', () => {
  const result = adjudicate({
    message: 'I make a melee weapon attack at the dark shape with my Longsword and use Divine Smite if the attack hits.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Lantern Bridge',
        present_npcs: ['Dark Shape'],
        present_objects: [],
        available_exits: ['bridge span'],
      },
      inventory_state: {
        carried_objects: [{ name: 'Longsword', quantity: 1 }],
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Brightward', hp: 18, max_hp: 18, ac: 19, is_player: true },
          { name: 'Dark Shape', hp: 20, max_hp: 20, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Brightward', class: 'paladin', class_name: 'Paladin', level: 2 },
      equipped: { main_hand: 'longsword', off_hand: 'shield', armor: 'chain_mail' },
      resources: {
        paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
      },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [{
          weapon_id: 'longsword',
          name: 'Longsword',
          attack_total: 5,
          damage_formula: '1d8+3',
          damage_type: 'slashing',
          properties: ['versatile'],
        }],
      },
    },
    rollDie: (sides) => (sides === 20 ? 10 : 4),
  });

  assert.equal(result.handled, true);
  assert.match(result.reply, /attack Dark Shape with Longsword/i);
  assert.doesNotMatch(result.reply, /Utilize/);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
});

test('Cunning Action Hide wording wins over a same-message ready clause', () => {
  const result = adjudicate({
    message: 'I use Cunning Action to Hide behind the bridge support and ready my shortsword if anything approaches.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Lantern Bridge',
        present_npcs: [],
        present_objects: ['bridge support'],
        available_exits: ['bridge span'],
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Quickstep', hp: 10, max_hp: 10, ac: 15, is_player: true },
          { name: 'Dark Shape', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Quickstep', class: 'rogue', class_name: 'Rogue', level: 2 },
    },
    currentTurn: 5,
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'referee_pending_roll');
  assert.equal(result.worldState.pending_roll.skill, 'stealth');
  assert.equal(result.worldState.pending_roll.consumes, 'bonus_action');
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.readied_action, undefined);
  assert.match(result.reply, /Cunning Action/);
});

test('explicit Cunning Action Hide reports the Bonus Action as spent instead of the Action', () => {
  const result = adjudicate({
    message: 'I use Cunning Action to Hide again.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        turn_resources: {
          actor: 'player',
          action_available: false,
          bonus_action_available: false,
          reaction_available: true,
          movement_remaining: 30,
          used: [
            { resource: 'bonus_action', label: 'Cunning Action: Dash' },
            { resource: 'action', label: 'Disengage' },
          ],
        },
        combatants: [
          { name: 'Quickstep', hp: 10, max_hp: 10, ac: 15, is_player: true },
          { name: 'Dark Shape', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Quickstep', class: 'rogue', class_name: 'Rogue', level: 2 },
    },
    currentTurn: 5,
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'referee_action_unavailable');
  assert.match(result.reply, /Bonus Action is already spent/);
  assert.doesNotMatch(result.reply, /Your Action is already spent/);
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

test('level 2 Barbarian Danger Sense grants Dexterity saving throw advantage', () => {
  const result = adjudicate({
    message: 'I dive away from the falling rocks.',
    worldState: worldState(),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ragna', class: 'barbarian', class_name: 'Barbarian', level: 2 },
    },
    currentTurn: 6,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'saving_throw');
  assert.equal(result.worldState.pending_roll.advantage_mode, 'advantage');
  assert(result.worldState.pending_roll.advantage_sources.includes('Danger Sense'));
  assert.match(result.reply, /advantage from Danger Sense/);
});

test('active item bonuses change pending skill checks and saving throws', () => {
  const stealth = adjudicate({
    message: 'I hide behind the rain barrel.',
    worldState: worldState({
      active_effects: [
        { id: 'equipment_cloak_of_quiet_steps', name: 'Cloak of Quiet Steps', rules_effects: [{ target: 'skill_check_bonus', skill: 'stealth', value: 2, label: 'Cloak of Quiet Steps' }] },
      ],
    }),
    characterSheet,
  });
  const save = adjudicate({
    message: 'I dive away from the falling rocks.',
    worldState: worldState({
      active_effects: [
        { id: 'equipment_ring_of_sure_feet', name: 'Ring of Sure Feet', rules_effects: [{ target: 'saving_throw_bonus', ability: 'dex', value: 1, label: 'Ring of Sure Feet' }] },
      ],
    }),
    characterSheet,
  });

  assert.equal(stealth.worldState.pending_roll.modifier, 5);
  assert.match(stealth.worldState.pending_roll.modifier_breakdown, /Cloak of Quiet Steps \+2/);
  assert.equal(save.worldState.pending_roll.modifier, 4);
  assert.match(save.worldState.pending_roll.modifier_breakdown, /Ring of Sure Feet \+1/);
});

test('Exhaustion changes referee pending check and save modifiers', () => {
  const check = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, conditions: ['exhaustion_2'] } }),
    characterSheet,
  });
  const save = adjudicate({
    message: 'I dive away from the falling rocks.',
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, exhaustion_level: 2 } }),
    characterSheet,
  });

  assert.equal(check.worldState.pending_roll.modifier, 0);
  assert.match(check.worldState.pending_roll.modifier_breakdown, /Exhaustion level 2 -4/);
  assert.equal(save.worldState.pending_roll.modifier, -1);
  assert.match(save.worldState.pending_roll.modifier_breakdown, /Exhaustion level 2 -4/);
});

test('Deafened blocks hearing-dependent referee checks before rolling', () => {
  const listen = adjudicate({
    message: 'I listen for footsteps behind the door.',
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, conditions: ['deafened'] } }),
    characterSheet,
  });
  const look = adjudicate({
    message: 'I look around the square for tracks.',
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, conditions: ['deafened'] } }),
    characterSheet,
  });

  assert.equal(listen.worldState.pending_roll, null);
  assert.match(listen.reply, /Deafened condition makes that hearing-dependent Wisdom \(Perception\) automatically fail/);
  assert.notEqual(look.worldState.pending_roll.advantage_mode, 'disadvantage');
});

test('Blinded blocks sight-dependent referee checks before rolling', () => {
  const read = adjudicate({
    message: 'I inspect the writing on the wall.',
    worldState: worldState({ player_stats: { hp: 12, max_hp: 12, armor_class: 16, conditions: ['blinded'] } }),
    characterSheet,
  });

  assert.equal(read.handled, true);
  assert.equal(read.worldState.pending_roll, null);
  assert.match(read.reply, /Blinded condition makes that sight-dependent Intelligence \(Investigation\) automatically fail/);
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
    worldState: worldState({
      scene_presence: {
        exact_location: 'town gate',
        present_npcs: ['hooded stranger'],
        present_objects: ['muddy road'],
      },
    }),
    characterSheet,
    currentTurn: 8,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.kind, 'initiative');
  assert.equal(result.worldState.pending_roll.created_turn, 8);
  assert.match(result.reply, /Combat begins/);
  assert.match(result.reply, /\[ROLL: id=.* 1d20\+1\]/);
});

test('starts unarmed combat without folding a Tavern Brawler push rider into the target name', () => {
  const result = adjudicate({
    message: 'Punch the cultist and push him back.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'town square',
        present_npcs: ['cultist'],
        present_objects: [],
        available_exits: ['gate'],
      },
    }),
    characterSheet: {
      ...characterSheet,
      origin: { background_feat: 'tavern_brawler' },
    },
  });

  assert.equal(result.worldState.pending_roll.kind, 'initiative');
  assert.equal(result.worldState.pending_roll.enemy.name, 'Cultist');
});

test('combat starter preserves explicit hostile target instead of falling back to scene NPCs', () => {
  const result = adjudicate({
    message: 'I draw my longsword and attack a hostile shadow emerging from the tree line.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'inn overhang',
        present_npcs: ['sealed-parchment guards (2)', 'reeve', 'hostile shadow'],
        present_objects: ['sealed parchment'],
        available_exits: ['tree line'],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll.enemy.name, 'Hostile Shadow');
});

test('blocks combat against absent service NPCs before initiative starts', () => {
  const result = adjudicate({
    message: 'I attack the innkeeper.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        present_npcs: ['older gate guard', 'younger gate guard'],
        present_objects: ['palisade gate'],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.match(result.reply, /innkeeper is not here/);
});

test('uses person-friendly wording for absent combat targets near a matching location', () => {
  const result = adjudicate({
    message: 'I attack the innkeeper.',
    worldState: worldState({
      scene_presence: {
        exact_location: "Mason's Rest, tavern eaves and square entrance",
        location_type: 'tavern exterior',
        present_npcs: ['ink-stained man'],
        present_objects: ['tavern door'],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.match(result.reply, /innkeeper is not here/);
  assert.match(result.reply, /look for them/);
  assert.doesNotMatch(result.reply, /look around for it/);
});

test('blocks invented hostile targets that are not established in the scene', () => {
  const result = adjudicate({
    message: 'I attack a hostile shadow emerging from the tree line.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        present_npcs: ['older gate guard', 'younger gate guard'],
        present_objects: ['palisade gate'],
        available_exits: ['tree line'],
      },
    }),
    characterSheet,
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.pending_roll, null);
  assert.match(result.reply, /hostile shadow is not here/);
});

test('drawing a weapon alone does not conjure combat', () => {
  const result = adjudicate({
    message: 'I draw my longsword.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        present_npcs: ['older gate guard', 'younger gate guard'],
        present_objects: ['palisade gate'],
      },
    }),
    characterSheet,
  });

  assert.equal(result, null);
});

test('throw verbs without a known weapon do not become weapon attacks', () => {
  const result = adjudicate({
    message: 'I throw the cultist over the table.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false },
        ],
      },
    }),
    characterSheet,
  });

  assert.equal(result.logType, 'referee_combat_action_needed');
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

test('asks for distance before resolving movement while combat is active', () => {
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
  assert.match(result.reply, /Say how far you want to move in feet/);
});

test('combat movement through the referee provokes an Opportunity Attack before moving', () => {
  const result = adjudicate({
    message: 'I move 10 feet away from the wolf.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          {
            name: 'Wolf',
            hp: 8,
            max_hp: 8,
            ac: 12,
            is_player: false,
            attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d4+1' },
          },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([14, 3]),
  });
  const wolf = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Wolf');

  assert.equal(result.worldState.player_stats.hp, 8);
  assert.equal(result.worldState.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(wolf.reaction_available, false);
  assert.match(result.reply, /Opportunity Attack/);
});

test('Disengage leaves the turn open for movement without Opportunity Attacks', () => {
  const result = adjudicate({
    message: 'I Disengage and sprint 20 feet away.',
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

  assert.equal(result.worldState.combat_state.round, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.disengaged, true);
  assert.equal(result.worldState.combat_state.turn_resources.movement_remaining, 10);
  assert.doesNotMatch(result.reply, /Opportunity Attack:/);
});

test('Dash leaves the turn open with extra movement equal to Speed', () => {
  const result = adjudicate({
    message: 'I Dash.',
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

  assert.equal(result.worldState.combat_state.round, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.movement_remaining, 60);
  assert.match(result.reply, /gain 30 feet of movement/);
});

test('Opportunity Attack damage prompts a concentration save after movement resolves', () => {
  const result = adjudicate({
    message: 'I move 10 feet away from the wolf.',
    worldState: worldState({
      active_effects: [
        { id: 'shield_of_faith', name: 'Shield of Faith', concentration: true },
      ],
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          {
            name: 'Wolf',
            hp: 8,
            max_hp: 8,
            ac: 12,
            is_player: false,
            attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d4+1' },
          },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([14, 3]),
  });

  assert.equal(result.worldState.pending_roll.kind, 'concentration_save');
  assert.equal(result.worldState.pending_roll.dc, 10);
  assert.match(result.reply, /Concentration is at risk from Wolf/);
});

test('retaliation that drops the last Opportunity Attacker ends combat immediately', () => {
  const result = adjudicate({
    message: 'I move 10 feet away from the wolf.',
    worldState: worldState({
      player_stats: { hp: 12, max_hp: 12, temp_hp: 5, armor_class: 16 },
      active_effects: [
        {
          id: 'armor_of_agathys',
          name: 'Armor of Agathys',
          rules_effects: [
            { target: 'temp_hp', value: 5, label: 'Armor of Agathys' },
            { target: 'melee_retaliation_damage', value: 5, damage_type: 'cold', label: 'Armor of Agathys' },
          ],
        },
      ],
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, temp_hp: 5, ac: 16, is_player: true },
          {
            name: 'Wolf',
            hp: 5,
            max_hp: 8,
            ac: 12,
            is_player: false,
            attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d4+1' },
          },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([14, 3]),
  });

  assert.equal(result.worldState.combat_state, null);
  assert.match(result.reply, /Armor of Agathys lashes back for 5 cold damage/);
  assert.match(result.reply, /Combat ends/);
});

test('ending a turn advances enemies and resets their Reactions at the start of their turns', () => {
  const result = adjudicate({
    message: 'End my turn.',
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
          movement_remaining: 20,
          used: [{ resource: 'movement', label: 'combat movement', feet: 10 }],
        },
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          {
            name: 'Wolf',
            hp: 8,
            max_hp: 8,
            ac: 12,
            is_player: false,
            reaction_available: false,
            attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d4+1' },
          },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([1]),
  });
  const wolf = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Wolf');

  assert.equal(result.worldState.combat_state.round, 2);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(wolf.reaction_available, true);
  assert.match(result.reply, /You end your turn/);
  assert.match(result.reply, /Round 2 begins\. It is your turn/);
});

test('Attack leaves movement and Bonus Action available until the player ends the turn', () => {
  const attacked = adjudicate({
    message: 'Attack the wolf with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Wolf', hp: 20, max_hp: 20, ac: 12, is_player: false, attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([12, 4]),
  });
  const moved = adjudicate({
    message: 'I move 10 feet toward the wolf.',
    worldState: attacked.worldState,
    characterSheet,
  });
  const ended = adjudicate({
    message: 'End my turn.',
    worldState: moved.worldState,
    characterSheet,
    rollDie: sequenceRolls([1]),
  });

  assert.equal(attacked.worldState.combat_state.round, 1);
  assert.equal(attacked.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(attacked.worldState.combat_state.turn_resources.bonus_action_available, true);
  assert.equal(moved.worldState.combat_state.turn_resources.movement_remaining, 20);
  assert.equal(ended.worldState.combat_state.round, 2);
  assert.match(attacked.reply, /Your turn remains open/);
  assert.match(ended.reply, /Wolf uses bite/);
});

test("Paladin Divine Smite rides a weapon hit and spends the free use before slots", () => {
  const paladin = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'paladin', class_name: 'Paladin', level: 2 },
    resources: {
      paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
    },
    spellcasting: {
      ability: 'cha',
      always_prepared_spells: ['divine_smite'],
      slots: { 1: 2 },
    },
  };
  const result = adjudicate({
    message: 'I attack the Cultist with my longsword and use Divine Smite.',
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        spell_slots: { 1: 2 },
        resources: {
          paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Cultist', hp: 40, max_hp: 40, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: paladin,
    rollDie: sequenceRolls([12, 4, 5, 6]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 22);
  assert.equal(result.worldState.player_stats.resources.paladins_smite.remaining, 0);
  assert.equal(result.worldState.player_stats.spell_slots[1], 2);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.match(result.reply, /Divine Smite/);
  assert.match(result.reply, /free Paladin's Smite use/);
});

test('Paladin Divine Smite spends nothing when the declared weapon attack misses', () => {
  const paladin = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'paladin', class_name: 'Paladin', level: 2 },
    resources: {
      paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
    },
    spellcasting: { ability: 'cha', always_prepared_spells: ['divine_smite'], slots: { 1: 2 } },
  };
  const result = adjudicate({
    message: 'I attack the Cultist with my longsword and use Divine Smite.',
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        spell_slots: { 1: 2 },
        resources: {
          paladins_smite: { name: "Paladin's Smite", remaining: 1, max: 1, reset: 'long_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Cultist', hp: 40, max_hp: 40, ac: 30, is_player: false },
        ],
      },
    }),
    characterSheet: paladin,
    rollDie: sequenceRolls([1]),
  });

  assert.equal(result.worldState.player_stats.resources.paladins_smite.remaining, 1);
  assert.equal(result.worldState.player_stats.spell_slots[1], 2);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, true);
  assert.match(result.reply, /no weapon hit occurred/);
});

test('level 2 Barbarian Reckless Attack grants attack advantage and exposes return attacks', () => {
  const barbarian = {
    ...characterSheet,
    identity: { name: 'Ragna', class: 'barbarian', class_name: 'Barbarian', level: 2 },
    derived_stats: { ...characterSheet.derived_stats, hp: 16, max_hp: 16, armor_class: 14 },
  };
  const attacked = adjudicate({
    message: 'I attack recklessly with my longsword.',
    worldState: worldState({
      player_stats: { hp: 16, max_hp: 16, armor_class: 14 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ragna', hp: 16, max_hp: 16, ac: 14, is_player: true },
          { name: 'Wolf', hp: 20, max_hp: 20, ac: 12, is_player: false, attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: barbarian,
    rollDie: sequenceRolls([2, 15, 4]),
  });
  const recklessPlayer = attacked.worldState.combat_state.combatants.find((combatant) => combatant.is_player);
  const ended = adjudicate({
    message: 'End my turn.',
    worldState: attacked.worldState,
    characterSheet: barbarian,
    rollDie: sequenceRolls([3, 16, 4]),
  });
  const nextPlayer = ended.worldState.combat_state.combatants.find((combatant) => combatant.is_player);

  assert.match(attacked.reply, /advantage from Reckless Attack/);
  assert.match(attacked.reply, /attacks against you have Advantage/);
  assert(recklessPlayer.conditions.includes('reckless_attack'));
  assert.match(ended.reply, /Wolf uses bite/);
  assert.match(ended.reply, /advantage: Reckless Attack target/);
  assert(!nextPlayer.conditions.includes('reckless_attack'));
});

test('a player can use a Bonus Action class feature after attacking', () => {
  const barbarian = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'barbarian', class_name: 'Barbarian', level: 1 },
    derived_stats: { ...characterSheet.derived_stats, hp: 14, max_hp: 14, armor_class: 14 },
  };
  const attacked = adjudicate({
    message: 'Attack the wolf with my longsword.',
    worldState: worldState({
      player_stats: { hp: 14, max_hp: 14, armor_class: 14 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 14, max_hp: 14, ac: 14, is_player: true },
          { name: 'Wolf', hp: 20, max_hp: 20, ac: 12, is_player: false, attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: barbarian,
    rollDie: sequenceRolls([12, 4]),
  });
  const raged = adjudicate({
    message: 'I enter Rage.',
    worldState: attacked.worldState,
    characterSheet: barbarian,
  });

  assert.equal(raged.worldState.combat_state.round, 1);
  assert.equal(raged.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(raged.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(raged.worldState.active_effects.some((effect) => effect.id === 'rage'), true);
  assert.doesNotMatch(raged.reply, /Wolf uses/);
});

test('the socket spell continuation seam keeps an action spell turn open', () => {
  const continued = finishPlayerCombatAction({
    result: {
      handled: true,
      logType: 'spell_attack',
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
            used: [{ resource: 'action', label: 'Fire Bolt' }],
          },
          combatants: [
            { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
            { name: 'Wolf', hp: 8, max_hp: 8, ac: 12, is_player: false },
          ],
        },
      }),
      reply: 'You cast **Fire Bolt**.',
    },
    characterSheet,
  });

  assert.equal(continued.worldState.combat_state.round, 1);
  assert.equal(continued.worldState.combat_state.turn_resources.action_available, false);
  assert.equal(continued.worldState.combat_state.turn_resources.bonus_action_available, true);
  assert.match(continued.reply, /Your turn remains open/);
});

test('Dodge persists until end turn and applies to creature attacks', () => {
  const dodged = adjudicate({
    message: 'I Dodge.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Wolf', hp: 8, max_hp: 8, ac: 12, is_player: false, attack: { name: 'bite', attack_bonus: 4, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet,
  });
  const ended = adjudicate({
    message: 'End my turn.',
    worldState: dodged.worldState,
    characterSheet,
    rollDie: sequenceRolls([18, 2]),
  });

  assert.equal(dodged.worldState.combat_state.round, 1);
  assert.equal(dodged.worldState.combat_state.turn_resources.dodging, true);
  assert.equal(ended.worldState.player_stats.hp, 12);
  assert.equal(ended.worldState.combat_state.turn_resources.dodging, undefined);
  assert.match(ended.reply, /disadvantage: Dodge/);
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

test('resolved combat skill checks leave the remainder of the player turn open', () => {
  const prompted = adjudicate({
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
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompted.worldState.pending_roll.id}]`,
    worldState: prompted.worldState,
    characterSheet,
    rollDie: sequenceRolls([15]),
  });

  assert.equal(resolved.worldState.pending_roll, null);
  assert.equal(resolved.worldState.combat_state.round, 1);
  assert.equal(resolved.worldState.combat_state.turn_resources.action_available, false);
  assert.match(resolved.reply, /Your turn remains open/);
  assert.doesNotMatch(resolved.reply, /Goblin uses/);
});

test('combat object interactions spend the Utilize action and update object state', () => {
  const result = adjudicate({
    message: 'Open the torn satchel.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        location_type: 'gate',
        present_npcs: ['Goblin'],
        present_objects: ['torn satchel'],
        available_exits: ['town square'],
        nearby_locations: [],
      },
      object_states: {},
      inventory_state: { carried_objects: [] },
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
  });

  assert.equal(result.handled, true);
  assert.equal(result.logType, 'referee_combat_object_interaction');
  assert.equal(result.worldState.object_states.torn_satchel.is_open, true);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /Utilize/);
  assert.match(result.reply, /Your turn remains open/);
});

test('locked objects create a Thieves Tools pending check and unlock on success', () => {
  const rogueSheet = {
    ...characterSheet,
    abilities: { modifiers: { ...characterSheet.abilities.modifiers, dex: 3 } },
    proficiencies: { tools: ['thieves_tools'] },
    derived_stats: { ...characterSheet.derived_stats, proficiency_bonus: 2 },
  };
  const prompted = adjudicate({
    message: 'Pick the lock on the iron chest.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        location_type: 'gate',
        present_npcs: [],
        present_objects: ['iron chest'],
        available_exits: ['town square'],
        nearby_locations: [],
      },
      object_states: {
        iron_chest: { name: 'iron chest', present: true, locked: true, lock_dc: 17 },
      },
    }),
    characterSheet: rogueSheet,
    currentTurn: 11,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompted.worldState.pending_roll.id}]`,
    worldState: prompted.worldState,
    characterSheet: rogueSheet,
    rollDie: sequenceRolls([12]),
  });

  assert.equal(prompted.logType, 'referee_object_challenge_pending');
  assert.equal(prompted.worldState.pending_roll.kind, 'ability_check');
  assert.equal(prompted.worldState.pending_roll.object_challenge_type, 'lock');
  assert.equal(prompted.worldState.pending_roll.dc, 17);
  assert.equal(prompted.worldState.pending_roll.modifier, 5);
  assert.match(prompted.reply, /Thieves' Tools/);
  assert.equal(resolved.worldState.object_states.iron_chest.locked, false);
  assert.equal(resolved.worldState.object_states.iron_chest.unlocked, true);
  assert.match(resolved.reply, /now unlocked/);
});

test('combat trap disarm spends Utilize and updates trap state on success', () => {
  const rogueSheet = {
    ...characterSheet,
    abilities: { modifiers: { ...characterSheet.abilities.modifiers, dex: 3 } },
    proficiencies: { tools: ['thieves_tools'] },
    derived_stats: { ...characterSheet.derived_stats, proficiency_bonus: 2 },
  };
  const prompted = adjudicate({
    message: 'Disarm the trap on the iron chest.',
    worldState: worldState({
      scene_presence: {
        exact_location: 'Morrowgate town gate',
        location_type: 'gate',
        present_npcs: ['Goblin'],
        present_objects: ['iron chest'],
        available_exits: ['town square'],
        nearby_locations: [],
      },
      object_states: {
        iron_chest: { name: 'iron chest', present: true, trap: { armed: true, known: true, dc: 16 } },
      },
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
    characterSheet: rogueSheet,
  });
  const resolved = adjudicate({
    message: `[ROLL REQUEST: ${prompted.worldState.pending_roll.id}]`,
    worldState: prompted.worldState,
    characterSheet: rogueSheet,
    rollDie: sequenceRolls([14]),
  });

  assert.equal(prompted.worldState.pending_roll.object_challenge_type, 'trap');
  assert.equal(prompted.worldState.pending_roll.modifier, 5);
  assert.equal(prompted.worldState.combat_state.turn_resources.action_available, false);
  assert.match(prompted.reply, /Utilize/);
  assert.equal(resolved.worldState.object_states.iron_chest.trap.armed, false);
  assert.equal(resolved.worldState.object_states.iron_chest.trap.disarmed, true);
  assert.equal(resolved.worldState.combat_state.round, 1);
  assert.match(resolved.reply, /trap is disarmed/);
  assert.match(resolved.reply, /Your turn remains open/);
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

test('shove is handled as an Attack action option with target save', () => {
  const shoved = adjudicate({
    message: 'I try to shove the hostile wolf away from the reeve with my shield.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 2,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Hostile Guard', hp: 11, max_hp: 11, ac: 14, is_player: false, saves: { str: 3, dex: 1 } },
          { name: 'Hostile Wolf', hp: 5, max_hp: 8, ac: 12, is_player: false, saves: { str: 0, dex: 1 } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
      },
    },
    rollDie: sequenceRolls([4]),
  });
  const result = adjudicate({
    message: 'End my turn.',
    worldState: shoved.worldState,
    characterSheet,
    rollDie: sequenceRolls([2, 2]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(shoved.worldState.combat_state.turn_resources.action_available, false);
  assert.match(shoved.reply, /Shove/);
  assert.match(shoved.reply, /against Hostile Wolf/);
  assert.match(shoved.reply, /DEX save: 4\+1 = 5 vs DC 13/);
  assert.match(shoved.reply, /Hostile Wolf is shoved 5 feet/);
  assert.match(result.reply, /Hostile Wolf uses attack/);
});

test('shove can knock a target prone and affect its next attack', () => {
  const shoved = adjudicate({
    message: 'I shove the goblin prone.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false, saves: { str: 0, dex: 0 } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
      },
    },
    rollDie: sequenceRolls([3]),
  });
  const result = adjudicate({
    message: 'End my turn.',
    worldState: shoved.worldState,
    characterSheet,
    rollDie: sequenceRolls([12, 6]),
  });

  const goblin = shoved.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');
  assert.equal(result.handled, true);
  assert.equal(goblin.conditions.includes('prone'), true);
  assert.match(shoved.reply, /knocked \*\*prone\*\*/);
  assert.match(result.reply, /disadvantage: Prone on attacker/);
});

test('grapple is handled as an Attack action option and tracks escape DC', () => {
  const result = adjudicate({
    message: 'I grab the cultist before he can run.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true },
          { name: 'Cultist', hp: 7, max_hp: 7, ac: 12, is_player: false, saves: { str: 0, dex: 1 } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
      },
    },
    rollDie: sequenceRolls([4, 2]),
  });

  const cultist = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Cultist');
  assert.equal(result.handled, true);
  assert.equal(cultist.conditions.includes('grappled'), true);
  assert.equal(cultist.grapple_escape_dc, 13);
  assert.equal(cultist.grappled_by, 'player');
  assert.match(result.reply, /Grapple/);
  assert.match(result.reply, /DEX save: 4\+1 = 5 vs DC 13/);
});

test('Unarmed Fighting damages one player-grappled creature at the start of the next player turn', () => {
  const fighter = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'fighter', level: 1 },
    class_choices: { fighting_style: 'unarmed_fighting' },
    abilities: { modifiers: { str: 3, dex: 1 } },
    derived_stats: {
      ...characterSheet.derived_stats,
      proficiency_bonus: 2,
    },
  };
  const grappled = adjudicate({
    message: 'I grapple the cultist.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 20, is_player: true },
          { name: 'Cultist', hp: 3, max_hp: 3, ac: 12, is_player: false, saves: { str: 0, dex: 0 }, attack: { name: 'dagger', attack_bonus: 0, damage_formula: '1d4' } },
        ],
      },
    }),
    characterSheet: fighter,
    rollDie: sequenceRolls([4]),
  });
  const result = adjudicate({
    message: 'End my turn.',
    worldState: grappled.worldState,
    characterSheet: fighter,
    rollDie: sequenceRolls([1, 3]),
  });

  assert.equal(result.worldState.combat_state, null);
  assert.match(result.reply, /Unarmed Fighting/);
  assert.match(result.reply, /Cultist: \(3 -> 0 HP\)/);
  assert.match(result.reply, /Combat ends/);
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

test('Halfling Luck rerolls a natural 1 death save before death-save failure rules apply', () => {
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
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'halfling' },
    },
    currentTurn: 12,
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'halfling' },
    },
    rollDie: sequenceRolls([1, 12]),
  });

  assert.equal(result.worldState.player_stats.death_saves.successes, 1);
  assert.equal(result.worldState.player_stats.death_saves.failures, 0);
  assert.match(result.reply, /Halfling Luck rerolled 1->12/);
  assert.doesNotMatch(result.reply, /Natural 1 counts as two failures/);
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
  assert.match(damaged.reply, new RegExp(`\\[SAVE: id=${damaged.worldState.pending_roll.id} ability=con`));
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

test('Guidance adds a bonus die only to its chosen skill and persists for the duration', () => {
  const guidance = {
    id: 'guidance',
    name: 'Guidance',
    concentration: true,
    remaining_rounds: 10,
    rules_effects: [{ target: 'ability_check_bonus_die', die: '1d4', label: 'Guidance (stealth)', skill: 'stealth' }],
  };
  const prompt = adjudicate({
    message: 'I hide behind the overturned table.',
    worldState: worldState({
      active_effects: [guidance],
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
  });
  const result = adjudicate({
    message: `[ROLL REQUEST: ${prompt.worldState.pending_roll.id}]`,
    worldState: prompt.worldState,
    characterSheet,
    rollDie: sequenceRolls([12, 2]),
  });

  assert.equal(prompt.worldState.pending_roll.bonus_die, '1d4');
  assert.match(prompt.reply, /bonus_die=1d4/);
  assert.deepEqual(result.worldState.active_effects.map((effect) => effect.id), ['guidance']);

  const otherSkillPrompt = adjudicate({
    message: "I study the clerk's face.",
    worldState: worldState({ active_effects: [guidance] }),
    characterSheet,
  });
  assert.equal(otherSkillPrompt.worldState.pending_roll.bonus_die, null);
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

test('Elf Trance completes a long rest in four hours', () => {
  const result = adjudicate({
    message: 'I take a long rest using Trance.',
    worldState: worldState({ time_state: { elapsed_minutes: 30 } }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'elf' },
    },
  });

  assert.equal(result.worldState.time_state.elapsed_minutes, 270);
  assert.match(result.reply, /4 hours of Trance/);
});

test('Halfling Naturally Stealthy records a Hide permission behind a larger creature', () => {
  const result = adjudicate({
    message: 'I hide behind the Ogre.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        turn_resources: { action_available: true, bonus_action_available: true, movement_remaining: 30 },
        combatants: [
          { name: 'Sir Testalot', hp: 12, max_hp: 12, ac: 16, is_player: true, size: 'small' },
          { name: 'Ogre', hp: 30, max_hp: 30, ac: 11, is_player: false, size: 'large' },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'halfling' },
    },
  });

  assert.equal(result.worldState.pending_roll.species_hide_permission, 'Naturally Stealthy');
  assert.match(result.reply, /Naturally Stealthy/);
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

test('level 2 Warlock short rest restores the full two-slot Pact Magic pool', () => {
  const result = adjudicate({
    message: 'We take a short rest.',
    worldState: worldState({
      player_stats: {
        hp: 10,
        max_hp: 10,
        armor_class: 14,
        spell_slots: { 1: 0 },
        spell_slots_max: { 1: 2 },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Vex', class: 'warlock', class_name: 'Warlock', level: 2 },
      derived_stats: { ...characterSheet.derived_stats, hp: 10, max_hp: 10, armor_class: 14 },
      spellcasting: { ability: 'cha', slots: { 1: 0 }, slots_max: { 1: 2 } },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.spell_slots[1], 2);
});

test('long rest grants Human Resourceful Heroic Inspiration', () => {
  const result = adjudicate({
    message: 'We take a long rest.',
    worldState: worldState({
      player_stats: {
        hp: 3,
        max_hp: 12,
        armor_class: 16,
        resources: {
          heroic_inspiration: { name: 'Heroic Inspiration', remaining: 0, max: 1 },
        },
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, species: 'human', class: 'fighter', class_name: 'Fighter', level: 1 },
      features: [
        { source: 'species', name: 'Resourceful', description: 'Gain Heroic Inspiration whenever you finish a Long Rest.' },
      ],
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.heroic_inspiration.remaining, 1);
  assert.match(result.reply, /Human Resourceful grants Heroic Inspiration/);
});

test('class feature bonus actions resolve during combat without ending the player turn', () => {
  const result = adjudicate({
    message: 'I enter Rage.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 14, max_hp: 14, ac: 14, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'barbarian', class_name: 'Barbarian', level: 1 },
      derived_stats: { ...characterSheet.derived_stats, hp: 14, max_hp: 14, armor_class: 14 },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.combat_state.round, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.active_effects[0].id, 'rage');
  assert.doesNotMatch(result.reply, /Goblin uses/);
});

test('Arcane Recovery restores an expended level 1 wizard slot during a short rest', () => {
  const result = adjudicate({
    message: 'We take a short rest.',
    worldState: worldState({
      player_stats: {
        hp: 8,
        max_hp: 8,
        armor_class: 12,
        spell_slots: { 1: 0 },
        resources: {
          arcane_recovery: { name: 'Arcane Recovery', remaining: 1, max: 1, reset: 'long_rest' },
        },
      },
    }),
    characterSheet: {
      identity: { name: 'Mira', class: 'wizard', class_name: 'Wizard', level: 1 },
      derived_stats: { hp: 8, max_hp: 8, armor_class: 12 },
      spellcasting: { ability: 'int', slots: { 1: 2 } },
      resources: {},
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.spell_slots[1], 1);
  assert.equal(result.worldState.player_stats.resources.arcane_recovery.remaining, 0);
  assert.match(result.reply, /Arcane Recovery restores one expended level 1 spell slot/);
});

test('rogue Sneak Attack adds damage when a finesse attack has advantage', () => {
  const result = adjudicate({
    message: 'I attack the goblin.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 10, max_hp: 10, ac: 14, is_player: true },
          { name: 'Goblin', hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: ['guiding_bolt_advantage'], attack: { name: 'scimitar', attack_bonus: 3, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 1 },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', attack_total: 5, damage_formula: '1d6 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([12, 5, 4, 3, 2]),
  });

  const goblin = result.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');
  assert.equal(result.handled, true);
  assert.equal(goblin.hp, 10);
  assert.match(result.reply, /Sneak Attack 1d6=3/);
});

test('Champion rolls Initiative and Strength Athletics with Remarkable Athlete Advantage', () => {
  const champion = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'fighter', class_name: 'Fighter', level: 3, subclass: 'champion' },
    derived_stats: {
      ...characterSheet.derived_stats,
      skill_modifiers: {
        ...characterSheet.derived_stats.skill_modifiers,
        athletics: { total: 5, ability: 'str', proficient: true },
      },
    },
  };
  const initiative = adjudicate({
    message: 'I attack the guard.',
    worldState: worldState({ scene_presence: { present_npcs: ['guard'], present_objects: [], available_exits: [] } }),
    characterSheet: champion,
  });
  const athletics = adjudicate({
    message: 'I climb the slick wall beside the gate.',
    worldState: worldState({ scene_presence: { exact_location: 'slick gate wall', present_npcs: [], present_objects: ['wall'], available_exits: [] } }),
    characterSheet: champion,
  });

  assert.equal(initiative.worldState.pending_roll.advantage_mode, 'advantage');
  assert(initiative.worldState.pending_roll.advantage_sources.includes('Remarkable Athlete'));
  assert.equal(athletics.worldState.pending_roll.advantage_mode, 'advantage');
  assert(athletics.worldState.pending_roll.advantage_sources.includes('Remarkable Athlete'));
});

test('Champion weapon attack scores a Critical Hit on natural 19 and grants protected movement', () => {
  const result = adjudicate({
    message: 'I attack the goblin with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 20, max_hp: 20, ac: 18, is_player: true },
          { name: 'Goblin', hp: 30, max_hp: 30, ac: 30, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'fighter', class_name: 'Fighter', level: 3, subclass: 'champion' },
      derived_stats: {
        ...characterSheet.derived_stats,
        speed: 30,
        attack_breakdowns: [{ weapon_id: 'longsword', name: 'Longsword', attack_total: 5, damage_formula: '1d8+3' }],
      },
    },
    rollDie: sequenceRolls([19, 4, 4]),
  });

  assert.match(result.reply, /Critical hit/);
  assert.match(result.reply, /Remarkable Athlete/);
  assert.equal(result.worldState.combat_state.turn_resources.remarkable_athlete_movement_remaining, 15);
});

test('level 3 Rogue Steady Aim grants one advantaged attack with 2d6 Sneak Attack', () => {
  const rogue = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 3, subclass: 'thief' },
    derived_stats: {
      ...characterSheet.derived_stats,
      speed: 30,
      attack_breakdowns: [{ weapon_id: 'shortsword', name: 'Shortsword', attack_total: 5, damage_formula: '1d6+3' }],
    },
  };
  const aimed = adjudicate({
    message: 'I use Steady Aim.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 17, max_hp: 17, ac: 14, is_player: true },
          { name: 'Goblin', hp: 30, max_hp: 30, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: rogue,
  });
  const attacked = adjudicate({
    message: 'I attack the goblin with my shortsword.',
    worldState: aimed.worldState,
    characterSheet: rogue,
    rollDie: sequenceRolls([5, 15, 4, 2, 3]),
  });

  assert.match(attacked.reply, /advantage from Steady Aim/i);
  assert.match(attacked.reply, /Sneak Attack 2d6=5/);
  assert.equal(attacked.worldState.combat_state.turn_resources.steady_aim, false);
  assert.equal(attacked.worldState.combat_state.turn_resources.sneak_attack_used, true);
});

test('Thief Fast Hands uses the Bonus Action for a combat lock check', () => {
  const thief = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 3, subclass: 'thief' },
    abilities: { modifiers: { ...characterSheet.abilities.modifiers, dex: 3 } },
    proficiencies: { tools: ['thieves_tools'] },
    derived_stats: { ...characterSheet.derived_stats, proficiency_bonus: 2 },
  };
  const result = adjudicate({
    message: 'I pick the lock on the iron chest.',
    worldState: worldState({
      scene_presence: { exact_location: 'gate', present_npcs: ['Goblin'], present_objects: ['iron chest'], available_exits: [] },
      object_states: { iron_chest: { name: 'iron chest', present: true, locked: true, lock_dc: 15 } },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 17, max_hp: 17, ac: 14, is_player: true },
          { name: 'Goblin', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: thief,
  });

  assert.equal(result.worldState.pending_roll.consumes, 'bonus_action');
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.match(result.reply, /Fast Hands/);
});

test("Thief Fast Hands recognizes natural possessive pickpocket wording", () => {
  const thief = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 3, subclass: 'thief' },
    abilities: { modifiers: { ...characterSheet.abilities.modifiers, dex: 3 } },
    proficiencies: { skills: ['sleight_of_hand'] },
    derived_stats: { ...characterSheet.derived_stats, proficiency_bonus: 2 },
  };
  const result = adjudicate({
    message: "I pick the guard's pocket.",
    worldState: worldState({
      scene_presence: { exact_location: 'gate', present_npcs: ['Guard'], present_objects: [], available_exits: [] },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 17, max_hp: 17, ac: 14, is_player: true },
          { name: 'Guard', hp: 11, max_hp: 11, ac: 16, is_player: false },
        ],
      },
    }),
    characterSheet: thief,
  });

  assert.equal(result.worldState.pending_roll.skill, 'sleight_of_hand');
  assert.equal(result.worldState.pending_roll.consumes, 'bonus_action');
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.match(result.reply, /Fast Hands/);
});

test('Thief Second-Story Work handles ordinary climbing but keeps hazardous climbs gated', () => {
  const thief = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 3, subclass: 'thief' },
    derived_stats: { ...characterSheet.derived_stats, speed: 30, climb_speed: 30, jump_ability: 'dex' },
  };
  const ordinary = adjudicate({
    message: 'I climb the stone wall.',
    worldState: worldState({ current_location: 'courtyard', scene_presence: { exact_location: 'courtyard', present_objects: ['stone wall'] } }),
    characterSheet: thief,
  });
  const hazardous = adjudicate({
    message: 'I climb the slick stone wall in heavy rain.',
    worldState: worldState({ current_location: 'courtyard', scene_presence: { exact_location: 'courtyard', present_objects: ['slick stone wall'] } }),
    characterSheet: thief,
  });

  assert.equal(ordinary.worldState.pending_roll, null);
  assert.match(ordinary.reply, /Second-Story Work/);
  assert.match(ordinary.reply, /without an Athletics check/);
  assert.equal(hazardous.worldState.pending_roll.skill, 'athletics');
});

test('Thief Second-Story Work uses Dexterity for a hazardous jump check', () => {
  const thief = {
    ...characterSheet,
    identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 3, subclass: 'thief' },
    abilities: { modifiers: { ...characterSheet.abilities.modifiers, str: 0, dex: 3 } },
    proficiencies: { skills: ['athletics'] },
    derived_stats: { ...characterSheet.derived_stats, proficiency_bonus: 2, jump_ability: 'dex' },
  };
  const result = adjudicate({
    message: 'I jump over the rope on the slick floor.',
    worldState: worldState({ current_location: 'ruined hall' }),
    characterSheet: thief,
  });

  assert.equal(result.worldState.pending_roll.ability, 'dex');
  assert.equal(result.worldState.pending_roll.skill, 'athletics');
  assert.equal(result.worldState.pending_roll.modifier, 3);
  assert.match(result.reply, /Dexterity \(Athletics\)/);
});

test('Tavern Brawler unarmed strike rerolls damage die results of 1 and records a requested push', () => {
  const result = adjudicate({
    message: 'Punch the Cultist and push him back.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 12, max_hp: 12, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      origin: { background_feat: 'tavern_brawler' },
    },
    rollDie: sequenceRolls([10, 1, 3, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 6);
  assert.deepEqual(cultist.forced_movement, { feet: 5, direction: 'away_from_player', source: 'Tavern Brawler' });
  assert.match(result.reply, /Unarmed Strike/);
  assert.match(result.reply, /Tavern Brawler/);
});

test('Savage Attacker uses the better of two weapon damage rolls', () => {
  const result = adjudicate({
    message: 'Attack the Cultist.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      origin: { background_feat: 'savage_attacker' },
    },
    rollDie: sequenceRolls([10, 2, 7, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 10);
  assert.match(result.reply, /Savage Attacker rolled weapon damage twice \(5\/10\) and used 10/);
});

test('Lucky can be spent explicitly on an immediate weapon attack roll', () => {
  const result = adjudicate({
    message: 'Attack the Cultist using Lucky.',
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        resources: {
          luck_points: { name: 'Luck Points', remaining: 2, max: 2, reset: 'long_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      origin: { background_feat: 'lucky' },
    },
    rollDie: sequenceRolls([2, 15, 4, 1]),
  });

  assert.equal(result.worldState.player_stats.resources.luck_points.remaining, 1);
  assert.match(result.reply, /advantage from Lucky/);
  assert.match(result.reply, /Lucky spends 1 Luck Point/);
});

test('selected Graze mastery applies through the referee attack loop on a miss', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my greatsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 8, max_hp: 8, ac: 20, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      weapon_masteries: [{ weapon_id: 'greatsword', mastery: 'graze' }],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'greatsword', name: 'Greatsword', ability: 'str', attack_total: 5, damage_formula: '2d6+3' },
        ],
      },
    },
    rollDie: sequenceRolls([2, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 5);
  assert.match(result.reply, /Graze mastery/);
});

test('selected Sap mastery gives the enemy next attack disadvantage and then clears', () => {
  const attacked = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      weapon_masteries: [{ weapon_id: 'longsword', mastery: 'sap' }],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 3]),
  });
  const result = adjudicate({
    message: 'End my turn.',
    worldState: attacked.worldState,
    characterSheet,
    rollDie: sequenceRolls([18, 2]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.conditions.includes('sapped'), false);
  assert.match(attacked.reply, /Sap mastery/);
  assert.match(result.reply, /disadvantage: Sapped on attacker/);
});

test('Dueling Fighting Style adds one-handed melee damage through the referee loop', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      class_choices: { fighting_style: 'dueling' },
      equipped: { main_hand: 'longsword', off_hand: 'shield' },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 11);
  assert.match(result.reply, /Dueling \+2/);
});

test('Great Weapon Fighting raises low melee weapon damage dice through the referee loop', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my greatsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      class_choices: { fighting_style: 'great_weapon_fighting' },
      equipped: { main_hand: 'greatsword', off_hand: null },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'greatsword', name: 'Greatsword', ability: 'str', attack_total: 5, damage_formula: '2d6+3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 1, 2, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 11);
  assert.match(result.reply, /Great Weapon Fighting treats low weapon damage die rolls as 3 \(1, 2 -> 3, 3\)/);
});

test('Archery Fighting Style updates older ranged sheets during referee attack resolution', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longbow.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 14, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      abilities: {
        final_scores: { str: 10, dex: 14 },
        modifiers: { str: 0, dex: 2 },
      },
      class_choices: { fighting_style: 'archery' },
      equipped: { main_hand: 'longbow', off_hand: null },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longbow', name: 'Longbow', ability: 'dex', attack_total: 4, damage_formula: '1d8+1' },
        ],
      },
    },
    rollDie: sequenceRolls([8, 4, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 15);
  assert.match(result.reply, /Attack roll: 14 \(natural 8; 8\+6=14\) vs AC 14/);
});

test('Blind Fighting ignores nearby sight-based attack disadvantage', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: ['blinded'], position: { map_id: 'crypt', q: 0, r: 0 } },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 14, is_player: false, conditions: ['invisible', 'hidden'], position: { map_id: 'crypt', q: 1, r: 0 }, attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      class_choices: { fighting_style: 'blind_fighting' },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([9, 2, 4]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 15);
  assert.match(result.reply, /Blind Fighting lets you treat that sight-blocking target within 10 feet as seen/);
  assert.doesNotMatch(result.reply, /Attack roll has disadvantage/);
  assert.match(result.reply, /Attack roll: 14 \(natural 9; 9\+5=14\) vs AC 14/);
});

test('active weapon attack bonuses change referee attack rolls', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      active_effects: [
        { id: 'equipment_longsword_plus_1', name: 'Longsword +1', source_type: 'equipment', source_item_id: 'longsword_plus_1', rules_effects: [{ target: 'weapon_attack_bonus', value: 1, label: 'Longsword +1' }] },
      ],
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 11, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([5, 4]),
  });

  assert.match(result.reply, /Attack roll: 11 \(natural 5; 5\+6=11\) vs AC 11/);
  assert.match(result.reply, /Active attack bonus: Longsword \+1 \+1/);
});

test('runtime equipment effects do not double-count magic already baked into weapon sheets', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      active_effects: [
        { id: 'equipment_longsword_plus_1', name: 'Longsword +1', source_type: 'equipment', source_item_id: 'longsword_plus_1', rules_effects: [{ target: 'weapon_attack_bonus', value: 1, label: 'Longsword +1' }, { target: 'weapon_damage_bonus', value: 1, label: 'Longsword +1' }] },
      ],
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          {
            weapon_id: 'longsword_plus_1',
            name: 'Longsword +1',
            ability: 'str',
            attack_total: 6,
            damage_formula: '1d8+4',
            attack_parts: [{ label: 'Weapon magic', value: 1 }],
            damage_parts: [{ label: 'Weapon magic', value: 1 }],
          },
        ],
      },
    },
    rollDie: sequenceRolls([6, 4]),
  });

  assert.match(result.reply, /Attack roll: 12 \(natural 6; 6\+6=12\) vs AC 12/);
  assert.doesNotMatch(result.reply, /Active attack bonus/);
  assert.match(result.reply, /Hit for 8 damage/);
});

test('Exhaustion applies to referee weapon attacks', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: ['exhaustion_2'] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 12, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8+3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4]),
  });

  assert.match(result.reply, /Attack roll: 11 \(natural 10; 10\+1=11\) vs AC 12/);
  assert.match(result.reply, /Condition modifier: Exhaustion level 2 -4/);
  assert.match(result.reply, /Miss/);
});

test('declared paired Light weapons resolve a Nick extra attack inside the Attack action', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my shortsword and dagger.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 10, max_hp: 10, ac: 14, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 30, max_hp: 30, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 1 },
      abilities: { modifiers: { str: 0, dex: 3 } },
      equipped: { main_hand: 'shortsword', off_hand: 'dagger' },
      weapon_masteries: [{ weapon_id: 'dagger', mastery: 'nick' }],
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
          { weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 5, damage_formula: '1d4 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 10, 3, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 20);
  assert.match(result.reply, /Nick mastery/);
  assert.match(result.reply, /extra attack.*Dagger/i);
});

test('level 2 Monk spends Focus for Flurry of Blows without consuming the Action', () => {
  const monkSheet = {
    identity: { name: 'QA Monk', class: 'monk', class_name: 'Monk', level: 2 },
    abilities: {
      modifiers: { str: 1, dex: 4, con: 2, wis: 2 },
    },
    derived_stats: {
      hp: 20,
      max_hp: 20,
      armor_class: 16,
      proficiency_bonus: 2,
      speed: 40,
    },
    resources: {
      focus_points: { name: 'Focus Points', remaining: 2, max: 2, reset: 'short_rest' },
    },
  };
  const result = adjudicate({
    message: 'I use Flurry of Blows on the Goblin.',
    worldState: worldState({
      player_stats: {
        hp: 20,
        max_hp: 20,
        armor_class: 16,
        resources: {
          focus_points: { name: 'Focus Points', remaining: 2, max: 2, reset: 'short_rest' },
        },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        turn_resources: {
          action_available: true,
          bonus_action_available: true,
          reaction_available: true,
          movement_remaining: 40,
          used: [],
        },
        combatants: [
          { name: 'QA Monk', hp: 20, max_hp: 20, ac: 16, is_player: true },
          { name: 'Goblin', hp: 20, max_hp: 20, ac: 12, is_player: false },
        ],
      },
    }),
    characterSheet: monkSheet,
    rollDie: sequenceRolls([12, 4, 13, 5]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.focus_points.remaining, 1);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, true);
  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, false);
  assert.match(result.reply, /Flurry strike 1/);
  assert.match(result.reply, /Flurry strike 2/);
});

test('Two-Weapon Fighting restores the ability modifier and spends the Light extra attack Bonus Action', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with both weapons.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Fia', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 30, max_hp: 30, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Fia', class: 'fighter', class_name: 'Fighter', level: 1 },
      abilities: { modifiers: { str: 0, dex: 3 } },
      class_choices: { fighting_style: 'two_weapon_fighting' },
      equipped: { main_hand: 'shortsword', off_hand: 'dagger' },
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
          { weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 5, damage_formula: '1d4 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 10, 3, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 17);
  assert.match(result.reply, /spend your Bonus Action/);
  assert.match(result.reply, /Extra attack hits for 6 damage/);
});

test('Savage Attacker does not repeat on a Light extra attack after the primary hit uses it', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with both weapons.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 10, max_hp: 10, ac: 14, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 30, max_hp: 30, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'rogue', class_name: 'Rogue', level: 1 },
      origin: { background_feat: 'savage_attacker' },
      abilities: { modifiers: { str: 0, dex: 3 } },
      equipped: { main_hand: 'shortsword', off_hand: 'dagger' },
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
          { weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 5, damage_formula: '1d4 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 2, 5, 10, 4, 1]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 18);
  assert.equal((result.reply.match(/Savage Attacker rolled weapon damage twice/g) || []).length, 1);
});

test('declared weapon name selects the matching calculated attack instead of the first sheet entry', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my dagger.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 10, max_hp: 10, ac: 14, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      abilities: { modifiers: { str: 0, dex: 3 } },
      equipped: { main_hand: 'shortsword', off_hand: 'dagger' },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
          { weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 5, damage_formula: '1d4 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 1]),
  });

  assert.match(result.reply, /attack Cultist with Dagger/);
  assert.match(result.reply, /Hit for 7 damage/);
});

test('dropping one enemy does not end combat while another enemy remains', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Sir Testalot', initiative: 18, hp: 12, max_hp: 12, ac: 16, is_player: true, conditions: [] },
          { name: 'Cultist', initiative: 8, hp: 4, max_hp: 4, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
          { name: 'Guard', initiative: 6, hp: 8, max_hp: 8, ac: 12, is_player: false, conditions: [], attack: { name: 'spear', attack_bonus: 2, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet,
    rollDie: sequenceRolls([10, 4, 1]),
  });

  assert.equal(result.worldState.combat_state.active, true);
  assert.match(result.reply, /Cultist falls/);
  assert.doesNotMatch(result.reply, /Combat ends/);
});

test('selected Cleave mastery attacks the declared second creature with weapon damage only', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my greataxe and cleave the Guard.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 14, is_player: true, conditions: [] },
          { name: 'Guard', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false, conditions: [], attack: { name: 'spear', attack_bonus: 2, damage_formula: '1d6+1' } },
          { name: 'Cultist', initiative: 6, hp: 20, max_hp: 20, ac: 10, is_player: false, conditions: [], attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'barbarian', class_name: 'Barbarian', level: 1 },
      abilities: { modifiers: { str: 3, dex: 1 } },
      equipped: { main_hand: 'greataxe', off_hand: null },
      weapon_masteries: [{ weapon_id: 'greataxe', mastery: 'cleave' }],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'greataxe', name: 'Greataxe', ability: 'str', attack_total: 5, damage_formula: '1d12 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 8, 10, 6, 1, 1]),
  });
  const guard = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Guard');
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 9);
  assert.equal(guard.hp, 14);
  assert.match(result.reply, /Cleave mastery/);
  assert.match(result.reply, /Cleave attack hits for 6 damage/);
  assert.match(result.reply, /Map coordinates are not active/);
});

test('Cleave refuses a declared second target outside reach when map coordinates exist', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my greataxe and cleave the Guard.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 14, is_player: true, conditions: [], position: { map_id: 'crypt', q: 0, r: 0 } },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false, conditions: [], position: { map_id: 'crypt', q: 1, r: 0 }, attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
          { name: 'Guard', initiative: 6, hp: 20, max_hp: 20, ac: 10, is_player: false, conditions: [], position: { map_id: 'crypt', q: 2, r: 0 }, attack: { name: 'spear', attack_bonus: 2, damage_formula: '1d6+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      abilities: { modifiers: { str: 3, dex: 1 } },
      equipped: { main_hand: 'greataxe', off_hand: null },
      weapon_masteries: [{ weapon_id: 'greataxe', mastery: 'cleave' }],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'greataxe', name: 'Greataxe', ability: 'str', attack_total: 5, damage_formula: '1d12 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 8, 1, 1]),
  });
  const guard = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Guard');

  assert.equal(guard.hp, 20);
  assert.match(result.reply, /within 5 feet of the first creature and within your weapon reach/);
});

test('referee blocks a two-handed weapon attack while the character carries a shield', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my greatsword.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true, position: { map_id: 'crypt', q: 0, r: 0 } },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false, position: { map_id: 'crypt', q: 1, r: 0 } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      equipped: { main_hand: 'greatsword', off_hand: 'shield' },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'greatsword', name: 'Greatsword', ability: 'str', attack_total: 5, damage_formula: '2d6 + 3' },
        ],
      },
    },
  });

  assert.equal(result.logType, 'referee_weapon_attack_unavailable');
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /requires two hands/);
});

test('referee routes a declared javelin throw through ranged long-range disadvantage', () => {
  const result = adjudicate({
    message: 'I attack the Cultist by throwing my javelin.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true, position: { map_id: 'crypt', q: 0, r: 0 } },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 30, is_player: false, position: { map_id: 'crypt', q: 8, r: 0 }, attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      equipped: { main_hand: 'javelin', off_hand: null },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'javelin', name: 'Javelin', ability: 'str', attack_total: 5, damage_formula: '1d6 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([18, 4, 1]),
  });

  assert.match(result.reply, /disadvantage from Long range/);
  assert.match(result.reply, /Attack roll: 9 \(natural 4; 18\/4 with disadvantage, using 4\+5=9\)/);
});

test('Thrown Weapon Fighting can draw and throw a carried weapon from inventory', () => {
  const result = adjudicate({
    message: 'I throw my handaxe at the Cultist.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false, attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { name: 'Ari', class: 'fighter', class_name: 'Fighter', level: 1 },
      abilities: { modifiers: { str: 3, dex: 1 } },
      class_choices: { fighting_style: 'thrown_weapon_fighting' },
      equipped: { main_hand: 'longsword', off_hand: null },
      inventory: [
        { id: 'longsword', name: 'Longsword', type: 'weapon', quantity: 1 },
        { id: 'handaxe', name: 'Handaxe', type: 'weapon', quantity: 1 },
      ],
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4]),
  });
  const cultist = result.worldState.combat_state.combatants.find((entry) => entry.name === 'Cultist');

  assert.equal(cultist.hp, 11);
  assert.equal(result.worldState.player_stats.thrown_weapons.handaxe.remaining, 0);
  assert.equal(result.worldState.player_stats.thrown_weapons_spent_since_recovery.handaxe, 1);
  assert.match(result.reply, /Thrown Weapon Fighting.*draw Handaxe/);
  assert.match(result.reply, /Thrown Weapon Fighting \+2/);
});

test('tracked thrown weapons cannot be thrown again until recovered', () => {
  const result = adjudicate({
    message: 'I throw my handaxe at the Cultist.',
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        thrown_weapons: { handaxe: { id: 'handaxe', name: 'Handaxe', remaining: 0 } },
        thrown_weapons_spent_since_recovery: { handaxe: 1 },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      class_choices: { fighting_style: 'thrown_weapon_fighting' },
      equipped: { main_hand: 'longsword', off_hand: null },
      inventory: [
        { id: 'longsword', name: 'Longsword', type: 'weapon', quantity: 1 },
        { id: 'handaxe', name: 'Handaxe', type: 'weapon', quantity: 1 },
      ],
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8 + 3' },
        ],
      },
    },
  });

  assert.equal(result.logType, 'referee_weapon_attack_unavailable');
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /no Handaxe ready to throw/);
});

test('Thrown Weapon Fighting cannot draw a carried weapon when both hands are occupied', () => {
  const result = adjudicate({
    message: 'I throw my handaxe at the Cultist.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 18, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      class_choices: { fighting_style: 'thrown_weapon_fighting' },
      equipped: { main_hand: 'longsword', off_hand: 'shield' },
      inventory: [
        { id: 'longsword', name: 'Longsword', type: 'weapon', quantity: 1 },
        { id: 'shield', name: 'Shield', type: 'shield', quantity: 1 },
        { id: 'handaxe', name: 'Handaxe', type: 'weapon', quantity: 1 },
      ],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8 + 3' },
        ],
      },
    },
  });

  assert.equal(result.logType, 'referee_weapon_attack_unavailable');
  assert.match(result.reply, /free hand/);
});

test('referee spends ammunition when a ranged weapon attack misses', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longbow.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 30, is_player: false, attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      equipped: { main_hand: 'longbow', off_hand: null },
      inventory: [{ id: 'arrows', name: 'Arrows', type: 'ammunition', quantity: 20 }],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longbow', name: 'Longbow', ability: 'dex', attack_total: 5, damage_formula: '1d8 + 1' },
        ],
      },
    },
    rollDie: sequenceRolls([2, 1]),
  });

  assert.equal(result.worldState.player_stats.ammunition.arrows.remaining, 19);
  assert.equal(result.worldState.player_stats.ammunition_spent_since_recovery.arrows, 1);
  assert.match(result.reply, /Ammunition.*19 Arrows remain/);
});

test('referee blocks an empty ranged weapon without spending the player turn', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my longbow.',
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        ammunition: { arrows: { id: 'arrows', name: 'Arrows', remaining: 0 } },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 20, max_hp: 20, ac: 10, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      equipped: { main_hand: 'longbow', off_hand: null },
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'longbow', name: 'Longbow', ability: 'dex', attack_total: 5, damage_formula: '1d8 + 1' },
        ],
      },
    },
  });

  assert.equal(result.logType, 'referee_weapon_attack_unavailable');
  assert.equal(result.worldState.combat_state.turn_resources, undefined);
  assert.match(result.reply, /out of Arrows/);
});

test('referee recovers half of spent ammunition after a one-minute battlefield search', () => {
  const result = adjudicate({
    message: 'I spend 1 minute searching the battlefield for my arrows.',
    worldState: worldState({
      active_effects: [{
        id: 'guidance',
        name: 'Guidance',
        remaining_minutes: 1,
        rules_effects: [],
      }],
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        ammunition: { arrows: { id: 'arrows', name: 'Arrows', remaining: 13 } },
        ammunition_spent_since_recovery: { arrows: 7 },
      },
    }),
    characterSheet,
  });

  assert.equal(result.worldState.player_stats.ammunition.arrows.remaining, 16);
  assert.equal(result.worldState.time_state.elapsed_minutes, 1);
  assert.deepEqual(result.worldState.active_effects, []);
  assert.match(result.reply, /recover 3 arrows/);
  assert.match(result.reply, /Expired effects: Guidance/);
});

test('referee recovers tracked thrown weapons after a one-minute battlefield search', () => {
  const result = adjudicate({
    message: 'I spend 1 minute searching the battlefield for my handaxe.',
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 16,
        thrown_weapons: { handaxe: { id: 'handaxe', name: 'Handaxe', remaining: 0 } },
        thrown_weapons_spent_since_recovery: { handaxe: 1 },
      },
    }),
    characterSheet,
  });

  assert.equal(result.worldState.player_stats.thrown_weapons.handaxe.remaining, 1);
  assert.equal(result.worldState.time_state.elapsed_minutes, 1);
  assert.match(result.reply, /recover 1 handaxe/);
});

test('blocked Light ammunition follow-up leaves the Bonus Action available', () => {
  const result = adjudicate({
    message: 'Attack the Cultist with my shortsword and hand crossbow.',
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 30, max_hp: 30, ac: 10, is_player: false, attack: { name: 'dagger', attack_bonus: 2, damage_formula: '1d4+1' } },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      equipped: { main_hand: 'shortsword', off_hand: 'hand_crossbow' },
      inventory: [{ id: 'bolts', name: 'Bolts', type: 'ammunition', quantity: 20 }],
      derived_stats: {
        ...characterSheet.derived_stats,
        attack_breakdowns: [
          { weapon_id: 'shortsword', name: 'Shortsword', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
          { weapon_id: 'hand_crossbow', name: 'Hand Crossbow', ability: 'dex', attack_total: 5, damage_formula: '1d6 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 4, 1]),
  });

  assert.equal(result.worldState.combat_state.turn_resources.bonus_action_available, true);
  assert.match(result.reply, /Light property.*needs a free hand/s);
});

test("declared Fire's Burn applies through the referee attack loop", () => {
  const result = adjudicate({
    message: "Attack the Cultist with my longsword and use Fire's Burn.",
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 8, max_hp: 8, ac: 10, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, name: 'Ari', species: 'goliath' },
      species_choices: { giant_ancestry: 'fire' },
      derived_stats: {
        ...characterSheet.derived_stats,
        proficiency_bonus: 2,
        attack_breakdowns: [
          { weapon_id: 'longsword', name: 'Longsword', ability: 'str', attack_total: 5, damage_formula: '1d8 + 3' },
        ],
      },
    },
    rollDie: sequenceRolls([10, 1, 4]),
  });

  assert.equal(result.worldState.combat_state, null);
  assert.equal(result.worldState.player_stats.resources.giant_ancestry.remaining, 1);
  assert.match(result.reply, /Fire's Burn/);
});

test("declared Fire's Burn on a spell attack stays available to the spell resolver", () => {
  const result = adjudicate({
    message: "I cast Fire Bolt at the Cultist and use Fire's Burn.",
    worldState: worldState({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', initiative: 18, hp: 14, max_hp: 14, ac: 16, is_player: true },
          { name: 'Cultist', initiative: 8, hp: 8, max_hp: 8, ac: 10, is_player: false },
        ],
      },
    }),
    characterSheet: {
      ...characterSheet,
      identity: { ...characterSheet.identity, name: 'Ari', species: 'goliath' },
      species_choices: { giant_ancestry: 'fire' },
    },
  });

  assert.equal(result, null);
});
