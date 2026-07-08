const ASI_BASE = [
  { id: 'level_4_feat', label: 'Feat', type: 'general_feat', count: 1 },
  {
    id: 'asi_pattern', label: 'Ability Score Improvement Pattern', type: 'option', count: 1,
    options: [
      { id: 'plus_two', name: 'Increase One Score by 2' },
      { id: 'split', name: 'Increase Two Scores by 1' },
    ],
    required_if: { choice_id: 'level_4_feat', includes: 'ability_score_improvement' },
  },
  { id: 'asi_primary', label: 'First Ability Increase', type: 'ability_increase', count: 1, required_if: { choice_id: 'level_4_feat', includes: 'ability_score_improvement' } },
  { id: 'asi_secondary', label: 'Second Ability Increase', type: 'ability_increase', count: 1, required_if: { choice_id: 'asi_pattern', includes: 'split' } },
  { id: 'grappler_ability', label: 'Grappler Ability Increase', type: 'ability_increase', count: 1, allowed: ['str', 'dex'], required_if: { choice_id: 'level_4_feat', includes: 'grappler' } },
];

const FULL_SLOTS = {
  11: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  12: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  13: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  14: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  15: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  16: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  17: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1 },
  18: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 1 },
  19: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1, 8: 1, 9: 1 },
  20: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 },
};

const HALF_SLOTS = {
  11: { 1: 4, 2: 3, 3: 2 },
  12: { 1: 4, 2: 3, 3: 2 },
  13: { 1: 4, 2: 3, 3: 3, 4: 1 },
  14: { 1: 4, 2: 3, 3: 3, 4: 1 },
  15: { 1: 4, 2: 3, 3: 3, 4: 2 },
  16: { 1: 4, 2: 3, 3: 3, 4: 2 },
  17: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  18: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  19: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
  20: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
};

function feature(id, name, description) {
  return { id, name, description };
}

function spellChoice(classId, count, maxLevel, label = 'Additional Prepared Spells') {
  return count > 0 ? [{ id: 'prepared_spells', label, type: 'spell', count, class_id: classId, min_level: 1, max_level: maxLevel }] : [];
}

function fullCaster(classId, level, prepared, cantrips, added, extra = {}) {
  return {
    features: extra.features || [],
    runtime_mechanics: extra.runtime_mechanics || [],
    required_choices: [...(extra.required_choices || []), ...spellChoice(classId, added, Math.ceil(level / 2))],
    spellcasting: { cantrips, prepared_spells: prepared, slots: FULL_SLOTS[level], ...(extra.spellcasting || {}) },
    ...(extra.resources ? { resources: extra.resources } : {}),
    ...(extra.derived ? { derived: extra.derived } : {}),
  };
}

function halfCaster(classId, level, prepared, added, extra = {}) {
  const highestSlotLevel = Math.max(...Object.keys(HALF_SLOTS[level] || {}).map(Number));
  return {
    features: extra.features || [],
    runtime_mechanics: extra.runtime_mechanics || [],
    required_choices: [...(extra.required_choices || []), ...spellChoice(classId, added, highestSlotLevel)],
    spellcasting: { prepared_spells: prepared, slots: HALF_SLOTS[level], ...(extra.spellcasting || {}) },
    ...(extra.resources ? { resources: extra.resources } : {}),
    ...(extra.derived ? { derived: extra.derived } : {}),
  };
}

function asi(extraChoices = []) {
  return {
    features: [feature('ability_score_improvement', 'Ability Score Improvement', 'Gain the Ability Score Improvement feat or another General feat for which you qualify.')],
    runtime_mechanics: ['level_4_feat'],
    required_choices: [...ASI_BASE, ...extraChoices],
  };
}

