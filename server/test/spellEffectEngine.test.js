process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const {
  resolveSpellCast,
  resolveSpellOutcome,
  tickActiveEffects,
  getActiveDamageDice,
} = require('../src/spellEffectEngine');
const { advanceEnemyTurns } = require('../src/refereeCore');

const content = getContentBundle();

function paladinSheet(overrides = {}) {
  const base = {
    identity: { name: 'Ari', level: 1, class: 'paladin', class_name: 'Paladin' },
    derived_stats: {
      armor_class: 18,
      armor_class_breakdown: [
        { label: 'Chain Mail', value: 16 },
        { label: 'Shield', value: 2 },
      ],
      active_spell_effects: [],
      ...overrides.derived_stats,
    },
    spellcasting: {
      ability: 'cha',
      cantrips_known: [],
      spells_prepared: ['bless', 'shield_of_faith'],
      slots: { 1: 2 },
    },
  };
  return {
    ...base,
    ...overrides,
    derived_stats: {
      ...base.derived_stats,
      ...(overrides.derived_stats || {}),
    },
    spellcasting: {
      ...base.spellcasting,
      ...(overrides.spellcasting || {}),
    },
  };
}

function worldState(overrides = {}) {
  return {
    player_stats: {
      armor_class: 18,
      base_armor_class: 18,
      spell_slots: { 1: 2 },
    },
    active_effects: [],
    time_state: { elapsed_rounds: 0, elapsed_minutes: 0, scene_time: '' },
    ...overrides,
  };
}

function casterSheet(overrides = {}) {
  const base = {
    identity: { name: 'Mira', level: 1, class: 'wizard', class_name: 'Wizard' },
    abilities: { modifiers: { int: 3, cha: 1, wis: 2 } },
    derived_stats: {
      hp: 8,
      max_hp: 8,
      armor_class: 12,
      spell_attack_bonus: 5,
      spell_save_dc: 13,
      active_spell_effects: [],
    },
    spellcasting: {
      ability: 'int',
      cantrips_known: ['fire_bolt'],
      spells_prepared: ['magic_missile', 'shield'],
      slots: { 1: 1 },
    },
  };
  return {
    ...base,
    ...overrides,
    abilities: {
      ...base.abilities,
      ...(overrides.abilities || {}),
      modifiers: {
        ...base.abilities.modifiers,
        ...(overrides.abilities?.modifiers || {}),
      },
    },
    derived_stats: {
      ...base.derived_stats,
      ...(overrides.derived_stats || {}),
    },
    spellcasting: {
      ...base.spellcasting,
      ...(overrides.spellcasting || {}),
    },
  };
}

function combatWorld(overrides = {}) {
  return worldState({
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Mira', hp: 8, max_hp: 8, ac: 12, is_player: true },
        { name: 'Skeleton', hp: 10, max_hp: 10, ac: 12, is_player: false, saves: { dex: 1, con: 1, wis: 0 } },
      ],
    },
    ...overrides,
  });
}

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 1;
}

test('casts Shield of Faith by spending a slot and applying the AC effect', () => {
  const result = resolveSpellCast({
    message: 'I cast Shield of Faith on myself.',
    content,
    characterSheet: paladinSheet(),
    worldState: worldState(),
  });

  assert.equal(result.blocked, false);
  assert.equal(result.characterSheet.spellcasting.slots[1], 1);
  assert.equal(result.characterSheet.derived_stats.armor_class, 20);
  assert.equal(result.worldState.player_stats.armor_class, 20);
  assert.equal(result.worldState.active_effects[0].id, 'shield_of_faith');
  assert.equal(result.worldState.active_effects[0].remaining_rounds, 100);
  assert.equal(result.worldState.active_effects[0].concentration, true);
});

test('Shield of Faith updates combat tracker AC while active and when expired', () => {
  const result = resolveSpellCast({
    message: 'I cast Shield of Faith on myself.',
    content,
    characterSheet: paladinSheet(),
    worldState: worldState({
      player_stats: {
        hp: 12,
        max_hp: 12,
        armor_class: 18,
        base_armor_class: 18,
        spell_slots: { 1: 2 },
      },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Ari', hp: 12, max_hp: 12, ac: 18, is_player: true },
          { name: 'Skeleton', hp: 10, max_hp: 10, ac: 12, is_player: false },
        ],
      },
    }),
  });
  const ticked = tickActiveEffects(result.worldState, { rounds: 100 });

  assert.equal(result.worldState.combat_state.combatants[0].ac, 20);
  assert.equal(ticked.worldState.player_stats.armor_class, 18);
  assert.equal(ticked.worldState.combat_state.combatants[0].ac, 18);
});

