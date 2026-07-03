const { getContentBundle, byId } = require('./contentData');
const { abilityMod } = require('./characterValidator');
const {
  getFightingStyleArmorBonus,
  getFightingStyleAttackBonus,
  getFightingStyleSenses,
} = require('./fightingStyleEngine');

const SUPPORTED_LEVEL_UP_MECHANICS = new Set([
  'action_surge',
  'channel_divinity',
  'cunning_action',
  'danger_sense',
  'divine_spark',
  'expertise_level_2',
  'deft_explorer',
  'druidic_warrior',
  'fighting_style_level_2',
  'focus_points',
  'font_of_magic',
  'jack_of_all_trades',
  'magical_cunning',
  'metamagic',
  'reckless_attack',
  'scholar',
  'paladin_smite',
  'tactical_mind',
  'turn_undead',
  'unarmored_movement',
  'uncanny_metabolism',
  'wild_companion',
  'wild_shape',
  'eldritch_invocations_level_2',
  'fighter_level_3',
  'rogue_level_3',
  'barbarian_level_3',
  'bard_level_3',
  'cleric_level_3',
  'druid_level_3',
  'monk_level_3',
  'paladin_level_3',
  'ranger_level_3',
  'sorcerer_level_3',
  'warlock_level_3',
  'wizard_level_3',
]);

