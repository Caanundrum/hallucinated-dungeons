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

  const abilityData = validateAbilityScores(draft.abilityMethod, draft.abilityScores, draft.rolledStats, background, verifyRolledStats);
  const abilityScores = abilityData.finalScores;
  const abilityModifiers = Object.fromEntries(ABILITIES.map((ability) => [ability, abilityMod(abilityScores[ability])]));

  const selectedSkills = Array.isArray(draft.selectedSkills) ? draft.selectedSkills.map(normalizeId) : [];
  const skillSet = validateSkills(selectedSkills, characterClass, background, content);

  const equipmentChoice = normalizeId(draft.equipmentChoice || 'pack');
  if (!['pack', 'gold'].includes(equipmentChoice)) {
    fail('equipment', 'equipmentChoice', 'Choose equipment pack or gold.');
  }

  const inventory = buildInventory(characterClass, content, equipmentChoice);
  const equipped = buildEquipped(inventory, content);
  const activeEffects = buildActiveEffects(equipped, content);

  const spellcasting = buildSpellcasting(draft, characterClass, content, abilityModifiers);
  const level = 1;
  const pb = proficiencyBonus(level);
  const maxHp = Math.max(1, characterClass.hit_die + abilityModifiers.con);
  const armorBreakdown = calculateArmorClass(equipped, content, abilityModifiers, activeEffects, characterClass);
  const derivedStats = {
    level,
    proficiency_bonus: pb,
    max_hp: maxHp,
    hp: maxHp,
    temp_hp: 0,
    armor_class: armorBreakdown.total,
    armor_class_breakdown: armorBreakdown.parts,
    speed: species.speed,
    initiative: abilityModifiers.dex,
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
    proficiencies: {
      saving_throws: characterClass.saving_throws,
      skills: [...skillSet],
      background_skills: background.skills,
      class_skills: selectedSkills,
      tools: [background.tool].filter(Boolean),
      armor: characterClass.armor,
      weapons: characterClass.weapons,
    },
    inventory,
    equipped,
    active_effects: activeEffects,
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
    ],
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
  const validShape = JSON.stringify(values) === JSON.stringify([2, 1]);
  if (total !== 3 || !validShape) {
    fail('background', 'backgroundBonus', 'Background bonus must assign +2 to one eligible ability and +1 to the other.');
  }
  for (const [ability] of entries) {
    if (!allowed.has(ability)) {
      fail('background', 'backgroundBonus', 'Background bonuses must use the background eligible abilities.');
    }
  }
  return bonus;
}

function validateSkills(selectedSkills, characterClass, background, content) {
  const allowed = new Set(characterClass.skill_options);
  const allSkills = new Set(content.skills.map((skill) => skill.id));
  const picked = new Set();
  for (const skillId of selectedSkills) {
    if (!allSkills.has(skillId)) fail('skills', 'selectedSkills', 'Choose valid skills.');
    if (!allowed.has(skillId)) fail('skills', 'selectedSkills', 'Class skills must come from the class list.');
    picked.add(skillId);
  }
  if (picked.size !== characterClass.skill_count) {
    fail('skills', 'selectedSkills', `Choose exactly ${characterClass.skill_count} class skills.`);
  }
  return new Set([...(background.skills || []), ...picked]);
}

function buildInventory(characterClass, content, equipmentChoice) {
  if (equipmentChoice === 'gold') {
    return [{ id: 'starting_gold', name: 'Starting Gold', type: 'currency', quantity: 1, description: 'Gold option selected. Purchase flow is deferred.' }];
  }
  return (characterClass.equipment_pack || []).map((id) => {
    const item = byId(content.equipment, id);
    return item ? { ...item, quantity: 1 } : { id, name: id, type: 'item', quantity: 1, description: 'Starting item.' };
  });
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
      ...(unarmoredBonus ? [{ label: `${unarmoredDefense.label} ${unarmoredAbility.toUpperCase()}`, value: unarmoredBonus }] : []),
      ...(shieldApplied ? [{ label: 'Shield', value: shieldApplied }] : []),
      ...(itemBonus ? [{ label: 'Item bonuses', value: itemBonus }] : []),
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