test('new concentration spell replaces prior concentration and removes its AC bonus', () => {
  const shield = resolveSpellCast({
    message: 'I cast Shield of Faith.',
    content,
    characterSheet: paladinSheet(),
    worldState: worldState(),
  });
  const bless = resolveSpellCast({
    message: 'I cast Bless.',
    content,
    characterSheet: shield.characterSheet,
    worldState: shield.worldState,
  });

  assert.equal(bless.characterSheet.spellcasting.slots[1], 0);
  assert.deepEqual(bless.worldState.active_effects.map((effect) => effect.id), ['bless']);
  assert.equal(bless.characterSheet.derived_stats.armor_class, 18);
  assert.equal(bless.worldState.player_stats.armor_class, 18);
});

test('blocks class spell when no matching slot remains', () => {
  const result = resolveSpellCast({
    message: 'I cast Bless.',
    content,
    characterSheet: paladinSheet({ spellcasting: { slots: { 1: 0 } } }),
    worldState: worldState({ player_stats: { armor_class: 18, base_armor_class: 18, spell_slots: { 1: 0 } } }),
  });

  assert.equal(result.blocked, true);
  assert.match(result.reply, /do not have a level 1 spell slot left/);
});

test('ticking active effects expires Shield of Faith and restores base AC', () => {
  const shield = resolveSpellCast({
    message: 'I cast Shield of Faith.',
    content,
    characterSheet: paladinSheet(),
    worldState: worldState(),
  });
  const ticked = tickActiveEffects(shield.worldState, { rounds: 100 });

  assert.deepEqual(ticked.expiredEffects.map((effect) => effect.id), ['shield_of_faith']);
  assert.deepEqual(ticked.worldState.active_effects, []);
  assert.equal(ticked.worldState.player_stats.armor_class, 18);
});

test('Magic Missile deals deterministic automatic damage in combat', () => {
  const cast = resolveSpellCast({
    message: 'I cast Magic Missile at the skeleton.',
    content,
    characterSheet: casterSheet(),
    worldState: combatWorld(),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
    rollDie: sequenceRolls([2, 3, 4]),
  });

  assert.equal(cast.characterSheet.spellcasting.slots[1], 0);
  assert.equal(outcome.handled, true);
  assert.equal(outcome.worldState.combat_state, null);
  assert.match(outcome.reply, /hits automatically for 12 force damage/);
});

test('Fire Bolt uses spell attack bonus and can consume a combat turn', () => {
  const cast = resolveSpellCast({
    message: 'I cast Fire Bolt at the skeleton.',
    content,
    characterSheet: casterSheet(),
    worldState: combatWorld(),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
    rollDie: sequenceRolls([12, 5]),
  });
  const target = outcome.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Skeleton');

  assert.equal(cast.characterSheet.spellcasting.slots[1], 1);
  assert.equal(outcome.consumesTurn, true);
  assert.equal(target.hp, 5);
  assert.match(outcome.reply, /12\+5 = 17 vs AC 12/);
});

test('action spell outcome can advance enemy turns through the referee', () => {
  const cast = resolveSpellCast({
    message: 'I cast Fire Bolt at the skeleton.',
    content,
    characterSheet: casterSheet(),
    worldState: combatWorld(),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
    rollDie: sequenceRolls([12, 5]),
  });
  const advanced = advanceEnemyTurns({
    worldState: outcome.worldState,
    characterSheet: cast.characterSheet,
    playerTurnNote: outcome.reply,
    rollDie: sequenceRolls([15, 2]),
  });

  assert.equal(advanced.worldState.combat_state.round, 2);
  assert.equal(advanced.worldState.player_stats.hp, 5);
  assert.match(advanced.reply, /Round 2 begins\. It is your turn/);
});

