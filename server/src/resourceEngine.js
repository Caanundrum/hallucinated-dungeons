const RESOURCE_DEFINITIONS = {
  heroic_inspiration: {
    name: 'Heroic Inspiration',
    max: 1,
    reset: 'special',
  },
  luck_points: {
    name: 'Luck Points',
    reset: 'long_rest',
  },
  rage: {
    name: 'Rage',
    remaining: 2,
    max: 2,
    reset: 'long_rest',
  },
  second_wind: {
    name: 'Second Wind',
    remaining: 2,
    max: 2,
    reset: 'long_rest',
    recover_on_short_rest: 1,
  },
  action_surge: {
    name: 'Action Surge',
    remaining: 1,
    max: 1,
    reset: 'short_rest',
  },
  lay_on_hands: {
    name: 'Lay on Hands',
    reset: 'long_rest',
    unit: 'HP',
  },
  paladins_smite: {
    name: "Paladin's Smite",
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  },
  bardic_inspiration: {
    name: 'Bardic Inspiration',
    reset: 'long_rest',
    die: '1d6',
  },
  channel_divinity: {
    name: 'Channel Divinity',
    remaining: 2,
    max: 2,
    reset: 'short_rest',
  },
  wild_shape: {
    name: 'Wild Shape',
    remaining: 2,
    max: 2,
    reset: 'short_rest',
  },
  focus_points: {
    name: 'Focus Points',
    reset: 'short_rest',
  },
  uncanny_metabolism: {
    name: 'Uncanny Metabolism',
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  },
  innate_sorcery: {
    name: 'Innate Sorcery',
    remaining: 2,
    max: 2,
    reset: 'long_rest',
  },
  sorcery_points: {
    name: 'Sorcery Points',
    remaining: 2,
    max: 2,
    reset: 'long_rest',
  },
  magical_cunning: {
    name: 'Magical Cunning',
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  },
  arcane_recovery: {
    name: 'Arcane Recovery',
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  },
  healing_hands: {
    name: 'Healing Hands',
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  },
  relentless_endurance: {
    name: 'Relentless Endurance',
    remaining: 1,
    max: 1,
    reset: 'long_rest',
  },
  adrenaline_rush: {
    name: 'Adrenaline Rush',
    reset: 'short_rest',
  },
  breath_weapon: {
    name: 'Breath Weapon',
    reset: 'long_rest',
  },
  stonecunning: {
    name: 'Stonecunning',
    reset: 'long_rest',
  },
  giant_ancestry: {
    name: 'Giant Ancestry',
    reset: 'long_rest',
  },
};

function buildResourceState(characterSheet = {}, worldState = {}) {
  const sheetResources = characterSheet.resources || {};
  const worldResources = worldState.player_stats?.resources || {};
  const proficiency = getProficiencyBonus(characterSheet);
  const resources = {
    ...cloneResourceBlock(sheetResources),
    ...cloneResourceBlock(worldResources),
  };

  if (!resources.heroic_inspiration && (hasHumanResourceful(characterSheet) || worldResources.heroic_inspiration)) {
    resources.heroic_inspiration = {
      ...RESOURCE_DEFINITIONS.heroic_inspiration,
      remaining: Number(worldResources.heroic_inspiration?.remaining ?? sheetResources.heroic_inspiration?.remaining ?? 0),
      max: 1,
    };
  }

  if (hasOriginFeat(characterSheet, 'lucky') || worldResources.luck_points) {
    resources.luck_points = {
      ...RESOURCE_DEFINITIONS.luck_points,
      remaining: Number(worldResources.luck_points?.remaining ?? sheetResources.luck_points?.remaining ?? proficiency),
      max: Number(worldResources.luck_points?.max ?? sheetResources.luck_points?.max ?? proficiency),
    };
  }

  if (sheetResources.spell_uses && !resources.spell_uses) {
    resources.spell_uses = cloneResourceBlock(sheetResources.spell_uses);
  }

  applyClassResourceDefaults(resources, characterSheet, worldResources, sheetResources);
  applySpeciesResourceDefaults(resources, characterSheet, worldResources, sheetResources);

  return resources;
}

