const { getContentBundle, byId } = require('./contentData');
const {
  ABILITIES,
  abilityMod,
  buildActiveEffects,
  buildAttackBreakdowns,
  buildSaveModifiers,
  calculateArmorClass,
  calculateInitiative,
} = require('./characterValidator');
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
  'level_4_feat',
  'slow_fall',
  'extra_attack',
  'fast_movement',
  'font_of_inspiration',
  'sear_undead',
  'wild_resurgence',
  'tactical_shift',
  'stunning_strike',
  'faithful_steed',
  'cunning_strike',
  'uncanny_dodge',
  'sorcerous_restoration',
  'eldritch_invocations_level_5',
  'memorize_spell',
  'mindless_rage',
  'magical_discoveries',
  'blessed_healer',
  'natural_recovery',
  'additional_fighting_style',
  'empowered_strikes',
  'wholeness_of_body',
  'aura_of_protection',
  'roving',
  'expertise_level_6',
  'elemental_affinity',
  'dark_ones_own_luck',
  'sculpt_spells',
  'feral_instinct',
  'instinctive_pounce',
  'countercharm',
  'blessed_strikes',
  'elemental_fury',
  'evasion',
  'aura_of_devotion',
  'defensive_tactics',
  'reliable_talent',
  'sorcery_incarnate',
  'eldritch_invocations_level_7',
  'brutal_strike',
  'expertise_level_9',
  'indomitable',
  'tactical_master',
  'acrobatic_movement',
  'abjure_foes',
  'supreme_sneak',
  'contact_patron',
  'eldritch_invocations_level_9',
  'berserker_retaliation',
  'magical_secrets',
  'divine_intervention',
  'natures_ward',
  'heroic_warrior',
  'heightened_focus',
  'self_restoration',
  'aura_of_courage',
  'tireless',
  'metamagic_level_10',
  'fiendish_resilience',
  'empowered_evocation',
  'relentless_rage',
  'brutal_strike_2',
  'berserker_presence',
  'persistent_rage',
  'brutal_strike_3',
  'indomitable_might',
  'primal_champion',
  'peerless_skill',
  'superior_inspiration',
  'words_of_creation',
  'improved_blessed_strikes',
  'supreme_healing',
  'greater_divine_intervention',
  'natures_sanctuary',
  'beast_spells',
  'archdruid',
  'extra_attack_2',
  'indomitable_uses_2',
  'superior_critical',
  'action_surge_uses_2',
  'indomitable_uses_3',
  'survivor',
  'extra_attack_3',
  'fleet_step',
  'deflect_energy',
  'diamond_soul',
  'perfect_self',
  'quivering_palm',
  'body_and_mind',
  'radiant_smite',
  'cleansing_touch',
  'purity_of_spirit',
  'holy_nimbus',
  'hunter_multiattack',
  'feral_senses',
  'superior_hunters_defense',
  'foe_slayer',
  'use_magic_device',
  'slippery_mind',
  'thiefs_reflexes',
  'elusive',
  'stroke_of_luck',
  'dragon_wings',
  'draconic_presence',
  'arcane_apotheosis',
  'mystic_arcanum_level_11',
  'eldritch_invocations_level_13',
  'hurl_through_hell',
  'eldritch_invocations_level_15',
  'eldritch_invocations_level_17',
  'eldritch_master',
  'overchannel',
  'spell_mastery',
  'signature_spells',
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
  const choiceSelections = normalizeChoiceSelections(options.payload?.choices || options.choices || {});
  const abilityIncreasePlan = getLevelUpAbilityIncreases(choiceSelections);
  const previewAbilities = applyAbilityIncreases(characterSheet.abilities, abilityIncreasePlan);
  const baseHp = getFixedHpIncrease({ ...characterSheet, abilities: previewAbilities }, classData);
  const oldConModifier = Number(characterSheet.abilities?.modifiers?.con || 0);
  const newConModifier = Number(previewAbilities.modifiers?.con || oldConModifier);
  const retroactiveConstitutionBonus = Math.max(0, newConModifier - oldConModifier) * currentLevel;
  const hp = {
    ...baseHp,
    retroactiveConstitutionBonus,
    increase: baseHp.increase + retroactiveConstitutionBonus,
  };
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

  const requiredChoices = buildRequiredChoicePreviews({
    choices: advancement?.required_choices || [],
    characterSheet,
    content,
    classId,
    selections: choiceSelections,
  });
  blockers.push(...validateRequiredChoices(requiredChoices, choiceSelections));
  for (const invocationId of choiceSelections.eldritch_invocations || []) {
    const invocation = byId(content.eldritchInvocations || [], invocationId);
    if (invocation?.implemented === false) {
      blockers.push(blocker('unsupported_mechanic', `${invocation.name} needs rules support before it can be selected.`, { mechanic: invocation.runtime_mechanic }));
    }
  }

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
    ...getSubclassRuntimeMechanics(selectedSubclass, nextLevel),
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
  const abilityIncreases = getLevelUpAbilityIncreases(levelUpChoices);
  const nextAbilities = applyAbilityIncreases(characterSheet.abilities, abilityIncreases, nextLevel);
  const nextSavingThrows = [...new Set([
    ...(characterSheet.proficiencies?.saving_throws || classData?.saving_throws || []),
    ...(preview.classId === 'monk' && nextLevel >= 14 ? ['str', 'dex', 'con', 'int', 'wis', 'cha'] : []),
    ...(preview.classId === 'rogue' && nextLevel >= 14 ? ['wis', 'cha'] : []),
  ])];
  const selectedGeneralFeatId = levelUpChoices.level_4_feat?.[0] || '';
  const selectedGeneralFeat = byId(content.feats || [], selectedGeneralFeatId);
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
  const nextResources = finalizeClassResources(mergeResources(currentResources, advancement.resources, {
    hit_dice: {
      die: Number(classData?.hit_die || preview.hp.hitDie || 8),
      remaining: Number(currentResources.hit_dice?.remaining ?? preview.currentLevel) + 1,
      max: nextLevel,
    },
  }), preview.classId, nextLevel, characterSheet);
  const nextCantrips = getCantripChoiceIds(advancement.required_choices || [], levelUpChoices);
  const nextSpellcasting = applySubclassSpellcasting(
    mergeSpellcasting(currentSpellcasting, advancement.spellcasting, levelUpChoices, nextCantrips),
    selectedSubclass,
    levelUpChoices,
    characterSheet,
    nextLevel,
  );
  const invocationState = buildInvocationLevelUpState({ characterSheet, levelUpChoices, content });
  const persistedClassChoices = getPersistedClassChoices(advancement.required_choices || [], levelUpChoices);
  const nextLanguages = mergeLanguages(
    characterSheet.languages || characterSheet.proficiencies?.languages || [],
    getLanguageChoiceIds(advancement.required_choices || [], levelUpChoices),
  );
  const currentFeatures = (characterSheet.features || []).filter((feature) => {
    const name = normalizeId(feature.name);
    if (preview.classId === 'rogue' && (advancement.derived?.sneak_attack_dice || [3, 5].includes(nextLevel)) && name.startsWith('sneak_attack')) return false;
    if (preview.classId === 'monk' && nextLevel === 5 && name.startsWith('martial_arts')) return false;
    return true;
  });
  const nextFeatures = [
    ...currentFeatures,
    ...preview.features.map((feature) => ({
      id: feature.id,
      source: getSubclassFeatures(selectedSubclass, nextLevel).some((entry) => entry.id === feature.id) ? 'subclass' : 'class',
      level: nextLevel,
      name: feature.name,
      description: feature.description || '',
    })),
    ...(selectedGeneralFeat && selectedGeneralFeat.id !== 'ability_score_improvement' ? [{
      id: selectedGeneralFeat.id,
      source: 'feat',
      level: nextLevel,
      name: selectedGeneralFeat.name,
      description: selectedGeneralFeat.description || '',
    }] : []),
    ...(levelUpChoices.eldritch_invocations || []).map((invocationId) => {
      const invocation = byId(content.eldritchInvocations || [], invocationId);
      return invocation ? {
        id: invocation.id,
        source: 'class_choice',
        level: nextLevel,
        name: invocation.name,
        description: invocation.description || '',
      } : null;
    }).filter(Boolean),
  ];
  let nextDerivedStats = buildLeveledDerivedStats({
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
    abilityModifiers: nextAbilities.modifiers,
    classData,
    recalculateCore: Object.keys(abilityIncreases).length > 0
      || Number(currentDerived.proficiency_bonus || nextPb) !== nextPb,
  });
  for (const additionalStyle of [
    ...((characterSheet.class_choices?.additional_fighting_styles || [])),
    ...(levelUpChoices.additional_fighting_style || []),
  ]) {
    nextDerivedStats = applyFightingStyleToDerivedStats(nextDerivedStats, characterSheet, additionalStyle);
  }
  applyLevelThreeDerivedStats(nextDerivedStats, preview.classId, nextLevel, characterSheet, selectedSubclass);
  applyAdvancementDerivedStats(nextDerivedStats, advancement, characterSheet);
  applyInvocationDerivedStats(nextDerivedStats, invocationState.invocations);
  const pactWeaponAttack = buildPactWeaponAttack({
    weaponId: invocationState.pactWeaponId,
    characterSheet: { ...characterSheet, abilities: nextAbilities, derived_stats: nextDerivedStats },
    content,
    proficiencyBonus: nextPb,
  });
  if (pactWeaponAttack) {
    nextDerivedStats.attack_breakdowns = [
      ...(nextDerivedStats.attack_breakdowns || []).filter((attack) => attack.weapon_id !== pactWeaponAttack.weapon_id),
      pactWeaponAttack,
    ];
  }
  const selectedAffinity = levelUpChoices.draconic_affinity?.[0];
  const selectedFiendishResilience = levelUpChoices.fiendish_resilience?.[0];
  const landType = levelUpChoices.land_type?.[0] || characterSheet.class_choices?.land_type;
  const subclassId = normalizeId(selectedSubclass?.id || characterSheet.identity?.subclass || characterSheet.class_choices?.subclass);
  const landResistance = preview.classId === 'druid' && subclassId === 'circle_of_the_land' && nextLevel >= 10
    ? { arid: 'fire', polar: 'cold', temperate: 'lightning', tropical: 'poison' }[normalizeId(landType)]
    : null;
  const nextResistances = [...new Set([
    ...(characterSheet.resistances || []),
    ...(selectedAffinity ? [selectedAffinity] : []),
    ...(selectedFiendishResilience ? [selectedFiendishResilience] : []),
    ...(landResistance ? [landResistance] : []),
  ])];
  const nextConditionImmunities = [...new Set([
    ...(characterSheet.condition_immunities || []),
    ...(preview.classId === 'druid' && subclassId === 'circle_of_the_land' && nextLevel >= 10 ? ['poisoned'] : []),
    ...(preview.classId === 'paladin' && subclassId === 'oath_of_devotion' && nextLevel >= 7 ? ['charmed'] : []),
    ...(preview.classId === 'paladin' && nextLevel >= 10 ? ['frightened'] : []),
  ])];

  return {
    ...characterSheet,
    abilities: nextAbilities,
    identity: {
      ...(characterSheet.identity || {}),
      level: nextLevel,
      ...(selectedSubclass ? { subclass: selectedSubclass.id, subclass_name: selectedSubclass.name } : {}),
      next_level_xp: nextThreshold,
      level_up_available: false,
    },
    derived_stats: nextDerivedStats,
    resistances: nextResistances,
    condition_immunities: nextConditionImmunities,
    features: dedupeFeatures(nextFeatures),
    resources: nextResources,
    general_feats: mergeGeneralFeats(characterSheet.general_feats, selectedGeneralFeat, nextLevel, abilityIncreases),
    expertise_skills: nextExpertiseSkills,
    class_choices: {
      ...(characterSheet.class_choices || {}),
      ...persistedClassChoices,
      ...(selectedFightingStyle ? { fighting_style: selectedFightingStyle } : {}),
      ...(levelUpChoices.metamagic?.length ? {
        metamagic: [...new Set([...(characterSheet.class_choices?.metamagic || []), ...levelUpChoices.metamagic])],
      } : {}),
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
      saving_throws: nextSavingThrows,
    },
    weapon_masteries: mergeWeaponMasteries(characterSheet.weapon_masteries, levelUpChoices.weapon_mastery, content),
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

function getLevelUpAbilityIncreases(selections = {}) {
  const feat = selections.level_4_feat?.[0];
  if (feat === 'grappler') {
    const ability = selections.grappler_ability?.[0];
    return ability ? { [ability]: 1 } : {};
  }
  if (feat !== 'ability_score_improvement') return {};
  const primary = selections.asi_primary?.[0];
  if (!primary) return {};
  if (selections.asi_pattern?.[0] === 'split') {
    const secondary = selections.asi_secondary?.[0];
    return secondary && secondary !== primary ? { [primary]: 1, [secondary]: 1 } : { [primary]: 1 };
  }
  return { [primary]: 2 };
}

function getAbilityChoiceAmount(choiceId = '', selections = {}) {
  if (normalizeId(choiceId) === 'asi_primary' && selections.asi_pattern?.[0] === 'plus_two') return 2;
  return 1;
}

function applyAbilityIncreases(abilities = {}, increases = {}, level = null) {
  if (Object.keys(increases || {}).length === 0) return abilities;
  const currentScores = abilities.final_scores || {};
  const finalScores = Object.fromEntries(ABILITIES.map((ability) => [
    ability,
    Math.min(20, Number(currentScores[ability] || 10) + Number(increases[ability] || 0)),
  ]));
  const modifiers = Object.fromEntries(ABILITIES.map((ability) => [ability, abilityMod(finalScores[ability])]));
  const history = level && Object.keys(increases).length
    ? [...(abilities.level_up_increases || []), { level, increases: { ...increases } }]
    : (abilities.level_up_increases || []);
  return { ...abilities, final_scores: finalScores, modifiers, level_up_increases: history };
}

function meetsFeatPrerequisite(feat = {}, characterSheet = {}, targetLevel = 1) {
  const prerequisite = feat.prerequisite || {};
  if (Number(prerequisite.level || 0) > Number(targetLevel || 0)) return false;
  if (prerequisite.any_ability) {
    const minimum = Number(prerequisite.any_ability.minimum || 0);
    const scores = characterSheet.abilities?.final_scores || {};
    if (!(prerequisite.any_ability.abilities || []).some((ability) => Number(scores[ability] || 0) >= minimum)) return false;
  }
  return true;
}

function mergeGeneralFeats(current = [], feat = null, level = 1, increases = {}) {
  if (!feat) return current || [];
  return [
    ...(current || []),
    { id: feat.id, name: feat.name, level, ability_increases: { ...increases } },
  ];
}

function mergeWeaponMasteries(current = [], selected = [], content = {}) {
  const merged = [...(current || [])];
  const known = new Set(merged.map((entry) => normalizeId(entry.weapon_id || entry.id || entry)));
  for (const weaponId of selected || []) {
    if (known.has(normalizeId(weaponId))) continue;
    const weapon = byId(content.equipment || [], weaponId);
    if (!weapon?.mastery) continue;
    merged.push({
      weapon_id: weapon.id,
      name: weapon.name,
      mastery: weapon.mastery,
      mastery_name: titleCase(weapon.mastery),
      description: weapon.description || '',
    });
    known.add(normalizeId(weaponId));
  }
  return merged;
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

  if (choice.type === 'general_feat') {
    const currentLevel = getCharacterLevel(characterSheet);
    const known = new Set((characterSheet.general_feats || []).map((entry) => normalizeId(entry.id || entry)));
    return (content.feats || [])
      .filter((feat) => normalizeId(feat.category) === 'general')
      .filter((feat) => feat.repeatable || !known.has(normalizeId(feat.id)))
      .filter((feat) => meetsFeatPrerequisite(feat, characterSheet, currentLevel + 1))
      .map((feat) => ({
        id: feat.id,
        name: feat.name,
        description: feat.description || '',
        meta: feat.repeatable ? 'General Feat - Repeatable' : 'General Feat',
      }));
  }

  if (choice.type === 'ability_increase') {
    const scores = characterSheet.abilities?.final_scores || {};
    const allowed = new Set((choice.allowed || ABILITIES).map(normalizeId));
    const amount = getAbilityChoiceAmount(choice.id, selections);
    const excluded = normalizeId(choice.id) === 'asi_secondary'
      ? new Set(selections.asi_primary || [])
      : new Set();
    return ABILITIES
      .filter((ability) => allowed.has(ability))
      .filter((ability) => !excluded.has(ability))
      .filter((ability) => Number(scores[ability] || 0) + amount <= 20)
      .map((ability) => ({
        id: ability,
        name: ability.toUpperCase(),
        description: `Increase ${ability.toUpperCase()} from ${Number(scores[ability] || 0)} to ${Number(scores[ability] || 0) + amount}.`,
        meta: `+${amount}, maximum 20`,
      }));
  }

  if (choice.type === 'weapon_mastery') {
    const known = new Set((characterSheet.weapon_masteries || []).map((entry) => normalizeId(entry.weapon_id || entry.id || entry)));
    const classData = byId(content.classes || [], classId);
    const proficiencies = new Set([...(classData?.weapons || []), ...(characterSheet.proficiencies?.weapons || [])].map(normalizeId));
    return (content.equipment || [])
      .filter((item) => item.type === 'weapon' && item.mastery)
      .filter((item) => !known.has(normalizeId(item.id)))
      .filter((item) => isWeaponProficientForLevelUp(item, proficiencies))
      .map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description || '',
        meta: `${titleCase(item.mastery)} mastery`,
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
    const spellClasses = new Set((choice.class_ids || [spellClass]).map(normalizeId));
    const minLevel = Number(choice.min_level ?? 0);
    const maxLevel = Number(choice.max_level ?? 1);
    const excluded = new Set((choice.exclude_ids || []).map(normalizeId));
    return (content.spells || [])
      .filter((spell) => Number(spell.level || 0) >= minLevel && Number(spell.level || 0) <= maxLevel)
      .filter((spell) => spellClasses.has('any') || (spell.classes || []).map(normalizeId).some((entry) => spellClasses.has(entry)))
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

  if (['known_damaging_warlock_cantrip', 'known_attack_warlock_cantrip'].includes(choice.type)) {
    const known = new Set((characterSheet.spellcasting?.cantrips_known || []).map(normalizeId));
    return (content.spells || [])
      .filter((spell) => known.has(normalizeId(spell.id)))
      .filter((spell) => Number(spell.level || 0) === 0 && (spell.classes || []).map(normalizeId).includes('warlock'))
      .filter((spell) => choice.type !== 'known_attack_warlock_cantrip' || spell.attack_type === 'spell_attack')
      .filter((spell) => choice.type !== 'known_damaging_warlock_cantrip' || ['spell_attack', 'save', 'damage'].includes(spell.attack_type))
      .map((spell) => ({ id: spell.id, name: spell.name, description: spell.description || '', meta: 'Known Warlock cantrip' }));
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
    const known = new Set([
      normalizeId(characterSheet.class_choices?.fighting_style),
      ...((characterSheet.class_choices?.additional_fighting_styles || []).map(normalizeId)),
    ].filter(Boolean));
    return [...fighterStyles, ...extraStyles].filter((style) => !known.has(normalizeId(style.id))).map((style) => ({
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
    const known = new Set([
      normalizeId(characterSheet.class_choices?.eldritch_invocation),
      ...((characterSheet.class_choices?.eldritch_invocations || []).map(normalizeId)),
    ].filter(Boolean));
    const selected = new Set(selections[choice.id] || []);
    const availableInvocations = new Set([...known, ...selected]);
    const levelTwoOptionIds = new Set((((byId(content.classes || [], 'warlock')?.class_choices || [])
      .find((entry) => entry.id === 'eldritch_invocation')?.options || []).map((option) => normalizeId(option.id))));
    return (content.eldritchInvocations || [])
      .filter((option) => Number(option.minimum_level || 2) <= getCharacterLevel(characterSheet) + 1)
      .filter((option) => getCharacterLevel(characterSheet) + 1 !== 2 || levelTwoOptionIds.has(normalizeId(option.id)))
      .filter((option) => option.repeatable || !known.has(normalizeId(option.id)))
      .filter((option) => !option.requires_invocation || availableInvocations.has(normalizeId(option.requires_invocation)))
      .map((option) => ({
        id: option.id,
        name: option.name,
        description: option.description,
        meta: `Eldritch Invocation${option.minimum_level > 2 ? ` - Level ${option.minimum_level}+` : ''}`,
      }));
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
      description: option.description || getLevelUpOptionDescription(choice.id, option.id),
      meta: option.meta || '',
    }));
  }

  if (choice.type === 'damage_type') {
    return ['acid', 'bludgeoning', 'cold', 'fire', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder']
      .map((id) => ({ id, name: titleCase(id), description: `Gain resistance to ${titleCase(id)} damage.`, meta: 'Damage resistance' }));
  }

  return [];
}

function getLevelUpOptionDescription(choiceId = '', optionId = '') {
  if (normalizeId(choiceId) !== 'asi_pattern') return '';
  return normalizeId(optionId) === 'plus_two'
    ? 'Increase one ability score by 2, to a maximum of 20.'
    : 'Increase two different ability scores by 1 each, to a maximum of 20.';
}

function isWeaponProficientForLevelUp(weapon = {}, proficiencies = new Set()) {
  if (proficiencies.has(normalizeId(weapon.id))) return true;
  if (weapon.weapon_category && proficiencies.has(normalizeId(weapon.weapon_category))) return true;
  if (proficiencies.has('finesse') && (weapon.properties || []).includes('finesse')) return true;
  return proficiencies.has('light_martial')
    && normalizeId(weapon.weapon_category) === 'martial'
    && (weapon.properties || []).includes('light');
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
  abilityModifiers = characterSheet.abilities?.modifiers || {},
  classData = {},
  recalculateCore = false,
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
      abilityModifiers,
      pb: nextPb,
      expertiseSkills: nextExpertiseSkills,
      jackOfAllTrades: hasJackOfAllTrades,
    });
  }

  if (recalculateCore) {
    const activeEffects = [
      ...(characterSheet.active_effects || []),
      ...buildActiveEffects(characterSheet.equipped || {}, content),
    ];
    const armor = calculateArmorClass(
      characterSheet.equipped || {},
      content,
      abilityModifiers,
      activeEffects,
      classData,
      { choices: { ...(characterSheet.class_choices || {}), ...(fightingStyle ? { fighting_style: fightingStyle } : {}) } },
    );
    const initiative = calculateInitiative(abilityModifiers, nextPb, activeEffects);
    nextDerived.armor_class = armor.total;
    nextDerived.armor_class_breakdown = armor.parts;
    nextDerived.initiative = initiative.total;
    nextDerived.initiative_breakdown = initiative.parts;
    const baseSaves = characterSheet.proficiencies?.saving_throws || classData.saving_throws || [];
    const actualSaves = [...new Set([
      ...baseSaves,
      ...(normalizeId(classData.id) === 'monk' && nextLevel >= 14 ? ['str', 'dex', 'con', 'int', 'wis', 'cha'] : []),
      ...(normalizeId(classData.id) === 'rogue' && nextLevel >= 14 ? ['wis', 'cha'] : []),
    ])];
    nextDerived.saving_throw_modifiers = buildSaveModifiers(
      actualSaves,
      abilityModifiers,
      nextPb,
    );
    nextDerived.attack_breakdowns = buildAttackBreakdowns(
      characterSheet.equipped || {},
      content,
      abilityModifiers,
      nextPb,
      activeEffects,
      { choices: { ...(characterSheet.class_choices || {}), ...(fightingStyle ? { fighting_style: fightingStyle } : {}) } },
    );
    if (characterSheet.spellcasting?.ability) {
      const castingModifier = Number(abilityModifiers[characterSheet.spellcasting.ability] || 0);
      nextDerived.spell_attack_bonus = castingModifier + nextPb;
      nextDerived.spell_save_dc = 8 + castingModifier + nextPb;
    }
  }

  return applyFightingStyleToDerivedStats(nextDerived, characterSheet, fightingStyle);
}

