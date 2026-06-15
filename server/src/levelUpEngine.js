const { getContentBundle, byId } = require('./contentData');
const { abilityMod } = require('./characterValidator');

const SUPPORTED_LEVEL_UP_MECHANICS = new Set([
  'action_surge',
  'channel_divinity',
  'cunning_action',
  'danger_sense',
  'divine_spark',
  'expertise_level_2',
  'focus_points',
  'jack_of_all_trades',
  'reckless_attack',
  'tactical_mind',
  'turn_undead',
  'unarmored_movement',
  'uncanny_metabolism',
  'wild_companion',
  'wild_shape',
]);

function getLevelUpPreview(characterSheet = {}, content = getContentBundle(), options = {}) {
  const currentLevel = getCharacterLevel(characterSheet);
  const nextLevel = currentLevel + 1;
  const currentXp = getCharacterXp(characterSheet);
  const threshold = getXpThreshold(content, nextLevel);
  const classId = normalizeId(characterSheet.identity?.class);
  const classData = byId(content.classes || [], classId);
  const advancement = getClassAdvancement(content, classId, nextLevel);
  const hp = getFixedHpIncrease(characterSheet, classData);
  const blockers = [];

  if (currentLevel >= 20) {
    blockers.push(blocker('max_level', 'This character is already at the supported maximum level.'));
  }

  if (threshold === null) {
    blockers.push(blocker('missing_threshold', `No XP threshold is defined for level ${nextLevel}.`));
  }

  if (!classData) {
    blockers.push(blocker('missing_class', 'The character class is not in the content catalog.'));
  }

  if (!advancement) {
    blockers.push(blocker('missing_advancement', `No advancement data is defined for ${classId || 'this class'} level ${nextLevel}.`));
  }

  const choiceSelections = normalizeChoiceSelections(options.payload?.choices || options.choices || {});
  const requiredChoices = buildRequiredChoicePreviews({
    choices: advancement?.required_choices || [],
    characterSheet,
    content,
    classId,
    selections: choiceSelections,
  });
  blockers.push(...validateRequiredChoices(requiredChoices, choiceSelections));

  const supportedMechanics = options.supportedMechanics || SUPPORTED_LEVEL_UP_MECHANICS;
  for (const mechanic of advancement?.runtime_mechanics || []) {
    if (supportedMechanics.has(mechanic)) continue;
    blockers.push(blocker(
      'unsupported_mechanic',
      `${titleCase(mechanic)} needs rules support before this level can be applied.`,
      { mechanic }
    ));
  }

  const canLevelUp = threshold !== null && currentXp >= threshold && currentLevel < 20;

  return {
    canLevelUp,
    canApply: canLevelUp && blockers.length === 0,
    currentLevel,
    nextLevel,
    currentXp,
    threshold,
    classId,
    className: classData?.name || characterSheet.identity?.class_name || titleCase(classId),
    hp,
    proficiencyBonus: {
      current: proficiencyBonus(currentLevel),
      next: proficiencyBonus(nextLevel),
    },
    features: (advancement?.features || []).map((feature) => ({
      id: feature.id,
      name: feature.name,
      description: feature.description || '',
    })),
    requiredChoices,
    choices: choiceSelections,
    runtimeMechanics: advancement?.runtime_mechanics || [],
    spellcasting: advancement?.spellcasting || null,
    resources: advancement?.resources || {},
    derived: advancement?.derived || {},
    blockers,
  };
}

function applyLevelUp({
  characterSheet = {},
  content = getContentBundle(),
  payload = {},
  options = {},
} = {}) {
  const preview = getLevelUpPreview(characterSheet, content, { ...options, payload });
  if (!preview.canLevelUp) {
    return {
      ok: false,
      error: `This character needs ${preview.threshold ?? 'more'} XP before level ${preview.nextLevel}.`,
      preview,
    };
  }
  if (!preview.canApply) {
    return {
      ok: false,
      error: 'This level has choices or mechanics that are not implemented yet.',
      preview,
    };
  }

  const classData = byId(content.classes || [], preview.classId);
  const advancement = getClassAdvancement(content, preview.classId, preview.nextLevel) || {};
  const nextSheet = buildLeveledSheet(characterSheet, classData, advancement, preview, payload, content);
  return {
    ok: true,
    characterSheet: nextSheet,
    preview: getLevelUpPreview(nextSheet, content, options),
    applied: {
      fromLevel: preview.currentLevel,
      toLevel: preview.nextLevel,
      hpIncrease: preview.hp.increase,
      features: preview.features,
    },
  };
}

