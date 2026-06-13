const { getContentBundle, byId } = require('./contentData');
const { abilityMod } = require('./characterValidator');

const SUPPORTED_LEVEL_UP_MECHANICS = new Set([
  'action_surge',
  'cunning_action',
  'danger_sense',
  'reckless_attack',
  'tactical_mind',
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

  const requiredChoices = advancement?.required_choices || [];
  for (const choice of requiredChoices) {
    blockers.push(blocker(
      'required_choice',
      `${choice.label || choice.id} must be selected before this level can be applied.`,
      { choice }
    ));
  }

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
  const preview = getLevelUpPreview(characterSheet, content, options);
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
  const nextMaxHp = Number(currentDerived.max_hp || 0) + preview.hp.increase;
  const nextHp = Number(currentDerived.hp ?? currentDerived.max_hp ?? nextMaxHp) + preview.hp.increase;
  const nextThreshold = getXpThreshold(content, nextLevel + 1);
  const nextPb = proficiencyBonus(nextLevel);
  const nextResources = mergeResources(currentResources, advancement.resources, {
    hit_dice: {
      die: Number(classData?.hit_die || preview.hp.hitDie || 8),
      remaining: Number(currentResources.hit_dice?.remaining ?? preview.currentLevel) + 1,
      max: nextLevel,
    },
  });
  const nextSpellcasting = mergeSpellcasting(currentSpellcasting, advancement.spellcasting);
  const nextFeatures = [
    ...(characterSheet.features || []),
    ...(advancement.features || []).map((feature) => ({
      source: 'class',
      level: nextLevel,
      name: feature.name,
      description: feature.description || '',
    })),
  ];

  return {
    ...characterSheet,
    identity: {
      ...(characterSheet.identity || {}),
      level: nextLevel,
      next_level_xp: nextThreshold,
      level_up_available: false,
    },
    derived_stats: {
      ...currentDerived,
      level: nextLevel,
      proficiency_bonus: nextPb,
      max_hp: nextMaxHp,
      hp: Math.max(1, nextHp),
      speed: Number(currentDerived.speed || 0) + Number(advancement.derived?.speed_bonus || 0),
    },
    features: dedupeFeatures(nextFeatures),
    resources: nextResources,
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
        },
      ],
    },
  };
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

function mergeSpellcasting(current, advancementSpellcasting) {
  if (!current && !advancementSpellcasting) return null;
  if (!advancementSpellcasting) return current;
  return {
    ...(current || {}),
    ...(advancementSpellcasting.cantrips !== undefined ? { cantrips_count: advancementSpellcasting.cantrips } : {}),
    ...(advancementSpellcasting.prepared_spells !== undefined ? { prepared_spells_count: advancementSpellcasting.prepared_spells } : {}),
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
