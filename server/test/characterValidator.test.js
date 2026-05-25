process.env.OPENAI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContentBundle } = require('../src/contentData');
const { validateCharacter } = require('../src/characterValidator');

function baseDraft(overrides = {}) {
  return {
    name: 'Rulecheck',
    speciesId: 'human',
    speciesChoices: { size: 'medium' },
    languages: ['elvish', 'dwarvish'],
    characterDetails: {
      alignment: 'Chaotic Good',
      appearance: 'Travel-stained cloak and a heroic amount of optimism.',
      personality: 'Brave, curious, and only occasionally sensible.',
      backstory: 'Left home chasing rumors of trouble and treasure.',
    },
    classId: 'fighter',
    backgroundId: 'farmer',
    abilityMethod: 'standard_array',
    abilityScores: {
      str: 15,
      dex: 13,
      con: 14,
      int: 8,
      wis: 12,
      cha: 10,
      backgroundBonus: { str: 2, con: 1 },
    },
    selectedSkills: ['athletics', 'intimidation'],
    equipmentChoice: 'pack',
    backgroundEquipmentChoice: 'equipment',
    backgroundToolChoices: [],
    classChoices: { fighting_style: 'defense' },
    classChoiceDetails: {},
    classLanguages: [],
    weaponMasteries: ['longsword', 'dagger', 'longbow'],
    expertiseSkills: [],
    humanSkillId: 'perception',
    humanOriginFeatId: 'alert',
    featSkillChoices: {},
    magicInitiateChoices: {},
    cantripsKnown: [],
    spellsKnown: [],
    spellbookSpells: [],
    ...overrides,
  };
}

function originChoicesFor(background) {
  const content = getContentBundle();
  const feat = content.feats.find((item) => item.id === background.origin_feat);
  if (!feat) return {};
  if (feat.choice) {
    const skills = content.skills
      .map((skill) => skill.id)
      .filter((skillId) => !(background.skills || []).includes(skillId));
    const tools = content.tools
      .filter((tool) => !feat.choice.category || tool.category === feat.choice.category)
      .map((tool) => tool.id);
    const pool = feat.choice.type === 'tools'
      ? tools
      : feat.choice.type === 'skill_or_tool'
        ? [...skills, ...tools]
        : skills;
    return { featSkillChoices: { background_feat: pool.slice(0, feat.choice.count) } };
  }
  if (feat.magic_list) {
    const cantrips = content.spells
      .filter((spell) => spell.level === 0 && spell.classes.includes(feat.magic_list))
      .map((spell) => spell.id)
      .slice(0, 2);
    const spell = content.spells.find((item) => item.level === 1 && item.classes.includes(feat.magic_list))?.id;
    return { magicInitiateChoices: { background_feat: { cantrips, spell, ability: 'wis' } } };
  }
  return {};
}

function speciesChoicesFor(species) {
  const values = {};
  for (const choice of species.choices || []) {
    if (choice.type === 'skill') values[choice.id] = choice.options[0];
    if (choice.type === 'ability') values[choice.id] = choice.options[0];
    if (choice.type === 'option') values[choice.id] = choice.options[0].id;
  }
  return values;
}

function backgroundToolChoicesFor(background, content) {
  if (!background.tool_choice) return [];
  return content.tools
    .filter((tool) => !background.tool_choice.category || tool.category === background.tool_choice.category)
    .map((tool) => tool.id)
    .slice(0, background.tool_choice.count);
}

function fighterSkillsExcluding(excluded) {
  return ['acrobatics', 'animal_handling', 'athletics', 'history', 'insight', 'intimidation', 'perception', 'survival']
    .filter((skillId) => !excluded.has(skillId))
    .slice(0, 2);
}

function skillsForClass(characterClass, background, count = characterClass.skill_count) {
  const excluded = new Set(background.skills || []);
  return characterClass.skill_options
    .filter((skillId) => !excluded.has(skillId))
    .slice(0, count);
}