function getAutoD20RerollRules(characterSheet = {}) {
  const rules = [];
  if (isSpecies(characterSheet, 'halfling')) {
    rules.push({
      id: 'halfling_luck',
      source: 'Halfling Luck',
      trigger: 'natural_1',
    });
  }
  return rules;
}

function getPendingRollResourceIntent(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\b(?:use|spend|burn)\s+(?:my\s+)?heroic\s+inspiration\b|\bheroic\s+inspiration\b/.test(text)) {
    return { resource: 'heroic_inspiration' };
  }
  if (/\b(?:use|spend|burn)\s+(?:my\s+)?luck(?:y| point| points)?\b|\blucky\b/.test(text)) {
    return { resource: 'luck_points' };
  }
  return null;
}

function applyPendingRollResourceIntent({ message, worldState = {}, characterSheet = {} } = {}) {
  const intent = getPendingRollResourceIntent(message);
  if (!intent || !worldState.pending_roll) return null;

  if (intent.resource === 'heroic_inspiration') {
    return primeHeroicInspiration({ worldState, characterSheet });
  }

  if (intent.resource === 'luck_points') {
    return primeLuckyReroll({ worldState, characterSheet });
  }

  return null;
}

function primeHeroicInspiration({ worldState = {}, characterSheet = {} } = {}) {
  const spent = spendResource({ worldState, characterSheet, resource: 'heroic_inspiration' });
  if (!spent.ok) {
    return {
      handled: true,
      logType: 'referee_resource_unavailable',
      worldState,
      reply: 'You do not currently have Heroic Inspiration to spend. The heroic part is still encouraged, but the reroll coupon is absent.',
    };
  }

  const pending = addRerollRule(worldState.pending_roll, {
    id: 'heroic_inspiration',
    source: 'Heroic Inspiration',
    trigger: 'failed_total',
    consumed_resource: 'heroic_inspiration',
  });

  return {
    handled: true,
    logType: 'referee_resource_primed',
    worldState: {
      ...spent.worldState,
      pending_roll: pending,
    },
    reply: `Heroic Inspiration is primed for this ${pending.label || pending.kind || 'roll'}. If the d20 test fails, the server will reroll the d20 and use the new roll. ${rollTagForPendingResource(pending)}`,
  };
}

function primeLuckyReroll({ worldState = {}, characterSheet = {} } = {}) {
  if (!hasOriginFeat(characterSheet, 'lucky')) {
    return {
      handled: true,
      logType: 'referee_resource_unavailable',
      worldState,
      reply: 'Lucky is not on this character sheet. Fate checks the feat list and declines to accept a resource left behind by somebody else.',
    };
  }
  const spent = spendResource({ worldState, characterSheet, resource: 'luck_points' });
  if (!spent.ok) {
    return {
      handled: true,
      logType: 'referee_resource_unavailable',
      worldState,
      reply: 'You do not have a Luck Point available for this roll. Fate checks its pockets and finds lint.',
    };
  }

  const pending = addAdvantageSource(worldState.pending_roll, 'Lucky');

  return {
    handled: true,
    logType: 'referee_resource_primed',
    worldState: {
      ...spent.worldState,
      pending_roll: pending,
    },
    reply: `Lucky is applied to this ${pending.label || pending.kind || 'roll'}. Roll with ${pending.advantage_mode || 'normal resolution'}${pending.advantage_mode ? '' : ' because existing Disadvantage cancels the Advantage'}. ${rollTagForPendingResource(pending)}`,
  };
}

function addAdvantageSource(pending = {}, source) {
  const current = pending.advantage_mode || null;
  const mode = current === 'disadvantage' ? null : 'advantage';
  return {
    ...pending,
    advantage_mode: mode,
    advantage_sources: [...new Set([...(pending.advantage_sources || []), source])],
  };
}

