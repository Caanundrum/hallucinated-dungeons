process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const {
  applyLevelUp,
  getFixedHpIncrease,
  getLevelUpPreview,
  proficiencyBonus,
} = require('../src/levelUpEngine');

function baseSheet(overrides = {}) {
  return {
    identity: {
      name: 'Ari',
      class: 'fighter',
      class_name: 'Fighter',
      level: 1,
      experience_points: 0,
      next_level_xp: 300,
      level_up_available: false,
      ...overrides.identity,
    },
    abilities: {
      final_scores: { str: 16, dex: 10, con: 14, int: 8, wis: 12, cha: 10 },
      modifiers: { str: 3, dex: 0, con: 2, int: -1, wis: 1, cha: 0 },
      ...overrides.abilities,
    },
    active_effects: overrides.active_effects || [],
    features: overrides.features || [],
    resources: overrides.resources || {},
    progression: {
      experience_points: overrides.identity?.experience_points ?? 0,
      next_level_xp: 300,
      level_up_available: null,
      ...(overrides.progression || {}),
    },
    derived_stats: {
      level: 1,
      proficiency_bonus: 2,
      hp: 12,
      max_hp: 12,
      speed: 30,
      ...(overrides.derived_stats || {}),
    },
  };
}

test('level-up preview stays unavailable below the XP threshold', () => {
  const preview = getLevelUpPreview(baseSheet(), getContentBundle());

  assert.equal(preview.canLevelUp, false);
  assert.equal(preview.canApply, false);
  assert.equal(preview.currentXp, 0);
  assert.equal(preview.threshold, 300);
});

test('fighter level 2 preview uses fixed HP and is apply-ready', () => {
  const preview = getLevelUpPreview(baseSheet({
    identity: { experience_points: 300, level_up_available: true },
    progression: { experience_points: 300 },
  }), getContentBundle());

  assert.equal(preview.canLevelUp, true);
  assert.equal(preview.canApply, true);
  assert.equal(preview.hp.hitDie, 10);
  assert.equal(preview.hp.fixedBase, 6);
  assert.equal(preview.hp.constitutionModifier, 2);
  assert.equal(preview.hp.increase, 8);
  assert.deepEqual(preview.features.map((feature) => feature.name), ['Action Surge', 'Tactical Mind']);
  assert.deepEqual(preview.blockers, []);
});

test('applying fighter level 2 updates level, HP, hit dice, and Action Surge resource', () => {
  const sheet = baseSheet({
    identity: { experience_points: 300, level_up_available: true },
    progression: { experience_points: 300 },
  });
  const result = applyLevelUp({ characterSheet: sheet, content: getContentBundle() });

  assert.equal(result.ok, true);
  assert.equal(result.characterSheet.identity.level, 2);
  assert.equal(result.characterSheet.derived_stats.max_hp, 20);
  assert.equal(result.characterSheet.resources.hit_dice.max, 2);
  assert.equal(result.characterSheet.resources.action_surge.remaining, 1);
  assert(result.characterSheet.features.some((feature) => feature.name === 'Action Surge'));
  assert(result.characterSheet.features.some((feature) => feature.name === 'Tactical Mind'));
});

test('barbarian and rogue level 2 previews are apply-ready as a two-class package', () => {
  const barbarianPreview = getLevelUpPreview(baseSheet({
    identity: {
      class: 'barbarian',
      class_name: 'Barbarian',
      experience_points: 300,
      level_up_available: true,
    },
    progression: { experience_points: 300 },
  }), getContentBundle());
  const roguePreview = getLevelUpPreview(baseSheet({
    identity: {
      class: 'rogue',
      class_name: 'Rogue',
      experience_points: 300,
      level_up_available: true,
    },
    progression: { experience_points: 300 },
  }), getContentBundle());

  assert.equal(barbarianPreview.canApply, true);
  assert.deepEqual(barbarianPreview.features.map((feature) => feature.name), ['Danger Sense', 'Reckless Attack']);
  assert.equal(barbarianPreview.hp.hitDie, 12);
  assert.equal(barbarianPreview.hp.increase, 9);
  assert.equal(roguePreview.canApply, true);
  assert.deepEqual(roguePreview.features.map((feature) => feature.name), ['Cunning Action']);
  assert.equal(roguePreview.hp.hitDie, 8);
  assert.equal(roguePreview.hp.increase, 7);
});