function spellDraftFor(characterClass, content, classChoices = {}) {
  const spellcasting = characterClass.spellcasting;
  if (!spellcasting) return {};
  const selectedOptions = (characterClass.class_choices || [])
    .map((choice) => (choice.options || []).find((option) => option.id === classChoices[choice.id]))
    .filter(Boolean);
  const extraCantrips = selectedOptions.reduce((sum, option) => sum + Number(option.extra_cantrips || 0), 0);
  const cantripCount = Number(spellcasting.cantrips || 0) + extraCantrips;
  const cantripsKnown = content.spells
    .filter((spell) => spell.level === 0 && spell.classes.includes(characterClass.id))
    .map((spell) => spell.id)
    .slice(0, cantripCount);
  const levelOneSpells = content.spells
    .filter((spell) => spell.level === 1 && spell.classes.includes(characterClass.id))
    .map((spell) => spell.id);
  const alwaysPrepared = new Set(spellcasting.always_prepared_spells || []);
  const choiceSpells = levelOneSpells.filter((spellId) => !alwaysPrepared.has(spellId));

  if (spellcasting.spellbook_spells) {
    const spellbookSpells = levelOneSpells.slice(0, spellcasting.spellbook_spells);
    return {
      cantripsKnown,
      spellbookSpells,
      spellsKnown: spellbookSpells.slice(0, spellcasting.prepared_spells || 0),
    };
  }

  return {
    cantripsKnown,
    spellsKnown: choiceSpells.slice(0, spellcasting.prepared_spells || 0),
  };
}

function classDraftFor(classId, overrides = {}) {
  const content = getContentBundle();
  const characterClass = content.classes.find((item) => item.id === classId);
  const background = content.backgrounds.find((item) => item.id === 'soldier');
  const classChoicesByClass = {
    cleric: { divine_order: 'protector' },
    druid: { primal_order: 'warden' },
    fighter: { fighting_style: 'defense' },
    warlock: { eldritch_invocation: 'armor_of_shadows' },
  };
  const weaponMasteriesByClass = {
    barbarian: ['greataxe', 'handaxe'],
    fighter: ['longsword', 'dagger', 'longbow'],
    paladin: ['longsword', 'mace'],
    ranger: ['longbow', 'shortsword'],
    rogue: ['dagger', 'shortsword'],
  };
  const classChoices = classChoicesByClass[classId] || {};
  const selectedSkills = skillsForClass(characterClass, background);
  return baseDraft({
    speciesId: 'dwarf',
    speciesChoices: {},
    backgroundId: 'soldier',
    backgroundToolChoices: backgroundToolChoicesFor(background, content),
    classId,
    abilityScores: {
      str: 15,
      dex: 13,
      con: 14,
      int: 10,
      wis: 12,
      cha: 8,
      backgroundBonus: { str: 2, con: 1 },
    },
    selectedSkills,
    humanSkillId: '',
    humanOriginFeatId: '',
    classChoices,
    classChoiceDetails: {},
    classLanguages: classId === 'rogue' ? ['goblin'] : [],
    weaponMasteries: weaponMasteriesByClass[classId] || [],
    expertiseSkills: classId === 'rogue' ? selectedSkills.slice(0, 2) : [],
    featSkillChoices: {},
    magicInitiateChoices: {},
    cantripsKnown: [],
    spellsKnown: [],
    spellbookSpells: [],
    ...spellDraftFor(characterClass, content, classChoices),
    ...overrides,
  });
}