function buildLeveledSheet(characterSheet, classData, advancement, preview, payload, content) {
  const nextLevel = preview.nextLevel;
  const currentDerived = characterSheet.derived_stats || {};
  const currentResources = characterSheet.resources || {};
  const currentSpellcasting = characterSheet.spellcasting || null;
  const currentProgression = characterSheet.progression || {};
  const levelUpChoices = normalizeChoiceSelections(payload.choices || {});
  const nextExpertiseSkills = mergeExpertiseSkills(
    characterSheet.expertise_skills || [],
    getExpertiseChoiceIds(advancement.required_choices || [], levelUpChoices),
  );
  const nextMaxHp = Number(currentDerived.max_hp || 0) + preview.hp.increase;
  const nextHp = Number(currentDerived.hp ?? currentDerived.max_hp ?? nextMaxHp) + preview.hp.increase;
  const nextThreshold = getXpThreshold(content, nextLevel + 1);
  const nextPb = proficiencyBonus(nextLevel);
  const nextSpeed = Number(currentDerived.speed || 0) + getDerivedSpeedBonus(advancement, characterSheet);
  const nextResources = mergeResources(currentResources, advancement.resources, {
    hit_dice: {
      die: Number(classData?.hit_die || preview.hp.hitDie || 8),
      remaining: Number(currentResources.hit_dice?.remaining ?? preview.currentLevel) + 1,
      max: nextLevel,
    },
  });
  const nextSpellcasting = mergeSpellcasting(currentSpellcasting, advancement.spellcasting, levelUpChoices);
  const nextFeatures = [
    ...(characterSheet.features || []),
    ...(advancement.features || []).map((feature) => ({
      source: 'class',
      level: nextLevel,
      name: feature.name,
      description: feature.description || '',
    })),
  ];
  const nextDerivedStats = buildLeveledDerivedStats({
    currentDerived,
    characterSheet,
    content,
    nextLevel,
    nextPb,
    nextMaxHp,
    nextHp,
    nextSpeed,
    nextExpertiseSkills,
    hasJackOfAllTrades: Boolean(currentDerived.jack_of_all_trades || (advancement.runtime_mechanics || []).includes('jack_of_all_trades')),
  });

  return {
    ...characterSheet,
    identity: {
      ...(characterSheet.identity || {}),
      level: nextLevel,
      next_level_xp: nextThreshold,
      level_up_available: false,
    },
    derived_stats: nextDerivedStats,
    features: dedupeFeatures(nextFeatures),
    resources: nextResources,
    expertise_skills: nextExpertiseSkills,
    ...(nextSpellcasting ? { spellcasting: nextSpellcasting } : {}),
    progression: {
      ...currentProgression,
      experience_points: getCharacterXp(characterSheet),
      next_level_xp: nextThreshold,
      level_up_available: null,
      level_history: [
        ...(currentProgression.level_history || []),
        {
          level: nextLevel,
          class: preview.classId,
          applied_at: new Date().toISOString(),
          hp_method: payload.hpMethod || 'fixed',
          hp_increase: preview.hp.increase,
          features: preview.features.map((feature) => feature.name),
          choices: levelUpChoices,
        },
      ],
    },
  };
}

function normalizeChoiceSelections(rawChoices = {}) {
  return Object.fromEntries(Object.entries(rawChoices || {}).map(([choiceId, value]) => [
    choiceId,
    [...new Set((Array.isArray(value) ? value : [value]).map(normalizeId).filter(Boolean))],
  ]));
}

function buildRequiredChoicePreviews({
  choices = [],
  characterSheet = {},
  content = {},
  classId = '',
  selections = {},
} = {}) {
  return choices.map((choice) => {
    const selected = selections[choice.id] || [];
    return {
      ...choice,
      selected,
      options: getChoiceOptions({ choice, characterSheet, content, classId }),
    };
  });
}

function getChoiceOptions({ choice = {}, characterSheet = {}, content = {}, classId = '' } = {}) {
  if (choice.type === 'skill') {
    const existingExpertise = new Set((characterSheet.expertise_skills || []).map(normalizeId));
    const skillData = characterSheet.derived_stats?.skill_modifiers || {};
    return (content.skills || [])
      .filter((skill) => {
        const data = skillData[skill.id];
        if (!data?.proficient) return false;
        if (isExpertiseChoice(choice) && (data.expertise || existingExpertise.has(skill.id))) return false;
        return true;
      })
      .map((skill) => ({
        id: skill.id,
        name: skill.name || titleCase(skill.id),
        description: skill.description || '',
        meta: `${String(skill.ability || '').toUpperCase()} skill`,
      }));
  }

  if (choice.type === 'spell') {
    const spellcasting = characterSheet.spellcasting || {};
    const prepared = new Set([
      ...(spellcasting.spells_prepared || []),
      ...(spellcasting.always_prepared_spells || []),
    ].map(normalizeId));
    const spellClass = normalizeId(choice.class_id || classId);
    const maxLevel = Number(choice.max_level ?? 1);
    return (content.spells || [])
      .filter((spell) => Number(spell.level || 0) <= maxLevel)
      .filter((spell) => (spell.classes || []).map(normalizeId).includes(spellClass))
      .filter((spell) => !prepared.has(normalizeId(spell.id)))
      .map((spell) => ({
        id: spell.id,
        name: spell.name || titleCase(spell.id),
        description: spell.description || '',
        meta: `Level ${spell.level} - ${spell.casting_time || 'Action'} - ${spell.duration || 'Instant'}`,
      }));
  }

  return [];
}