test('applying barbarian and rogue level 2 records their runtime features', () => {
  const barbarian = applyLevelUp({
    characterSheet: baseSheet({
      identity: {
        class: 'barbarian',
        class_name: 'Barbarian',
        experience_points: 300,
        level_up_available: true,
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
  });
  const rogue = applyLevelUp({
    characterSheet: baseSheet({
      identity: {
        class: 'rogue',
        class_name: 'Rogue',
        experience_points: 300,
        level_up_available: true,
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
  });

  assert.equal(barbarian.ok, true);
  assert.equal(barbarian.characterSheet.identity.level, 2);
  assert.equal(barbarian.characterSheet.resources.rage.recover_on_short_rest, 1);
  assert(barbarian.characterSheet.features.some((feature) => feature.name === 'Danger Sense'));
  assert(barbarian.characterSheet.features.some((feature) => feature.name === 'Reckless Attack'));
  assert.equal(rogue.ok, true);
  assert.equal(rogue.characterSheet.identity.level, 2);
  assert(rogue.characterSheet.features.some((feature) => feature.name === 'Cunning Action'));
});

test('applying a blocked choice-heavy level returns a preview and does not mutate the sheet', () => {
  const sheet = baseSheet({
    identity: {
      class: 'bard',
      class_name: 'Bard',
      experience_points: 300,
      level_up_available: true,
    },
    progression: { experience_points: 300 },
  });
  const result = applyLevelUp({ characterSheet: sheet, content: getContentBundle() });

  assert.equal(result.ok, false);
  assert.equal(result.preview.canLevelUp, true);
  assert.equal(result.preview.canApply, false);
  assert(result.preview.blockers.some((entry) => entry.type === 'required_choice'));
  assert.equal(sheet.identity.level, 1);
});

test('fixed HP increase includes per-level HP bonuses', () => {
  const hp = getFixedHpIncrease(baseSheet({
    active_effects: [{ target: 'max_hp_per_level_bonus', value: 2 }],
  }), { hit_die: 10 });

  assert.equal(hp.increase, 10);
  assert.equal(hp.perLevelBonus, 2);
});

test('applyLevelUp can apply an unblocked advancement record', () => {
  const content = {
    classes: [{ id: 'test_class', name: 'Test Class', hit_die: 8 }],
    xpThresholds: { 2: 300, 3: 900 },
    classAdvancement: {
      levels: {
        test_class: {
          2: {
            features: [{ id: 'steady_step', name: 'Steady Step', description: 'Walk slightly more impressively.' }],
            runtime_mechanics: [],
            required_choices: [],
            resources: {
              steady_step: { name: 'Steady Step', remaining: 1, max: 1, reset: 'long_rest' },
            },
          },
        },
      },
    },
  };
  const result = applyLevelUp({
    characterSheet: baseSheet({
      identity: {
        class: 'test_class',
        class_name: 'Test Class',
        experience_points: 300,
        level_up_available: true,
      },
      progression: { experience_points: 300 },
    }),
    content,
  });

  assert.equal(result.ok, true);
  assert.equal(result.characterSheet.identity.level, 2);
  assert.equal(result.characterSheet.identity.next_level_xp, 900);
  assert.equal(result.characterSheet.identity.level_up_available, false);
  assert.equal(result.characterSheet.derived_stats.max_hp, 19);
  assert.equal(result.characterSheet.resources.hit_dice.max, 2);
  assert.equal(result.characterSheet.resources.steady_step.remaining, 1);
  assert(result.characterSheet.features.some((feature) => feature.name === 'Steady Step'));
});

test('proficiency bonus follows the SRD advancement table cadence', () => {
  assert.equal(proficiencyBonus(1), 2);
  assert.equal(proficiencyBonus(4), 2);
  assert.equal(proficiencyBonus(5), 3);
  assert.equal(proficiencyBonus(17), 6);
});