const METAMAGIC_OPTIONS = [
  { id: 'careful_spell', name: 'Careful Spell', description: 'Spend 1 Sorcery Point to protect chosen creatures from a spell saving throw.' },
  { id: 'distant_spell', name: 'Distant Spell', description: 'Spend 1 Sorcery Point to double a spell range or make a Touch spell reach 30 feet.' },
  { id: 'empowered_spell', name: 'Empowered Spell', description: 'Spend 1 Sorcery Point to reroll some spell damage dice.' },
  { id: 'extended_spell', name: 'Extended Spell', description: 'Spend 1 Sorcery Point to double a spell duration and steady its Concentration.' },
  { id: 'heightened_spell', name: 'Heightened Spell', description: 'Spend 2 Sorcery Points to impose Disadvantage on one target save.' },
  { id: 'quickened_spell', name: 'Quickened Spell', description: 'Spend 2 Sorcery Points to cast an Action spell as a Bonus Action.' },
  { id: 'seeking_spell', name: 'Seeking Spell', description: 'Spend 1 Sorcery Point to reroll a missed spell attack.' },
  { id: 'subtle_spell', name: 'Subtle Spell', description: 'Spend 1 Sorcery Point to cast without verbal, somatic, or ordinary material components.' },
  { id: 'transmuted_spell', name: 'Transmuted Spell', description: 'Spend 1 Sorcery Point to change eligible elemental spell damage.' },
  { id: 'twinned_spell', name: 'Twinned Spell', description: 'Spend 1 Sorcery Point to increase a qualifying spell\'s effective level for an extra target.' },
];

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

  const selectedSubclass = getSelectedSubclass({
    characterSheet,
    content,
    classId,
    nextLevel,
    selections: choiceSelections,
  });
  const levelFeatures = [
    ...(advancement?.features || []),
    ...getSubclassFeatures(selectedSubclass, nextLevel),
  ];
  const runtimeMechanics = [...new Set([
    ...(advancement?.runtime_mechanics || []),
    ...(selectedSubclass?.runtime_mechanics || []),
  ])];

  const supportedMechanics = options.supportedMechanics || SUPPORTED_LEVEL_UP_MECHANICS;
  for (const mechanic of runtimeMechanics) {
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
    features: levelFeatures.map((feature) => ({
      id: feature.id,
      name: feature.name,
      description: feature.description || '',
    })),
    requiredChoices,
    selectedSubclass: selectedSubclass ? summarizeSubclass(selectedSubclass) : null,
    choices: choiceSelections,
    runtimeMechanics,
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
  const selectedSubclass = getSelectedSubclass({
    characterSheet,
    content,
    classId: preview.classId,
    nextLevel,
    selections: levelUpChoices,
  });
  const selectedFightingStyle = levelUpChoices.fighting_style?.[0]
    || normalizeId(characterSheet.class_choices?.fighting_style);
  const nextExpertiseSkills = mergeExpertiseSkills(
    characterSheet.expertise_skills || [],
    getExpertiseChoiceIds(advancement.required_choices || [], levelUpChoices),
  );
  const nextProficientSkills = mergeSkillProficiencies(
    characterSheet.proficiencies?.skills || [],
    getSkillProficiencyChoiceIds(advancement.required_choices || [], levelUpChoices),
  );
  const subclassHpBonus = selectedSubclass?.id === 'draconic_sorcery' && nextLevel === 3 ? 3 : 0;
  const nextMaxHp = Number(currentDerived.max_hp || 0) + preview.hp.increase + subclassHpBonus;
  const nextHp = Number(currentDerived.hp ?? currentDerived.max_hp ?? nextMaxHp) + preview.hp.increase + subclassHpBonus;
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
  const nextCantrips = getCantripChoiceIds(advancement.required_choices || [], levelUpChoices);
  const nextSpellcasting = applySubclassSpellcasting(
    mergeSpellcasting(currentSpellcasting, advancement.spellcasting, levelUpChoices, nextCantrips),
    selectedSubclass,
    levelUpChoices,
  );
  const invocationState = buildInvocationLevelUpState({ characterSheet, levelUpChoices, content });
  const nextLanguages = mergeLanguages(
    characterSheet.languages || characterSheet.proficiencies?.languages || [],
    getLanguageChoiceIds(advancement.required_choices || [], levelUpChoices),
  );
  const currentFeatures = preview.classId === 'rogue' && nextLevel === 3
    ? (characterSheet.features || []).filter((feature) => !normalizeId(feature.name).startsWith('sneak_attack'))
    : (characterSheet.features || []);
  const nextFeatures = [
    ...currentFeatures,
    ...preview.features.map((feature) => ({
      source: getSubclassFeatures(selectedSubclass, nextLevel).some((entry) => entry.id === feature.id) ? 'subclass' : 'class',
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
    proficientSkills: nextProficientSkills,
    fightingStyle: selectedFightingStyle,
    hasJackOfAllTrades: Boolean(currentDerived.jack_of_all_trades || (advancement.runtime_mechanics || []).includes('jack_of_all_trades')),
  });
  applyLevelThreeDerivedStats(nextDerivedStats, preview.classId, nextLevel, characterSheet, selectedSubclass);
  const pactWeaponAttack = buildPactWeaponAttack({
    weaponId: invocationState.pactWeaponId,
    characterSheet,
    content,
    proficiencyBonus: nextPb,
  });
  if (pactWeaponAttack) {
    nextDerivedStats.attack_breakdowns = [
      ...(nextDerivedStats.attack_breakdowns || []).filter((attack) => attack.weapon_id !== pactWeaponAttack.weapon_id),
      pactWeaponAttack,
    ];
  }

  return {
    ...characterSheet,
    identity: {
      ...(characterSheet.identity || {}),
      level: nextLevel,
      ...(selectedSubclass ? { subclass: selectedSubclass.id, subclass_name: selectedSubclass.name } : {}),
      next_level_xp: nextThreshold,
      level_up_available: false,
    },
    derived_stats: nextDerivedStats,
    features: dedupeFeatures(nextFeatures),
    resources: nextResources,
    expertise_skills: nextExpertiseSkills,
    class_choices: {
      ...(characterSheet.class_choices || {}),
      ...(selectedFightingStyle ? { fighting_style: selectedFightingStyle } : {}),
      ...(levelUpChoices.metamagic?.length ? { metamagic: levelUpChoices.metamagic } : {}),
      ...(invocationState.invocations.length ? { eldritch_invocations: invocationState.invocations } : {}),
      ...(levelUpChoices.land_type?.length ? { land_type: levelUpChoices.land_type[0] } : {}),
      ...(levelUpChoices.hunters_prey?.length ? { hunters_prey: levelUpChoices.hunters_prey[0] } : {}),
      ...(selectedSubclass ? { subclass: selectedSubclass.id } : {}),
    },
    class_choice_details: {
      ...(characterSheet.class_choice_details || {}),
      ...invocationState.details,
    },
    class_choice_spells: mergeClassChoiceSpells(characterSheet.class_choice_spells, invocationState.spells),
    languages: nextLanguages,
    proficiencies: {
      ...(characterSheet.proficiencies || {}),
      skills: nextProficientSkills,
      languages: nextLanguages,
    },
    ...(nextSpellcasting ? {
      spellcasting: {
        ...nextSpellcasting,
        class_choice_spells: mergeClassChoiceSpells(nextSpellcasting.class_choice_spells, invocationState.spells),
        ritual_spells: [
          ...new Set([
            ...(nextSpellcasting.ritual_spells || []),
            ...invocationState.spells.filter((spell) => spell.type === 'ritual').map((spell) => spell.id),
          ]),
        ],
        cantrips_known: [
          ...new Set([
            ...(nextSpellcasting.cantrips_known || []),
            ...invocationState.spells.filter((spell) => spell.type === 'cantrip').map((spell) => spell.id),
          ]),
        ],
      },
    } : {}),
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
          ...(selectedSubclass ? { subclass: selectedSubclass.id } : {}),
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
      active: isRequiredChoiceActive(choice, selections),
      options: getChoiceOptions({ choice, characterSheet, content, classId, selections }),
    };
  });
}

