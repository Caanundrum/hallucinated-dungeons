process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getSavingThrowModifier, resolveRefereeAction } = require('../src/refereeCore');
const { buildResourceState } = require('../src/resourceEngine');

function sheet({ classId, level, subclass = null, choices = {}, features = [] }) {
  return {
    identity: { name: 'Midlevel Test', class: classId, level, ...(subclass ? { subclass } : {}) },
    abilities: {
      modifiers: { str: 2, dex: 3, con: 2, int: 1, wis: 2, cha: 3 },
    },
    derived_stats: {
      level,
      proficiency_bonus: level >= 9 ? 4 : 3,
      hp: 50,
      max_hp: 50,
      armor_class: 16,
      speed: 30,
      skill_modifiers: {
        stealth: { total: 6, ability: 'dex', proficient: true },
        athletics: { total: 2, ability: 'str', proficient: false },
      },
      saving_throw_modifiers: {
        dex: { total: 3, proficient: false },
        wis: { total: 2, proficient: false },
      },
    },
    class_choices: choices,
    features,
    resources: {},
  };
}

function pendingWorld(pending) {
  return {
    current_location: 'test arena',
    player_stats: { hp: 50, max_hp: 50, armor_class: 16 },
    pending_roll: { id: 'midlevel_roll', dc: 15, label: 'test roll', ...pending },
  };
}

test('Reliable Talent treats a proficient skill d20 below 10 as 10', () => {
  const result = resolveRefereeAction({
    message: '[ROLL REQUEST: midlevel_roll]',
    worldState: pendingWorld({ kind: 'skill_check', skill: 'stealth', ability: 'dex', modifier: 6 }),
    characterSheet: sheet({ classId: 'rogue', level: 7 }),
    rollDie: () => 3,
  });

  assert.match(result.reply, /Reliable Talent treats the d20 as 10/);
  assert.match(result.reply, /16/);
});

test('Reliable Talent does not alter an unproficient ability check', () => {
  const result = resolveRefereeAction({
    message: '[ROLL REQUEST: midlevel_roll]',
    worldState: pendingWorld({ kind: 'ability_check', ability: 'str', modifier: 2 }),
    characterSheet: sheet({ classId: 'rogue', level: 7 }),
    rollDie: () => 3,
  });

  assert.doesNotMatch(result.reply, /Reliable Talent/);
  assert.match(result.reply, /5/);
});

test('Aura of Protection adds Charisma to the Paladin saving throw', () => {
  const result = getSavingThrowModifier(sheet({ classId: 'paladin', level: 6 }), 'wis', {});
  assert.equal(result.total, 5);
  assert.match(result.breakdown, /Aura of Protection \+3/);
});

test('Champion Heroic Warrior exposes authoritative Heroic Inspiration', () => {
  const resources = buildResourceState(sheet({ classId: 'fighter', level: 10, subclass: 'champion' }), {});
  assert.deepEqual(resources.heroic_inspiration, {
    name: 'Heroic Inspiration',
    max: 1,
    reset: 'special',
    remaining: 0,
  });
});

test('Indomitable rerolls a failed save, adds Fighter level, and spends one use', () => {
  const fighter = sheet({ classId: 'fighter', level: 9 });
  fighter.resources.indomitable = { name: 'Indomitable', remaining: 1, max: 1, reset: 'long_rest' };
  const prompted = resolveRefereeAction({
    message: '[ROLL REQUEST: midlevel_roll]',
    worldState: pendingWorld({ kind: 'saving_throw', ability: 'wis', modifier: 2 }),
    characterSheet: fighter,
    rollDie: () => 2,
  });
  assert.match(prompted.reply, /Indomitable is available/);

  const resolved = resolveRefereeAction({
    message: 'I use Indomitable.',
    worldState: prompted.worldState,
    characterSheet: fighter,
    rollDie: () => 8,
  });
  assert.match(resolved.reply, /Indomitable \+9/);
  assert.equal(resolved.worldState.player_stats.resources.indomitable.remaining, 0);
});

