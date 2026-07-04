const { validateCharacter } = require('./characterValidator');
const { getContentBundle } = require('./contentData');
const { applyLevelUp, getLevelUpPreview } = require('./levelUpEngine');
const { getXpThreshold, setCharacterXp } = require('./progressionEngine');

const CLASS_PROFILES = {
  barbarian: { background: 'soldier', primary: 'str', secondary: 'con' },
  bard: { background: 'merchant', primary: 'cha', secondary: 'dex' },
  cleric: { background: 'farmer', primary: 'wis', secondary: 'con' },
  druid: { background: 'farmer', primary: 'wis', secondary: 'con' },
  fighter: { background: 'soldier', primary: 'str', secondary: 'con' },
  monk: { background: 'wayfarer', primary: 'dex', secondary: 'wis' },
  paladin: { background: 'soldier', primary: 'str', secondary: 'cha' },
  ranger: { background: 'wayfarer', primary: 'dex', secondary: 'wis' },
  rogue: { background: 'wayfarer', primary: 'dex', secondary: 'int' },
  sorcerer: { background: 'merchant', primary: 'cha', secondary: 'con' },
  warlock: { background: 'merchant', primary: 'cha', secondary: 'con' },
  wizard: { background: 'merchant', primary: 'int', secondary: 'con' },
};

const CLASS_CHOICES = {
  cleric: { divine_order: 'protector' },
  druid: { primal_order: 'warden' },
  fighter: { fighting_style: 'defense' },
  warlock: { eldritch_invocation: 'pact_of_the_blade' },
};

const CLASS_CHOICE_DETAILS = {
  warlock: { eldritch_invocation: { pact_weapon: 'longsword' } },
};

const WEAPON_MASTERIES = {
  barbarian: ['greataxe', 'handaxe'],
  fighter: ['longsword', 'dagger', 'longbow'],
  paladin: ['longsword', 'mace'],
  ranger: ['longbow', 'shortsword'],
  rogue: ['dagger', 'shortsword'],
};

function buildQaLevelFourRoster({ sessionId, campaignId, content = getContentBundle() } = {}) {
  if (!sessionId || !campaignId) throw new Error('QA roster generation requires a session and campaign.');

  return Object.keys(CLASS_PROFILES).map((classId) => ({
    classId,
    name: qaLevelFourFixtureName(classId),
    characterSheet: buildQaLevelFourCharacter({ classId, sessionId, campaignId, content }),
  }));
}

function buildQaLevelFourCharacter({ classId, sessionId, campaignId, content = getContentBundle() } = {}) {
  const profile = CLASS_PROFILES[classId];
  const characterClass = content.classes.find((entry) => entry.id === classId);
  const background = content.backgrounds.find((entry) => entry.id === profile?.background);
  if (!profile || !characterClass || !background) throw new Error(`No QA level 4 fixture profile exists for ${classId}.`);

  let characterSheet = validateCharacter(buildLevelOneDraft({ characterClass, background, profile, content }), content, {
    sessionId,
    campaignId,
  });

  for (const targetLevel of [2, 3, 4]) {
    characterSheet = advanceFixture(characterSheet, targetLevel, profile.primary, content);
  }

  const levelFiveThreshold = getXpThreshold(5);
  characterSheet = setCharacterXp(characterSheet, levelFiveThreshold, {
    sourceType: 'qa_fixture',
    sourceId: `qa:level_four_fixture:${classId}`,
    reason: 'Protected QA level 5 readiness fixture',
    metadata: { tool: 'qa_seed_level_four_roster', class_id: classId },
  });
  characterSheet.notes = {
    ...(characterSheet.notes || {}),
    qa_fixture: {
      id: `level_four_${classId}`,
      resettable: true,
      target_level: 5,
    },
  };
  return characterSheet;
}

function buildLevelOneDraft({ characterClass, background, profile, content }) {
  const classId = characterClass.id;
  const classChoices = CLASS_CHOICES[classId] || {};
  const selectedSkills = characterClass.skill_options
    .filter((skillId) => !(background.skills || []).includes(skillId))
    .slice(0, characterClass.skill_count);

  return {
    name: qaLevelFourFixtureName(classId),
    speciesId: 'dwarf',
    speciesChoices: {},
    languages: ['elvish', 'gnomish'],
    characterDetails: {
      alignment: 'Neutral Good',
      appearance: `A practical ${characterClass.name} prepared for repeatable QA adventures.`,
      personality: 'Methodical, cooperative, and unusually tolerant of reset buttons.',
      backstory: 'Assigned to verify level progression without endangering ordinary campaign characters.',
    },
    classId,
    backgroundId: background.id,
    abilityMethod: 'standard_array',
    abilityScores: buildAbilityScores(profile, background),
    selectedSkills,
    equipmentChoice: 'pack',
    backgroundEquipmentChoice: 'equipment',
    backgroundToolChoices: getBackgroundToolChoices(background, content),
    classChoices,
    classChoiceDetails: CLASS_CHOICE_DETAILS[classId] || {},
    classLanguages: classId === 'rogue' ? ['goblin'] : [],
    weaponMasteries: WEAPON_MASTERIES[classId] || [],
    expertiseSkills: classId === 'rogue' ? selectedSkills.slice(0, 2) : [],
    humanSkillId: '',
    humanOriginFeatId: '',
    featSkillChoices: {},
    magicInitiateChoices: {},
    ...buildSpellDraft(characterClass, content, classChoices),
  };
}