function spendResource({ worldState = {}, characterSheet = {}, resource, amount = 1 } = {}) {
  const resources = buildResourceState(characterSheet, worldState);
  const entry = resources[resource];
  const remaining = Number(entry?.remaining || 0);
  if (!entry || remaining < amount) {
    return { ok: false, worldState, resources };
  }

  const nextEntry = {
    ...entry,
    remaining: Math.max(0, remaining - amount),
  };
  const nextResources = {
    ...resources,
    [resource]: nextEntry,
  };
  return {
    ok: true,
    resource: nextEntry,
    resources: nextResources,
    worldState: mergeWorldResources(worldState, nextResources),
  };
}

function completeLongRestResources({ characterSheet = {}, worldState = {} } = {}) {
  const resources = buildResourceState(characterSheet, worldState);
  const notes = [];

  for (const [key, resource] of Object.entries(resources)) {
    if (isCounterResource(resource) && ['long_rest', 'short_rest'].includes(resource.reset)) {
      resources[key] = {
        ...resource,
        remaining: Number(resource.max ?? 1),
      };
    }
  }

  if (hasHumanResourceful(characterSheet)) {
    resources.heroic_inspiration = {
      ...RESOURCE_DEFINITIONS.heroic_inspiration,
      remaining: 1,
      max: 1,
    };
    notes.push('Human Resourceful grants Heroic Inspiration.');
  }

  if (resources.luck_points) {
    resources.luck_points = {
      ...resources.luck_points,
      remaining: Number(resources.luck_points.max || getProficiencyBonus(characterSheet)),
    };
    notes.push('Luck Points reset.');
  }

  if (resources.spell_uses) {
    resources.spell_uses = Object.fromEntries(Object.entries(resources.spell_uses).map(([key, use]) => [
      key,
      resetResourceUse(use, 'long_rest'),
    ]));
  }

  return { resources, notes };
}

function completeShortRestResources({ characterSheet = {}, worldState = {} } = {}) {
  const resources = buildResourceState(characterSheet, worldState);
  const notes = [];
  const classId = normalizeId(characterSheet.identity?.class || characterSheet.identity?.class_name);
  const level = getCharacterLevel(characterSheet);
  if (classId === 'bard' && level >= 5 && resources.bardic_inspiration) {
    resources.bardic_inspiration = {
      ...resources.bardic_inspiration,
      die: '1d8',
      reset: 'short_rest',
    };
  }
  for (const [key, resource] of Object.entries(resources)) {
    if (!isCounterResource(resource)) continue;
    if (resource.reset === 'short_rest') {
      resources[key] = resetResourceUse(resource, 'short_rest');
      notes.push(`${resource.name || titleCase(key)} resets.`);
    } else if (Number(resource.recover_on_short_rest || 0) > 0) {
      const before = Number(resource.remaining || 0);
      const after = Math.min(Number(resource.max || before), before + Number(resource.recover_on_short_rest || 0));
      resources[key] = { ...resource, remaining: after };
      if (after > before) notes.push(`${resource.name || titleCase(key)} recovers ${after - before} use.`);
    }
  }

  if (resources.spell_uses) {
    resources.spell_uses = Object.fromEntries(Object.entries(resources.spell_uses).map(([key, use]) => [
      key,
      resetResourceUse(use, 'short_rest'),
    ]));
  }
  if (classId === 'sorcerer' && level >= 5 && resources.sorcerous_restoration && resources.sorcery_points) {
    const available = Number(resources.sorcerous_restoration.remaining || 0);
    const missing = Math.max(0, Number(resources.sorcery_points.max || level) - Number(resources.sorcery_points.remaining || 0));
    const restored = Math.min(2, missing);
    if (available > 0 && restored > 0) {
      resources.sorcerous_restoration = { ...resources.sorcerous_restoration, remaining: available - 1 };
      resources.sorcery_points = { ...resources.sorcery_points, remaining: Number(resources.sorcery_points.remaining || 0) + restored };
      notes.push(`Sorcerous Restoration recovers ${restored} Sorcery Point${restored === 1 ? '' : 's'}.`);
    }
  }
  return { resources, notes };
}