function getChoiceOptions({ choice = {}, characterSheet = {}, content = {}, classId = '', selections = {} } = {}) {
  if (choice.type === 'subclass') {
    const currentLevel = getCharacterLevel(characterSheet);
    return (content.subclasses || [])
      .filter((subclass) => normalizeId(subclass.class_id) === normalizeId(classId))
      .filter((subclass) => Number(subclass.unlock_level || 3) <= currentLevel + 1)
      .map((subclass) => ({
        id: subclass.id,
        name: subclass.name,
        description: subclass.description || '',
        meta: [
          `${titleCase(classId)} subclass`,
          ...getSubclassFeatures(subclass, currentLevel + 1).map((feature) => feature.name),
        ].join(' - '),
      }));
  }

  if (choice.type === 'skill_proficiency') {
    const known = new Set((characterSheet.proficiencies?.skills || []).map(normalizeId));
    const classData = byId(content.classes || [], classId);
    return (content.skills || [])
      .filter((skill) => (classData?.skill_options || []).map(normalizeId).includes(normalizeId(skill.id)))
      .filter((skill) => !known.has(normalizeId(skill.id)))
      .map((skill) => ({
        id: skill.id,
        name: skill.name || titleCase(skill.id),
        description: skill.description || '',
        meta: `${String(skill.ability || '').toUpperCase()} skill proficiency`,
      }));
  }

  if (choice.type === 'skill_proficiency_any') {
    const known = new Set((characterSheet.proficiencies?.skills || []).map(normalizeId));
    return (content.skills || [])
      .filter((skill) => !known.has(normalizeId(skill.id)))
      .map((skill) => ({
        id: skill.id,
        name: skill.name || titleCase(skill.id),
        description: skill.description || '',
        meta: `${String(skill.ability || '').toUpperCase()} skill proficiency`,
      }));
  }

  if (choice.type === 'skill') {
    const existingExpertise = new Set((characterSheet.expertise_skills || []).map(normalizeId));
    const skillData = characterSheet.derived_stats?.skill_modifiers || {};
    const scholarSkills = new Set(['arcana', 'history', 'investigation', 'medicine', 'nature', 'religion']);
    return (content.skills || [])
      .filter((skill) => {
        const data = skillData[skill.id];
        if (!data?.proficient) return false;
        if (isExpertiseChoice(choice) && (data.expertise || existingExpertise.has(skill.id))) return false;
        if (normalizeId(choice.id) === 'scholar_skill' && !scholarSkills.has(normalizeId(skill.id))) return false;
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
    const minLevel = Number(choice.min_level ?? 0);
    const maxLevel = Number(choice.max_level ?? 1);
    const excluded = new Set((choice.exclude_ids || []).map(normalizeId));
    return (content.spells || [])
      .filter((spell) => Number(spell.level || 0) >= minLevel && Number(spell.level || 0) <= maxLevel)
      .filter((spell) => spellClass === 'any' || (spell.classes || []).map(normalizeId).includes(spellClass))
      .filter((spell) => !choice.ritual_only || spell.ritual)
      .filter((spell) => !prepared.has(normalizeId(spell.id)))
      .filter((spell) => !excluded.has(normalizeId(spell.id)))
      .map((spell) => ({
        id: spell.id,
        name: spell.name || titleCase(spell.id),
        description: spell.description || '',
        meta: `Level ${spell.level} - ${spell.casting_time || 'Action'} - ${spell.duration || 'Instant'}`,
      }));
  }

  if (choice.type === 'wizard_spell') {
    const spellbook = new Set((characterSheet.spellcasting?.spellbook_spells || []).map(normalizeId));
    const selectedElsewhere = new Set(Object.entries(selections)
      .filter(([choiceId]) => choiceId !== choice.id && ['spellbook_spells', 'evocation_savant_spells'].includes(choiceId))
      .flatMap(([, ids]) => ids || [])
      .map(normalizeId));
    const maxLevel = Number(choice.max_level ?? 1);
    const requiredSchool = normalizeId(choice.school);
    return (content.spells || [])
      .filter((spell) => Number(spell.level || 0) >= 1 && Number(spell.level || 0) <= maxLevel)
      .filter((spell) => (spell.classes || []).map(normalizeId).includes('wizard'))
      .filter((spell) => !requiredSchool || inferSpellSchool(spell) === requiredSchool)
      .filter((spell) => !spellbook.has(normalizeId(spell.id)))
      .filter((spell) => !selectedElsewhere.has(normalizeId(spell.id)))
      .map((spell) => ({
        id: spell.id,
        name: spell.name || titleCase(spell.id),
        description: spell.description || '',
        meta: `Level ${spell.level} ${titleCase(inferSpellSchool(spell) || 'spell')} spellbook addition - ${spell.casting_time || 'Action'} - ${spell.duration || 'Instant'}`,
      }));
  }

  if (choice.type === 'wizard_prepared_spell') {
    const spellbook = new Set((characterSheet.spellcasting?.spellbook_spells || []).map(normalizeId));
    const prepared = new Set((characterSheet.spellcasting?.spells_prepared || []).map(normalizeId));
    const maxLevel = Number(choice.max_level ?? 1);
    return (content.spells || [])
      .filter((spell) => Number(spell.level || 0) >= 1 && Number(spell.level || 0) <= maxLevel)
      .filter((spell) => (spell.classes || []).map(normalizeId).includes('wizard'))
      .filter((spell) => !prepared.has(normalizeId(spell.id)))
      .map((spell) => ({
        id: spell.id,
        name: spell.name || titleCase(spell.id),
        description: spell.description || '',
        meta: spellbook.has(normalizeId(spell.id)) ? 'Already in spellbook' : 'Selected spellbook addition',
        ...(!spellbook.has(normalizeId(spell.id)) && ![
          ...(selections.spellbook_spells || []),
          ...(selections.evocation_savant_spells || []),
        ].includes(normalizeId(spell.id)) ? {
          requires_choice: { choice_id: 'spellbook_spells', option_id: spell.id },
        } : {}),
      }));
  }

  if (choice.type === 'language') {
    const known = new Set([
      ...(characterSheet.languages || []),
      ...(characterSheet.proficiencies?.languages || []),
    ].map(normalizeId));
    const reserved = new Set(['druidic', 'thieves_cant']);
    return (content.languages || [])
      .filter((language) => !known.has(normalizeId(language.id)))
      .filter((language) => !reserved.has(normalizeId(language.id)))
      .map((language) => ({
        id: language.id,
        name: language.name || titleCase(language.id),
        description: language.description || '',
        meta: titleCase(language.category || 'language'),
      }));
  }

  if (choice.type === 'fighting_style') {
    const fighter = byId(content.classes || [], 'fighter');
    const fighterStyles = (fighter?.class_choices || [])
      .find((entry) => entry.id === 'fighting_style')?.options || [];
    const extraStyles = classId === 'ranger'
      ? [{
          id: 'druidic_warrior',
          name: 'Druidic Warrior',
          description: 'Learn two Druid cantrips, using Wisdom as your spellcasting ability for them.',
        }]
      : [];
    return [...fighterStyles, ...extraStyles].map((style) => ({
      id: style.id,
      name: style.name || titleCase(style.id),
      description: style.description || '',
      meta: style.id === 'druidic_warrior' ? 'Cantrip style' : 'Fighting Style feat',
    }));
  }

  if (choice.type === 'metamagic') {
    const known = new Set((characterSheet.class_choices?.metamagic || []).map(normalizeId));
    return METAMAGIC_OPTIONS
      .filter((option) => !known.has(option.id))
      .map((option) => ({ ...option, meta: option.id === 'heightened_spell' || option.id === 'quickened_spell' ? '2 Sorcery Points' : '1 Sorcery Point' }));
  }

  if (choice.type === 'eldritch_invocation') {
    const warlock = byId(content.classes || [], 'warlock');
    const invocationChoice = (warlock?.class_choices || []).find((entry) => entry.id === 'eldritch_invocation');
    const known = new Set([
      normalizeId(characterSheet.class_choices?.eldritch_invocation),
      ...((characterSheet.class_choices?.eldritch_invocations || []).map(normalizeId)),
    ].filter(Boolean));
    return (invocationChoice?.options || [])
      .filter((option) => !known.has(normalizeId(option.id)))
      .map((option) => ({ id: option.id, name: option.name, description: option.description, meta: 'Eldritch Invocation' }));
  }

  if (choice.type === 'weapon') {
    return (content.equipment || [])
      .filter((item) => item.type === 'weapon')
      .filter((item) => choice.weapon_filter !== 'simple_or_martial_melee' || !item.properties?.includes('ammunition'))
      .map((item) => ({ id: item.id, name: item.name, description: item.description || '', meta: 'Pact weapon form' }));
  }

  if (choice.type === 'option') {
    return (choice.options || []).map((option) => ({
      id: option.id,
      name: option.name || titleCase(option.id),
      description: option.description || '',
      meta: option.meta || '',
    }));
  }

  return [];
}

function validateRequiredChoices(requiredChoices = [], selections = {}) {
  const blockers = [];
  for (const choice of requiredChoices) {
    if (!isRequiredChoiceActive(choice, selections)) continue;
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

    const validIds = new Set((choice.options || [])
      .filter((option) => isChoiceOptionAvailable(option, selections))
      .map((option) => normalizeId(option.id)));
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

function isChoiceOptionAvailable(option = {}, selections = {}) {
  const requirement = option.requires_choice;
  if (!requirement) return true;
  return (selections[requirement.choice_id] || [])
    .map(normalizeId)
    .includes(normalizeId(requirement.option_id));
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
  proficientSkills = characterSheet.proficiencies?.skills || [],
  hasJackOfAllTrades = false,
  fightingStyle = '',
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

  if ((content.skills || []).length > 0 && proficientSkills) {
    nextDerived.skill_modifiers = buildSkillModifiersForLevelUp({
      skills: content.skills,
      proficientSkills,
      abilityModifiers: characterSheet.abilities?.modifiers || {},
      pb: nextPb,
      expertiseSkills: nextExpertiseSkills,
      jackOfAllTrades: hasJackOfAllTrades,
    });
  }

  return applyFightingStyleToDerivedStats(nextDerived, characterSheet, fightingStyle);
}

function applyLevelThreeDerivedStats(derived = {}, classId = '', level = 1, characterSheet = {}, selectedSubclass = null) {
  if (Number(level) < 3) return derived;
  if (classId === 'fighter') {
    derived.weapon_critical_threshold = 19;
    derived.initiative_advantage_sources = [...new Set([...(derived.initiative_advantage_sources || []), 'Remarkable Athlete'])];
  }
  if (classId === 'rogue') {
    derived.sneak_attack_dice = '2d6';
    derived.climb_speed = Number(derived.speed || 30);
    derived.jump_ability = 'dex';
  }
  if (classId === 'monk') derived.martial_arts_die = '1d6';
  if (selectedSubclass?.id === 'draconic_sorcery') {
    derived.draconic_resilience_hp_bonus = 3;
    if (!hasArmorOrShieldEquipped(characterSheet)) {
      const dex = Number(characterSheet.abilities?.modifiers?.dex || 0);
      const cha = Number(characterSheet.abilities?.modifiers?.cha || 0);
      derived.armor_class = 10 + dex + cha;
      derived.armor_class_breakdown = [
        { label: 'Draconic Resilience', value: 10 },
        { label: 'DEX modifier', value: dex },
        { label: 'CHA modifier', value: cha },
      ];
    }
  }
  return derived;
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

function getSkillProficiencyChoiceIds(requiredChoices = [], selections = {}) {
  return requiredChoices
    .filter((choice) => ['skill_proficiency', 'skill_proficiency_any'].includes(choice.type) && isRequiredChoiceActive(choice, selections))
    .flatMap((choice) => selections[choice.id] || []);
}

function mergeSkillProficiencies(current = [], additions = []) {
  return [...new Set([...current, ...additions].map(normalizeId).filter(Boolean))];
}

function isExpertiseChoice(choice = {}) {
  const id = normalizeId(choice.id);
  return choice.type === 'skill' && (id.includes('expertise') || id === 'scholar_skill');
}

function mergeExpertiseSkills(current = [], additions = []) {
  return [...new Set([...current, ...additions].map(normalizeId).filter(Boolean))];
}

function getLanguageChoiceIds(requiredChoices = [], selections = {}) {
  return requiredChoices
    .filter((choice) => choice.type === 'language' && isRequiredChoiceActive(choice, selections))
    .flatMap((choice) => selections[choice.id] || []);
}

function getCantripChoiceIds(requiredChoices = [], selections = {}) {
  return requiredChoices
    .filter((choice) => choice.type === 'spell' && Number(choice.max_level) === 0)
    .filter((choice) => isRequiredChoiceActive(choice, selections))
    .flatMap((choice) => selections[choice.id] || []);
}

function mergeLanguages(current = [], additions = []) {
  return [...new Set([...current, ...additions].map(normalizeId).filter(Boolean))];
}

function isRequiredChoiceActive(choice = {}, selections = {}) {
  const condition = choice.required_if;
  if (!condition) return true;
  const selected = selections[condition.choice_id] || [];
  const required = normalizeId(condition.includes || condition.equals);
  return required ? selected.includes(required) : true;
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
  const storedPerLevelBonus = (characterSheet.active_effects || [])
    .filter((effect) => effect.target === 'max_hp_per_level_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  const draconicPerLevelBonus = normalizeId(characterSheet.identity?.subclass) === 'draconic_sorcery'
    && Number(characterSheet.identity?.level || 1) >= 3
    ? 1
    : 0;
  const perLevelBonus = Math.max(storedPerLevelBonus, draconicPerLevelBonus);
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

function getSelectedSubclass({ characterSheet = {}, content = {}, classId = '', nextLevel = 1, selections = {} } = {}) {
  const selectedId = selections.subclass?.[0]
    || normalizeId(characterSheet.identity?.subclass)
    || normalizeId(characterSheet.class_choices?.subclass);
  if (!selectedId) return null;
  const subclass = byId(content.subclasses || [], selectedId);
  if (!subclass) return null;
  if (normalizeId(subclass.class_id) !== normalizeId(classId)) return null;
  if (Number(subclass.unlock_level || 3) > Number(nextLevel)) return null;
  return subclass;
}

function getSubclassFeatures(subclass, level) {
  if (!subclass) return [];
  return Object.entries(subclass.level_features || {})
    .filter(([featureLevel]) => Number(featureLevel) === Number(level))
    .flatMap(([, features]) => features || []);
}

function summarizeSubclass(subclass) {
  return {
    id: subclass.id,
    classId: subclass.class_id,
    name: subclass.name,
    description: subclass.description || '',
    unlockLevel: Number(subclass.unlock_level || 3),
  };
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

function mergeSpellcasting(current, advancementSpellcasting, levelUpChoices = {}, cantripAdditions = []) {
  if (!current && !advancementSpellcasting) return null;
  if (!advancementSpellcasting) return current;
  const preparedAdditions = [
    ...(levelUpChoices.prepared_spells || []),
    ...(levelUpChoices.prepared_spell || []),
  ];
  const spellbookAdditions = [
    ...(levelUpChoices.spellbook_spells || []),
    ...(levelUpChoices.evocation_savant_spells || []),
  ];
  return {
    ...(current || {}),
    ...(advancementSpellcasting.cantrips !== undefined ? { cantrips_count: advancementSpellcasting.cantrips } : {}),
    ...(advancementSpellcasting.prepared_spells !== undefined ? { prepared_spells_count: advancementSpellcasting.prepared_spells } : {}),
    cantrips_known: [
      ...new Set([
        ...((current || {}).cantrips_known || []),
        ...cantripAdditions,
      ]),
    ],
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
    ...((current || {}).spellbook_spells || advancementSpellcasting.spellbook_spells_add ? {
      spellbook_spells: [
        ...new Set([
          ...((current || {}).spellbook_spells || []),
          ...spellbookAdditions,
        ]),
      ],
    } : {}),
    slots: {
      ...((current || {}).slots || {}),
      ...(advancementSpellcasting.slots || {}),
    },
    slots_max: {
      ...((current || {}).slots_max || (current || {}).slots || {}),
      ...(advancementSpellcasting.slots || {}),
    },
    ...(advancementSpellcasting.pact_slot_level ? { pact_slot_level: advancementSpellcasting.pact_slot_level } : {}),
  };
}

function applySubclassSpellcasting(spellcasting, selectedSubclass = null, choices = {}) {
  if (!spellcasting || selectedSubclass?.id !== 'circle_of_the_land') return spellcasting;
  const land = normalizeId(choices.land_type?.[0] || '');
  const circleSpells = {
    arid: ['blur', 'burning_hands', 'fire_bolt'],
    polar: ['fog_cloud', 'hold_person', 'ray_of_frost'],
    temperate: ['misty_step', 'shocking_grasp', 'sleep'],
    tropical: ['acid_splash', 'ray_of_sickness', 'web'],
  }[land] || [];
  return {
    ...spellcasting,
    always_prepared_spells: [...new Set([...(spellcasting.always_prepared_spells || []), ...circleSpells])],
  };
}

function inferSpellSchool(spell = {}) {
  if (spell.school) return normalizeId(spell.school);
  const evocation = new Set([
    'burning_hands', 'chromatic_orb', 'continual_flame', 'fire_bolt', 'flame_blade',
    'flaming_sphere', 'gust_of_wind', 'magic_missile', 'moonbeam', 'ray_of_frost',
    'scorching_ray', 'shatter', 'shocking_grasp', 'spiritual_weapon', 'thunderwave',
  ]);
  return evocation.has(normalizeId(spell.id)) ? 'evocation' : normalizeId(spell.school);
}

function buildInvocationLevelUpState({ characterSheet = {}, levelUpChoices = {}, content = {} } = {}) {
  const added = levelUpChoices.eldritch_invocations || [];
  const existingPactWeaponId = getExistingPactWeaponId(characterSheet);
  if (!added.length) return { invocations: [], details: {}, spells: [], pactWeaponId: existingPactWeaponId };
  const existing = [
    normalizeId(characterSheet.class_choices?.eldritch_invocation),
    ...((characterSheet.class_choices?.eldritch_invocations || []).map(normalizeId)),
  ].filter(Boolean);
  const invocations = [...new Set([...existing, ...added])];
  const details = {};
  const spells = [];

  if (added.includes('armor_of_shadows')) {
    spells.push({ id: 'mage_armor', source: 'Armor of Shadows', type: 'at_will' });
  }
  if (added.includes('pact_of_the_blade')) {
    details.pact_of_the_blade = { pact_weapon: levelUpChoices.pact_weapon?.[0] };
  }
  if (added.includes('pact_of_the_chain')) {
    details.pact_of_the_chain = { familiar_form: levelUpChoices.pact_chain_familiar?.[0] };
    spells.push({ id: 'find_familiar', source: 'Pact of the Chain', type: 'ritual' });
  }
  if (added.includes('pact_of_the_tome')) {
    details.pact_of_the_tome = {
      tome_cantrips: levelUpChoices.pact_tome_cantrips || [],
      tome_rituals: levelUpChoices.pact_tome_rituals || [],
    };
    spells.push(...(levelUpChoices.pact_tome_cantrips || []).map((id) => ({ id, source: 'Pact of the Tome', type: 'cantrip' })));
    spells.push(...(levelUpChoices.pact_tome_rituals || []).map((id) => ({ id, source: 'Pact of the Tome', type: 'ritual' })));
  }

  return { invocations, details, spells, pactWeaponId: details.pact_of_the_blade?.pact_weapon || existingPactWeaponId };
}

function getExistingPactWeaponId(characterSheet = {}) {
  return normalizeId(
    characterSheet.class_choice_details?.pact_of_the_blade?.pact_weapon
      || characterSheet.class_choice_details?.eldritch_invocations?.pact_weapon
      || characterSheet.class_choice_details?.eldritch_invocation?.pact_weapon
  );
}

function buildPactWeaponAttack({ weaponId = '', characterSheet = {}, content = {}, proficiencyBonus = 2 } = {}) {
  if (!weaponId) return null;
  const weapon = byId(content.equipment || [], weaponId);
  if (!weapon || weapon.type !== 'weapon') return null;
  const charisma = Number(characterSheet.abilities?.modifiers?.cha || 0);
  const damageModifier = charisma;
  return {
    weapon_id: weapon.id,
    name: `${weapon.name} (Pact Weapon)`,
    ability: 'cha',
    properties: weapon.properties || [],
    weapon_category: weapon.weapon_category || null,
    attack_kind: weapon.attack_kind || 'melee',
    damage_type: weapon.damage_type || null,
    mastery: null,
    versatile_damage: weapon.versatile_damage || null,
    ammunition_type: weapon.ammunition_type || null,
    attack_total: charisma + Number(proficiencyBonus || 0),
    attack_parts: [
      { label: 'CHA (Pact of the Blade)', value: charisma },
      { label: 'Proficiency', value: Number(proficiencyBonus || 0) },
    ],
    damage_formula: formatDamageFormula(weapon.damage, damageModifier),
    damage_parts: [
      { label: weapon.damage, value: null },
      { label: 'CHA (Pact of the Blade)', value: damageModifier },
    ],
    pact_weapon: true,
  };
}

function repairPactWeaponAttack(characterSheet = {}, content = getContentBundle()) {
  const invocations = [
    characterSheet.class_choices?.eldritch_invocation,
    ...(characterSheet.class_choices?.eldritch_invocations || []),
  ].map(normalizeId).filter(Boolean);
  if (!invocations.includes('pact_of_the_blade')) return characterSheet;

  const weaponId = getExistingPactWeaponId(characterSheet);
  const attack = buildPactWeaponAttack({
    weaponId,
    characterSheet,
    content,
    proficiencyBonus: Number(characterSheet.derived_stats?.proficiency_bonus || proficiencyBonus(getCharacterLevel(characterSheet))),
  });
  if (!attack) return characterSheet;

  const currentAttacks = characterSheet.derived_stats?.attack_breakdowns || [];
  const nextAttacks = [
    ...currentAttacks.filter((entry) => !(entry.pact_weapon || entry.weapon_id === weaponId)),
    attack,
  ];
  if (JSON.stringify(currentAttacks) === JSON.stringify(nextAttacks)) return characterSheet;
  return {
    ...characterSheet,
    derived_stats: {
      ...(characterSheet.derived_stats || {}),
      attack_breakdowns: nextAttacks,
    },
  };
}

function repairRogueSneakAttack(characterSheet = {}) {
  const classId = normalizeId(characterSheet.identity?.class || characterSheet.identity?.class_name);
  const level = Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  if (classId !== 'rogue' || level < 3) return characterSheet;

  const diceCount = Math.ceil(level / 2);
  const dice = `${diceCount}d6`;
  const features = (characterSheet.features || [])
    .filter((feature) => !normalizeId(feature.name).startsWith('sneak_attack'));

  return {
    ...characterSheet,
    features: [
      ...features,
      {
        source: 'class',
        level: Math.max(1, level),
        name: `Sneak Attack (${dice})`,
        description: `Once per turn, deal an extra ${dice} damage when Sneak Attack's requirements are met.`,
      },
    ],
    derived_stats: {
      ...(characterSheet.derived_stats || {}),
      sneak_attack_dice: dice,
    },
  };
}

function formatDamageFormula(dice = '1d4', modifier = 0) {
  const value = Number(modifier || 0);
  if (value < 0) return `${dice} - ${Math.abs(value)}`;
  return `${dice} + ${value}`;
}

function mergeClassChoiceSpells(current = [], additions = []) {
  const entries = [...(current || []), ...(additions || [])];
  const byKey = new Map();
  for (const entry of entries) {
    const normalized = typeof entry === 'string' ? { id: entry } : entry;
    if (!normalized?.id) continue;
    byKey.set(`${normalizeId(normalized.id)}:${normalizeId(normalized.type || '')}`, normalized);
  }
  return [...byKey.values()];
}

function applyFightingStyleToDerivedStats(derivedStats = {}, characterSheet = {}, styleId = '') {
  const style = normalizeId(styleId);
  if (!style) return derivedStats;

  const next = clone(derivedStats);
  const armorBreakdown = next.armor_class_breakdown || [];
  const wearingArmor = Boolean(characterSheet.equipped?.armor);
  const hasDefense = armorBreakdown.some((entry) => entry.label === 'Defense Fighting Style');
  const armorBonus = getFightingStyleArmorBonus({ styleId: style, wearingArmor });
  if (armorBonus && !hasDefense) {
    next.armor_class = Number(next.armor_class || 10) + armorBonus;
    next.armor_class_breakdown = [...armorBreakdown, { label: 'Defense Fighting Style', value: armorBonus }];
    next.defense_fighting_style_applied = true;
  }

  next.attack_breakdowns = (next.attack_breakdowns || []).map((attack) => {
    const expected = getFightingStyleAttackBonus({
      styleId: style,
      attack: { attackKind: attack.attack_kind || attack.attackKind },
    });
    const included = Number(attack.fighting_style_attack_bonus || 0);
    const added = Math.max(0, expected - included);
    if (!added) return attack;
    return {
      ...attack,
      attack_total: Number(attack.attack_total || 0) + added,
      fighting_style_attack_bonus: included + added,
      attack_parts: [
        ...(attack.attack_parts || []),
        { label: 'Archery Fighting Style', value: added },
      ],
    };
  });

  const senses = getFightingStyleSenses({ class_choices: { fighting_style: style } });
  if (senses.length) {
    next.senses = {
      ...(next.senses || {}),
      ...Object.fromEntries(senses.map((sense) => [sense.type, sense.range_feet])),
      special: [
        ...((next.senses || {}).special || []).filter((sense) => sense.source !== 'Blind Fighting'),
        ...senses,
      ],
    };
  }
  return next;
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
  repairPactWeaponAttack,
  repairRogueSneakAttack,
};