function buildAbilityScores(profile, background) {
  const scores = {};
  const preferred = [...new Set([profile.primary, profile.secondary, 'con'])];
  const remaining = ['str', 'dex', 'con', 'int', 'wis', 'cha'].filter((ability) => !preferred.includes(ability));
  [...preferred, ...remaining].forEach((ability, index) => {
    scores[ability] = [15, 14, 13, 12, 10, 8][index];
  });

  const bonusOptions = new Set(background.asi_options || []);
  const primaryBonus = bonusOptions.has(profile.primary) ? profile.primary : [...bonusOptions][0];
  const secondaryBonus = [profile.secondary, 'con', ...bonusOptions]
    .find((ability) => ability !== primaryBonus && bonusOptions.has(ability));
  scores.backgroundBonus = { [primaryBonus]: 2, [secondaryBonus]: 1 };
  return scores;
}

function getBackgroundToolChoices(background, content) {
  if (!background.tool_choice) return [];
  return content.tools
    .filter((tool) => !background.tool_choice.category || tool.category === background.tool_choice.category)
    .slice(0, background.tool_choice.count)
    .map((tool) => tool.id);
}

function buildSpellDraft(characterClass, content, classChoices) {
  const spellcasting = characterClass.spellcasting;
  if (!spellcasting) return { cantripsKnown: [], spellsKnown: [], spellbookSpells: [] };

  const selectedOptions = (characterClass.class_choices || [])
    .map((choice) => (choice.options || []).find((option) => option.id === classChoices[choice.id]))
    .filter(Boolean);
  const extraCantrips = selectedOptions.reduce((sum, option) => sum + Number(option.extra_cantrips || 0), 0);
  const cantripsKnown = content.spells
    .filter((spell) => spell.level === 0 && spell.classes.includes(characterClass.id))
    .slice(0, Number(spellcasting.cantrips || 0) + extraCantrips)
    .map((spell) => spell.id);
  const levelOneSpells = content.spells
    .filter((spell) => spell.level === 1 && spell.classes.includes(characterClass.id))
    .map((spell) => spell.id);
  const eligiblePrepared = levelOneSpells.filter((spellId) => !(spellcasting.always_prepared_spells || []).includes(spellId));

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
    spellsKnown: eligiblePrepared.slice(0, spellcasting.prepared_spells || 0),
    spellbookSpells: [],
  };
}

function advanceFixture(characterSheet, targetLevel, primaryAbility, content) {
  const threshold = getXpThreshold(targetLevel);
  let readySheet = setCharacterXp(characterSheet, threshold, {
    sourceType: 'qa_fixture',
    sourceId: `qa:fixture:${characterSheet.identity.class}:level_${targetLevel}`,
    reason: `Build protected QA level ${targetLevel} fixture state`,
  });
  const choices = targetLevel === 3
    ? { subclass: [content.subclasses.find((entry) => entry.class_id === characterSheet.identity.class)?.id].filter(Boolean) }
    : targetLevel === 4
      ? { level_4_feat: ['ability_score_improvement'], asi_pattern: ['plus_two'], asi_primary: [primaryAbility] }
      : {};

  completeRequiredChoices(readySheet, content, choices);
  const result = applyLevelUp({ characterSheet: readySheet, content, payload: { choices } });
  if (!result.ok) {
    const blockers = result.preview?.blockers?.map((entry) => entry.message).join(' | ') || result.error;
    throw new Error(`${characterSheet.identity.class} level ${targetLevel} QA fixture failed: ${blockers}`);
  }
  return result.characterSheet;
}

function completeRequiredChoices(characterSheet, content, choices) {
  for (let pass = 0; pass < 30; pass += 1) {
    const preview = getLevelUpPreview(characterSheet, content, { choices });
    const missing = preview.requiredChoices.find((choice) => choice.active && !choices[choice.id]);
    if (!missing) return choices;
    const available = (missing.options || []).filter((option) => {
      if (option.disabled) return false;
      const requirement = option.requires_choice;
      return !requirement || (choices[requirement.choice_id] || []).includes(requirement.option_id);
    });
    const count = Number(missing.count || 0);
    if (available.length < count) throw new Error(`QA fixture cannot satisfy ${missing.label}.`);
    choices[missing.id] = available.slice(0, count).map((option) => option.id);
  }
  throw new Error('QA fixture choice completion exceeded its safety limit.');
}

function qaLevelFourFixtureName(classId) {
  const normalized = String(classId || '').trim().toLowerCase();
  if (!CLASS_PROFILES[normalized]) return null;
  return `QA L4 ${normalized[0].toUpperCase()}${normalized.slice(1)}`;
}

function isQaLevelFourFixtureName(name) {
  return Object.keys(CLASS_PROFILES).some((classId) => qaLevelFourFixtureName(classId) === String(name || '').trim());
}

module.exports = {
  buildQaLevelFourCharacter,
  buildQaLevelFourRoster,
  isQaLevelFourFixtureName,
  qaLevelFourFixtureName,
};