function applyLevelThreeDerivedStats(derived = {}, classId = '', level = 1, characterSheet = {}, selectedSubclass = null) {
  if (Number(level) < 3) return derived;
  if (classId === 'fighter') {
    derived.weapon_critical_threshold = Number(level) >= 15 ? 18 : 19;
    derived.initiative_advantage_sources = [...new Set([...(derived.initiative_advantage_sources || []), 'Remarkable Athlete'])];
  }
  if (classId === 'rogue') {
    derived.sneak_attack_dice = `${Math.max(1, Math.ceil(Number(level) / 2))}d6`;
    derived.climb_speed = Number(derived.speed || 30);
    derived.jump_ability = 'dex';
  }
  if (classId === 'monk') derived.martial_arts_die = Number(level) >= 5 ? '1d8' : '1d6';
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

function getPersistedClassChoices(requiredChoices = [], selections = {}) {
  const persisted = {};
  for (const choice of requiredChoices) {
    if (!choice.persist_as || !isRequiredChoiceActive(choice, selections)) continue;
    const selected = selections[choice.id] || [];
    persisted[choice.persist_as] = choice.persist_as.endsWith('s') ? selected : selected[0];
  }
  return persisted;
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
  const conditionalBonus = Number(advancement.derived?.speed_bonus_unless_heavy_armor || 0);
  if (conditionalBonus && !hasHeavyArmorEquipped(characterSheet)) return conditionalBonus;
  if (!bonus) return 0;
  if (!(advancement.runtime_mechanics || []).includes('unarmored_movement')) return bonus;
  return hasArmorOrShieldEquipped(characterSheet) ? 0 : bonus;
}

function hasHeavyArmorEquipped(characterSheet = {}) {
  return ['chain_mail', 'splint_armor', 'plate_armor', 'ring_mail']
    .includes(normalizeId(characterSheet.equipped?.armor));
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
  const classLevels = content.classAdvancement?.levels?.[normalizeId(classId)] || {};
  const advancement = classLevels[String(level)] || null;
  if (!advancement?.inherit_choice_ids?.length) return advancement;
  const inheritedIds = new Set(advancement.inherit_choice_ids.map(normalizeId));
  const inherited = Object.values(classLevels)
    .flatMap((entry) => entry.required_choices || [])
    .filter((choice) => inheritedIds.has(normalizeId(choice.id)));
  return {
    ...advancement,
    required_choices: [...(advancement.required_choices || []), ...inherited],
  };
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
    if (key === 'spell_uses') {
      merged.spell_uses = mergeResources(merged.spell_uses || {}, value || {});
      continue;
    }
    const existing = merged[key];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const max = value.max ?? existing.max;
      const oldMax = Number(existing.max ?? existing.remaining ?? max ?? 0);
      const oldRemaining = Number(existing.remaining ?? oldMax);
      const spentUses = Math.max(0, oldMax - oldRemaining);
      merged[key] = {
        ...existing,
        ...value,
        remaining: Math.max(0, Number(max ?? oldRemaining) - spentUses),
        max,
      };
    } else {
      merged[key] = clone(value);
    }
  }
  return merged;
}