test('applies Human Skillful, Human Versatile, background Origin feat, and static math', () => {
  const sheet = validateCharacter(baseDraft(), getContentBundle());

  assert.equal(sheet.origin.background_feat, 'tough');
  assert.equal(sheet.origin.human_origin_feat, 'alert');
  assert.equal(sheet.origin.human_skill, 'perception');
  assert.equal(sheet.character_details.alignment, 'Chaotic Good');
  assert.deepEqual(sheet.languages, ['common', 'elvish', 'dwarvish']);
  assert.equal(sheet.inventory.some((item) => item.id === 'background_equipment_farmer'), true);
  assert.equal(sheet.derived_stats.max_hp, 14);
  assert.equal(sheet.derived_stats.initiative, 3);
  assert.deepEqual(
    sheet.derived_stats.initiative_breakdown.map((part) => part.label),
    ['DEX modifier', 'Alert proficiency'],
  );
  assert.equal(sheet.derived_stats.skill_modifiers.perception.proficient, true);
  assert.equal(sheet.proficiencies.skills.includes('animal_handling'), true);
  assert.equal(sheet.proficiencies.skills.includes('athletics'), true);
});

test('requires Magic Initiate choices granted by a background Origin feat', () => {
  assert.throws(
    () => validateCharacter(baseDraft({
      speciesId: 'dwarf',
      speciesChoices: {},
      backgroundId: 'acolyte',
      abilityScores: {
        str: 15,
        dex: 13,
        con: 14,
        int: 10,
        wis: 12,
        cha: 8,
        backgroundBonus: { wis: 2, int: 1 },
      },
      selectedSkills: ['athletics', 'perception'],
      humanSkillId: '',
      humanOriginFeatId: '',
    }), getContentBundle()),
    /Magic Initiate.*two cantrips/,
  );

  const sheet = validateCharacter(baseDraft({
    speciesId: 'dwarf',
    speciesChoices: {},
    backgroundId: 'acolyte',
    abilityScores: {
      str: 15,
      dex: 13,
      con: 14,
      int: 10,
      wis: 12,
      cha: 8,
      backgroundBonus: { wis: 2, int: 1 },
    },
    selectedSkills: ['athletics', 'perception'],
    humanSkillId: '',
    humanOriginFeatId: '',
    magicInitiateChoices: {
      background_feat: { cantrips: ['light', 'guidance'], spell: 'bless', ability: 'wis' },
    },
  }), getContentBundle());

  assert.deepEqual(sheet.origin.magic_initiate.background_feat, {
    list: 'cleric',
    cantrips: ['light', 'guidance'],
    spell: 'bless',
    ability: 'wis',
  });
});

test('rejects duplicate non-repeatable Human Origin feats and duplicate granted skills', () => {
  assert.throws(
    () => validateCharacter(baseDraft({ humanOriginFeatId: 'tough' }), getContentBundle()),
    /different Origin feat/,
  );

  assert.throws(
    () => validateCharacter(baseDraft({ humanSkillId: 'animal_handling' }), getContentBundle()),
    /not already granted by the background/,
  );

  assert.throws(
    () => validateCharacter(baseDraft({ selectedSkills: ['athletics', 'perception'] }), getContentBundle()),
    /must not duplicate/,
  );
});

test('requires two standard language choices in addition to Common', () => {
  assert.throws(
    () => validateCharacter(baseDraft({ languages: ['elvish'] }), getContentBundle()),
    /exactly two languages/,
  );

  assert.throws(
    () => validateCharacter(baseDraft({ languages: ['elvish', 'infernal'] }), getContentBundle()),
    /standard languages/,
  );
});

test('records background 50 GP alternative and validates character detail lengths', () => {
  const sheet = validateCharacter(baseDraft({
    backgroundEquipmentChoice: 'gold',
    characterDetails: { alignment: 'Neutral', appearance: '', personality: '', backstory: '' },
  }), getContentBundle());

  assert.equal(sheet.inventory.some((item) => item.id === 'background_50_gp' && item.quantity === 50), true);
  assert.equal(sheet.character_details.alignment, 'Neutral');

  assert.throws(
    () => validateCharacter(baseDraft({ characterDetails: { backstory: 'x'.repeat(801) } }), getContentBundle()),
    /800 characters/,
  );
});