function validateRequiredChoices(requiredChoices = [], selections = {}) {
  const blockers = [];
  for (const choice of requiredChoices) {
    const selected = selections[choice.id] || [];
    const count = Number(choice.count || 0);
    if (selected.length !== count) {
      blockers.push(blocker(
        'required_choice',
        `${choice.label || choice.id} must have exactly ${count} selection${count === 1 ? '' : 's'} before this level can be applied.`,
        { choice }
      ));
      continue;
    }

    if (new Set(selected).size !== selected.length) {
      blockers.push(blocker(
        'invalid_choice',
        `${choice.label || choice.id} cannot contain duplicate selections.`,
        { choice }
      ));
      continue;
    }

    const validIds = new Set((choice.options || []).map((option) => normalizeId(option.id)));
    const invalid = selected.filter((id) => !validIds.has(normalizeId(id)));
    if (invalid.length > 0) {
      blockers.push(blocker(
        'invalid_choice',
        `${choice.label || choice.id} includes an option that is not valid for this character.`,
        { choice }
      ));
    }
  }
  return blockers;
}

function buildLeveledDerivedStats({
  currentDerived = {},
  characterSheet = {},
  content = {},
  nextLevel,
  nextPb,
  nextMaxHp,
  nextHp,
  nextSpeed,
  nextExpertiseSkills = [],
  hasJackOfAllTrades = false,
} = {}) {
  const nextDerived = {
    ...currentDerived,
    level: nextLevel,
    proficiency_bonus: nextPb,
    max_hp: nextMaxHp,
    hp: Math.max(1, nextHp),
    speed: nextSpeed,
  };

  if (hasJackOfAllTrades) {
    nextDerived.jack_of_all_trades = true;
    nextDerived.jack_of_all_trades_bonus = Math.floor(nextPb / 2);
  }

  if ((content.skills || []).length > 0 && characterSheet.proficiencies?.skills) {
    nextDerived.skill_modifiers = buildSkillModifiersForLevelUp({
      skills: content.skills,
      proficientSkills: characterSheet.proficiencies.skills,
      abilityModifiers: characterSheet.abilities?.modifiers || {},
      pb: nextPb,
      expertiseSkills: nextExpertiseSkills,
      jackOfAllTrades: hasJackOfAllTrades,
    });
  }

  return nextDerived;
}

function buildSkillModifiersForLevelUp({
  skills = [],
  proficientSkills = [],
  abilityModifiers = {},
  pb = 2,
  expertiseSkills = [],
  jackOfAllTrades = false,
} = {}) {
  const proficient = new Set(proficientSkills.map(normalizeId));
  const expertise = new Set(expertiseSkills.map(normalizeId));
  const jackBonus = jackOfAllTrades ? Math.floor(Number(pb || 0) / 2) : 0;
  return Object.fromEntries(skills.map((skill) => {
    const skillId = normalizeId(skill.id);
    const hasProficiency = proficient.has(skillId);
    const hasExpertise = hasProficiency && expertise.has(skillId);
    const jackApplied = !hasProficiency && jackBonus > 0;
    return [skill.id, {
      ability: skill.ability,
      proficient: hasProficiency,
      expertise: hasExpertise,
      jack_of_all_trades: jackApplied,
      jack_bonus: jackApplied ? jackBonus : 0,
      total: Number(abilityModifiers[skill.ability] || 0)
        + (hasProficiency ? Number(pb || 0) : 0)
        + (hasExpertise ? Number(pb || 0) : 0)
        + (jackApplied ? jackBonus : 0),
    }];
  }));
}

function getExpertiseChoiceIds(requiredChoices = [], selections = {}) {
  return requiredChoices
    .filter(isExpertiseChoice)
    .flatMap((choice) => selections[choice.id] || []);
}

function isExpertiseChoice(choice = {}) {
  const id = normalizeId(choice.id);
  return choice.type === 'skill' && (id.includes('expertise') || id === 'scholar_skill');
}

