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
  repairPactWeaponAttack,
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
    proficiencies: {
      saving_throws: ['str', 'con'],
      skills: ['athletics', 'perception', 'persuasion'],
      tools: [],
      languages: [],
      armor: [],
      weapons: [],
      ...(overrides.proficiencies || {}),
    },
    active_effects: overrides.active_effects || [],
    features: overrides.features || [],
    resources: overrides.resources || {},
    languages: overrides.languages || overrides.proficiencies?.languages || [],
    class_choices: overrides.class_choices || {},
    class_choice_details: overrides.class_choice_details || {},
    equipped: overrides.equipped || {},
    spellcasting: overrides.spellcasting,
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

test('bard level 2 requires Expertise and prepared spell choices before apply', () => {
  const sheet = baseSheet({
    identity: {
      class: 'bard',
      class_name: 'Bard',
      experience_points: 300,
      level_up_available: true,
    },
    abilities: {
      modifiers: { str: 0, dex: 2, con: 1, int: 0, wis: 1, cha: 3 },
      final_scores: { str: 10, dex: 14, con: 12, int: 10, wis: 12, cha: 16 },
    },
    proficiencies: { skills: ['persuasion', 'performance', 'insight'] },
    derived_stats: {
      skill_modifiers: {
        persuasion: { ability: 'cha', proficient: true, total: 5 },
        performance: { ability: 'cha', proficient: true, total: 5 },
        insight: { ability: 'wis', proficient: true, total: 3 },
        athletics: { ability: 'str', proficient: false, total: 0 },
      },
    },
    spellcasting: {
      ability: 'cha',
      cantrips_known: ['minor_illusion', 'vicious_mockery'],
      prepared_from_choices: ['charm_person', 'cure_wounds', 'dissonant_whispers', 'healing_word'],
      spells_prepared: ['charm_person', 'cure_wounds', 'dissonant_whispers', 'healing_word'],
      always_prepared_spells: [],
      slots: { 1: 2 },
    },
    progression: { experience_points: 300 },
  });
  const preview = getLevelUpPreview(sheet, getContentBundle());
  const result = applyLevelUp({ characterSheet: sheet, content: getContentBundle() });

  assert.equal(preview.canLevelUp, true);
  assert.equal(preview.canApply, false);
  assert.equal(preview.requiredChoices.length, 2);
  assert.equal(preview.requiredChoices.find((choice) => choice.id === 'expertise_skills').options.length, 3);
  assert(preview.requiredChoices.find((choice) => choice.id === 'prepared_spells').options.some((option) => option.id === 'faerie_fire'));
  assert.equal(result.ok, false);
  assert(result.preview.blockers.some((entry) => entry.type === 'required_choice'));
  assert.equal(sheet.identity.level, 1);
});