test('validates every 2024 background with its Origin feat requirements', () => {
  const content = getContentBundle();
  for (const background of content.backgrounds) {
    const [first, second] = background.asi_options;
    const originChoiceDraft = originChoicesFor(background);
    const originSkillChoices = Object.values(originChoiceDraft.featSkillChoices || {}).flat();
    const excluded = new Set([...(background.skills || []), ...originSkillChoices]);
    const sheet = validateCharacter(baseDraft({
      speciesId: 'dwarf',
      speciesChoices: {},
      backgroundId: background.id,
      abilityScores: {
        str: 15,
        dex: 13,
        con: 14,
        int: 10,
        wis: 12,
        cha: 8,
        backgroundBonus: { [first]: 2, [second]: 1 },
      },
      selectedSkills: fighterSkillsExcluding(excluded),
      backgroundToolChoices: backgroundToolChoicesFor(background, content),
      humanSkillId: '',
      humanOriginFeatId: '',
      ...originChoiceDraft,
    }), content);

    assert.equal(sheet.origin.background_feat, background.origin_feat);
    assert.equal(sheet.identity.background, background.id);
  }
});

test('validates every 2024 species and applies species-level rules', () => {
  const content = getContentBundle();
  const background = content.backgrounds.find((item) => item.id === 'soldier');
  for (const species of content.species) {
    const speciesChoices = speciesChoicesFor(species);
    const speciesSkillChoices = (species.choices || [])
      .filter((choice) => choice.type === 'skill')
      .map((choice) => speciesChoices[choice.id]);
    const excluded = new Set([...(background.skills || []), ...speciesSkillChoices]);
    const sheet = validateCharacter(baseDraft({
      speciesId: species.id,
      speciesChoices,
      backgroundId: 'soldier',
      backgroundToolChoices: backgroundToolChoicesFor(background, content),
      abilityScores: {
        str: 15,
        dex: 13,
        con: 14,
        int: 8,
        wis: 12,
        cha: 10,
        backgroundBonus: { str: 2, dex: 1 },
      },
      selectedSkills: fighterSkillsExcluding(excluded),
      humanSkillId: species.id === 'human' ? 'perception' : '',
      humanOriginFeatId: species.id === 'human' ? 'alert' : '',
      featSkillChoices: {},
      magicInitiateChoices: {},
    }), content);

    assert.equal(sheet.identity.species, species.id);
    for (const skillId of speciesSkillChoices) {
      assert.equal(sheet.derived_stats.skill_modifiers[skillId].proficient, true);
    }
    if (species.id === 'dwarf') assert.equal(sheet.derived_stats.max_hp, 13);
    if (species.id === 'elf' && speciesChoices.elven_lineage === 'drow') {
      assert.equal(sheet.derived_stats.senses.darkvision, 120);
      assert.equal(sheet.species_spells.some((spell) => spell.id === 'dancing_lights'), true);
    }
    if (species.id === 'tiefling') {
      assert.equal(sheet.species_spells.some((spell) => spell.id === 'thaumaturgy'), true);
    }
  }
});

test('caster spell lists cover the largest level 1 creation choices', () => {
  const content = getContentBundle();
  for (const characterClass of content.classes) {
    const spellcasting = characterClass.spellcasting;
    if (!spellcasting) continue;
    const cantripOptions = content.spells.filter((spell) => spell.level === 0 && spell.classes.includes(characterClass.id));
    const levelOneOptions = content.spells.filter((spell) => spell.level === 1 && spell.classes.includes(characterClass.id));
    const requiredLevelOne = spellcasting.prepared_spells || 0;

    assert.ok(
      cantripOptions.length >= (spellcasting.cantrips || 0),
      `${characterClass.name} needs ${spellcasting.cantrips || 0} cantrips but only has ${cantripOptions.length}`,
    );
    assert.ok(
      levelOneOptions.length >= requiredLevelOne,
      `${characterClass.name} needs ${requiredLevelOne} level 1 spell choices but only has ${levelOneOptions.length}`,
    );
  }
});