function finalizeClassResources(resources = {}, classId = '', level = 1, characterSheet = {}) {
  if (classId === 'bard' && Number(level) >= 5) {
    const max = Math.max(1, Number(characterSheet.abilities?.modifiers?.cha || 0));
    const current = resources.bardic_inspiration || {};
    const oldMax = Number(current.max ?? max);
    const spent = Math.max(0, oldMax - Number(current.remaining ?? oldMax));
    resources.bardic_inspiration = {
      name: 'Bardic Inspiration',
      ...current,
      die: Number(level) >= 15 ? '1d12' : (Number(level) >= 10 ? '1d10' : '1d8'),
      reset: 'short_rest',
      max,
      remaining: Math.max(0, max - spent),
    };
  }
  const abilityResources = {
    tireless: 'wis',
    dark_ones_own_luck: 'cha',
    wholeness_of_body: 'wis',
  };
  for (const [resourceId, ability] of Object.entries(abilityResources)) {
    const resource = resources[resourceId];
    if (!resource || resource.max !== `${ability === 'wis' ? 'wisdom' : 'charisma'}_modifier`) continue;
    const max = Math.max(1, Number(characterSheet.abilities?.modifiers?.[ability] || 0));
    resources[resourceId] = { ...resource, max, remaining: max };
  }
  return resources;
}

