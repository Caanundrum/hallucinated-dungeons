process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUnarmedAttack,
  resolveOriginFeatAction,
  rollWeaponDamage,
} = require('../src/originFeatEngine');

function sequenceRolls(values) {
  let index = 0;
  return () => values[index++] ?? values[values.length - 1] ?? 10;
}

function sheet(feat, overrides = {}) {
  return {
    identity: { name: 'Ari', class: 'fighter', level: 1 },
    origin: { background_feat: feat },
    abilities: { modifiers: { str: 3, dex: 1 } },
    derived_stats: { hp: 12, max_hp: 12, proficiency_bonus: 2 },
    ...overrides,
  };
}

test('Healer Battle Medic spends one Hit Die, rerolls healing die results of 1, and spends an Action', () => {
  const result = resolveOriginFeatAction({
    message: "Use the healer's kit on myself.",
    worldState: {
      player_stats: { hp: 3, max_hp: 12, hit_dice: { die: 10, remaining: 1, max: 1 } },
      combat_state: {
        active: true,
        combatants: [
          { name: 'Ari', hp: 3, max_hp: 12, ac: 14, is_player: true },
          { name: 'Cultist', hp: 8, max_hp: 8, ac: 12, is_player: false },
        ],
      },
    },
    characterSheet: sheet('healer'),
    rollDie: sequenceRolls([1, 6]),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.hp, 11);
  assert.equal(result.worldState.player_stats.hit_dice.remaining, 0);
  assert.equal(result.worldState.combat_state.turn_resources.action_available, false);
  assert.match(result.reply, /regain 8 HP/);
});

test('mentioning a Healer kit without using it does not trigger Battle Medic', () => {
  const result = resolveOriginFeatAction({
    message: "Inspect the healer's kit.",
    worldState: {},
    characterSheet: sheet('healer'),
  });

  assert.equal(result, null);
});

test('Lucky defensive priming spends one Luck Point and records the next-attack rider', () => {
  const result = resolveOriginFeatAction({
    message: 'Use my lucky point defensively against the next attack.',
    worldState: {
      player_stats: {
        resources: {
          luck_points: { name: 'Luck Points', remaining: 2, max: 2, reset: 'long_rest' },
        },
      },
    },
    characterSheet: sheet('lucky'),
  });

  assert.equal(result.handled, true);
  assert.equal(result.worldState.player_stats.resources.luck_points.remaining, 1);
  assert.equal(result.worldState.player_stats.lucky_defense_primed, true);
});

test('Savage Attacker rolls weapon damage twice and uses the higher result', () => {
  const result = rollWeaponDamage({
    formula: '1d8+3',
    characterSheet: sheet('savage_attacker'),
    attack: { isWeapon: true },
    rollDie: sequenceRolls([2, 7]),
  });

  assert.equal(result.total, 10);
  assert.match(result.note, /twice \(5\/10\)/);
});

test('extra attacks can suppress Savage Attacker after its once-per-turn use', () => {
  const result = rollWeaponDamage({
    formula: '1d12+3',
    characterSheet: sheet('savage_attacker'),
    attack: { isWeapon: true, allowSavageAttacker: false },
    rollDie: sequenceRolls([4, 12]),
  });

  assert.equal(result.total, 7);
  assert.equal(result.savageAttacker, undefined);
});

test('Tavern Brawler and Monk unarmed strikes use their deterministic damage rules', () => {
  const tavern = buildUnarmedAttack({
    characterSheet: sheet('tavern_brawler'),
    message: 'Punch the cultist and push him back.',
  });
  const monk = buildUnarmedAttack({
    characterSheet: sheet(null, {
      identity: { name: 'Ari', class: 'monk', level: 1 },
      abilities: { modifiers: { str: 1, dex: 4 } },
    }),
    message: 'Kick the cultist.',
  });

  assert.equal(tavern.damageFormula, '1d4+3');
  assert.equal(tavern.rerollDamageOnes, true);
  assert.equal(tavern.tavernBrawlerPush, true);
  assert.equal(monk.damageFormula, '1d6+4');
  assert.equal(monk.ability, 'dex');
});

test('Unarmed Fighting style routes declared punches through its d6 strike', () => {
  const unarmed = buildUnarmedAttack({
    characterSheet: sheet(null, {
      class_choices: { fighting_style: 'unarmed_fighting' },
    }),
    message: 'Punch the cultist.',
  });

  assert.equal(unarmed.damageFormula, '1d6+3');
  assert.equal(unarmed.attackBonus, 5);
});