test('level 1 spellcasters use fixed 2024 prepared spell counts', () => {
  const content = getContentBundle();
  const expectedCounts = {
    bard: 4,
    cleric: 4,
    druid: 4,
    paladin: 2,
    ranger: 2,
    sorcerer: 2,
    warlock: 2,
    wizard: 4,
  };

  for (const [classId, expectedCount] of Object.entries(expectedCounts)) {
    const characterClass = content.classes.find((item) => item.id === classId);
    assert.equal(characterClass?.spellcasting?.prepared_spells, expectedCount, `${classId} prepared spell count`);
  }
});

test('validates every available level 1 class with required 2024 class choices', () => {
  const content = getContentBundle();
  for (const characterClass of content.classes) {
    const sheet = validateCharacter(classDraftFor(characterClass.id), content);
    assert.equal(sheet.identity.class, characterClass.id);
    assert.equal((sheet.weapon_masteries || []).length, characterClass.weapon_mastery_count || 0);
    assert.equal((sheet.expertise_skills || []).length, characterClass.expertise_count || 0);
  }
});

test('level 1 option catalogs expose 2024 choices that drive later mechanics', () => {
  const content = getContentBundle();
  const fighter = content.classes.find((item) => item.id === 'fighter');
  const warlock = content.classes.find((item) => item.id === 'warlock');
  const druid = content.classes.find((item) => item.id === 'druid');
  const rogue = content.classes.find((item) => item.id === 'rogue');
  const fightingStyles = fighter.class_choices[0].options.map((option) => option.id);
  const invocations = warlock.class_choices[0].options.map((option) => option.id);
  const weapons = content.equipment.filter((item) => item.type === 'weapon' && ['simple', 'martial'].includes(item.weapon_category));

  assert.deepEqual(fightingStyles.sort(), [
    'archery',
    'blind_fighting',
    'defense',
    'dueling',
    'great_weapon_fighting',
    'interception',
    'protection',
    'thrown_weapon_fighting',
    'two_weapon_fighting',
    'unarmed_fighting',
  ].sort());
  assert.deepEqual(invocations.sort(), [
    'armor_of_shadows',
    'eldritch_mind',
    'pact_of_the_blade',
    'pact_of_the_chain',
    'pact_of_the_tome',
  ].sort());
  assert.equal(weapons.length, 36);
  assert.equal(new Set(weapons.map((weapon) => weapon.mastery)).size >= 8, true);
  assert.equal(druid.class_languages.includes('druidic'), true);
  assert.equal(druid.spellcasting.always_prepared_spells.includes('speak_with_animals'), true);
  assert.equal(rogue.class_languages.includes('thieves_cant'), true);
  assert.equal(rogue.class_language_choice_count, 1);
  assert.ok(content.tools.filter((tool) => tool.category === 'artisan').length >= 17);
  assert.ok(content.tools.filter((tool) => tool.category === 'instrument').length >= 10);
});

test('origin feat subchoices record tools and Magic Initiate ability', () => {
  const content = getContentBundle();
  const crafter = validateCharacter(baseDraft({
    speciesId: 'dwarf',
    speciesChoices: {},
    backgroundId: 'artisan',
    backgroundToolChoices: ['smith_tools'],
    abilityScores: {
      str: 15,
      dex: 13,
      con: 14,
      int: 10,
      wis: 12,
      cha: 8,
      backgroundBonus: { str: 2, dex: 1 },
    },
    selectedSkills: ['athletics', 'perception'],
    humanSkillId: '',
    humanOriginFeatId: '',
    featSkillChoices: {
      background_feat: ['smith_tools', 'weaver_tools', 'woodcarver_tools'],
    },
  }), content);
  assert.deepEqual(crafter.origin.tool_choices.background_feat, ['smith_tools', 'weaver_tools', 'woodcarver_tools']);
  assert.equal(crafter.proficiencies.tools.includes('smith_tools'), true);

  assert.throws(
    () => validateCharacter(baseDraft({
      speciesId: 'dwarf',
      speciesChoices: {},
      backgroundId: 'acolyte',
      abilityScores: {
        str: 15,
        dex: 13,
        con: 14,
        int: 10,
        wis: 12,
        cha: 8,
        backgroundBonus: { wis: 2, int: 1 },
      },
      selectedSkills: ['athletics', 'perception'],
      humanSkillId: '',
      humanOriginFeatId: '',
      magicInitiateChoices: {
        background_feat: { cantrips: ['light', 'guidance'], spell: 'bless' },
      },
    }), content),
    /spellcasting ability/,
  );
});

