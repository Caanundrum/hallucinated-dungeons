const { byId } = require('./contentData');

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function proficiencyBonus(level) {
  return Math.floor((level - 1) / 4) + 2;
}

function normalizeId(value) {
  return String(value || '').trim();
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
  const languages = validateLanguages(draft, content);
  const speciesData = validateSpeciesChoices(draft, species, content);
  const origin = validateOriginChoices(draft, species, background, content, speciesData.skillProficiencies);
  const skillSet = validateSkills(selectedSkills, characterClass, background, content, [
    ...speciesData.skillProficiencies,
    ...origin.skillProficiencies,
  ]);

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

  const spellcasting = buildSpellcasting(draft, characterClass, content, abilityModifiers);
  const level = 1;
  const pb = proficiencyBonus(level);
  const maxHpBonus = activeEffects
    .filter((effect) => effect.target === 'max_hp_per_level_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0) * level, 0);
  const maxHp = Math.max(1, characterClass.hit_die + abilityModifiers.con + maxHpBonus);
  const armorBreakdown = calculateArmorClass(equipped, content, abilityModifiers, activeEffects, characterClass);
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
    skill_modifiers: buildSkillModifiers(content.skills, skillSet, abilityModifiers, pb),
    saving_throw_modifiers: buildSaveModifiers(characterClass.saving_throws, abilityModifiers, pb),
    attack_breakdowns: buildAttackBreakdowns(equipped, content, abilityModifiers, pb, activeEffects),
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
      tools: [background.tool].filter(Boolean),
      languages,
      armor: characterClass.armor,
      weapons: characterClass.weapons,
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
    ],
    species_choices: speciesData.choices,
    species_spells: speciesData.spells,
    languages,
    origin: {
      background_feat: origin.backgroundFeat?.id || null,
      human_origin_feat: origin.humanFeat?.id || null,
      human_skill: origin.humanSkill || null,
      skill_choices: origin.skillChoices,
      magic_initiate: origin.magicInitiate,
    },
    spellcasting,
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
  if (humanSkill) skillProficiencies.push(humanSkill);
  const reservedSkills = new Set([...(background.skills || []), ...speciesSkills, ...(humanSkill ? [humanSkill] : [])]);
  const skillChoices = {};
  const magicInitiate = {};

  for (const entry of entries) {
    if (entry.feat.choice?.type === 'skills') {
      const selected = Array.isArray(draft.featSkillChoices?.[entry.source])
        ? draft.featSkillChoices[entry.source].map(normalizeId)
        : [];
      const unique = new Set(selected);
      if (unique.size !== entry.feat.choice.count) {
        fail('origin', entry.source, `${entry.feat.name} must choose ${entry.feat.choice.count} skills.`);
      }
      for (const skillId of unique) {
        if (!allSkillIds.has(skillId)) fail('origin', entry.source, 'Choose valid skills for Skilled.');
        if (reservedSkills.has(skillId)) fail('origin', entry.source, 'Skilled must choose skills not already granted by background or species.');
      }
      skillChoices[entry.source] = [...unique];
      skillProficiencies.push(...unique);
      for (const skillId of unique) reservedSkills.add(skillId);
    }

    if (entry.feat.magic_list) {
      const choice = draft.magicInitiateChoices?.[entry.source] || {};
      const list = entry.feat.magic_list;
      const cantrips = Array.isArray(choice.cantrips) ? choice.cantrips.map(normalizeId) : [];
      const spell = normalizeId(choice.spell);
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
      magicInitiate[entry.source] = { list, cantrips, spell };
    }
  }

  return {
    backgroundFeat,
    humanFeat,
    humanSkill: humanSkill || null,
    feats: entries,
    skillProficiencies: [...new Set(skillProficiencies)],
    skillChoices,
    magicInitiate,
  };
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
  const weapon = inventory.find((item) => item.type === 'weapon') || null;
  const armor = inventory.find((item) => item.type === 'armor') || null;
  const shield = inventory.find((item) => item.type === 'shield') || null;
  return {
    main_hand: weapon?.id || null,
    off_hand: shield?.id || null,
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

function calculateArmorClass(equipped, content, abilityModifiers, activeEffects, characterClass) {
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
  return {
    total: base + dexApplied + unarmoredBonus + shieldApplied + itemBonus,
    parts: [
      { label: armorEffect ? armorEffect.source_item_name : 'Unarmored base', value: base },
      { label: dexCap === null || dexCap === undefined ? 'DEX modifier' : `DEX modifier (cap ${dexCap})`, value: dexApplied },
      ...(unarmoredAbility ? [{ label: `${unarmoredDefense.label} ${unarmoredAbility.toUpperCase()}`, value: unarmoredBonus }] : []),
      ...(shieldApplied ? [{ label: 'Shield', value: shieldApplied }] : []),
      ...(itemBonus ? [{ label: 'Item bonuses', value: itemBonus }] : []),
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

function buildSkillModifiers(skills, proficientSkills, abilityModifiers, pb) {
  return Object.fromEntries(skills.map((skill) => {
    const proficient = proficientSkills.has(skill.id);
    return [skill.id, {
      ability: skill.ability,
      proficient,
      total: (abilityModifiers[skill.ability] || 0) + (proficient ? pb : 0),
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

function buildAttackBreakdowns(equipped, content, abilityModifiers, pb, activeEffects) {
  const weapon = byId(content.equipment, equipped.main_hand);
  if (!weapon || weapon.type !== 'weapon') return [];
  const ability = weapon.ability || 'str';
  const attackBonus = activeEffects
    .filter((effect) => effect.target === 'weapon_attack_bonus' && effect.source_item_id === weapon.id)
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  const damageBonus = activeEffects
    .filter((effect) => effect.target === 'weapon_damage_bonus' && effect.source_item_id === weapon.id)
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  return [{
    weapon_id: weapon.id,
    name: weapon.name,
    attack_total: (abilityModifiers[ability] || 0) + pb + attackBonus,
    attack_parts: [
      { label: ability.toUpperCase(), value: abilityModifiers[ability] || 0 },
      { label: 'Proficiency', value: pb },
      ...(attackBonus ? [{ label: 'Weapon magic', value: attackBonus }] : []),
    ],
    damage_formula: `${weapon.damage} + ${(abilityModifiers[ability] || 0) + damageBonus}`,
    damage_parts: [
      { label: weapon.damage, value: null },
      { label: ability.toUpperCase(), value: abilityModifiers[ability] || 0 },
      ...(damageBonus ? [{ label: 'Weapon magic', value: damageBonus }] : []),
    ],
  }];
}

function buildSpellcasting(draft, characterClass, content, abilityModifiers) {
  const config = characterClass.spellcasting;
  if (!config) return null;
  const cantripsKnown = Array.isArray(draft.cantripsKnown) ? draft.cantripsKnown.map(normalizeId) : [];
  const spellsKnown = Array.isArray(draft.spellsKnown) ? draft.spellsKnown.map(normalizeId) : [];
  const cantripOptions = content.spells.filter((spell) => spell.level === 0 && spell.classes.includes(characterClass.id));
  const spellOptions = content.spells.filter((spell) => spell.level === 1 && spell.classes.includes(characterClass.id));
  if ((config.cantrips || 0) !== cantripsKnown.length) {
    fail('spells', 'cantripsKnown', `Choose exactly ${config.cantrips || 0} cantrips.`);
  }
  for (const id of cantripsKnown) {
    if (!cantripOptions.some((spell) => spell.id === id)) fail('spells', 'cantripsKnown', 'Choose valid class cantrips.');
  }
  const requiredSpellCount = config.spells_known
    || Math.max(1, (abilityModifiers[config.ability] || 0) + 1)
    || 0;
  if (requiredSpellCount !== spellsKnown.length) {
    fail('spells', 'spellsKnown', `Choose exactly ${requiredSpellCount} level 1 spells.`);
  }
  for (const id of spellsKnown) {
    if (!spellOptions.some((spell) => spell.id === id)) fail('spells', 'spellsKnown', 'Choose valid class spells.');
  }
  return {
    ability: config.ability,
    cantrips_known: cantripsKnown,
    spells_known: spellsKnown,
    spells_prepared: spellsKnown,
    slots: config.slots || {},
  };
}

module.exports = {
  validateCharacter,
  abilityMod,
  proficiencyBonus,
  ABILITIES,
};