const levels = {
  barbarian: {
    11: { features: [feature('relentless_rage', 'Relentless Rage', 'If you drop to 0 HP while raging, make a Con save to drop to 1 instead.')], runtime_mechanics: ['relentless_rage'], resources: { rage: { name: 'Rage', remaining: 5, max: 5, reset: 'long_rest', recover_on_short_rest: 1 } } },
    12: asi(),
    13: { features: [feature('brutal_strike_2', 'Brutal Strike (2d10)', 'Brutal Strike damage increases to 2d10.')], runtime_mechanics: ['brutal_strike_2'] },
    14: { features: [], runtime_mechanics: ['berserker_presence'] },
    15: { features: [feature('persistent_rage', 'Persistent Rage', 'Your rage ends early only if you fall unconscious or choose to end it.')], runtime_mechanics: ['persistent_rage'] },
    16: { ...asi(), derived: { rage_damage_bonus: 4 }, resources: { rage: { name: 'Rage', remaining: 5, max: 5, reset: 'long_rest', recover_on_short_rest: 1 } } },
    17: { features: [feature('brutal_strike_3', 'Brutal Strike (3d10)', 'Brutal Strike damage increases to 3d10.')], runtime_mechanics: ['brutal_strike_3'], resources: { rage: { name: 'Rage', remaining: 6, max: 6, reset: 'long_rest', recover_on_short_rest: 1 } } },
    18: { features: [feature('indomitable_might', 'Indomitable Might', 'Use your Strength score if a Strength check is lower than it.')], runtime_mechanics: ['indomitable_might'] },
    19: asi(),
    20: { features: [feature('primal_champion', 'Primal Champion', 'Your Strength and Constitution scores increase by 4, to a maximum of 24.')], runtime_mechanics: ['primal_champion'] },
  },
  bard: {
    11: fullCaster('bard', 11, 16, 4, 1),
    12: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 16, slots: FULL_SLOTS[12] }, required_choices: [...ASI_BASE] },
    13: fullCaster('bard', 13, 18, 4, 2),
    14: fullCaster('bard', 14, 18, 4, 0, { features: [feature('peerless_skill', 'Peerless Skill', 'Add your Bardic Inspiration die to a failed check or attack roll.')], runtime_mechanics: ['peerless_skill'] }),
    15: fullCaster('bard', 15, 19, 4, 1, { resources: { bardic_inspiration: { name: 'Bardic Inspiration', die: '1d12', reset: 'short_rest' } } }),
    16: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 19, slots: FULL_SLOTS[16] }, required_choices: [...ASI_BASE] },
    17: fullCaster('bard', 17, 21, 4, 2),
    18: fullCaster('bard', 18, 22, 4, 1, { features: [feature('superior_inspiration', 'Superior Inspiration', 'Regain one use of Bardic Inspiration if you start turn with none.')], runtime_mechanics: ['superior_inspiration'] }),
    19: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 22, slots: FULL_SLOTS[19] }, required_choices: [...ASI_BASE] },
    20: fullCaster('bard', 20, 22, 4, 0, { features: [feature('words_of_creation', 'Words of Creation', 'You always have Power Word Heal and Power Word Kill prepared.')], runtime_mechanics: ['words_of_creation'] }),
  },
  cleric: {
    11: fullCaster('cleric', 11, 16, 5, 1),
    12: { ...asi(), spellcasting: { cantrips: 5, prepared_spells: 16, slots: FULL_SLOTS[12] }, required_choices: [...ASI_BASE] },
    13: fullCaster('cleric', 13, 18, 5, 2),
    14: fullCaster('cleric', 14, 18, 5, 0, { features: [feature('improved_blessed_strikes', 'Improved Blessed Strikes', 'Blessed Strikes damage increases or potent spellcasting adds Wisdom twice.')], runtime_mechanics: ['improved_blessed_strikes'] }),
    15: fullCaster('cleric', 15, 19, 5, 1),
    16: { ...asi(), spellcasting: { cantrips: 5, prepared_spells: 19, slots: FULL_SLOTS[16] }, required_choices: [...ASI_BASE] },
    17: fullCaster('cleric', 17, 21, 5, 2, { features: [], runtime_mechanics: ['supreme_healing'] }),
    18: fullCaster('cleric', 18, 22, 5, 1),
    19: { ...asi(), spellcasting: { cantrips: 5, prepared_spells: 22, slots: FULL_SLOTS[19] }, required_choices: [...ASI_BASE] },
    20: fullCaster('cleric', 20, 22, 5, 0, { features: [feature('greater_divine_intervention', 'Greater Divine Intervention', 'Your Divine Intervention automatically succeeds.')], runtime_mechanics: ['greater_divine_intervention'] }),
  },
  druid: {
    11: fullCaster('druid', 11, 16, 4, 1),
    12: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 16, slots: FULL_SLOTS[12] }, required_choices: [...ASI_BASE] },
    13: fullCaster('druid', 13, 18, 4, 2),
    14: fullCaster('druid', 14, 18, 4, 0, { features: [], runtime_mechanics: ['natures_sanctuary'] }),
    15: fullCaster('druid', 15, 19, 4, 1, { derived: { wild_shape_max_cr: 2 } }),
    16: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 19, slots: FULL_SLOTS[16] }, required_choices: [...ASI_BASE] },
    17: fullCaster('druid', 17, 21, 4, 2),
    18: fullCaster('druid', 18, 22, 4, 1, { features: [feature('beast_spells', 'Beast Spells', 'You can cast druid spells in wild shape.')], runtime_mechanics: ['beast_spells'] }),
    19: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 22, slots: FULL_SLOTS[19] }, required_choices: [...ASI_BASE] },
    20: fullCaster('druid', 20, 22, 4, 0, { features: [feature('archdruid', 'Archdruid', 'Regain Wild Shape uses on initiative.')], runtime_mechanics: ['archdruid'] }),
  },
  fighter: {
    11: { features: [feature('extra_attack_2', 'Extra Attack (2)', 'Attack three times instead of once when you take the Attack action.')], runtime_mechanics: ['extra_attack_2'], derived: { attacks_per_action: 3 } },
    12: asi(),
    13: { features: [], runtime_mechanics: ['indomitable_uses_2'], resources: { indomitable: { name: 'Indomitable', remaining: 2, max: 2, reset: 'long_rest' } } },
    14: asi(),
    15: { features: [], runtime_mechanics: ['superior_critical'] },
    16: asi(),
    17: { features: [], runtime_mechanics: ['action_surge_uses_2', 'indomitable_uses_3'], resources: { action_surge: { name: 'Action Surge', remaining: 2, max: 2, reset: 'short_rest' }, indomitable: { name: 'Indomitable', remaining: 3, max: 3, reset: 'long_rest' } } },
    18: { features: [], runtime_mechanics: ['survivor'] },
    19: asi(),
    20: { features: [feature('extra_attack_3', 'Extra Attack (3)', 'Attack four times instead of once when you take the Attack action.')], runtime_mechanics: ['extra_attack_3'], derived: { attacks_per_action: 4 } },
  },
  monk: {
    11: { features: [], runtime_mechanics: ['fleet_step'], resources: { focus_points: { name: 'Focus Points', remaining: 11, max: 11, reset: 'short_rest' } } },
    12: { ...asi(), resources: { focus_points: { name: 'Focus Points', remaining: 12, max: 12, reset: 'short_rest' } } },
    13: { features: [feature('deflect_energy', 'Deflect Energy', 'Deflect missiles can deflect energy damage types.')], runtime_mechanics: ['deflect_energy'], resources: { focus_points: { name: 'Focus Points', remaining: 13, max: 13, reset: 'short_rest' } } },
    14: { features: [feature('diamond_soul', 'Diamond Soul', 'Gain proficiency in all saving throws.')], runtime_mechanics: ['diamond_soul'], resources: { focus_points: { name: 'Focus Points', remaining: 14, max: 14, reset: 'short_rest' } } },
    15: { features: [feature('perfect_self', 'Perfect Self', 'Regain focus points when you start combat with none.')], runtime_mechanics: ['perfect_self'], resources: { focus_points: { name: 'Focus Points', remaining: 15, max: 15, reset: 'short_rest' } }, derived: { unarmored_movement_bonus: 25 } },
    16: { ...asi(), resources: { focus_points: { name: 'Focus Points', remaining: 16, max: 16, reset: 'short_rest' } } },
    17: { features: [], runtime_mechanics: ['quivering_palm'], resources: { focus_points: { name: 'Focus Points', remaining: 17, max: 17, reset: 'short_rest' } } },
    18: { features: [], resources: { focus_points: { name: 'Focus Points', remaining: 18, max: 18, reset: 'short_rest' } }, derived: { unarmored_movement_bonus: 30 } },
    19: { ...asi(), resources: { focus_points: { name: 'Focus Points', remaining: 19, max: 19, reset: 'short_rest' } } },
    20: { features: [feature('body_and_mind', 'Body and Mind', 'Increase Strength and Wisdom.')], runtime_mechanics: ['body_and_mind'], resources: { focus_points: { name: 'Focus Points', remaining: 20, max: 20, reset: 'short_rest' } } },
  },
  paladin: {
    11: halfCaster('paladin', 11, 10, 0, 1, { features: [feature('radiant_smite', 'Radiant Smite', 'Your melee weapon attacks deal an extra 1d8 radiant damage on hit.')], runtime_mechanics: ['radiant_smite'], resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 55, max: 55, reset: 'long_rest' } } }),
    12: { ...asi(), spellcasting: { prepared_spells: 10, slots: HALF_SLOTS[12] }, resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 60, max: 60, reset: 'long_rest' } } },
    13: halfCaster('paladin', 13, 11, 1, { resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 65, max: 65, reset: 'long_rest' } } }),
    14: halfCaster('paladin', 14, 11, 0, { features: [feature('cleansing_touch', 'Cleansing Touch', 'Use an action to end one spell on yourself or a willing creature.')], runtime_mechanics: ['cleansing_touch'], resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 70, max: 70, reset: 'long_rest' } } }),
    15: halfCaster('paladin', 15, 12, 1, { features: [], runtime_mechanics: ['purity_of_spirit'], resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 75, max: 75, reset: 'long_rest' } } }),
    16: { ...asi(), spellcasting: { prepared_spells: 12, slots: HALF_SLOTS[16] }, resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 80, max: 80, reset: 'long_rest' } } },
    17: halfCaster('paladin', 17, 14, 2, { resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 85, max: 85, reset: 'long_rest' } } }),
    18: halfCaster('paladin', 18, 14, 0, { resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 90, max: 90, reset: 'long_rest' } }, derived: { aura_of_protection_range: 30 } }),
    19: { ...asi(), spellcasting: { prepared_spells: 14, slots: HALF_SLOTS[19] }, resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 95, max: 95, reset: 'long_rest' } } },
    20: halfCaster('paladin', 20, 15, 1, { features: [], runtime_mechanics: ['holy_nimbus'], resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 100, max: 100, reset: 'long_rest' } } }),
  },
  ranger: {
    11: halfCaster('ranger', 11, 10, 0, 1, { features: [], runtime_mechanics: ['hunter_multiattack'], resources: { spell_uses: { 'class_feature:favored_enemy:hunter_mark': { name: "Hunter's Mark", spell_id: 'hunter_mark', source: 'favored_enemy', source_name: 'Favored Enemy', remaining: 5, max: 5, reset: 'long_rest' } } } }),
    12: { ...asi(), spellcasting: { prepared_spells: 10, slots: HALF_SLOTS[12] } },
    13: halfCaster('ranger', 13, 11, 1),
    14: halfCaster('ranger', 14, 11, 0, { features: [feature('feral_senses', 'Feral Senses', 'You gain blindsight to 30 feet.')], runtime_mechanics: ['feral_senses'] }),
    15: halfCaster('ranger', 15, 12, 1, { features: [], runtime_mechanics: ['superior_hunters_defense'] }),
    16: { ...asi(), spellcasting: { prepared_spells: 12, slots: HALF_SLOTS[16] } },
    17: halfCaster('ranger', 17, 14, 2, { resources: { spell_uses: { 'class_feature:favored_enemy:hunter_mark': { name: "Hunter's Mark", spell_id: 'hunter_mark', source: 'favored_enemy', source_name: 'Favored Enemy', remaining: 6, max: 6, reset: 'long_rest' } } } }),
    18: halfCaster('ranger', 18, 14, 0),
    19: { ...asi(), spellcasting: { prepared_spells: 14, slots: HALF_SLOTS[19] } },
    20: halfCaster('ranger', 20, 15, 1, { features: [feature('foe_slayer', 'Foe Slayer', 'Add Wisdom modifier to attack or damage.')], runtime_mechanics: ['foe_slayer'] }),
  },
  rogue: {
    11: { features: [feature('sneak_attack_level_11', 'Sneak Attack (6d6)', 'Sneak Attack damage increases to 6d6.')], derived: { sneak_attack_dice: '6d6' } },
    12: asi(),
    13: { features: [feature('sneak_attack_level_13', 'Sneak Attack (7d6)', 'Sneak Attack damage increases to 7d6.')], runtime_mechanics: ['use_magic_device'], derived: { sneak_attack_dice: '7d6' } },
    14: { features: [feature('slippery_mind', 'Slippery Mind', 'Gain proficiency in Wisdom saving throws.')], runtime_mechanics: ['slippery_mind'] },
    15: { features: [feature('sneak_attack_level_15', 'Sneak Attack (8d6)', 'Sneak Attack damage increases to 8d6.')], derived: { sneak_attack_dice: '8d6' } },
    16: asi(),
    17: { features: [feature('sneak_attack_level_17', 'Sneak Attack (9d6)', 'Sneak Attack damage increases to 9d6.')], runtime_mechanics: ['thiefs_reflexes'], derived: { sneak_attack_dice: '9d6' } },
    18: { features: [feature('elusive', 'Elusive', 'No attack has advantage against you.')], runtime_mechanics: ['elusive'], derived: { elusive: true } },
    19: { ...asi(), features: [feature('sneak_attack_level_19', 'Sneak Attack (10d6)', 'Sneak Attack damage increases to 10d6.')], derived: { sneak_attack_dice: '10d6' } },
    20: { features: [feature('stroke_of_luck', 'Stroke of Luck', 'Turn failure into success once per short rest.')], runtime_mechanics: ['stroke_of_luck'], resources: { stroke_of_luck: { name: 'Stroke of Luck', remaining: 1, max: 1, reset: 'short_rest' } } },
  },
  sorcerer: {
    11: fullCaster('sorcerer', 11, 16, 6, 1, { resources: { sorcery_points: { name: 'Sorcery Points', remaining: 11, max: 11, reset: 'long_rest' } } }),
    12: { ...asi(), spellcasting: { cantrips: 6, prepared_spells: 16, slots: FULL_SLOTS[12] }, required_choices: [...ASI_BASE], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 12, max: 12, reset: 'long_rest' } } },
    13: fullCaster('sorcerer', 13, 18, 6, 2, { resources: { sorcery_points: { name: 'Sorcery Points', remaining: 13, max: 13, reset: 'long_rest' } } }),
    14: fullCaster('sorcerer', 14, 18, 6, 0, { features: [], runtime_mechanics: ['dragon_wings'], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 14, max: 14, reset: 'long_rest' } } }),
    15: fullCaster('sorcerer', 15, 19, 6, 1, { resources: { sorcery_points: { name: 'Sorcery Points', remaining: 15, max: 15, reset: 'long_rest' } } }),
    16: { ...asi(), spellcasting: { cantrips: 6, prepared_spells: 19, slots: FULL_SLOTS[16] }, required_choices: [...ASI_BASE], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 16, max: 16, reset: 'long_rest' } } },
    17: fullCaster('sorcerer', 17, 21, 6, 2, { resources: { sorcery_points: { name: 'Sorcery Points', remaining: 17, max: 17, reset: 'long_rest' } } }),
    18: fullCaster('sorcerer', 18, 22, 6, 1, { features: [], runtime_mechanics: ['draconic_presence'], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 18, max: 18, reset: 'long_rest' } } }),
    19: { ...asi(), spellcasting: { cantrips: 6, prepared_spells: 22, slots: FULL_SLOTS[19] }, required_choices: [...ASI_BASE], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 19, max: 19, reset: 'long_rest' } } },
    20: fullCaster('sorcerer', 20, 22, 6, 0, { features: [feature('arcane_apotheosis', 'Arcane Apotheosis', 'Innate Sorcery Metamagic costs no sorcery points.')], runtime_mechanics: ['arcane_apotheosis'], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 20, max: 20, reset: 'long_rest' } } }),
  },
  warlock: {
    11: { features: [], runtime_mechanics: ['mystic_arcanum_level_11'], required_choices: spellChoice('warlock', 1, 5), spellcasting: { cantrips: 4, prepared_spells: 11, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 3 }, pact_slot_level: 5 } },
    12: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 12, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 3 }, pact_slot_level: 5 }, required_choices: [...ASI_BASE, ...spellChoice('warlock', 1, 5)] },
    13: { features: [], runtime_mechanics: ['eldritch_invocations_level_13'], required_choices: [{ id: 'eldritch_invocations', label: 'Additional Eldritch Invocation', type: 'eldritch_invocation', count: 1 }, ...spellChoice('warlock', 1, 5)], spellcasting: { cantrips: 4, prepared_spells: 13, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 3 }, pact_slot_level: 5 } },
    14: { features: [], runtime_mechanics: ['hurl_through_hell'], required_choices: spellChoice('warlock', 1, 5), spellcasting: { cantrips: 4, prepared_spells: 14, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 3 }, pact_slot_level: 5 } },
    15: { features: [], runtime_mechanics: ['eldritch_invocations_level_15'], required_choices: [{ id: 'eldritch_invocations', label: 'Additional Eldritch Invocation', type: 'eldritch_invocation', count: 1 }, ...spellChoice('warlock', 1, 5)], spellcasting: { cantrips: 4, prepared_spells: 15, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 3 }, pact_slot_level: 5 } },
    16: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 16, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 3 }, pact_slot_level: 5 }, required_choices: [...ASI_BASE, ...spellChoice('warlock', 1, 5)] },
    17: { features: [], runtime_mechanics: ['eldritch_invocations_level_17'], required_choices: [{ id: 'eldritch_invocations', label: 'Additional Eldritch Invocation', type: 'eldritch_invocation', count: 1 }, ...spellChoice('warlock', 1, 5)], spellcasting: { cantrips: 4, prepared_spells: 17, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 4 }, pact_slot_level: 5 } },
    18: { features: [], required_choices: spellChoice('warlock', 1, 5), spellcasting: { cantrips: 4, prepared_spells: 18, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 4 }, pact_slot_level: 5 } },
    19: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 19, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 4 }, pact_slot_level: 5 }, required_choices: [...ASI_BASE, ...spellChoice('warlock', 1, 5)] },
    20: { features: [feature('eldritch_master', 'Eldritch Master', 'Spend 1 minute to regain all expended Pact Magic slots.')], runtime_mechanics: ['eldritch_master'], required_choices: spellChoice('warlock', 1, 5), spellcasting: { cantrips: 4, prepared_spells: 20, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 4 }, pact_slot_level: 5 }, resources: { eldritch_master: { name: 'Eldritch Master', remaining: 1, max: 1, reset: 'long_rest' } } },
  },
  wizard: {
    11: fullCaster('wizard', 11, 16, 5, 0, { required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 6 }, { id: 'prepared_spells', label: 'New Prepared Spell', type: 'wizard_prepared_spell', count: 1, max_level: 6 }] }),
    12: { ...asi(), spellcasting: { cantrips: 5, prepared_spells: 16, spellbook_spells_add: 2, slots: FULL_SLOTS[12] }, required_choices: [...ASI_BASE, { id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 6 }] },
    13: fullCaster('wizard', 13, 18, 5, 0, { required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 7 }, { id: 'prepared_spells', label: 'New Prepared Spells', type: 'wizard_prepared_spell', count: 2, max_level: 7 }] }),
    14: fullCaster('wizard', 14, 18, 5, 0, { features: [], runtime_mechanics: ['overchannel'], required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 7 }] }),
    15: fullCaster('wizard', 15, 19, 5, 0, { required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 8 }, { id: 'prepared_spells', label: 'New Prepared Spell', type: 'wizard_prepared_spell', count: 1, max_level: 8 }] }),
    16: { ...asi(), spellcasting: { cantrips: 5, prepared_spells: 19, spellbook_spells_add: 2, slots: FULL_SLOTS[16] }, required_choices: [...ASI_BASE, { id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 8 }] },
    17: fullCaster('wizard', 17, 21, 5, 0, { required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 9 }, { id: 'prepared_spells', label: 'New Prepared Spells', type: 'wizard_prepared_spell', count: 2, max_level: 9 }] }),
    18: fullCaster('wizard', 18, 22, 5, 0, { features: [feature('spell_mastery', 'Spell Mastery', 'Choose a 1st-level and 2nd-level spell to cast without slots.')], runtime_mechanics: ['spell_mastery'], required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 9 }, { id: 'prepared_spells', label: 'New Prepared Spell', type: 'wizard_prepared_spell', count: 1, max_level: 9 }] }),
    19: { ...asi(), spellcasting: { cantrips: 5, prepared_spells: 22, spellbook_spells_add: 2, slots: FULL_SLOTS[19] }, required_choices: [...ASI_BASE, { id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 9 }] },
    20: fullCaster('wizard', 20, 22, 5, 0, { features: [feature('signature_spells', 'Signature Spells', 'Choose two 3rd-level signature spells.')], runtime_mechanics: ['signature_spells'], required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 9 }] }),
  },
};

module.exports = {
  version: 'srd-5.2.1-levels-11-20-runtime',
  source: 'SRD 5.2.1 class feature tables',
  levels,
};
