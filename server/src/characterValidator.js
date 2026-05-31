const { byId } = require('./contentData');
const {
  getFightingStyleArmorBonus,
  getFightingStyleAttackBonus,
} = require('./fightingStyleEngine');

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const WEAPON_MASTERY_DESCRIPTIONS = {
  cleave: 'On a strong melee hit, the referee can carry damage into a second nearby creature when the weapon supports it.',
  graze: 'A heavy melee weapon can still deal a small amount of ability-based damage on a miss.',
  nick: 'Lets a light off-hand strike fold into the Attack action instead of needing the Bonus Action.',
  push: 'A hit can shove the target away when the weapon supports that impact.',
  sap: 'A hit can hinder the target and make its next attack less reliable.',
  slow: 'A hit can reduce the target speed briefly.',
  topple: 'A hit can force the target to resist being knocked prone.',
  vex: 'A hit can set up advantage on your next attack against that target.',
};

function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function proficiencyBonus(level) {
  return Math.floor((level - 1) / 4) + 2;
}

function normalizeId(value) {
  return String(value || '').trim();
}

function titleCase(value) {
  return String(value || '').replace(/\b\w/g, (char) => char.toUpperCase());
}

function fail(step, field, message) {
  const error = new Error(message);
  error.step = step;
  error.field = field;
  throw error;
}