function mergeExpertiseSkills(current = [], additions = []) {
  return [...new Set([...current, ...additions].map(normalizeId).filter(Boolean))];
}

function getDerivedSpeedBonus(advancement = {}, characterSheet = {}) {
  const bonus = Number(advancement.derived?.speed_bonus || 0);
  if (!bonus) return 0;
  if (!(advancement.runtime_mechanics || []).includes('unarmored_movement')) return bonus;
  return hasArmorOrShieldEquipped(characterSheet) ? 0 : bonus;
}

function hasArmorOrShieldEquipped(characterSheet = {}) {
  const equipped = characterSheet.equipped || {};
  if (equipped.armor || equipped.shield || equipped.off_hand === 'shield') return true;
  return (characterSheet.active_effects || []).some((effect) => (
    effect.source_type === 'equipment'
    && ['armor_formula', 'shield_bonus'].includes(effect.target)
  ));
}

function getFixedHpIncrease(characterSheet = {}, classData = {}) {
  const hitDie = Number(classData?.hit_die || characterSheet.identity?.hit_die || 8);
  const fixedBase = Math.floor(hitDie / 2) + 1;
  const conScore = Number(characterSheet.abilities?.final_scores?.con ?? 10);
  const conModifier = Number(
    characterSheet.abilities?.modifiers?.con
      ?? abilityMod(conScore)
  );
  const perLevelBonus = (characterSheet.active_effects || [])
    .filter((effect) => effect.target === 'max_hp_per_level_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  const increase = Math.max(1, fixedBase + conModifier + perLevelBonus);
  return {
    method: 'fixed',
    hitDie,
    fixedBase,
    constitutionModifier: conModifier,
    perLevelBonus,
    increase,
  };
}

function getClassAdvancement(content = {}, classId, level) {
  return content.classAdvancement?.levels?.[normalizeId(classId)]?.[String(level)] || null;
}

function getCharacterXp(characterSheet = {}) {
  return Number(
    characterSheet.identity?.experience_points
      ?? characterSheet.progression?.experience_points
      ?? 0
  );
}

function getCharacterLevel(characterSheet = {}) {
  return Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
}

function getXpThreshold(content = {}, level) {
  const value = content.xpThresholds?.[String(level)];
  return value === undefined ? null : Number(value);
}

function proficiencyBonus(level) {
  return Math.floor((Number(level || 1) - 1) / 4) + 2;
}

function mergeResources(current = {}, advancementResources = {}, extra = {}) {
  const merged = clone(current);
  for (const [key, value] of Object.entries({ ...advancementResources, ...extra })) {
    const existing = merged[key];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const max = value.max ?? existing.max;
      merged[key] = {
        ...existing,
        ...value,
        remaining: Math.min(Number(existing.remaining ?? value.remaining ?? max ?? 0), Number(max ?? existing.remaining ?? 0)),
        max,
      };
    } else {
      merged[key] = clone(value);
    }
  }
  return merged;
}

function mergeSpellcasting(current, advancementSpellcasting, levelUpChoices = {}) {
  if (!current && !advancementSpellcasting) return null;
  if (!advancementSpellcasting) return current;
  const preparedAdditions = levelUpChoices.prepared_spells || [];
  return {
    ...(current || {}),
    ...(advancementSpellcasting.cantrips !== undefined ? { cantrips_count: advancementSpellcasting.cantrips } : {}),
    ...(advancementSpellcasting.prepared_spells !== undefined ? { prepared_spells_count: advancementSpellcasting.prepared_spells } : {}),
    prepared_from_choices: [
      ...new Set([
        ...((current || {}).prepared_from_choices || []),
        ...preparedAdditions,
      ]),
    ],
    spells_prepared: [
      ...new Set([
        ...((current || {}).spells_prepared || []),
        ...preparedAdditions,
      ]),
    ],
    always_prepared_spells: [
      ...new Set([
        ...((current || {}).always_prepared_spells || []),
        ...(advancementSpellcasting.always_prepared_spells || []),
      ]),
    ],
    slots: {
      ...((current || {}).slots || {}),
      ...(advancementSpellcasting.slots || {}),
    },
  };
}

function dedupeFeatures(features = []) {
  const seen = new Set();
  return features.filter((feature) => {
    const key = `${normalizeId(feature.source || 'feature')}:${normalizeId(feature.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blocker(type, message, extra = {}) {
  return { type, message, ...extra };
}

function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function normalizeId(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function titleCase(value = '') {
  return normalizeId(value).replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

module.exports = {
  applyLevelUp,
  getClassAdvancement,
  getFixedHpIncrease,
  getLevelUpPreview,
  getXpThreshold,
  proficiencyBonus,
};