test('applying bard level 2 records Expertise, Jack of All Trades, spell preparation, and slots', () => {
  const sheet = baseSheet({
    identity: {
      class: 'bard',
      class_name: 'Bard',
      experience_points: 300,
      level_up_available: true,
    },
    abilities: {
      modifiers: { str: 0, dex: 2, con: 1, int: 0, wis: 1, cha: 3 },
      final_scores: { str: 10, dex: 14, con: 12, int: 10, wis: 12, cha: 16 },
    },
    proficiencies: { skills: ['persuasion', 'performance', 'insight'] },
    derived_stats: {
      skill_modifiers: {
        persuasion: { ability: 'cha', proficient: true, total: 5 },
        performance: { ability: 'cha', proficient: true, total: 5 },
        insight: { ability: 'wis', proficient: true, total: 3 },
        athletics: { ability: 'str', proficient: false, total: 0 },
      },
    },
    spellcasting: {
      ability: 'cha',
      cantrips_known: ['minor_illusion', 'vicious_mockery'],
      prepared_from_choices: ['charm_person', 'cure_wounds', 'dissonant_whispers', 'healing_word'],
      spells_prepared: ['charm_person', 'cure_wounds', 'dissonant_whispers', 'healing_word'],
      always_prepared_spells: [],
      slots: { 1: 2 },
    },
    progression: { experience_points: 300 },
  });
  const result = applyLevelUp({
    characterSheet: sheet,
    content: getContentBundle(),
    payload: {
      choices: {
        expertise_skills: ['persuasion', 'performance'],
        prepared_spells: ['faerie_fire'],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.characterSheet.identity.level, 2);
  assert.deepEqual(result.characterSheet.expertise_skills, ['persuasion', 'performance']);
  assert.equal(result.characterSheet.derived_stats.skill_modifiers.persuasion.expertise, true);
  assert.equal(result.characterSheet.derived_stats.skill_modifiers.persuasion.total, 7);
  assert.equal(result.characterSheet.derived_stats.skill_modifiers.athletics.jack_of_all_trades, true);
  assert.equal(result.characterSheet.derived_stats.skill_modifiers.athletics.total, 1);
  assert.equal(result.characterSheet.spellcasting.prepared_spells_count, 5);
  assert.equal(result.characterSheet.spellcasting.slots[1], 3);
  assert(result.characterSheet.spellcasting.spells_prepared.includes('faerie_fire'));
});

test('applying monk level 2 adds Focus resources and unarmored movement speed', () => {
  const result = applyLevelUp({
    characterSheet: baseSheet({
      identity: {
        class: 'monk',
        class_name: 'Monk',
        experience_points: 300,
        level_up_available: true,
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.characterSheet.identity.level, 2);
  assert.equal(result.characterSheet.resources.focus_points.remaining, 2);
  assert.equal(result.characterSheet.resources.uncanny_metabolism.remaining, 1);
  assert.equal(result.characterSheet.derived_stats.speed, 40);
  assert(result.characterSheet.features.some((feature) => feature.name === "Monk's Focus"));
});

test('cleric and druid level 2 previews are apply-ready with their class resources', () => {
  const clericPreview = getLevelUpPreview(baseSheet({
    identity: {
      class: 'cleric',
      class_name: 'Cleric',
      experience_points: 300,
      level_up_available: true,
    },
    spellcasting: {
      ability: 'wis',
      cantrips_known: ['guidance', 'sacred_flame', 'thaumaturgy'],
      spells_prepared: ['bless', 'cure_wounds', 'detect_magic', 'guiding_bolt'],
      slots: { 1: 2 },
    },
    progression: { experience_points: 300 },
  }), getContentBundle());
  const druidPreview = getLevelUpPreview(baseSheet({
    identity: {
      class: 'druid',
      class_name: 'Druid',
      experience_points: 300,
      level_up_available: true,
    },
    spellcasting: {
      ability: 'wis',
      cantrips_known: ['druidcraft', 'produce_flame'],
      spells_prepared: ['cure_wounds', 'entangle', 'faerie_fire', 'thunderwave'],
      always_prepared_spells: ['speak_with_animals'],
      slots: { 1: 2 },
    },
    progression: { experience_points: 300 },
  }), getContentBundle());

  assert.equal(clericPreview.canApply, true);
  assert.deepEqual(clericPreview.features.map((feature) => feature.name), ['Channel Divinity']);
  assert.equal(clericPreview.resources.channel_divinity.max, 2);
  assert.equal(clericPreview.spellcasting.slots[1], 3);
  assert.equal(druidPreview.canApply, true);
  assert.deepEqual(druidPreview.features.map((feature) => feature.name), ['Wild Shape', 'Wild Companion']);
  assert.equal(druidPreview.resources.wild_shape.max, 2);
  assert.equal(druidPreview.spellcasting.slots[1], 3);
});

test('applying cleric and druid level 2 records Channel Divinity and Wild Shape resources', () => {
  const cleric = applyLevelUp({
    characterSheet: baseSheet({
      identity: {
        class: 'cleric',
        class_name: 'Cleric',
        experience_points: 300,
        level_up_available: true,
      },
      spellcasting: {
        ability: 'wis',
        cantrips_known: ['guidance', 'sacred_flame', 'thaumaturgy'],
        spells_prepared: ['bless', 'cure_wounds', 'detect_magic', 'guiding_bolt'],
        slots: { 1: 2 },
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
  });
  const druid = applyLevelUp({
    characterSheet: baseSheet({
      identity: {
        class: 'druid',
        class_name: 'Druid',
        experience_points: 300,
        level_up_available: true,
      },
      spellcasting: {
        ability: 'wis',
        cantrips_known: ['druidcraft', 'produce_flame'],
        spells_prepared: ['cure_wounds', 'entangle', 'faerie_fire', 'thunderwave'],
        always_prepared_spells: ['speak_with_animals'],
        slots: { 1: 2 },
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
  });

  assert.equal(cleric.ok, true);
  assert.equal(cleric.characterSheet.resources.channel_divinity.remaining, 2);
  assert.equal(cleric.characterSheet.spellcasting.prepared_spells_count, 5);
  assert(cleric.characterSheet.features.some((feature) => feature.name === 'Channel Divinity'));
  assert.equal(druid.ok, true);
  assert.equal(druid.characterSheet.resources.wild_shape.remaining, 2);
  assert.equal(druid.characterSheet.spellcasting.prepared_spells_count, 5);
  assert(druid.characterSheet.features.some((feature) => feature.name === 'Wild Shape'));
  assert(druid.characterSheet.features.some((feature) => feature.name === 'Wild Companion'));
});

test('Paladin level 2 requires a Fighting Style and one additional prepared spell', () => {
  const sheet = baseSheet({
    identity: {
      class: 'paladin',
      class_name: 'Paladin',
      experience_points: 300,
      level_up_available: true,
    },
    equipped: { armor: 'chain_mail', main_hand: 'longsword', off_hand: 'shield' },
    derived_stats: {
      armor_class: 18,
      armor_class_breakdown: [
        { label: 'Chain Mail', value: 16 },
        { label: 'Shield', value: 2 },
      ],
      attack_breakdowns: [
        { name: 'Longsword', attack_kind: 'melee', attack_total: 5, fighting_style_attack_bonus: 0 },
      ],
    },
    spellcasting: {
      ability: 'cha',
      cantrips_known: [],
      prepared_from_choices: ['bless', 'shield_of_faith'],
      spells_prepared: ['bless', 'shield_of_faith'],
      always_prepared_spells: [],
      slots: { 1: 2 },
    },
    progression: { experience_points: 300 },
  });
  const preview = getLevelUpPreview(sheet, getContentBundle());
  const result = applyLevelUp({ characterSheet: sheet, content: getContentBundle() });

  assert.equal(preview.canLevelUp, true);
  assert.equal(preview.canApply, false);
  assert.equal(preview.requiredChoices.find((choice) => choice.id === 'fighting_style').options.length, 10);
  assert(preview.requiredChoices.find((choice) => choice.id === 'prepared_spells').options.some((option) => option.id === 'divine_favor'));
  assert.equal(result.ok, false);
});

test('applying Paladin level 2 records Fighting Style, Smite, spell preparation, and static Defense AC', () => {
  const result = applyLevelUp({
    characterSheet: baseSheet({
      identity: {
        class: 'paladin',
        class_name: 'Paladin',
        experience_points: 300,
        level_up_available: true,
      },
      equipped: { armor: 'chain_mail', main_hand: 'longsword', off_hand: 'shield' },
      derived_stats: {
        armor_class: 18,
        armor_class_breakdown: [
          { label: 'Chain Mail', value: 16 },
          { label: 'Shield', value: 2 },
        ],
        attack_breakdowns: [
          { name: 'Longsword', attack_kind: 'melee', attack_total: 5, fighting_style_attack_bonus: 0 },
        ],
      },
      spellcasting: {
        ability: 'cha',
        cantrips_known: [],
        prepared_from_choices: ['bless', 'shield_of_faith'],
        spells_prepared: ['bless', 'shield_of_faith'],
        always_prepared_spells: [],
        slots: { 1: 2 },
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
    payload: {
      choices: {
        fighting_style: ['defense'],
        prepared_spells: ['divine_favor'],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.characterSheet.identity.level, 2);
  assert.equal(result.characterSheet.class_choices.fighting_style, 'defense');
  assert.equal(result.characterSheet.derived_stats.armor_class, 19);
  assert(result.characterSheet.derived_stats.armor_class_breakdown.some((entry) => entry.label === 'Defense Fighting Style'));
  assert.equal(result.characterSheet.resources.paladins_smite.remaining, 1);
  assert(result.characterSheet.spellcasting.always_prepared_spells.includes('divine_smite'));
  assert(result.characterSheet.spellcasting.spells_prepared.includes('divine_favor'));
  assert.equal(result.characterSheet.spellcasting.prepared_spells_count, 3);
});

test('Ranger level 2 applies Deft Explorer, Archery, languages, and one prepared spell', () => {
  const result = applyLevelUp({
    characterSheet: baseSheet({
      identity: {
        class: 'ranger',
        class_name: 'Ranger',
        experience_points: 300,
        level_up_available: true,
      },
      abilities: {
        final_scores: { str: 10, dex: 16, con: 14, int: 10, wis: 14, cha: 8 },
        modifiers: { str: 0, dex: 3, con: 2, int: 0, wis: 2, cha: -1 },
      },
      proficiencies: {
        skills: ['perception', 'stealth', 'survival'],
        languages: ['common', 'elvish'],
      },
      languages: ['common', 'elvish'],
      derived_stats: {
        skill_modifiers: {
          perception: { ability: 'wis', proficient: true, total: 4 },
          stealth: { ability: 'dex', proficient: true, total: 5 },
          survival: { ability: 'wis', proficient: true, total: 4 },
        },
        attack_breakdowns: [
          { name: 'Longbow', attack_kind: 'ranged', attack_total: 5, fighting_style_attack_bonus: 0 },
        ],
      },
      spellcasting: {
        ability: 'wis',
        cantrips_known: [],
        prepared_from_choices: ['cure_wounds', 'ensnaring_strike'],
        spells_prepared: ['cure_wounds', 'ensnaring_strike', 'hunter_mark'],
        always_prepared_spells: ['hunter_mark'],
        slots: { 1: 2 },
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
    payload: {
      choices: {
        deft_explorer_expertise: ['perception'],
        deft_explorer_languages: ['draconic', 'dwarvish'],
        fighting_style: ['archery'],
        prepared_spells: ['hail_of_thorns'],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.characterSheet.class_choices.fighting_style, 'archery');
  assert.equal(result.characterSheet.derived_stats.attack_breakdowns[0].attack_total, 7);
  assert.equal(result.characterSheet.derived_stats.skill_modifiers.perception.expertise, true);
  assert.equal(result.characterSheet.derived_stats.skill_modifiers.perception.total, 6);
  assert(result.characterSheet.languages.includes('draconic'));
  assert(result.characterSheet.languages.includes('dwarvish'));
  assert(result.characterSheet.spellcasting.spells_prepared.includes('hail_of_thorns'));
  assert.equal(result.characterSheet.spellcasting.prepared_spells_count, 3);
});

test('Ranger Druidic Warrior conditionally requires and records two Druid cantrips', () => {
  const ranger = baseSheet({
    identity: {
      class: 'ranger',
      class_name: 'Ranger',
      experience_points: 300,
      level_up_available: true,
    },
    proficiencies: {
      skills: ['perception', 'stealth', 'survival'],
      languages: ['common', 'elvish'],
    },
    languages: ['common', 'elvish'],
    derived_stats: {
      skill_modifiers: {
        perception: { ability: 'wis', proficient: true, total: 3 },
        stealth: { ability: 'dex', proficient: true, total: 2 },
        survival: { ability: 'wis', proficient: true, total: 3 },
      },
    },
    spellcasting: {
      ability: 'wis',
      cantrips_known: [],
      prepared_from_choices: ['cure_wounds', 'ensnaring_strike'],
      spells_prepared: ['cure_wounds', 'ensnaring_strike', 'hunter_mark'],
      always_prepared_spells: ['hunter_mark'],
      slots: { 1: 2 },
    },
    progression: { experience_points: 300 },
  });
  const incompleteChoices = {
    deft_explorer_expertise: ['perception'],
    deft_explorer_languages: ['draconic', 'dwarvish'],
    fighting_style: ['druidic_warrior'],
    prepared_spells: ['hail_of_thorns'],
  };
  const preview = getLevelUpPreview(ranger, getContentBundle(), { choices: incompleteChoices });
  const cantripChoice = preview.requiredChoices.find((choice) => choice.id === 'druidic_warrior_cantrips');
  const result = applyLevelUp({
    characterSheet: ranger,
    content: getContentBundle(),
    payload: {
      choices: {
        ...incompleteChoices,
        druidic_warrior_cantrips: ['druidcraft', 'produce_flame'],
      },
    },
  });

  assert.equal(cantripChoice.active, true);
  assert(cantripChoice.options.some((option) => option.id === 'druidcraft'));
  assert(preview.blockers.some((entry) => entry.type === 'required_choice' && entry.choice.id === 'druidic_warrior_cantrips'));
  assert.equal(result.ok, true);
  assert.equal(result.characterSheet.class_choices.fighting_style, 'druidic_warrior');
  assert(result.characterSheet.spellcasting.cantrips_known.includes('druidcraft'));
  assert(result.characterSheet.spellcasting.cantrips_known.includes('produce_flame'));
});

test('Sorcerer level 2 requires Metamagic and two new prepared spells', () => {
  const sheet = baseSheet({
    identity: { class: 'sorcerer', class_name: 'Sorcerer', experience_points: 300, level_up_available: true },
    spellcasting: {
      ability: 'cha',
      cantrips_known: ['fire_bolt', 'mage_hand', 'prestidigitation', 'sorcerous_burst'],
      spells_prepared: ['magic_missile', 'shield'],
      slots: { 1: 2 },
    },
    progression: { experience_points: 300 },
  });
  const preview = getLevelUpPreview(sheet, getContentBundle());

  assert.equal(preview.canLevelUp, true);
  assert.equal(preview.canApply, false);
  assert.equal(preview.requiredChoices.find((choice) => choice.id === 'metamagic').options.length, 10);
  assert.equal(preview.requiredChoices.find((choice) => choice.id === 'prepared_spells').count, 2);
});

test('Sorcerer and Warlock level-up prepared spell choices exclude cantrips and reject forged cantrip selections', () => {
  const cases = [
    {
      classId: 'sorcerer',
      spells: ['magic_missile', 'mage_armor'],
      choices: { metamagic: ['quickened_spell', 'subtle_spell'], prepared_spells: ['fire_bolt', 'ray_of_frost'] },
    },
    {
      classId: 'warlock',
      spells: ['hex', 'armor_of_agathys'],
      choices: { eldritch_invocations: ['eldritch_mind', 'pact_of_the_blade'], pact_weapon: ['longsword'], prepared_spells: ['eldritch_blast'] },
    },
  ];

  for (const entry of cases) {
    const characterSheet = baseSheet({
      identity: { class: entry.classId, class_name: entry.classId, experience_points: 300, level_up_available: true },
      class_choices: entry.classId === 'warlock' ? { eldritch_invocation: 'armor_of_shadows' } : {},
      spellcasting: { ability: 'cha', cantrips_known: ['fire_bolt', 'eldritch_blast'], spells_prepared: entry.spells, slots: { 1: entry.classId === 'warlock' ? 1 : 2 } },
      progression: { experience_points: 300 },
    });
    const preview = getLevelUpPreview(characterSheet, getContentBundle());
    const prepared = preview.requiredChoices.find((choice) => choice.id === 'prepared_spells');
    assert.equal(prepared.options.some((option) => Number(option.level) === 0 || ['fire_bolt', 'eldritch_blast'].includes(option.id)), false);

    const result = applyLevelUp({ characterSheet, content: getContentBundle(), payload: { choices: entry.choices } });
    assert.equal(result.ok, false);
    assert.equal(result.preview.blockers.some((entryBlocker) => entryBlocker.type === 'invalid_choice'), true);
  }
});

test('applying Sorcerer level 2 records Metamagic, Sorcery Points, spells, and slots', () => {
  const result = applyLevelUp({
    characterSheet: baseSheet({
      identity: { class: 'sorcerer', class_name: 'Sorcerer', experience_points: 300, level_up_available: true },
      spellcasting: {
        ability: 'cha',
        cantrips_known: ['fire_bolt', 'mage_hand', 'prestidigitation', 'sorcerous_burst'],
        spells_prepared: ['magic_missile', 'shield'],
        slots: { 1: 2 },
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
    payload: { choices: { metamagic: ['quickened_spell', 'transmuted_spell'], prepared_spells: ['chromatic_orb', 'mage_armor'] } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.characterSheet.class_choices.metamagic, ['quickened_spell', 'transmuted_spell']);
  assert.equal(result.characterSheet.resources.sorcery_points.remaining, 2);
  assert.equal(result.characterSheet.spellcasting.prepared_spells_count, 4);
  assert(result.characterSheet.spellcasting.spells_prepared.includes('chromatic_orb'));
  assert.equal(result.characterSheet.spellcasting.slots[1], 3);
});

test('Warlock level 2 requires two new invocations and one prepared spell', () => {
  const sheet = baseSheet({
    identity: { class: 'warlock', class_name: 'Warlock', experience_points: 300, level_up_available: true },
    class_choices: { eldritch_invocation: 'pact_of_the_blade' },
    spellcasting: { ability: 'cha', cantrips_known: ['eldritch_blast', 'mage_hand'], spells_prepared: ['hex', 'armor_of_agathys'], slots: { 1: 1 } },
    progression: { experience_points: 300 },
  });
  const preview = getLevelUpPreview(sheet, getContentBundle());
  const invocationChoice = preview.requiredChoices.find((choice) => choice.id === 'eldritch_invocations');

  assert.equal(preview.canApply, false);
  assert.equal(invocationChoice.options.some((option) => option.id === 'pact_of_the_blade'), false);
  assert.equal(invocationChoice.options.length, 4);
  assert.equal(preview.requiredChoices.find((choice) => choice.id === 'prepared_spells').count, 1);
});

test('applying Warlock level 2 records invocations, granted magic, Magical Cunning, and Pact slots', () => {
  const result = applyLevelUp({
    characterSheet: baseSheet({
      identity: { class: 'warlock', class_name: 'Warlock', experience_points: 300, level_up_available: true },
      class_choices: { eldritch_invocation: 'pact_of_the_blade' },
      class_choice_details: { eldritch_invocation: { pact_weapon: 'spear' } },
      spellcasting: { ability: 'cha', cantrips_known: ['eldritch_blast', 'mage_hand'], spells_prepared: ['hex', 'armor_of_agathys'], slots: { 1: 1 } },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
    payload: { choices: { eldritch_invocations: ['armor_of_shadows', 'eldritch_mind'], prepared_spells: ['charm_person'] } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.characterSheet.class_choices.eldritch_invocations, ['pact_of_the_blade', 'armor_of_shadows', 'eldritch_mind']);
  assert.equal(result.characterSheet.resources.magical_cunning.remaining, 1);
  assert.equal(result.characterSheet.spellcasting.slots[1], 2);
  assert.equal(result.characterSheet.spellcasting.slots_max[1], 2);
  assert.equal(result.characterSheet.spellcasting.prepared_spells_count, 3);
  assert(result.characterSheet.class_choice_spells.some((spell) => spell.id === 'mage_armor' && spell.type === 'at_will'));
  assert.equal(result.characterSheet.derived_stats.attack_breakdowns.some((attack) => attack.weapon_id === 'spear' && attack.pact_weapon), true);
});

test('new Pact of the Blade choice records and exposes its Charisma pact weapon attack', () => {
  const result = applyLevelUp({
    characterSheet: baseSheet({
      identity: { class: 'warlock', class_name: 'Warlock', experience_points: 300, level_up_available: true },
      abilities: { modifiers: { str: 0, dex: 1, con: 2, int: 0, wis: 0, cha: 3 } },
      class_choices: { eldritch_invocation: 'armor_of_shadows' },
      spellcasting: { ability: 'cha', cantrips_known: ['eldritch_blast', 'mage_hand'], spells_prepared: ['hex', 'armor_of_agathys'], slots: { 1: 1 } },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
    payload: { choices: { eldritch_invocations: ['pact_of_the_blade', 'eldritch_mind'], pact_weapon: ['longsword'], prepared_spells: ['charm_person'] } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.characterSheet.class_choice_details.pact_of_the_blade.pact_weapon, 'longsword');
  const attack = result.characterSheet.derived_stats.attack_breakdowns.find((entry) => entry.weapon_id === 'longsword');
  assert.equal(attack.ability, 'cha');
  assert.equal(attack.attack_total, 5);
  assert.match(attack.name, /Pact Weapon/);
});

test('runtime repair adds the chosen Pact weapon attack to an already-leveled legacy sheet', () => {
  const legacy = baseSheet({
    identity: { class: 'warlock', class_name: 'Warlock', level: 2 },
    abilities: { modifiers: { str: 1, dex: 1, con: 2, int: 0, wis: 0, cha: 3 } },
    class_choices: { eldritch_invocation: 'armor_of_shadows', eldritch_invocations: ['armor_of_shadows', 'pact_of_the_blade', 'eldritch_mind'] },
    class_choice_details: { pact_of_the_blade: { pact_weapon: 'longsword' } },
    derived_stats: {
      level: 2,
      proficiency_bonus: 2,
      attack_breakdowns: [{ weapon_id: 'dagger', name: 'Dagger', ability: 'dex', attack_total: 3, damage_formula: '1d4 + 1' }],
    },
  });

  const repaired = repairPactWeaponAttack(legacy, getContentBundle());
  const pactAttack = repaired.derived_stats.attack_breakdowns.find((entry) => entry.pact_weapon);
  assert.equal(pactAttack.weapon_id, 'longsword');
  assert.equal(pactAttack.attack_total, 5);
  assert.equal(pactAttack.damage_formula, '1d8 + 3');
  assert.equal(repaired.derived_stats.attack_breakdowns.some((entry) => entry.weapon_id === 'dagger'), true);
  assert.strictEqual(repairPactWeaponAttack(repaired, getContentBundle()), repaired);
});

test('Warlock Pact of the Tome level-up choices become usable cantrips and rituals', () => {
  const result = applyLevelUp({
    characterSheet: baseSheet({
      identity: { class: 'warlock', class_name: 'Warlock', experience_points: 300, level_up_available: true },
      class_choices: { eldritch_invocation: 'armor_of_shadows' },
      spellcasting: {
        ability: 'cha',
        cantrips_known: ['eldritch_blast', 'mage_hand'],
        spells_prepared: ['hex', 'armor_of_agathys'],
        slots: { 1: 1 },
      },
      progression: { experience_points: 300 },
    }),
    content: getContentBundle(),
    payload: {
      choices: {
        eldritch_invocations: ['pact_of_the_tome', 'eldritch_mind'],
        pact_tome_cantrips: ['fire_bolt', 'guidance', 'prestidigitation'],
        pact_tome_rituals: ['find_familiar', 'identify'],
        prepared_spells: ['charm_person'],
      },
    },
  });

  assert.equal(result.ok, true);
  assert(result.characterSheet.spellcasting.cantrips_known.includes('guidance'));
  assert(result.characterSheet.spellcasting.ritual_spells.includes('find_familiar'));
  assert(result.characterSheet.class_choice_spells.some((spell) => spell.id === 'identify' && spell.type === 'ritual'));
  assert.deepEqual(result.characterSheet.class_choice_details.pact_of_the_tome.tome_cantrips, ['fire_bolt', 'guidance', 'prestidigitation']);
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