function resetResourceUse(use = {}, restType) {
  if (use.reset !== restType) return use;
  return {
    ...use,
    remaining: Number(use.max ?? 1),
  };
}

function applyClassResourceDefaults(resources, characterSheet = {}, worldResources = {}, sheetResources = {}) {
  const classId = normalizeId(characterSheet.identity?.class);
  const level = getCharacterLevel(characterSheet);
  const abilityMods = characterSheet.abilities?.modifiers || {};
  const defaults = {};

  if (classId === 'barbarian') defaults.rage = {
    ...RESOURCE_DEFINITIONS.rage,
    remaining: level >= 3 ? 3 : 2,
    max: level >= 3 ? 3 : 2,
    recover_on_short_rest: 1,
  };
  if (classId === 'fighter') {
    defaults.second_wind = RESOURCE_DEFINITIONS.second_wind;
    if (level >= 2) defaults.action_surge = RESOURCE_DEFINITIONS.action_surge;
  }
  if (classId === 'paladin') {
    const max = level * 5;
    defaults.lay_on_hands = { ...RESOURCE_DEFINITIONS.lay_on_hands, remaining: max, max };
    if (level >= 2) defaults.paladins_smite = RESOURCE_DEFINITIONS.paladins_smite;
  }
  if (classId === 'bard') {
    const max = Math.max(1, Number(abilityMods.cha || 0));
    defaults.bardic_inspiration = {
      ...RESOURCE_DEFINITIONS.bardic_inspiration,
      remaining: max,
      max,
      ...(level >= 5 ? { die: '1d8', reset: 'short_rest' } : {}),
    };
  }
  if (classId === 'cleric' && level >= 2) defaults.channel_divinity = RESOURCE_DEFINITIONS.channel_divinity;
  if (classId === 'druid' && level >= 2) defaults.wild_shape = RESOURCE_DEFINITIONS.wild_shape;
  if (classId === 'monk' && level >= 2) {
    defaults.focus_points = { ...RESOURCE_DEFINITIONS.focus_points, remaining: level, max: level };
    defaults.uncanny_metabolism = RESOURCE_DEFINITIONS.uncanny_metabolism;
  }
  if (classId === 'sorcerer') {
    defaults.innate_sorcery = RESOURCE_DEFINITIONS.innate_sorcery;
    if (level >= 2) defaults.sorcery_points = { ...RESOURCE_DEFINITIONS.sorcery_points, remaining: level, max: level };
    if (level >= 5) defaults.sorcerous_restoration = { name: 'Sorcerous Restoration', remaining: 1, max: 1, reset: 'long_rest' };
  }
  if (classId === 'warlock' && level >= 2) defaults.magical_cunning = RESOURCE_DEFINITIONS.magical_cunning;
  if (classId === 'wizard') defaults.arcane_recovery = RESOURCE_DEFINITIONS.arcane_recovery;

  for (const [key, definition] of Object.entries(defaults)) {
    if (resources[key]) continue;
    resources[key] = {
      ...definition,
      remaining: Number(worldResources[key]?.remaining ?? sheetResources[key]?.remaining ?? definition.remaining ?? definition.max ?? 0),
      max: Number(worldResources[key]?.max ?? sheetResources[key]?.max ?? definition.max ?? definition.remaining ?? 0),
    };
  }
}

