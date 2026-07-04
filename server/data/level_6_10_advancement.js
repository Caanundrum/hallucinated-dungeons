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
  6: { 1: 4, 2: 3, 3: 3 },
  7: { 1: 4, 2: 3, 3: 3, 4: 1 },
  8: { 1: 4, 2: 3, 3: 3, 4: 2 },
  9: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  10: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
};

const HALF_SLOTS = {
  6: { 1: 4, 2: 2 },
  7: { 1: 4, 2: 3 },
  8: { 1: 4, 2: 3 },
  9: { 1: 4, 2: 3, 3: 2 },
  10: { 1: 4, 2: 3, 3: 2 },
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
    6: { features: [], runtime_mechanics: ['mindless_rage'], resources: { rage: { name: 'Rage', remaining: 4, max: 4, reset: 'long_rest', recover_on_short_rest: 1 } } },
    7: { features: [feature('feral_instinct', 'Feral Instinct', 'Gain Advantage on Initiative rolls.'), feature('instinctive_pounce', 'Instinctive Pounce', 'Move up to half your Speed when you enter Rage.')], runtime_mechanics: ['feral_instinct', 'instinctive_pounce'], derived: { initiative_advantage: 'Feral Instinct' } },
    8: asi(),
    9: { features: [feature('brutal_strike', 'Brutal Strike', 'Trade Reckless Attack Advantage on one eligible Strength attack for 1d10 extra damage and Forceful Blow or Hamstring Blow.')], runtime_mechanics: ['brutal_strike'], derived: { rage_damage_bonus: 3 } },
    10: { features: [], runtime_mechanics: ['berserker_retaliation'], required_choices: [{ id: 'weapon_mastery', label: 'Additional Weapon Mastery', type: 'weapon_mastery', count: 1 }] },
  },
  bard: {
    6: fullCaster('bard', 6, 10, 3, 1, {
      required_choices: [{ id: 'magical_discoveries', label: 'College of Lore Magical Discoveries', type: 'spell', count: 2, class_ids: ['cleric', 'druid', 'wizard'], min_level: 0, max_level: 3, persist_as: 'magical_discoveries' }],
      runtime_mechanics: ['magical_discoveries'],
    }),
    7: fullCaster('bard', 7, 11, 3, 1, { features: [feature('countercharm', 'Countercharm', 'Use a Reaction to give a reroll with Advantage after a nearby creature fails against Charmed or Frightened.')], runtime_mechanics: ['countercharm'] }),
    8: { ...asi(), spellcasting: { cantrips: 3, prepared_spells: 12, slots: FULL_SLOTS[8] }, required_choices: [...ASI_BASE, ...spellChoice('bard', 1, 4)] },
    9: fullCaster('bard', 9, 14, 3, 2, { required_choices: [{ id: 'bard_expertise_level_9', label: 'Additional Expertise Skills', type: 'skill', count: 2 }], runtime_mechanics: ['expertise_level_9'] }),
    10: fullCaster('bard', 10, 15, 4, 0, {
      features: [feature('magical_secrets', 'Magical Secrets', 'New and replacement prepared spells can come from the Bard, Cleric, Druid, or Wizard lists.')],
      runtime_mechanics: ['magical_secrets'],
      required_choices: [
        { id: 'cantrip', label: 'Additional Bard Cantrip', type: 'spell', count: 1, class_id: 'bard', max_level: 0 },
        { id: 'prepared_spells', label: 'Magical Secrets Spell', type: 'spell', count: 1, class_ids: ['bard', 'cleric', 'druid', 'wizard'], min_level: 1, max_level: 5 },
      ],
      resources: { bardic_inspiration: { name: 'Bardic Inspiration', die: '1d10', reset: 'short_rest' } },
    }),
  },
  cleric: {
    6: fullCaster('cleric', 6, 10, 4, 1, { features: [], runtime_mechanics: ['blessed_healer'], resources: { channel_divinity: { name: 'Channel Divinity', remaining: 3, max: 3, reset: 'short_rest' } } }),
    7: fullCaster('cleric', 7, 11, 4, 1, { features: [feature('blessed_strikes', 'Blessed Strikes', 'Choose Divine Strike for weapon damage or Potent Spellcasting for Cleric cantrip damage.')], runtime_mechanics: ['blessed_strikes'], required_choices: [{ id: 'blessed_strikes', label: 'Blessed Strikes', type: 'option', count: 1, persist_as: 'blessed_strikes', options: [{ id: 'divine_strike', name: 'Divine Strike', description: 'Once per turn, add 1d8 Radiant or Necrotic damage to a weapon hit.' }, { id: 'potent_spellcasting', name: 'Potent Spellcasting', description: 'Add Wisdom modifier to Cleric cantrip damage.' }] }] }),
    8: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 12, slots: FULL_SLOTS[8] }, required_choices: [...ASI_BASE, ...spellChoice('cleric', 1, 4)] },
    9: fullCaster('cleric', 9, 14, 4, 2),
    10: fullCaster('cleric', 10, 15, 5, 1, { features: [feature('divine_intervention', 'Divine Intervention', 'Once per Long Rest, cast a Cleric spell of level 5 or lower without a spell slot or Material components.')], runtime_mechanics: ['divine_intervention'], required_choices: [{ id: 'cantrip', label: 'Additional Cleric Cantrip', type: 'spell', count: 1, class_id: 'cleric', max_level: 0 }], resources: { channel_divinity: { name: 'Channel Divinity', remaining: 3, max: 3, reset: 'short_rest' }, divine_intervention: { name: 'Divine Intervention', remaining: 1, max: 1, reset: 'long_rest' } } }),
  },
  druid: {
    6: fullCaster('druid', 6, 10, 3, 1, { features: [], runtime_mechanics: ['natural_recovery'], resources: { wild_shape: { name: 'Wild Shape', remaining: 3, max: 3, reset: 'short_rest' }, natural_recovery: { name: 'Natural Recovery', remaining: 1, max: 1, reset: 'long_rest' }, natural_recovery_circle_spell: { name: 'Natural Recovery Circle Spell', remaining: 1, max: 1, reset: 'long_rest' } } }),
    7: fullCaster('druid', 7, 11, 3, 1, { features: [feature('elemental_fury', 'Elemental Fury', 'Choose Potent Spellcasting or Primal Strike.')], runtime_mechanics: ['elemental_fury'], required_choices: [{ id: 'elemental_fury', label: 'Elemental Fury', type: 'option', count: 1, persist_as: 'elemental_fury', options: [{ id: 'potent_spellcasting', name: 'Potent Spellcasting', description: 'Add Wisdom modifier to Druid cantrip damage.' }, { id: 'primal_strike', name: 'Primal Strike', description: 'Once per turn, add 1d8 Cold, Fire, Lightning, or Thunder damage to a weapon or Wild Shape hit.' }] }] }),
    8: { ...asi(), spellcasting: { cantrips: 3, prepared_spells: 12, slots: FULL_SLOTS[8] }, required_choices: [...ASI_BASE, ...spellChoice('druid', 1, 4)], derived: { wild_shape_known_forms: 8, wild_shape_max_cr: 1, wild_shape_fly_speed: true } },
    9: fullCaster('druid', 9, 14, 3, 2),
    10: fullCaster('druid', 10, 15, 4, 1, { features: [], runtime_mechanics: ['natures_ward'], required_choices: [{ id: 'cantrip', label: 'Additional Druid Cantrip', type: 'spell', count: 1, class_id: 'druid', max_level: 0 }], resources: { wild_shape: { name: 'Wild Shape', remaining: 3, max: 3, reset: 'short_rest' } } }),
  },
  fighter: {
    6: asi(),
    7: { features: [], runtime_mechanics: ['additional_fighting_style'], required_choices: [{ id: 'additional_fighting_style', label: 'Additional Fighting Style', type: 'fighting_style', count: 1, persist_as: 'additional_fighting_styles' }] },
    8: asi(),
    9: { features: [feature('indomitable', 'Indomitable', 'After failing a saving throw, reroll it with a bonus equal to your Fighter level.'), feature('tactical_master', 'Tactical Master', 'Replace a mastered weapon property with Push, Sap, or Slow for an attack.')], runtime_mechanics: ['indomitable', 'tactical_master'], resources: { indomitable: { name: 'Indomitable', remaining: 1, max: 1, reset: 'long_rest' } } },
    10: { features: [], runtime_mechanics: ['heroic_warrior'], required_choices: [{ id: 'weapon_mastery', label: 'Additional Weapon Mastery', type: 'weapon_mastery', count: 1 }], resources: { second_wind: { name: 'Second Wind', remaining: 4, max: 4, reset: 'long_rest', recover_on_short_rest: 1 } } },
  },
  monk: {
    6: { features: [feature('empowered_strikes', 'Empowered Strikes', 'Unarmed Strikes can deal Force damage instead of their normal damage type.')], runtime_mechanics: ['empowered_strikes', 'wholeness_of_body'], resources: { focus_points: { name: 'Focus Points', remaining: 6, max: 6, reset: 'short_rest' }, wholeness_of_body: { name: 'Wholeness of Body', remaining: 'wisdom_modifier', max: 'wisdom_modifier', reset: 'long_rest' } }, derived: { unarmored_movement_bonus: 15, empowered_strikes: true } },
    7: { features: [feature('evasion', 'Evasion', 'Dexterity-save effects deal no damage on a success and half damage on a failure.')], runtime_mechanics: ['evasion'], resources: { focus_points: { name: 'Focus Points', remaining: 7, max: 7, reset: 'short_rest' } }, derived: { evasion: true } },
    8: { ...asi(), resources: { focus_points: { name: 'Focus Points', remaining: 8, max: 8, reset: 'short_rest' } } },
    9: { features: [feature('acrobatic_movement', 'Acrobatic Movement', 'Move across liquids and along vertical surfaces during your turn while unarmored and without a Shield.')], runtime_mechanics: ['acrobatic_movement'], resources: { focus_points: { name: 'Focus Points', remaining: 9, max: 9, reset: 'short_rest' } }, derived: { acrobatic_movement: true } },
    10: { features: [feature('heightened_focus', 'Heightened Focus', 'Improve Flurry of Blows, Patient Defense, and Step of the Wind.'), feature('self_restoration', 'Self-Restoration', 'At the end of your turn, remove Charmed, Frightened, or Poisoned from yourself.')], runtime_mechanics: ['heightened_focus', 'self_restoration'], resources: { focus_points: { name: 'Focus Points', remaining: 10, max: 10, reset: 'short_rest' } }, derived: { unarmored_movement_bonus: 20, heightened_focus: true, self_restoration: true } },
  },
  paladin: {
    6: halfCaster('paladin', 6, 6, 0, { features: [feature('aura_of_protection', 'Aura of Protection', 'You and allies within 10 feet add your Charisma modifier to saving throws.')], runtime_mechanics: ['aura_of_protection'], resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 30, max: 30, reset: 'long_rest' } }, derived: { aura_of_protection_range: 10 } }),
    7: halfCaster('paladin', 7, 7, 1, { features: [], runtime_mechanics: ['aura_of_devotion'], resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 35, max: 35, reset: 'long_rest' } }, derived: { aura_charmed_immunity: true } }),
    8: { ...asi(), spellcasting: { prepared_spells: 7, slots: HALF_SLOTS[8] }, resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 40, max: 40, reset: 'long_rest' } } },
    9: halfCaster('paladin', 9, 9, 2, { features: [feature('abjure_foes', 'Abjure Foes', 'Spend Channel Divinity to Frighten multiple visible creatures for up to 1 minute.')], runtime_mechanics: ['abjure_foes'], resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 45, max: 45, reset: 'long_rest' } } }),
    10: halfCaster('paladin', 10, 9, 0, { features: [feature('aura_of_courage', 'Aura of Courage', 'You and allies in your Aura of Protection are immune to Frightened.')], runtime_mechanics: ['aura_of_courage'], resources: { lay_on_hands: { name: 'Lay on Hands', remaining: 50, max: 50, reset: 'long_rest' } }, derived: { aura_frightened_immunity: true } }),
  },
  ranger: {
    6: halfCaster('ranger', 6, 6, 0, { features: [feature('roving', 'Roving', 'Gain 10 feet of Speed plus Climb and Swim Speeds equal to your Speed while not in Heavy armor.')], runtime_mechanics: ['roving'], derived: { speed_bonus_unless_heavy_armor: 10, climb_speed_equals_speed: true, swim_speed_equals_speed: true }, resources: { spell_uses: { 'class_feature:favored_enemy:hunter_mark': { name: "Hunter's Mark", spell_id: 'hunter_mark', source: 'favored_enemy', source_name: 'Favored Enemy', remaining: 3, max: 3, reset: 'long_rest' } } } }),
    7: halfCaster('ranger', 7, 7, 1, { features: [], runtime_mechanics: ['defensive_tactics'], required_choices: [{ id: 'defensive_tactics', label: 'Defensive Tactics', type: 'option', count: 1, persist_as: 'defensive_tactics', options: [{ id: 'escape_the_horde', name: 'Escape the Horde', description: 'Opportunity Attacks have Disadvantage against you.' }, { id: 'multiattack_defense', name: 'Multiattack Defense', description: 'After a creature hits you, its later attacks against you this turn have Disadvantage.' }] }] }),
    8: { ...asi(), spellcasting: { prepared_spells: 7, slots: HALF_SLOTS[8] } },
    9: halfCaster('ranger', 9, 9, 2, { required_choices: [{ id: 'ranger_expertise_level_9', label: 'Additional Expertise Skills', type: 'skill', count: 2 }], runtime_mechanics: ['expertise_level_9'], resources: { spell_uses: { 'class_feature:favored_enemy:hunter_mark': { name: "Hunter's Mark", spell_id: 'hunter_mark', source: 'favored_enemy', source_name: 'Favored Enemy', remaining: 4, max: 4, reset: 'long_rest' } } } }),
    10: halfCaster('ranger', 10, 9, 0, { features: [feature('tireless', 'Tireless', 'Gain temporary HP through primal stamina and reduce Exhaustion after Short Rests.')], runtime_mechanics: ['tireless'], resources: { tireless: { name: 'Tireless', remaining: 'wisdom_modifier', max: 'wisdom_modifier', reset: 'long_rest' } } }),
  },
  rogue: {
    6: { features: [], runtime_mechanics: ['expertise_level_6'], required_choices: [{ id: 'rogue_expertise_level_6', label: 'Additional Expertise Skills', type: 'skill', count: 2 }] },
    7: { features: [feature('evasion', 'Evasion', 'Dexterity-save effects deal no damage on a success and half damage on a failure.'), feature('reliable_talent', 'Reliable Talent', 'Treat a d20 roll of 9 or lower as 10 on proficient skill and tool checks.'), feature('sneak_attack_level_7', 'Sneak Attack (4d6)', 'Sneak Attack damage increases to 4d6.')], runtime_mechanics: ['evasion', 'reliable_talent'], derived: { sneak_attack_dice: '4d6', evasion: true, reliable_talent_floor: 10 } },
    8: asi(),
    9: { features: [feature('sneak_attack_level_9', 'Sneak Attack (5d6)', 'Sneak Attack damage increases to 5d6')], runtime_mechanics: ['supreme_sneak'], derived: { sneak_attack_dice: '5d6' } },
    10: asi(),
  },
  sorcerer: {
    6: fullCaster('sorcerer', 6, 10, 5, 1, { features: [], runtime_mechanics: ['elemental_affinity'], required_choices: [{ id: 'draconic_affinity', label: 'Elemental Affinity', type: 'option', count: 1, persist_as: 'draconic_affinity', options: ['acid', 'cold', 'fire', 'lightning', 'poison'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), description: `Gain ${id} resistance and empower matching spell damage.` })) }], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 6, max: 6, reset: 'long_rest' } } }),
    7: fullCaster('sorcerer', 7, 11, 5, 1, { features: [feature('sorcery_incarnate', 'Sorcery Incarnate', 'Spend 2 Sorcery Points to activate Innate Sorcery when its uses are gone; while active, use up to two Metamagic options per spell.')], runtime_mechanics: ['sorcery_incarnate'], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 7, max: 7, reset: 'long_rest' } } }),
    8: { ...asi(), spellcasting: { cantrips: 5, prepared_spells: 12, slots: FULL_SLOTS[8] }, required_choices: [...ASI_BASE, ...spellChoice('sorcerer', 1, 4)], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 8, max: 8, reset: 'long_rest' } } },
    9: fullCaster('sorcerer', 9, 14, 5, 2, { resources: { sorcery_points: { name: 'Sorcery Points', remaining: 9, max: 9, reset: 'long_rest' } } }),
    10: fullCaster('sorcerer', 10, 15, 6, 1, { features: [feature('metamagic_level_10', 'Metamagic', 'Learn two additional Metamagic options.')], runtime_mechanics: ['metamagic_level_10'], required_choices: [{ id: 'metamagic', label: 'Additional Metamagic Options', type: 'metamagic', count: 2 }, { id: 'cantrip', label: 'Additional Sorcerer Cantrip', type: 'spell', count: 1, class_id: 'sorcerer', max_level: 0 }], resources: { sorcery_points: { name: 'Sorcery Points', remaining: 10, max: 10, reset: 'long_rest' } } }),
  },
  warlock: {
    6: { features: [], runtime_mechanics: ['dark_ones_own_luck'], required_choices: spellChoice('warlock', 1, 3), spellcasting: { cantrips: 3, prepared_spells: 7, slots: { 1: 0, 2: 0, 3: 2 }, pact_slot_level: 3 }, resources: { dark_ones_own_luck: { name: "Dark One's Own Luck", remaining: 'charisma_modifier', max: 'charisma_modifier', reset: 'long_rest' } } },
    7: { features: [], runtime_mechanics: ['eldritch_invocations_level_7'], required_choices: [{ id: 'eldritch_invocations', label: 'Additional Eldritch Invocation', type: 'eldritch_invocation', count: 1 }, ...spellChoice('warlock', 1, 4)], spellcasting: { cantrips: 3, prepared_spells: 8, slots: { 1: 0, 2: 0, 3: 0, 4: 2 }, pact_slot_level: 4 } },
    8: { ...asi(), spellcasting: { cantrips: 3, prepared_spells: 9, slots: { 1: 0, 2: 0, 3: 0, 4: 2 }, pact_slot_level: 4 }, required_choices: [...ASI_BASE, ...spellChoice('warlock', 1, 4)] },
    9: { features: [feature('contact_patron', 'Contact Patron', 'Cast Contact Other Plane to contact your patron once per Long Rest without a slot and automatically succeed on its save.')], runtime_mechanics: ['contact_patron', 'eldritch_invocations_level_9'], required_choices: [{ id: 'eldritch_invocations', label: 'Additional Eldritch Invocation', type: 'eldritch_invocation', count: 1 }, ...spellChoice('warlock', 1, 5)], spellcasting: { cantrips: 3, prepared_spells: 10, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 }, pact_slot_level: 5, always_prepared: ['contact_other_plane'] }, resources: { contact_patron: { name: 'Contact Patron', remaining: 1, max: 1, reset: 'long_rest' } } },
    10: { features: [], runtime_mechanics: ['fiendish_resilience'], required_choices: [{ id: 'cantrip', label: 'Additional Warlock Cantrip', type: 'spell', count: 1, class_id: 'warlock', max_level: 0 }, { id: 'fiendish_resilience', label: 'Fiendish Resilience', type: 'damage_type', count: 1, persist_as: 'fiendish_resilience' }], spellcasting: { cantrips: 4, prepared_spells: 10, slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 }, pact_slot_level: 5 } },
  },
  wizard: {
    6: fullCaster('wizard', 6, 10, 4, 0, { features: [], runtime_mechanics: ['sculpt_spells'], required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 3 }, { id: 'prepared_spells', label: 'New Prepared Spell', type: 'wizard_prepared_spell', count: 1, max_level: 3 }] }),
    7: fullCaster('wizard', 7, 11, 4, 0, { required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 4 }, { id: 'evocation_savant_spells', label: 'Evocation Savant Addition', type: 'wizard_spell', count: 1, max_level: 4, school: 'evocation' }, { id: 'prepared_spells', label: 'New Prepared Spell', type: 'wizard_prepared_spell', count: 1, max_level: 4 }] }),
    8: { ...asi(), spellcasting: { cantrips: 4, prepared_spells: 12, spellbook_spells_add: 2, slots: FULL_SLOTS[8] }, required_choices: [...ASI_BASE, { id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 4 }, { id: 'prepared_spells', label: 'New Prepared Spell', type: 'wizard_prepared_spell', count: 1, max_level: 4 }] },
    9: fullCaster('wizard', 9, 14, 4, 0, { required_choices: [{ id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 5 }, { id: 'evocation_savant_spells', label: 'Evocation Savant Addition', type: 'wizard_spell', count: 1, max_level: 5, school: 'evocation' }, { id: 'prepared_spells', label: 'New Prepared Spells', type: 'wizard_prepared_spell', count: 2, max_level: 5 }] }),
    10: fullCaster('wizard', 10, 15, 5, 0, { features: [], runtime_mechanics: ['empowered_evocation'], required_choices: [{ id: 'cantrip', label: 'Additional Wizard Cantrip', type: 'spell', count: 1, class_id: 'wizard', max_level: 0 }, { id: 'spellbook_spells', label: 'Spellbook Additions', type: 'wizard_spell', count: 2, max_level: 5 }, { id: 'prepared_spells', label: 'New Prepared Spell', type: 'wizard_prepared_spell', count: 1, max_level: 5 }] }),
  },
};

module.exports = {
  version: 'srd-5.2.1-levels-6-10-runtime',
  source: 'SRD 5.2.1 class feature tables',
  levels,
};