test('saving throw spell rolls target save against spell DC', () => {
  const sheet = casterSheet({
    identity: { name: 'Mira', level: 1, class: 'cleric', class_name: 'Cleric' },
    abilities: { modifiers: { wis: 3 } },
    derived_stats: { spell_save_dc: 13 },
    spellcasting: {
      ability: 'wis',
      cantrips_known: ['sacred_flame'],
      spells_prepared: [],
      slots: { 1: 1 },
    },
  });
  const cast = resolveSpellCast({
    message: 'I cast Sacred Flame at the skeleton.',
    content,
    characterSheet: sheet,
    worldState: combatWorld(),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
    rollDie: sequenceRolls([5, 7]),
  });
  const target = outcome.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Skeleton');

  assert.equal(target.hp, 3);
  assert.equal(outcome.consumesTurn, true);
  assert.match(outcome.reply, /DEX save: 5\+1 = 6 vs DC 13/);
});

test('Healing Word restores HP and does not consume the combat action', () => {
  const sheet = casterSheet({
    identity: { name: 'Mira', level: 1, class: 'bard', class_name: 'Bard' },
    abilities: { modifiers: { cha: 3 } },
    spellcasting: {
      ability: 'cha',
      cantrips_known: [],
      spells_prepared: ['healing_word'],
      slots: { 1: 1 },
    },
  });
  const cast = resolveSpellCast({
    message: 'I cast Healing Word on myself.',
    content,
    characterSheet: sheet,
    worldState: combatWorld({
      player_stats: { hp: 5, max_hp: 12, armor_class: 12 },
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Mira', hp: 5, max_hp: 12, ac: 12, is_player: true },
          { name: 'Skeleton', hp: 10, max_hp: 10, ac: 12, is_player: false },
        ],
      },
    }),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
    rollDie: sequenceRolls([4, 4]),
  });

  assert.equal(outcome.worldState.player_stats.hp, 12);
  assert.equal(outcome.consumesTurn, false);
  assert.match(outcome.reply, /restore 11 HP/);
});

test('blocks proactive Reaction spell casting before spending a slot', () => {
  const result = resolveSpellCast({
    message: 'I cast Shield.',
    content,
    characterSheet: casterSheet(),
    worldState: combatWorld(),
  });

  assert.equal(result.blocked, true);
  assert.match(result.reply, /Reaction spell/);
});

test('blocks one-minute casting during active combat', () => {
  const result = resolveSpellCast({
    message: 'I cast Mending.',
    content,
    characterSheet: casterSheet({
      spellcasting: {
        cantrips_known: ['mending'],
        spells_prepared: [],
        slots: { 1: 1 },
      },
    }),
    worldState: combatWorld(),
  });

  assert.equal(result.blocked, true);
  assert.match(result.reply, /not a single combat action/);
});

test('Mage Armor raises unarmored AC using the spell formula', () => {
  const sheet = casterSheet({
    abilities: { modifiers: { dex: 2, int: 3 } },
    derived_stats: {
      armor_class: 12,
      base_armor_class: 12,
    },
    spellcasting: {
      cantrips_known: [],
      spells_prepared: ['mage_armor'],
      slots: { 1: 1 },
    },
  });
  const cast = resolveSpellCast({
    message: 'I cast Mage Armor.',
    content,
    characterSheet: sheet,
    worldState: worldState({
      player_stats: { armor_class: 12, base_armor_class: 12, spell_slots: { 1: 1 } },
    }),
  });
  const ticked = tickActiveEffects(cast.worldState, { minutes: 8 * 60 });

  assert.equal(cast.blocked, false);
  assert.equal(cast.worldState.player_stats.armor_class, 15);
  assert.equal(ticked.worldState.player_stats.armor_class, 12);
});

test('Sleep applies the asleep condition when the HP pool covers the target', () => {
  const sheet = casterSheet({
    spellcasting: {
      cantrips_known: [],
      spells_prepared: ['sleep'],
      slots: { 1: 1 },
    },
  });
  const cast = resolveSpellCast({
    message: 'I cast Sleep.',
    content,
    characterSheet: sheet,
    worldState: combatWorld(),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
    rollDie: sequenceRolls([4, 4, 4, 4, 4]),
  });
  const target = outcome.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Skeleton');
  const expired = tickActiveEffects(outcome.worldState, { rounds: 10 });
  const expiredTarget = expired.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Skeleton');

  assert.equal(target.conditions.includes('sleep'), true);
  assert.equal(outcome.worldState.active_effects.some((effect) => effect.id === 'sleep'), true);
  assert.equal(expiredTarget.conditions.includes('sleep'), false);
  assert.match(outcome.reply, /falls \*\*unconscious\*\*/);
});