function mergeSpellcasting(current, advancementSpellcasting, levelUpChoices = {}, cantripAdditions = []) {
  if (!current && !advancementSpellcasting) return null;
  if (!advancementSpellcasting) return current;
  const preparedAdditions = [
    ...(levelUpChoices.prepared_spells || []),
    ...(levelUpChoices.prepared_spell || []),
  ];
  const alwaysPreparedAdditions = [
    ...(levelUpChoices.magical_discoveries || []),
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
        ...(advancementSpellcasting.always_prepared_spells || advancementSpellcasting.always_prepared || []),
        ...alwaysPreparedAdditions,
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
    slots: mergeSpellSlots(current || {}, advancementSpellcasting),
    slots_max: {
      ...((current || {}).slots_max || (current || {}).slots || {}),
      ...(advancementSpellcasting.slots || {}),
    },
    ...(advancementSpellcasting.pact_slot_level ? { pact_slot_level: advancementSpellcasting.pact_slot_level } : {}),
  };
}

function mergeSpellSlots(current = {}, advancement = {}) {
  const currentSlots = current.slots || {};
  const currentMax = current.slots_max || currentSlots;
  const nextMax = advancement.slots || {};
  const merged = { ...currentSlots };
  const oldPactLevel = Number(current.pact_slot_level || 0);
  const nextPactLevel = Number(advancement.pact_slot_level || oldPactLevel || 0);

  if (oldPactLevel && nextPactLevel && oldPactLevel !== nextPactLevel) {
    const oldRemaining = Number(currentSlots[oldPactLevel] || 0);
    const oldCapacity = Number(currentMax[oldPactLevel] ?? oldRemaining);
    const spent = Math.max(0, oldCapacity - oldRemaining);
    merged[oldPactLevel] = Number(nextMax[oldPactLevel] || 0);
    merged[nextPactLevel] = Math.max(0, Number(nextMax[nextPactLevel] || 0) - spent);
  }

  for (const [level, capacityValue] of Object.entries(nextMax)) {
    if (oldPactLevel && nextPactLevel && oldPactLevel !== nextPactLevel && Number(level) === nextPactLevel) continue;
    const capacity = Number(capacityValue || 0);
    const oldCapacity = Number(currentMax[level] ?? currentSlots[level] ?? 0);
    const oldRemaining = Number(currentSlots[level] ?? oldCapacity);
    const spent = Math.max(0, oldCapacity - oldRemaining);
    merged[level] = Math.max(0, capacity - spent);
  }
  return merged;
}