function applySpeciesResourceDefaults(resources, characterSheet = {}, worldResources = {}, sheetResources = {}) {
  const speciesId = normalizeId(characterSheet.identity?.species);
  const proficiency = getProficiencyBonus(characterSheet);
  const defaults = {};

  if (speciesId === 'celestial_touched') {
    defaults.healing_hands = { ...RESOURCE_DEFINITIONS.healing_hands, dice: `${proficiency}d4` };
  }
  if (speciesId === 'orc') {
    defaults.adrenaline_rush = { ...RESOURCE_DEFINITIONS.adrenaline_rush, remaining: proficiency, max: proficiency };
    defaults.relentless_endurance = RESOURCE_DEFINITIONS.relentless_endurance;
  }
  if (speciesId === 'dragonborn') {
    defaults.breath_weapon = { ...RESOURCE_DEFINITIONS.breath_weapon, remaining: proficiency, max: proficiency };
  }
  if (speciesId === 'dwarf') {
    defaults.stonecunning = { ...RESOURCE_DEFINITIONS.stonecunning, remaining: proficiency, max: proficiency };
  }
  if (speciesId === 'goliath') {
    defaults.giant_ancestry = { ...RESOURCE_DEFINITIONS.giant_ancestry, remaining: proficiency, max: proficiency };
  }
  if (speciesId === 'gnome' && normalizeId(characterSheet.species_choices?.gnomish_lineage) === 'forest') {
    const key = 'species_spell:Forest Gnome:speak_with_animals';
    const current = resources.spell_uses?.[key];
    resources.spell_uses = {
      ...(resources.spell_uses || {}),
      [key]: current || {
        name: 'Speak with Animals',
        spell_id: 'speak_with_animals',
        source: 'Forest Gnome',
        source_name: 'Forest Gnome',
        remaining: proficiency,
        max: proficiency,
        reset: 'long_rest',
      },
    };
  }

  for (const [key, definition] of Object.entries(defaults)) {
    if (resources[key]) continue;
    resources[key] = {
      ...definition,
      remaining: Number(worldResources[key]?.remaining ?? sheetResources[key]?.remaining ?? definition.remaining ?? definition.max ?? 0),
      max: Number(worldResources[key]?.max ?? sheetResources[key]?.max ?? definition.max ?? definition.remaining ?? 0),
    };
  }
}

function isCounterResource(value = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.remaining !== undefined && value.max !== undefined;
}

function getCharacterLevel(characterSheet = {}) {
  return Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
}

function titleCase(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function addRerollRule(pending = {}, rule) {
  const existing = pending.reroll_rules || [];
  if (existing.some((item) => item.id === rule.id)) return pending;
  return {
    ...pending,
    reroll_rules: [...existing, rule],
  };
}

function mergeWorldResources(worldState = {}, resources = {}) {
  return {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      resources,
    },
  };
}

function hasHumanResourceful(characterSheet = {}) {
  return isSpecies(characterSheet, 'human')
    && (characterSheet.features || []).some((feature) => normalizeId(feature.name) === 'resourceful');
}

function isSpecies(characterSheet = {}, speciesId) {
  return normalizeId(characterSheet.identity?.species) === speciesId;
}

function hasOriginFeat(characterSheet = {}, featId) {
  const origin = characterSheet.origin || {};
  return normalizeId(origin.background_feat) === featId
    || normalizeId(origin.human_origin_feat) === featId
    || (characterSheet.features || []).some((feature) => normalizeId(feature.name) === featId);
}

function getProficiencyBonus(characterSheet = {}) {
  const level = Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  return Number(characterSheet.derived_stats?.proficiency_bonus || Math.floor((level - 1) / 4) + 2);
}

function cloneResourceBlock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function rollTagForPendingResource(pending = {}) {
  const idPart = pending.id ? `id=${pending.id} ` : '';
  if (pending.kind === 'saving_throw' || pending.kind === 'concentration_save') {
    return `[SAVE: ${idPart}ability=${pending.ability || 'con'} modifier=${Number(pending.modifier || 0)}]`;
  }
  if (pending.kind === 'skill_check' || pending.kind === 'ability_check') {
    return `[CHECK: ${idPart}${pending.skill ? `skill=${pending.skill} ` : ''}ability=${pending.ability || 'str'} modifier=${Number(pending.modifier || 0)}]`;
  }
  return `[ROLL: ${idPart}${pending.formula || '1d20'}]`;
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  buildResourceState,
  getAutoD20RerollRules,
  getPendingRollResourceIntent,
  applyPendingRollResourceIntent,
  spendResource,
  completeLongRestResources,
  completeShortRestResources,
  mergeWorldResources,
};