function validateCharacter(draft, content, { sessionId, campaignId, verifyRolledStats } = {}) {
  if (!draft || typeof draft !== 'object') fail('review', 'character', 'Character data is missing.');

  const name = String(draft.name || '').trim();
  if (!name) fail('identity', 'name', 'Character name is required.');
  if (name.length > 30) fail('identity', 'name', 'Character name must be 30 characters or fewer.');

  const species = byId(content.species, normalizeId(draft.speciesId));
  if (!species) fail('identity', 'speciesId', 'Choose a valid species.');

  const characterClass = byId(content.classes, normalizeId(draft.classId));
  if (!characterClass) fail('class', 'classId', 'Choose a valid class.');

  const background = byId(content.backgrounds, normalizeId(draft.backgroundId));
  if (!background) fail('background', 'backgroundId', 'Choose a valid background.');

  const characterDetails = validateCharacterDetails(draft.characterDetails);
  const abilityData = validateAbilityScores(draft.abilityMethod, draft.abilityScores, draft.rolledStats, background, verifyRolledStats);
  const abilityScores = abilityData.finalScores;
  const abilityModifiers = Object.fromEntries(ABILITIES.map((ability) => [ability, abilityMod(abilityScores[ability])]));

  const selectedSkills = Array.isArray(draft.selectedSkills) ? draft.selectedSkills.map(normalizeId) : [];
  const backgroundTools = validateBackgroundTools(draft, background, content);
  const baseLanguages = validateLanguages(draft, content);
  const speciesData = validateSpeciesChoices(draft, species, content);
  const origin = validateOriginChoices(draft, species, background, content, speciesData.skillProficiencies);
  const skillSet = validateSkills(selectedSkills, characterClass, background, content, [
    ...speciesData.skillProficiencies,
    ...origin.skillProficiencies,
  ]);
  const classData = validateClassLevelChoices(draft, characterClass, content, skillSet);
  const languages = [...new Set([...baseLanguages, ...classData.classLanguages])];

  const equipmentChoice = normalizeId(draft.equipmentChoice || 'pack');
  if (!['pack', 'gold'].includes(equipmentChoice)) {
    fail('equipment', 'equipmentChoice', 'Choose equipment pack or gold.');
  }
  const backgroundEquipmentChoice = normalizeId(draft.backgroundEquipmentChoice || 'equipment');
  if (!['equipment', 'gold'].includes(backgroundEquipmentChoice)) {
    fail('equipment', 'backgroundEquipmentChoice', 'Choose background equipment package or 50 GP.');
  }

  const inventory = buildInventory(characterClass, content, equipmentChoice, background, backgroundEquipmentChoice);
  const equipped = buildEquipped(inventory, content);
  const featEffects = origin.feats.flatMap((entry) => (entry.feat.effects || []).map((effect) => ({
    ...effect,
    source_feat_id: entry.feat.id,
    source_feat_name: entry.feat.name,
  })));
  const activeEffects = [...buildActiveEffects(equipped, content), ...speciesData.effects, ...featEffects];

  const spellcasting = buildSpellcasting(draft, characterClass, content, abilityModifiers, classData);
  const resources = buildClassResources(characterClass, content);
  const level = 1;
  const pb = proficiencyBonus(level);
  const maxHpBonus = activeEffects
    .filter((effect) => effect.target === 'max_hp_per_level_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0) * level, 0);
  const maxHp = Math.max(1, characterClass.hit_die + abilityModifiers.con + maxHpBonus);
  const armorBreakdown = calculateArmorClass(equipped, content, abilityModifiers, activeEffects, characterClass, classData);
  const initiativeBreakdown = calculateInitiative(abilityModifiers, pb, activeEffects);
  const derivedStats = {
    level,
    proficiency_bonus: pb,
    max_hp: maxHp,
    hp: maxHp,
    temp_hp: 0,
    armor_class: armorBreakdown.total,
    armor_class_breakdown: armorBreakdown.parts,
    speed: species.speed + activeEffects
      .filter((effect) => effect.target === 'speed_bonus')
      .reduce((sum, effect) => sum + Number(effect.value || 0), 0),
    senses: {
      darkvision: activeEffects
        .filter((effect) => effect.target === 'darkvision_override')
        .reduce((value, effect) => Math.max(value, Number(effect.value || 0)), species.darkvision || 0),
    },
    initiative: initiativeBreakdown.total,
    initiative_breakdown: initiativeBreakdown.parts,
    death_saves: { successes: 0, failures: 0 },
    skill_modifiers: buildSkillModifiers(content.skills, skillSet, abilityModifiers, pb, classData.expertiseSkills),
    saving_throw_modifiers: buildSaveModifiers(characterClass.saving_throws, abilityModifiers, pb),
    attack_breakdowns: buildAttackBreakdowns(equipped, content, abilityModifiers, pb, activeEffects, classData),
  };

  if (spellcasting) {
    const castingMod = abilityModifiers[spellcasting.ability] || 0;
    derivedStats.spell_attack_bonus = castingMod + pb;
    derivedStats.spell_save_dc = 8 + castingMod + pb;
  }

  return {
    schema_version: 1,
    session_id: sessionId || null,
    campaign_id: campaignId || null,
    identity: {
      name,
      species: species.id,
      species_name: species.name,
      class: characterClass.id,
      class_name: characterClass.name,
      background: background.id,
      background_name: background.name,
      level,
      experience_points: 0,
      status: 'active',
    },
    abilities: {
      method: abilityData.method,
      base_scores: abilityData.baseScores,
      background_bonus: abilityData.backgroundBonus,
      final_scores: abilityScores,
      modifiers: abilityModifiers,
      audit: abilityData.audit,
    },
    character_details: characterDetails,
    proficiencies: {
      saving_throws: characterClass.saving_throws,
      skills: [...skillSet],
      species_skills: speciesData.skillProficiencies,
      background_skills: background.skills,
      class_skills: selectedSkills,
      origin_skills: origin.skillProficiencies,
      tools: [...new Set([...backgroundTools, ...origin.toolProficiencies].filter(Boolean))],
      languages,
      armor: [...new Set([...(characterClass.armor || []), ...classData.armorProficiencies])],
      weapons: [...new Set([...(characterClass.weapons || []), ...classData.weaponProficiencies])],
    },
    inventory,
    equipped,
    active_effects: activeEffects,
    resistances: speciesData.resistances,
    features: [
      ...species.traits.map((trait) => ({
        source: 'species',
        name: trait.name,
        description: trait.description,
      })),
      {
        source: 'background',
        name: background.name,
        description: background.description,
      },
      ...origin.feats.map((entry) => ({
        source: entry.source,
        name: entry.feat.name,
        description: entry.feat.description,
      })),
      ...(characterClass.class_features || []).map((feature) => ({
        source: 'class',
        name: feature.name,
        description: feature.description,
      })),
      ...classData.features,
    ],
    species_choices: speciesData.choices,
    species_spells: speciesData.spells,
    class_choices: classData.choices,
    class_choice_details: classData.choiceDetails,
    class_choice_spells: classData.choiceSpells,
    weapon_masteries: classData.weaponMasteries,
    expertise_skills: classData.expertiseSkills,
    languages,
    origin: {
      background_feat: origin.backgroundFeat?.id || null,
      background_tool_choices: backgroundTools,
      human_origin_feat: origin.humanFeat?.id || null,
      human_skill: origin.humanSkill || null,
      skill_choices: origin.skillChoices,
      tool_choices: origin.toolChoices,
      magic_initiate: origin.magicInitiate,
    },
    spellcasting,
    resources,
    derived_stats: derivedStats,
    notes: {
      item_math_rule: 'Inventory does not alter math unless an item is equipped, attuned, or otherwise active.',
    },
  };
}

function validateAbilityScores(method, scores, rolledStats, background, verifyRolledStats) {
  const selectedMethod = normalizeId(method);
  if (!['standard_array', 'point_buy', 'rolled'].includes(selectedMethod)) {
    fail('abilities', 'abilityMethod', 'Choose an ability score method.');
  }

  const baseScores = {};
  for (const ability of ABILITIES) {
    const value = Number(scores?.[ability]);
    if (!Number.isInteger(value)) fail('abilities', ability, `Set ${ability.toUpperCase()}.`);
    baseScores[ability] = value;
  }

  if (selectedMethod === 'standard_array') {
    const sorted = Object.values(baseScores).sort((a, b) => b - a);
    if (JSON.stringify(sorted) !== JSON.stringify(STANDARD_ARRAY)) {
      fail('abilities', 'abilityScores', 'Standard Array must use 15, 14, 13, 12, 10, and 8 exactly once.');
    }
  }

  if (selectedMethod === 'point_buy') {
    let spent = 0;
    const costs = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
    for (const value of Object.values(baseScores)) {
      if (!(value in costs)) fail('abilities', 'abilityScores', 'Point Buy scores must be between 8 and 15.');
      spent += costs[value];
    }
    if (spent !== 27) fail('abilities', 'abilityScores', 'Point Buy must spend exactly 27 points.');
  }

  if (selectedMethod === 'rolled') {
    const accepted = rolledStats?.acceptedSet;
    const attemptsUsed = Number(rolledStats?.attemptsUsed);
    if (!Array.isArray(accepted) || accepted.length !== 6) {
      fail('abilities', 'rolledStats', 'Rolled Stats must submit one accepted set of six scores.');
    }
    if (!Number.isInteger(attemptsUsed) || attemptsUsed < 1 || attemptsUsed > 3) {
      fail('abilities', 'rolledStats', 'Rolled Stats attempts must be between 1 and 3.');
    }
    if (typeof verifyRolledStats !== 'function' || !verifyRolledStats(rolledStats)) {
      fail('abilities', 'rolledStats', 'Rolled Stats must come from the server dice roller.');
    }
    const assigned = Object.values(baseScores).sort((a, b) => b - a);
    const acceptedSorted = accepted.map(Number).sort((a, b) => b - a);
    if (acceptedSorted.some((value) => !Number.isInteger(value) || value < 3 || value > 18)) {
      fail('abilities', 'rolledStats', 'Rolled Stats values must be between 3 and 18.');
    }
    if (JSON.stringify(assigned) !== JSON.stringify(acceptedSorted)) {
      fail('abilities', 'rolledStats', 'Assigned rolled scores must match the accepted roll set.');
    }
  }

  const backgroundBonus = validateBackgroundBonus(background, scores?.backgroundBonus);
  const finalScores = {};
  const audit = {};
  for (const ability of ABILITIES) {
    finalScores[ability] = baseScores[ability] + (backgroundBonus[ability] || 0);
    if (finalScores[ability] < 3 || finalScores[ability] > 20) {
      fail('abilities', ability, `${ability.toUpperCase()} must end between 3 and 20.`);
    }
    audit[ability] = {
      base: baseScores[ability],
      background_bonus: backgroundBonus[ability] || 0,
      final: finalScores[ability],
      modifier: abilityMod(finalScores[ability]),
    };
  }

  return {
    method: selectedMethod,
    baseScores,
    backgroundBonus,
    finalScores,
    audit,
  };
}

function validateBackgroundBonus(background, submittedBonus) {
  const bonus = {};
  for (const ability of ABILITIES) bonus[ability] = Number(submittedBonus?.[ability] || 0);
  const allowed = new Set(background.asi_options || []);
  const entries = Object.entries(bonus).filter(([, value]) => value !== 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const values = entries.map(([, value]) => value).sort((a, b) => b - a);
  const validShape = JSON.stringify(values) === JSON.stringify([2, 1])
    || JSON.stringify(values) === JSON.stringify([1, 1, 1]);
  if (total !== 3 || !validShape) {
    fail('background', 'backgroundBonus', 'Background bonus must assign +2/+1 or +1/+1/+1 to eligible abilities.');
  }
  for (const [ability] of entries) {
    if (!allowed.has(ability)) {
      fail('background', 'backgroundBonus', 'Background bonuses must use the background eligible abilities.');
    }
  }
  return bonus;
}

function validateCharacterDetails(input = {}) {
  const details = {
    alignment: String(input.alignment || '').trim(),
    appearance: String(input.appearance || '').trim(),
    personality: String(input.personality || '').trim(),
    backstory: String(input.backstory || '').trim(),
  };
  if (details.alignment.length > 40) fail('details', 'alignment', 'Alignment must be 40 characters or fewer.');
  if (details.appearance.length > 500) fail('details', 'appearance', 'Appearance must be 500 characters or fewer.');
  if (details.personality.length > 500) fail('details', 'personality', 'Personality must be 500 characters or fewer.');
  if (details.backstory.length > 800) fail('details', 'backstory', 'Backstory note must be 800 characters or fewer.');
  return details;
}

function validateBackgroundTools(draft, background, content) {
  const choice = background.tool_choice;
  if (!choice) return [background.tool].filter(Boolean);

  const selected = Array.isArray(draft.backgroundToolChoices)
    ? draft.backgroundToolChoices.map(normalizeId).filter(Boolean)
    : [];
  const unique = [...new Set(selected)];
  if (unique.length !== selected.length) fail('background', 'backgroundToolChoices', 'Background tool choices cannot repeat.');
  if (unique.length !== Number(choice.count || 0)) {
    fail('background', 'backgroundToolChoices', `${background.name} must choose ${choice.count} ${formatChoiceKind(choice)}.`);
  }
  const allowedTools = getToolChoiceOptions(choice, content);
  const allowed = new Set(allowedTools.map((tool) => tool.id));
  for (const toolId of unique) {
    if (!allowed.has(toolId)) fail('background', 'backgroundToolChoices', `Choose a valid ${background.tool}.`);
  }
  return unique;
}

function validateLanguages(draft, content) {
  const allLanguages = new Set((content.languages || []).map((language) => language.id));
  const standardLanguages = new Set((content.languages || [])
    .filter((language) => language.category === 'standard' && language.id !== 'common')
    .map((language) => language.id));
  const selected = Array.isArray(draft.languages) ? draft.languages.map(normalizeId).filter(Boolean) : [];
  const unique = [...new Set(selected)];
  if (unique.length !== 2) fail('origin', 'languages', 'Choose exactly two languages in addition to Common.');
  for (const languageId of unique) {
    if (!allLanguages.has(languageId)) fail('origin', 'languages', 'Choose valid languages.');
    if (!standardLanguages.has(languageId)) fail('origin', 'languages', 'Starting language choices must be standard languages.');
  }
  return ['common', ...unique];
}

function validateSpeciesChoices(draft, species, content) {
  const submitted = draft.speciesChoices && typeof draft.speciesChoices === 'object' ? draft.speciesChoices : {};
  const allSkillIds = new Set(content.skills.map((skill) => skill.id));
  const allSpellIds = new Set(content.spells.map((spell) => spell.id));
  const choices = {};
  const skillProficiencies = [];
  const spells = [];
  const resistances = [];
  const effects = [];

  for (const trait of species.traits || []) {
    for (const spellId of trait.spells || []) {
      if (!allSpellIds.has(spellId)) fail('species', 'spells', `${species.name} references an unavailable species spell.`);
      spells.push({ id: spellId, source: trait.name, ability: trait.spellcasting_ability || null });
    }
    resistances.push(...(trait.resistances || []));
    effects.push(...(trait.effects || []).map((effect) => ({
      ...effect,
      source_species_id: species.id,
      source_species_name: species.name,
      source_trait_name: trait.name,
    })));
  }

  for (const choice of species.choices || []) {
    const value = normalizeId(submitted[choice.id]);
    if (choice.required && !value) fail('species', choice.id, `${species.name} requires ${choice.label}.`);

    if (choice.type === 'skill') {
      const allowed = new Set(choice.options || []);
      if (!allowed.has(value) || !allSkillIds.has(value)) fail('species', choice.id, `Choose a valid ${choice.label}.`);
      choices[choice.id] = value;
      skillProficiencies.push(value);
      continue;
    }

    if (choice.type === 'ability') {
      if (!ABILITIES.includes(value) || !(choice.options || []).includes(value)) fail('species', choice.id, `Choose a valid ${choice.label}.`);
      choices[choice.id] = value;
      continue;
    }

    if (choice.type === 'option') {
      const option = (choice.options || []).find((item) => item.id === value);
      if (!option) fail('species', choice.id, `Choose a valid ${choice.label}.`);
      choices[choice.id] = value;
      for (const spellId of option.spells || []) {
        if (!allSpellIds.has(spellId)) fail('species', choice.id, `${option.name} references an unavailable species spell.`);
        spells.push({ id: spellId, source: option.name, ability: null });
      }
      resistances.push(...(option.resistances || []));
      effects.push(...(option.effects || []).map((effect) => ({
        ...effect,
        source_species_id: species.id,
        source_species_name: species.name,
        source_trait_name: option.name,
      })));
    }
  }

  const spellAbility = choices.lineage_spell_ability || choices.legacy_spell_ability || null;
  return {
    choices,
    skillProficiencies: [...new Set(skillProficiencies)],
    spells: spells.map((spell) => ({ ...spell, ability: spell.ability || spellAbility })),
    resistances: [...new Set(resistances)],
    effects,
  };
}

function validateOriginChoices(draft, species, background, content, speciesSkills = []) {
  const backgroundFeat = byId(content.feats, normalizeId(background.origin_feat));
  if (!backgroundFeat || backgroundFeat.category !== 'origin') {
    fail('background', 'origin_feat', 'Background must grant a valid Origin feat.');
  }

  const isHuman = species.id === 'human';
  const allSkillIds = new Set(content.skills.map((skill) => skill.id));
  const allToolIds = new Set((content.tools || []).map((tool) => tool.id));
  const originFeats = content.feats.filter((feat) => feat.category === 'origin');
  const humanFeatId = normalizeId(draft.humanOriginFeatId);
  const humanFeat = isHuman ? byId(originFeats, humanFeatId) : null;
  if (isHuman && !humanFeat) {
    fail('origin', 'humanOriginFeatId', 'Human characters must choose an extra Origin feat.');
  }
  if (humanFeat && humanFeat.id === backgroundFeat.id && !humanFeat.repeatable) {
    fail('origin', 'humanOriginFeatId', 'Choose a different Origin feat unless the feat is repeatable.');
  }

  const humanSkill = normalizeId(draft.humanSkillId);
  if (isHuman && !allSkillIds.has(humanSkill)) {
    fail('origin', 'humanSkillId', 'Human characters must choose one extra skill proficiency.');
  }
  if (isHuman && [...(background.skills || []), ...speciesSkills].includes(humanSkill)) {
    fail('origin', 'humanSkillId', 'Human Skillful must choose a skill not already granted by the background or species.');
  }

  const entries = [
    { source: 'background_feat', feat: backgroundFeat },
    ...(humanFeat ? [{ source: 'human_feat', feat: humanFeat }] : []),
  ];
  const skillProficiencies = [];
  const toolProficiencies = [];
  if (humanSkill) skillProficiencies.push(humanSkill);
  const reservedSkills = new Set([...(background.skills || []), ...speciesSkills, ...(humanSkill ? [humanSkill] : [])]);
  const skillChoices = {};
  const toolChoices = {};
  const magicInitiate = {};

  for (const entry of entries) {
    if (entry.feat.choice) {
      const selected = Array.isArray(draft.featSkillChoices?.[entry.source])
        ? draft.featSkillChoices[entry.source].map(normalizeId).filter(Boolean)
        : [];
      const unique = [...new Set(selected)];
      if (unique.length !== selected.length) fail('origin', entry.source, `${entry.feat.name} choices cannot repeat.`);
      if (unique.length !== entry.feat.choice.count) {
        fail('origin', entry.source, `${entry.feat.name} must choose ${entry.feat.choice.count} ${formatChoiceKind(entry.feat.choice)}.`);
      }

      const allowedTools = getToolChoiceOptions(entry.feat.choice, content);
      const allowedToolIds = new Set(allowedTools.map((tool) => tool.id));
      const entrySkillChoices = [];
      const entryToolChoices = [];

      for (const choiceId of unique) {
        const isSkill = allSkillIds.has(choiceId);
        const isTool = allToolIds.has(choiceId);
        if (entry.feat.choice.type === 'skills' && !isSkill) fail('origin', entry.source, `Choose valid skills for ${entry.feat.name}.`);
        if (entry.feat.choice.type === 'tools' && (!isTool || !allowedToolIds.has(choiceId))) fail('origin', entry.source, `Choose valid tools for ${entry.feat.name}.`);
        if (entry.feat.choice.type === 'skill_or_tool' && !isSkill && !isTool) fail('origin', entry.source, `Choose valid skills or tools for ${entry.feat.name}.`);
        if (isSkill) {
          if (reservedSkills.has(choiceId)) fail('origin', entry.source, `${entry.feat.name} must choose skills not already granted by background, species, or another origin choice.`);
          entrySkillChoices.push(choiceId);
        } else if (isTool) {
          if (entry.feat.choice.type === 'tools' && !allowedToolIds.has(choiceId)) fail('origin', entry.source, `Choose valid tools for ${entry.feat.name}.`);
          entryToolChoices.push(choiceId);
        }
      }

      if (entrySkillChoices.length) {
        skillChoices[entry.source] = entrySkillChoices;
        skillProficiencies.push(...entrySkillChoices);
        for (const skillId of entrySkillChoices) reservedSkills.add(skillId);
      }
      if (entryToolChoices.length) {
        toolChoices[entry.source] = entryToolChoices;
        toolProficiencies.push(...entryToolChoices);
      }
    }

    if (entry.feat.magic_list) {
      const choice = draft.magicInitiateChoices?.[entry.source] || {};
      const list = entry.feat.magic_list;
      const cantrips = Array.isArray(choice.cantrips) ? choice.cantrips.map(normalizeId) : [];
      const spell = normalizeId(choice.spell);
      const ability = normalizeId(choice.ability);
      const abilityOptions = entry.feat.spellcasting_ability_choices || ['int', 'wis', 'cha'];
      const cantripOptions = content.spells.filter((item) => item.level === 0 && item.classes.includes(list));
      const spellOptions = content.spells.filter((item) => item.level === 1 && item.classes.includes(list));
      if (new Set(cantrips).size !== 2) {
        fail('origin', entry.source, `${entry.feat.name} must choose two cantrips.`);
      }
      for (const cantripId of cantrips) {
        if (!cantripOptions.some((item) => item.id === cantripId)) {
          fail('origin', entry.source, `Choose valid ${list} cantrips.`);
        }
      }
      if (!spellOptions.some((item) => item.id === spell)) {
        fail('origin', entry.source, `Choose a valid level 1 ${list} spell.`);
      }
      if (!abilityOptions.includes(ability)) {
        fail('origin', entry.source, `${entry.feat.name} must choose Intelligence, Wisdom, or Charisma as its spellcasting ability.`);
      }
      magicInitiate[entry.source] = { list, cantrips, spell, ability };
    }
  }

  return {
    backgroundFeat,
    humanFeat,
    humanSkill: humanSkill || null,
    feats: entries,
    skillProficiencies: [...new Set(skillProficiencies)],
    toolProficiencies: [...new Set(toolProficiencies)],
    skillChoices,
    toolChoices,
    magicInitiate,
  };
}

function formatChoiceKind(choice = {}) {
  if (choice.type === 'skills') return 'skills';
  if (choice.type === 'tools') return 'tools';
  if (choice.type === 'skill_or_tool') return 'skills or tools';
  return 'choices';
}

function getToolChoiceOptions(choice = {}, content = {}) {
  const tools = content.tools || [];
  if (!choice.category) return tools;
  return tools.filter((tool) => tool.category === choice.category);
}

function validateSkills(selectedSkills, characterClass, background, content, originSkills = []) {
  const allowed = new Set(characterClass.skill_options);
  const allSkills = new Set(content.skills.map((skill) => skill.id));
  const alreadyGranted = new Set([...(background.skills || []), ...originSkills]);
  const picked = new Set();
  for (const skillId of selectedSkills) {
    if (!allSkills.has(skillId)) fail('skills', 'selectedSkills', 'Choose valid skills.');
    if (!allowed.has(skillId)) fail('skills', 'selectedSkills', 'Class skills must come from the class list.');
    if (alreadyGranted.has(skillId)) fail('skills', 'selectedSkills', 'Class skills must not duplicate background or origin skills.');
    picked.add(skillId);
  }
  if (picked.size !== characterClass.skill_count) {
    fail('skills', 'selectedSkills', `Choose exactly ${characterClass.skill_count} class skills.`);
  }
  return new Set([...(background.skills || []), ...picked, ...originSkills]);
}

function validateClassLevelChoices(draft, characterClass, content, skillSet) {
  const submittedChoices = draft.classChoices && typeof draft.classChoices === 'object' ? draft.classChoices : {};
  const submittedDetails = draft.classChoiceDetails && typeof draft.classChoiceDetails === 'object' ? draft.classChoiceDetails : {};
  const choices = {};
  const choiceDetails = {};
  const choiceSpells = [];
  const features = [];
  const armorProficiencies = [];
  const weaponProficiencies = [];
  const classLanguages = validateClassLanguages(draft, characterClass, content);
  let extraCantrips = 0;

  for (const choice of characterClass.class_choices || []) {
    const value = normalizeId(submittedChoices[choice.id]);
    if (choice.required && !value) fail('class', choice.id, `${characterClass.name} requires ${choice.label}.`);
    if (!value) continue;

    const option = (choice.options || []).find((item) => item.id === value);
    if (!option) fail('class', choice.id, `Choose a valid ${choice.label}.`);
    choices[choice.id] = option.id;
    armorProficiencies.push(...(option.armor || []));
    weaponProficiencies.push(...(option.weapons || []));
    extraCantrips += Number(option.extra_cantrips || 0);
    const details = validateClassChoiceDetails(submittedDetails[choice.id], choice, option, content);
    if (Object.keys(details.choices).length > 0) choiceDetails[choice.id] = details.choices;
    choiceSpells.push(...getOptionGrantedSpells(option, 'at_will_spells', 'at_will'));
    choiceSpells.push(...getOptionGrantedSpells(option, 'ritual_spells', 'ritual'));
    choiceSpells.push(...details.spells);
    features.push({
      source: 'class_choice',
      name: `${choice.label}: ${option.name}`,
      description: details.summary ? `${option.description} ${details.summary}` : option.description,
    });
  }

  const weaponMasteries = validateWeaponMasteries(
    draft.weaponMasteries,
    characterClass,
    content,
    weaponProficiencies,
  );
  const expertiseSkills = validateExpertiseSkills(draft.expertiseSkills, characterClass, skillSet, content);

  if (weaponMasteries.length > 0) {
    features.push({
      source: 'class_choice',
      name: 'Weapon Mastery Choices',
      description: weaponMasteries
        .map((entry) => `${entry.name}: ${entry.mastery_name}`)
        .join(', '),
    });
  }
  if (expertiseSkills.length > 0) {
    const skillNames = expertiseSkills.map((skillId) => byId(content.skills, skillId)?.name || skillId);
    features.push({
      source: 'class_choice',
      name: 'Expertise Choices',
      description: skillNames.join(', '),
    });
  }

  return {
    choices,
    features,
    armorProficiencies: [...new Set(armorProficiencies)],
    weaponProficiencies: [...new Set(weaponProficiencies)],
    classLanguages,
    extraCantrips,
    choiceDetails,
    choiceSpells,
    weaponMasteries,
    expertiseSkills,
  };
}

function getOptionGrantedSpells(option, field, type) {
  return (option[field] || []).map((spellId) => ({
    id: spellId,
    source: option.name,
    source_detail: type === 'at_will' ? 'At-Will Spell' : 'Ritual Spell',
    type,
  }));
}

function validateClassLanguages(draft, characterClass, content) {
  const automatic = characterClass.class_languages || [];
  const choiceCount = Number(characterClass.class_language_choice_count || 0);
  if (choiceCount === 0) return automatic;

  const allLanguages = new Set((content.languages || []).map((language) => language.id));
  const selected = Array.isArray(draft.classLanguages) ? draft.classLanguages.map(normalizeId).filter(Boolean) : [];
  const unique = [...new Set(selected)];
  if (unique.length !== selected.length) fail('class', 'classLanguages', 'Class language choices cannot repeat.');
  if (unique.length !== choiceCount) {
    fail('class', 'classLanguages', `${characterClass.name} must choose ${choiceCount} additional language from ${characterClass.class_language_choice_source || 'a class feature'}.`);
  }
  for (const languageId of unique) {
    if (!allLanguages.has(languageId)) fail('class', 'classLanguages', 'Choose a valid class language.');
    if (automatic.includes(languageId)) fail('class', 'classLanguages', 'Class language choices cannot duplicate automatic class languages.');
  }
  return [...automatic, ...unique];
}

function validateClassChoiceDetails(submitted, choice, option, content) {
  const raw = submitted && typeof submitted === 'object' ? submitted : {};
  const choices = {};
  const spells = [];
  const summary = [];

  for (const subchoice of option.subchoices || []) {
    if (subchoice.type === 'weapon') {
      const value = normalizeId(raw[subchoice.id]);
      const options = getClassSubchoiceWeaponOptions(subchoice, content);
      if (subchoice.required && !value) fail('class', choice.id, `${option.name} requires ${subchoice.label}.`);
      if (value && !options.some((weapon) => weapon.id === value)) fail('class', choice.id, `Choose a valid ${subchoice.label}.`);
      if (value) {
        choices[subchoice.id] = value;
        const weapon = options.find((item) => item.id === value);
        summary.push(`${subchoice.label}: ${weapon?.name || value}.`);
      }
      continue;
    }

    if (subchoice.type === 'option') {
      const value = normalizeId(raw[subchoice.id]);
      const options = subchoice.options || [];
      if (subchoice.required && !value) fail('class', choice.id, `${option.name} requires ${subchoice.label}.`);
      if (value && !options.some((item) => item.id === value)) fail('class', choice.id, `Choose a valid ${subchoice.label}.`);
      if (value) {
        choices[subchoice.id] = value;
        const selected = options.find((item) => item.id === value);
        summary.push(`${subchoice.label}: ${selected?.name || value}.`);
      }
      continue;
    }

    if (subchoice.type === 'spell') {
      const selected = Array.isArray(raw[subchoice.id]) ? raw[subchoice.id].map(normalizeId).filter(Boolean) : [];
      const unique = [...new Set(selected)];
      const count = Number(subchoice.count || 0);
      if (unique.length !== selected.length) fail('class', choice.id, `${subchoice.label} choices cannot repeat.`);
      if (subchoice.required && unique.length !== count) fail('class', choice.id, `${option.name} requires ${count} ${subchoice.label}.`);
      const spellOptions = getClassSubchoiceSpellOptions(subchoice, content);
      for (const spellId of unique) {
        if (!spellOptions.some((spell) => spell.id === spellId)) fail('class', choice.id, `Choose valid ${subchoice.label}.`);
      }
      if (unique.length > 0) {
        choices[subchoice.id] = unique;
        spells.push(...unique.map((spellId) => ({
          id: spellId,
          source: option.name,
          source_detail: subchoice.label,
          type: Number(subchoice.level || 0) === 0 ? 'cantrip' : subchoice.ritual ? 'ritual' : 'spell',
        })));
        summary.push(`${subchoice.label}: ${unique.map((id) => byId(content.spells, id)?.name || id).join(', ')}.`);
      }
    }
  }

  return { choices, spells, summary: summary.join(' ') };
}

function getClassSubchoiceWeaponOptions(subchoice, content) {
  return (content.equipment || [])
    .filter((item) => item.type === 'weapon')
    .filter((weapon) => {
      if (subchoice.weapon_filter === 'simple_or_martial_melee') {
        return ['simple', 'martial'].includes(weapon.weapon_category) && !(weapon.properties || []).includes('ammunition');
      }
      return true;
    });
}

function getClassSubchoiceSpellOptions(subchoice, content) {
  return (content.spells || [])
    .filter((spell) => Number(spell.level || 0) === Number(subchoice.level || 0))
    .filter((spell) => !subchoice.ritual || Boolean(spell.ritual))
    .filter((spell) => !subchoice.source || subchoice.source === 'any' || (spell.classes || []).includes(subchoice.source));
}

function validateWeaponMasteries(submitted, characterClass, content, extraWeaponProficiencies = []) {
  const requiredCount = Number(characterClass.weapon_mastery_count || 0);
  const selected = Array.isArray(submitted) ? submitted.map(normalizeId).filter(Boolean) : [];
  const unique = [...new Set(selected)];
  if (unique.length !== selected.length) fail('class', 'weaponMasteries', 'Weapon Mastery choices cannot repeat.');
  if (requiredCount === 0) return [];
  if (unique.length !== requiredCount) {
    fail('class', 'weaponMasteries', `${characterClass.name} must choose exactly ${requiredCount} Weapon Mastery options.`);
  }

  const available = getWeaponMasteryOptions(characterClass, content, extraWeaponProficiencies);
  const availableById = new Map(available.map((weapon) => [weapon.id, weapon]));
  return unique.map((weaponId) => {
    const weapon = availableById.get(weaponId);
    if (!weapon) fail('class', 'weaponMasteries', 'Weapon Mastery choices must be proficient weapons with mastery properties.');
    return {
      weapon_id: weapon.id,
      name: weapon.name,
      mastery: weapon.mastery,
      mastery_name: titleCase(String(weapon.mastery || '').replaceAll('_', ' ')),
      description: weapon.description,
      mastery_description: WEAPON_MASTERY_DESCRIPTIONS[weapon.mastery] || 'Use this weapon mastery property when the referee resolves attacks with this weapon.',
    };
  });
}

function validateExpertiseSkills(submitted, characterClass, skillSet, content) {
  const requiredCount = Number(characterClass.expertise_count || 0);
  const selected = Array.isArray(submitted) ? submitted.map(normalizeId).filter(Boolean) : [];
  const unique = [...new Set(selected)];
  if (unique.length !== selected.length) fail('skills', 'expertiseSkills', 'Expertise choices cannot repeat.');
  if (requiredCount === 0) return [];
  if (unique.length !== requiredCount) {
    fail('skills', 'expertiseSkills', `${characterClass.name} must choose exactly ${requiredCount} Expertise skills.`);
  }
  const allSkills = new Set(content.skills.map((skill) => skill.id));
  for (const skillId of unique) {
    if (!allSkills.has(skillId)) fail('skills', 'expertiseSkills', 'Choose valid Expertise skills.');
    if (!skillSet.has(skillId)) fail('skills', 'expertiseSkills', 'Expertise must be chosen from your proficient skills.');
  }
  return unique;
}

function getWeaponMasteryOptions(characterClass, content, extraWeaponProficiencies = []) {
  const proficiencies = new Set([...(characterClass.weapons || []), ...extraWeaponProficiencies]);
  return (content.equipment || [])
    .filter((item) => item.type === 'weapon' && item.mastery)
    .filter((weapon) => isWeaponProficient(weapon, proficiencies));
}

function isWeaponProficient(weapon, proficiencies) {
  if (proficiencies.has(weapon.id)) return true;
  if (weapon.weapon_category && proficiencies.has(weapon.weapon_category)) return true;
  if (proficiencies.has('finesse') && (weapon.properties || []).includes('finesse')) return true;
  if (proficiencies.has('light_martial') && weapon.weapon_category === 'martial' && (weapon.properties || []).includes('light')) return true;
  return false;
}

function buildInventory(characterClass, content, equipmentChoice, background, backgroundEquipmentChoice) {
  const inventory = [];
  if (equipmentChoice === 'gold') {
    inventory.push({ id: 'class_starting_gold', name: 'Class Starting Gold', type: 'currency', quantity: 1, description: 'Class gold option selected. Purchase flow is deferred.' });
  } else {
    inventory.push(...(characterClass.equipment_pack || []).map((id) => {
    const item = byId(content.equipment, id);
    return item ? { ...item, quantity: 1 } : { id, name: id, type: 'item', quantity: 1, description: 'Starting item.' };
    }));
  }
  if (backgroundEquipmentChoice === 'gold') {
    inventory.push({ id: 'background_50_gp', name: '50 GP', type: 'currency', quantity: 50, description: 'Background gold alternative selected.' });
  } else {
    inventory.push({
      id: `background_equipment_${background.id}`,
      name: `${background.name} Background Equipment`,
      type: 'background_equipment',
      quantity: 1,
      description: `Starting background package, including ${background.tool || 'the listed tool'} and personal gear.`,
    });
  }
  return inventory;
}

function buildEquipped(inventory, content) {
  const weapons = inventory.filter((item) => item.type === 'weapon');
  const weapon = weapons[0] || null;
  const armor = inventory.find((item) => item.type === 'armor') || null;
  const shield = inventory.find((item) => item.type === 'shield') || null;
  const pairedLightWeapon = !shield && hasWeaponProperty(weapon, 'light')
    ? weapons.slice(1).find((item) => item.id !== weapon.id && hasWeaponProperty(item, 'light')) || null
    : null;
  return {
    main_hand: weapon?.id || null,
    off_hand: shield?.id || pairedLightWeapon?.id || null,
    armor: armor?.id || null,
    attuned: [],
  };
}

function getEquippedItems(equipped, content) {
  return [equipped.main_hand, equipped.off_hand, equipped.armor, ...(equipped.attuned || [])]
    .filter(Boolean)
    .map((id) => byId(content.equipment, id))
    .filter(Boolean);
}

function buildActiveEffects(equipped, content) {
  return getEquippedItems(equipped, content).flatMap((item) => (item.effects || []).map((effect) => ({
    ...effect,
    source_item_id: item.id,
    source_item_name: item.name,
  })));
}

function calculateArmorClass(equipped, content, abilityModifiers, activeEffects, characterClass, classData = {}) {
  const armorEffect = activeEffects.find((effect) => effect.target === 'armor_formula');
  const dexMod = abilityModifiers.dex || 0;
  const unarmoredDefense = !armorEffect ? characterClass.unarmored_defense : null;
  const unarmoredAbility = unarmoredDefense?.ability;
  const unarmoredBonus = unarmoredAbility ? (abilityModifiers[unarmoredAbility] || 0) : 0;
  const base = armorEffect ? armorEffect.base : 10;
  const dexCap = armorEffect ? armorEffect.dex_cap : null;
  const dexApplied = dexCap === null || dexCap === undefined ? dexMod : Math.min(dexMod, dexCap);
  const shieldBonus = activeEffects
    .filter((effect) => effect.target === 'shield_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  const shieldApplied = unarmoredDefense && !unarmoredDefense.allows_shield ? 0 : shieldBonus;
  const itemBonus = activeEffects
    .filter((effect) => effect.target === 'armor_class_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  const fightingStyleBonus = getFightingStyleArmorBonus({
    styleId: classData.choices?.fighting_style,
    wearingArmor: Boolean(armorEffect),
  });
  return {
    total: base + dexApplied + unarmoredBonus + shieldApplied + itemBonus + fightingStyleBonus,
    parts: [
      { label: armorEffect ? armorEffect.source_item_name : 'Unarmored base', value: base },
      { label: dexCap === null || dexCap === undefined ? 'DEX modifier' : `DEX modifier (cap ${dexCap})`, value: dexApplied },
      ...(unarmoredAbility ? [{ label: `${unarmoredDefense.label} ${unarmoredAbility.toUpperCase()}`, value: unarmoredBonus }] : []),
      ...(shieldApplied ? [{ label: 'Shield', value: shieldApplied }] : []),
      ...(itemBonus ? [{ label: 'Item bonuses', value: itemBonus }] : []),
      ...(fightingStyleBonus ? [{ label: 'Defense Fighting Style', value: fightingStyleBonus }] : []),
    ],
  };
}

function calculateInitiative(abilityModifiers, pb, activeEffects) {
  const dex = abilityModifiers.dex || 0;
  const alertBonus = activeEffects.some((effect) => effect.target === 'initiative_proficiency') ? pb : 0;
  const flatBonus = activeEffects
    .filter((effect) => effect.target === 'initiative_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  return {
    total: dex + alertBonus + flatBonus,
    parts: [
      { label: 'DEX modifier', value: dex },
      ...(alertBonus ? [{ label: 'Alert proficiency', value: alertBonus }] : []),
      ...(flatBonus ? [{ label: 'Initiative bonuses', value: flatBonus }] : []),
    ],
  };
}

function buildSkillModifiers(skills, proficientSkills, abilityModifiers, pb, expertiseSkills = []) {
  const expertise = new Set(expertiseSkills);
  return Object.fromEntries(skills.map((skill) => {
    const proficient = proficientSkills.has(skill.id);
    const expert = proficient && expertise.has(skill.id);
    return [skill.id, {
      ability: skill.ability,
      proficient,
      expertise: expert,
      total: (abilityModifiers[skill.ability] || 0) + (proficient ? pb : 0) + (expert ? pb : 0),
    }];
  }));
}

function buildSaveModifiers(saveProficiencies, abilityModifiers, pb) {
  const saves = new Set(saveProficiencies);
  return Object.fromEntries(ABILITIES.map((ability) => [ability, {
    proficient: saves.has(ability),
    total: (abilityModifiers[ability] || 0) + (saves.has(ability) ? pb : 0),
  }]));
}

function buildAttackBreakdowns(equipped, content, abilityModifiers, pb, activeEffects, classData = {}) {
  const weaponIds = [...new Set([equipped.main_hand, equipped.off_hand].filter(Boolean))];
  return weaponIds
    .map((weaponId) => byId(content.equipment, weaponId))
    .filter((weapon) => weapon?.type === 'weapon')
    .map((weapon) => buildAttackBreakdown(weapon, abilityModifiers, pb, activeEffects, classData));
}

function buildAttackBreakdown(weapon, abilityModifiers, pb, activeEffects, classData = {}) {
  const ability = getWeaponAttackAbility(weapon, abilityModifiers);
  const attackBonus = activeEffects
    .filter((effect) => effect.target === 'weapon_attack_bonus' && effect.source_item_id === weapon.id)
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  const damageBonus = activeEffects
    .filter((effect) => effect.target === 'weapon_damage_bonus' && effect.source_item_id === weapon.id)
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  const fightingStyleAttackBonus = getFightingStyleAttackBonus({
    styleId: classData.choices?.fighting_style,
    attack: { attackKind: weapon.attack_kind || 'melee' },
  });
  return {
    weapon_id: weapon.id,
    name: weapon.name,
    ability,
    properties: weapon.properties || [],
    weapon_category: weapon.weapon_category || null,
    attack_kind: weapon.attack_kind || 'melee',
    damage_type: weapon.damage_type || null,
    mastery: weapon.mastery || null,
    versatile_damage: weapon.versatile_damage || null,
    attack_total: (abilityModifiers[ability] || 0) + pb + attackBonus + fightingStyleAttackBonus,
    fighting_style_attack_bonus: fightingStyleAttackBonus,
    attack_parts: [
      { label: ability.toUpperCase(), value: abilityModifiers[ability] || 0 },
      { label: 'Proficiency', value: pb },
      ...(attackBonus ? [{ label: 'Weapon magic', value: attackBonus }] : []),
      ...(fightingStyleAttackBonus ? [{ label: 'Archery Fighting Style', value: fightingStyleAttackBonus }] : []),
    ],
    damage_formula: buildDamageFormula(weapon.damage, (abilityModifiers[ability] || 0) + damageBonus),
    damage_parts: [
      { label: weapon.damage, value: null },
      { label: ability.toUpperCase(), value: abilityModifiers[ability] || 0 },
      ...(damageBonus ? [{ label: 'Weapon magic', value: damageBonus }] : []),
    ],
  };
}

function getWeaponAttackAbility(weapon, abilityModifiers) {
  if ((weapon.properties || []).includes('finesse')) {
    return Number(abilityModifiers.dex || 0) > Number(abilityModifiers.str || 0) ? 'dex' : 'str';
  }
  return weapon.ability || 'str';
}

function buildDamageFormula(dice, modifier) {
  const value = Number(modifier || 0);
  if (value < 0) return `${dice} - ${Math.abs(value)}`;
  return `${dice} + ${value}`;
}

function hasWeaponProperty(weapon, property) {
  return (weapon?.properties || []).includes(property);
}

function buildSpellcasting(draft, characterClass, content, abilityModifiers, classData = {}) {
  const config = characterClass.spellcasting;
  if (!config) return null;
  const cantripsKnown = Array.isArray(draft.cantripsKnown) ? draft.cantripsKnown.map(normalizeId) : [];
  const spellsKnown = Array.isArray(draft.spellsKnown) ? draft.spellsKnown.map(normalizeId) : [];
  const spellbookKnown = Array.isArray(draft.spellbookSpells) ? draft.spellbookSpells.map(normalizeId) : [];
  const cantripOptions = content.spells.filter((spell) => spell.level === 0 && spell.classes.includes(characterClass.id));
  const spellOptions = content.spells.filter((spell) => spell.level === 1 && spell.classes.includes(characterClass.id));
  const alwaysPrepared = config.always_prepared_spells || [];
  const requiredCantrips = (config.cantrips || 0) + Number(classData.extraCantrips || 0);
  if (requiredCantrips !== cantripsKnown.length) {
    fail('spells', 'cantripsKnown', `Choose exactly ${requiredCantrips} cantrips.`);
  }
  if (new Set(cantripsKnown).size !== cantripsKnown.length) fail('spells', 'cantripsKnown', 'Cantrip choices cannot repeat.');
  for (const id of cantripsKnown) {
    if (!cantripOptions.some((spell) => spell.id === id)) fail('spells', 'cantripsKnown', 'Choose valid class cantrips.');
  }
  if (config.spellbook_spells) {
    if (new Set(spellbookKnown).size !== spellbookKnown.length) fail('spells', 'spellbookSpells', 'Spellbook choices cannot repeat.');
    if (spellbookKnown.length !== config.spellbook_spells) {
      fail('spells', 'spellbookSpells', `Choose exactly ${config.spellbook_spells} level 1 spells for your spellbook.`);
    }
    for (const id of spellbookKnown) {
      if (!spellOptions.some((spell) => spell.id === id)) fail('spells', 'spellbookSpells', 'Choose valid class spells for the spellbook.');
    }
  }
  const requiredSpellCount = config.prepared_spells || 0;
  if (requiredSpellCount !== spellsKnown.length) {
    fail('spells', 'spellsKnown', `Choose exactly ${requiredSpellCount} level 1 spells.`);
  }
  if (new Set(spellsKnown).size !== spellsKnown.length) fail('spells', 'spellsKnown', 'Prepared spell choices cannot repeat.');
  for (const id of spellsKnown) {
    if (!spellOptions.some((spell) => spell.id === id)) fail('spells', 'spellsKnown', 'Choose valid class spells.');
    if (alwaysPrepared.includes(id)) fail('spells', 'spellsKnown', 'Always Prepared spells do not count against your chosen prepared spells.');
    if (config.spellbook_spells && !spellbookKnown.includes(id)) {
      fail('spells', 'spellsKnown', 'Prepared Wizard spells must come from your spellbook.');
    }
  }
  const classChoiceCantrips = getClassChoiceSpellIds(classData.choiceSpells, 'cantrip');
  const finalCantrips = [...cantripsKnown, ...classChoiceCantrips];
  if (new Set(finalCantrips).size !== finalCantrips.length) {
    fail('spells', 'cantripsKnown', 'Class choice cantrips cannot duplicate class cantrips.');
  }

  return {
    ability: config.ability,
    cantrips_known: finalCantrips,
    prepared_from_choices: spellsKnown,
    always_prepared_spells: alwaysPrepared,
    spells_prepared: [...spellsKnown, ...alwaysPrepared],
    class_choice_spells: classData.choiceSpells || [],
    ritual_spells: getClassChoiceSpellIds(classData.choiceSpells, 'ritual'),
    ...(config.spellbook_spells ? { spellbook_spells: spellbookKnown } : {}),
    slots: config.slots || {},
  };
}

function getClassChoiceSpellIds(choiceSpells = [], type) {
  return (choiceSpells || [])
    .filter((entry) => entry.type === type)
    .map((entry) => entry.id);
}

function buildClassResources(characterClass, content) {
  const resources = {};
  const freeSpellUses = characterClass.spellcasting?.free_spell_uses || {};
  const spellUses = {};
  for (const [spellId, config] of Object.entries(freeSpellUses)) {
    const spell = byId(content.spells, spellId);
    const source = normalizeId(config.source || 'class_feature');
    const key = `class_feature:${source}:${spellId}`;
    spellUses[key] = {
      name: spell?.name || spellId,
      spell_id: spellId,
      source,
      source_name: titleCase(source.replaceAll('_', ' ')),
      remaining: Number(config.uses || 0),
      max: Number(config.uses || 0),
      reset: config.reset || 'long_rest',
    };
  }
  if (Object.keys(spellUses).length > 0) resources.spell_uses = spellUses;
  return resources;
}

module.exports = {
  validateCharacter,
  abilityMod,
  ABILITIES,
};