test("Dark One's Own Luck adds 1d10 to a failed check and spends one use", () => {
  const warlock = sheet({ classId: 'warlock', level: 6 });
  warlock.resources.dark_ones_own_luck = { name: "Dark One's Own Luck", remaining: 3, max: 3, reset: 'long_rest' };
  const prompted = resolveRefereeAction({
    message: '[ROLL REQUEST: midlevel_roll]',
    worldState: pendingWorld({ kind: 'skill_check', skill: 'stealth', ability: 'dex', modifier: 6, dc: 18 }),
    characterSheet: warlock,
    rollDie: () => 3,
  });
  assert.match(prompted.reply, /Dark One's Own Luck is available/);

  const resolved = resolveRefereeAction({
    message: "I use Dark One's Own Luck.",
    worldState: prompted.worldState,
    characterSheet: warlock,
    rollDie: () => 10,
  });
  assert.match(resolved.reply, /1d10 = 10/);
  assert.equal(resolved.worldState.player_stats.resources.dark_ones_own_luck.remaining, 2);
});

test('Countercharm rerolls a failed fear save with Advantage', () => {
  const bard = sheet({ classId: 'bard', level: 7 });
  const prompted = resolveRefereeAction({
    message: '[ROLL REQUEST: midlevel_roll]',
    worldState: pendingWorld({ kind: 'saving_throw', ability: 'wis', modifier: 2, intent: 'resist being frightened' }),
    characterSheet: bard,
    rollDie: () => 2,
  });
  assert.match(prompted.reply, /Countercharm is available/);

  const rolls = [4, 18];
  const resolved = resolveRefereeAction({
    message: 'I use Countercharm.',
    worldState: prompted.worldState,
    characterSheet: bard,
    rollDie: () => rolls.shift(),
  });
  assert.match(resolved.reply, /reroll the save with Advantage/);
  assert.match(resolved.reply, /20/);
});

function combatWorld() {
  return {
    player_stats: { hp: 50, max_hp: 50, armor_class: 16 },
    combat_state: {
      active: true,
      round: 1,
      turn_index: 0,
      combatants: [
        { name: 'Midlevel Test', hp: 50, max_hp: 50, ac: 16, is_player: true },
        { name: 'Goblin', hp: 50, max_hp: 50, ac: 12, speed: 30, is_player: false },
      ],
    },
  };
}

test('Brutal Strike forgoes Reckless Advantage and applies its damage rider', () => {
  const barbarian = sheet({ classId: 'barbarian', level: 9 });
  barbarian.derived_stats.attack_breakdowns = [{ weapon_id: 'greataxe', name: 'Greataxe', attack_total: 7, attack_bonus: 7, ability: 'str', damage_formula: '1d12+4', weapon_category: 'martial', properties: ['heavy', 'two_handed'], is_weapon: true }];
  barbarian.weapon_masteries = [{ weapon_id: 'greataxe', mastery: 'cleave' }];
  const rolls = [10, 5, 6];
  const result = resolveRefereeAction({
    message: 'I attack the Goblin with my Greataxe using Brutal Strike and Forceful Blow.',
    worldState: combatWorld(),
    characterSheet: barbarian,
    rollDie: () => rolls.shift() ?? 5,
  });

  assert.match(result.reply, /Brutal Strike 1d10=6/);
  assert.match(result.reply, /Forceful Blow/);
  assert.doesNotMatch(result.reply, /with advantage/);
});

test('Tactical Master replaces a mastered weapon property for the declared attack', () => {
  const fighter = sheet({ classId: 'fighter', level: 9 });
  fighter.derived_stats.attack_breakdowns = [{ weapon_id: 'longsword', name: 'Longsword', attack_total: 7, attack_bonus: 7, ability: 'str', damage_formula: '1d8+3', weapon_category: 'martial', properties: ['versatile'], mastery: 'sap', is_weapon: true }];
  fighter.weapon_masteries = [{ weapon_id: 'longsword', mastery: 'sap' }];
  const rolls = [12, 5];
  const result = resolveRefereeAction({
    message: 'I attack the Goblin with my Longsword and use Tactical Master to replace its mastery with Slow.',
    worldState: combatWorld(),
    characterSheet: fighter,
    rollDie: () => rolls.shift() ?? 5,
  });

  assert.match(result.reply, /Slow mastery/);
});