function applySubclassSpellcasting(spellcasting, selectedSubclass = null, choices = {}, characterSheet = {}, level = 1) {
  if (!spellcasting || !selectedSubclass) return spellcasting;
  const land = normalizeId(choices.land_type?.[0] || characterSheet.class_choices?.land_type || '');
  const subclassSpells = {
    circle_of_the_land: {
      arid: ['blur', 'burning_hands', 'fire_bolt', ...(level >= 5 ? ['fireball'] : []), ...(level >= 7 ? ['blight'] : []), ...(level >= 9 ? ['wall_of_stone'] : [])],
      polar: ['fog_cloud', 'hold_person', 'ray_of_frost', ...(level >= 5 ? ['sleet_storm'] : []), ...(level >= 7 ? ['ice_storm'] : []), ...(level >= 9 ? ['cone_of_cold'] : [])],
      temperate: ['misty_step', 'shocking_grasp', 'sleep', ...(level >= 5 ? ['lightning_bolt'] : []), ...(level >= 7 ? ['freedom_of_movement'] : []), ...(level >= 9 ? ['tree_stride'] : [])],
      tropical: ['acid_splash', 'ray_of_sickness', 'web', ...(level >= 5 ? ['stinking_cloud'] : []), ...(level >= 7 ? ['polymorph'] : []), ...(level >= 9 ? ['insect_plague'] : [])],
    }[land] || [],
    life_domain: [...(level >= 5 ? ['mass_healing_word', 'revivify'] : []), ...(level >= 7 ? ['aura_of_life', 'death_ward'] : []), ...(level >= 9 ? ['greater_restoration', 'mass_cure_wounds'] : [])],
    draconic_sorcery: [...(level >= 5 ? ['fear', 'fly'] : []), ...(level >= 7 ? ['arcane_eye', 'charm_monster'] : []), ...(level >= 9 ? ['legend_lore', 'summon_dragon'] : [])],
    fiend_patron: [...(level >= 5 ? ['fireball', 'stinking_cloud'] : []), ...(level >= 7 ? ['fire_shield', 'wall_of_fire'] : []), ...(level >= 9 ? ['geas', 'insect_plague'] : [])],
    oath_of_devotion: [...(level >= 9 ? ['beacon_of_hope', 'dispel_magic'] : [])],
  }[selectedSubclass.id] || [];
  return {
    ...spellcasting,
    always_prepared_spells: [...new Set([...(spellcasting.always_prepared_spells || []), ...subclassSpells])],
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
  for (const invocationId of added) {
    const invocation = byId(content.eldritchInvocations || [], invocationId);
    if (invocation?.spell_id) {
      spells.push({ id: invocation.spell_id, source: invocation.name, type: 'at_will' });
    }
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
  if (added.includes('agonizing_blast')) details.agonizing_blast = { cantrip: levelUpChoices.agonizing_blast_cantrip?.[0] };
  if (added.includes('repelling_blast')) details.repelling_blast = { cantrip: levelUpChoices.repelling_blast_cantrip?.[0] };

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

function applyAdvancementDerivedStats(derived = {}, advancement = {}, characterSheet = {}) {
  const additions = advancement.derived || {};
  if (additions.martial_arts_die) derived.martial_arts_die = additions.martial_arts_die;
  if (additions.sneak_attack_dice) derived.sneak_attack_dice = additions.sneak_attack_dice;
  for (const key of [
    'aura_of_protection_range', 'aura_charmed_immunity', 'aura_frightened_immunity',
    'empowered_strikes', 'evasion', 'reliable_talent_floor', 'acrobatic_movement',
    'heightened_focus', 'self_restoration', 'rage_damage_bonus', 'wild_shape_known_forms',
    'wild_shape_max_cr', 'wild_shape_fly_speed', 'elusive',
  ]) {
    if (additions[key] !== undefined) derived[key] = additions[key];
  }
  if (additions.initiative_advantage) {
    derived.initiative_advantage_sources = [...new Set([...(derived.initiative_advantage_sources || []), additions.initiative_advantage])];
  }
  if (additions.climb_speed_equals_speed) derived.climb_speed = Number(derived.speed || 30);
  if (additions.swim_speed_equals_speed) derived.swim_speed = Number(derived.speed || 30);
  if (additions.unarmored_movement_bonus) {
    const previous = Number(characterSheet.derived_stats?.unarmored_movement_bonus || 10);
    const delta = Number(additions.unarmored_movement_bonus) - previous;
    if (delta > 0 && !hasArmorOrShieldEquipped(characterSheet)) derived.speed = Number(derived.speed || 30) + delta;
    derived.unarmored_movement_bonus = Number(additions.unarmored_movement_bonus);
  }
  if ((advancement.runtime_mechanics || []).includes('extra_attack')) derived.attacks_per_action = 2;
  if ((advancement.runtime_mechanics || []).includes('extra_attack_2')) derived.attacks_per_action = 3;
  if ((advancement.runtime_mechanics || []).includes('extra_attack_3')) derived.attacks_per_action = 4;
  if ((advancement.runtime_mechanics || []).includes('fast_movement')) {
    derived.fast_movement = !hasHeavyArmorEquipped(characterSheet);
  }
  return derived;
}

function getSubclassRuntimeMechanics(subclass = null, level = 1) {
  if (!subclass) return [];
  const exact = subclass.level_runtime_mechanics?.[String(level)] || [];
  if (exact.length) return exact;
  return Number(level) === Number(subclass.unlock_level || 3) ? (subclass.runtime_mechanics || []) : [];
}

function applyInvocationDerivedStats(derived = {}, invocations = []) {
  const selected = new Set((invocations || []).map(normalizeId));
  if (selected.has('devils_sight')) {
    derived.senses = {
      ...(derived.senses || {}),
      devils_sight: 120,
      special: [
        ...((derived.senses || {}).special || []).filter((sense) => normalizeId(sense.source) !== 'devils_sight'),
        { type: 'devils_sight', range_feet: 120, source: "Devil's Sight", description: 'See normally in magical and nonmagical darkness.' },
      ],
    };
  }
  if (selected.has('gift_of_the_depths')) {
    derived.swim_speed = Math.max(Number(derived.swim_speed || 0), Number(derived.speed || 30));
    derived.can_breathe_underwater = true;
  }
  return derived;
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