test('Warlock Pact options validate subchoices and expose class-choice spells', () => {
  const content = getContentBundle();
  const tome = validateCharacter(classDraftFor('warlock', {
    classChoices: { eldritch_invocation: 'pact_of_the_tome' },
    classChoiceDetails: {
      eldritch_invocation: {
        tome_cantrips: ['guidance', 'thaumaturgy', 'druidcraft'],
        tome_rituals: ['alarm', 'identify'],
      },
    },
  }), content);
  assert.equal(tome.spellcasting.cantrips_known.includes('guidance'), true);
  assert.deepEqual(tome.spellcasting.ritual_spells, ['alarm', 'identify']);
  assert.equal(tome.class_choice_spells.length, 5);

  const chain = validateCharacter(classDraftFor('warlock', {
    classChoices: { eldritch_invocation: 'pact_of_the_chain' },
    classChoiceDetails: {
      eldritch_invocation: { familiar_form: 'imp' },
    },
  }), content);
  assert.equal(chain.class_choice_details.eldritch_invocation.familiar_form, 'imp');
  assert.equal(chain.class_choice_spells.some((entry) => entry.id === 'find_familiar' && entry.type === 'ritual'), true);

  assert.throws(
    () => validateCharacter(classDraftFor('warlock', {
      classChoices: { eldritch_invocation: 'pact_of_the_blade' },
      classChoiceDetails: { eldritch_invocation: {} },
    }), content),
    /Pact Weapon/,
  );
});

test('class choices can grant level 1 proficiencies and extra cantrips', () => {
  const content = getContentBundle();
  const protector = validateCharacter(classDraftFor('cleric', {
    classChoices: { divine_order: 'protector' },
    cantripsKnown: ['light', 'mending', 'thaumaturgy'],
    spellsKnown: ['cure_wounds', 'bless', 'command', 'shield_of_faith'],
  }), content);
  assert.equal(protector.proficiencies.armor.includes('heavy'), true);
  assert.equal(protector.proficiencies.weapons.includes('martial'), true);

  const thaumaturge = validateCharacter(classDraftFor('cleric', {
    classChoices: { divine_order: 'thaumaturge' },
    cantripsKnown: ['light', 'mending', 'thaumaturgy', 'sacred_flame'],
    spellsKnown: ['cure_wounds', 'bless', 'command', 'shield_of_faith'],
  }), content);
  assert.equal(thaumaturge.spellcasting.cantrips_known.length, 4);
});

test('Rogue Expertise doubles proficiency on selected proficient skills', () => {
  const content = getContentBundle();
  const sheet = validateCharacter(classDraftFor('rogue', {
    selectedSkills: ['deception', 'insight', 'investigation', 'perception'],
    expertiseSkills: ['deception', 'insight'],
  }), content);

  assert.equal(sheet.derived_stats.skill_modifiers.deception.expertise, true);
  assert.equal(sheet.derived_stats.skill_modifiers.deception.total, 3);
  assert.equal(sheet.derived_stats.skill_modifiers.investigation.expertise, false);
  assert.equal(sheet.derived_stats.skill_modifiers.investigation.total, 2);
});