test('Armor of Agathys grants temporary HP and retaliates when hit', () => {
  const sheet = casterSheet({
    identity: { name: 'Mira', level: 1, class: 'warlock', class_name: 'Warlock' },
    spellcasting: {
      ability: 'cha',
      cantrips_known: [],
      spells_prepared: ['armor_of_agathys'],
      slots: { 1: 1 },
    },
  });
  const cast = resolveSpellCast({
    message: 'I cast Armor of Agathys.',
    content,
    characterSheet: sheet,
    worldState: combatWorld(),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
  });
  const advanced = advanceEnemyTurns({
    worldState: outcome.worldState,
    characterSheet: cast.characterSheet,
    playerTurnNote: outcome.reply,
    rollDie: sequenceRolls([18, 4]),
  });
  const skeleton = advanced.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Skeleton');

  assert.equal(cast.worldState.player_stats.temp_hp, 5);
  assert.equal(advanced.worldState.player_stats.hp, 8);
  assert.equal(advanced.worldState.player_stats.temp_hp, 0);
  assert.equal(skeleton.hp, 5);
  assert.match(advanced.reply, /lashes back for 5 cold damage/);
});

test('non-combat save spells resolve against present scene targets', () => {
  const sheet = casterSheet({
    spellcasting: {
      ability: 'int',
      cantrips_known: [],
      spells_prepared: ['charm_person'],
      slots: { 1: 1 },
    },
  });
  const cast = resolveSpellCast({
    message: 'I cast Charm Person on the clerk.',
    content,
    characterSheet: sheet,
    worldState: worldState({
      scene_presence: {
        exact_location: 'town hall door',
        present_npcs: ['clerk'],
        present_objects: [],
        available_exits: ['square'],
      },
    }),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
    rollDie: sequenceRolls([5]),
  });

  assert.equal(outcome.handled, true);
  assert.equal(outcome.worldState.scene_target_states[0].name, 'clerk');
  assert.equal(outcome.worldState.scene_target_states[0].conditions.includes('charm_person'), true);
  assert.equal(outcome.worldState.active_effects[0].target, 'clerk');
  assert.match(outcome.reply, /WIS save: 5/);
});

test('Sleep distributes its HP pool across multiple eligible enemies', () => {
  const sheet = casterSheet({
    spellcasting: {
      cantrips_known: [],
      spells_prepared: ['sleep'],
      slots: { 1: 1 },
    },
  });
  const cast = resolveSpellCast({
    message: 'I cast Sleep.',
    content,
    characterSheet: sheet,
    worldState: combatWorld({
      combat_state: {
        active: true,
        round: 1,
        turn_index: 0,
        combatants: [
          { name: 'Mira', hp: 8, max_hp: 8, ac: 12, is_player: true },
          { name: 'Goblin', hp: 4, max_hp: 7, ac: 12, is_player: false },
          { name: 'Skeleton', hp: 8, max_hp: 10, ac: 12, is_player: false },
        ],
      },
    }),
  });
  const outcome = resolveSpellOutcome({
    spellCast: cast,
    characterSheet: cast.characterSheet,
    worldState: cast.worldState,
    rollDie: sequenceRolls([3, 3, 3, 3, 3]),
  });
  const goblin = outcome.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Goblin');
  const skeleton = outcome.worldState.combat_state.combatants.find((combatant) => combatant.name === 'Skeleton');

  assert.equal(goblin.conditions.includes('sleep'), true);
  assert.equal(skeleton.conditions.includes('sleep'), true);
  assert.deepEqual(outcome.worldState.active_effects[0].targets.map((target) => target.name), ['Goblin', 'Skeleton']);
});

test('target-bound damage dice only apply to their marked target', () => {
  const markedWorld = worldState({
    active_effects: [{
      id: 'hunter_mark',
      name: "Hunter's Mark",
      target: 'Goblin',
      rules_effects: [{ target: 'weapon_damage_bonus_die', die: '1d6', damage_type: 'force', label: "Hunter's Mark", target_bound: true }],
    }],
  });

  assert.equal(getActiveDamageDice(markedWorld, { name: 'Goblin' }).length, 1);
  assert.equal(getActiveDamageDice(markedWorld, { name: 'Skeleton' }).length, 0);
});