test('Wizard records six spellbook spells and prepares from that spellbook', () => {
  const content = getContentBundle();
  const sheet = validateCharacter(classDraftFor('wizard', {
    spellbookSpells: ['magic_missile', 'shield', 'detect_magic', 'charm_person', 'mage_armor', 'sleep'],
    spellsKnown: ['magic_missile', 'shield', 'detect_magic', 'charm_person'],
  }), content);

  assert.equal(sheet.spellcasting.spellbook_spells.length, 6);
  assert.deepEqual(sheet.spellcasting.spells_prepared, ['magic_missile', 'shield', 'detect_magic', 'charm_person']);

  assert.throws(
    () => validateCharacter(classDraftFor('wizard', {
      spellbookSpells: ['magic_missile', 'shield', 'detect_magic', 'charm_person', 'mage_armor', 'sleep'],
      spellsKnown: ['magic_missile', 'shield', 'detect_magic', 'thunderwave'],
    }), content),
    /must come from your spellbook/,
  );
});

test("Ranger adds Hunter's Mark as an always-prepared free-use class spell", () => {
  const content = getContentBundle();
  const sheet = validateCharacter(classDraftFor('ranger', {
    spellsKnown: ['cure_wounds', 'speak_with_animals'],
  }), content);

  assert.deepEqual(sheet.spellcasting.prepared_from_choices, ['cure_wounds', 'speak_with_animals']);
  assert.equal(sheet.spellcasting.always_prepared_spells.includes('hunter_mark'), true);
  assert.equal(sheet.spellcasting.spells_prepared.includes('hunter_mark'), true);
  assert.equal(sheet.resources.spell_uses['class_feature:favored_enemy:hunter_mark'].remaining, 2);
});

test('validates Human Paladin Noble with high Charisma and spell choices', () => {
  const content = getContentBundle();
  const sheet = validateCharacter(baseDraft({
    name: 'Noble Paladin',
    speciesId: 'human',
    speciesChoices: { size: 'medium' },
    backgroundId: 'noble',
    backgroundToolChoices: ['dice_set'],
    classId: 'paladin',
    classChoices: {},
    weaponMasteries: ['longsword', 'mace'],
    abilityScores: {
      str: 14,
      dex: 10,
      con: 13,
      int: 8,
      wis: 12,
      cha: 15,
      backgroundBonus: { cha: 2, str: 1 },
    },
    selectedSkills: ['athletics', 'insight'],
    humanSkillId: 'deception',
    humanOriginFeatId: 'magic_initiate_cleric',
    featSkillChoices: {
      background_feat: ['acrobatics', 'arcana', 'animal_handling'],
    },
    magicInitiateChoices: {
      human_feat: { cantrips: ['light', 'guidance'], spell: 'healing_word', ability: 'wis' },
    },
    cantripsKnown: [],
    spellsKnown: ['cure_wounds', 'shield_of_faith'],
  }), content);

  assert.equal(sheet.identity.class, 'paladin');
  assert.deepEqual(sheet.spellcasting.spells_prepared, ['cure_wounds', 'shield_of_faith']);
  assert.equal(sheet.origin.magic_initiate.human_feat.spell, 'healing_word');
  assert.equal(sheet.derived_stats.spell_save_dc, 13);
});

test('Paladin level 1 prepares two spells even with low Charisma', () => {
  const content = getContentBundle();
  const sheet = validateCharacter(baseDraft({
    name: 'Low Charm Paladin',
    speciesId: 'dwarf',
    speciesChoices: {},
    languages: ['elvish', 'dwarvish'],
    backgroundId: 'guard',
    backgroundToolChoices: ['dice_set'],
    classId: 'paladin',
    classChoices: {},
    weaponMasteries: ['longsword', 'mace'],
    abilityScores: {
      str: 15,
      dex: 10,
      con: 14,
      int: 12,
      wis: 13,
      cha: 8,
      backgroundBonus: { str: 2, wis: 1 },
    },
    selectedSkills: ['insight', 'intimidation'],
    humanSkillId: '',
    humanOriginFeatId: '',
    featSkillChoices: {},
    magicInitiateChoices: {},
    cantripsKnown: [],
    spellsKnown: ['cure_wounds', 'bless'],
  }), content);

  assert.deepEqual(sheet.spellcasting.spells_prepared, ['cure_wounds', 'bless']);
});
