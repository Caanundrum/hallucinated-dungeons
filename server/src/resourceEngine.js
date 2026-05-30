const { getContentBundle } = require('./contentData');

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
  const spent = spendResource({ worldState, characterSheet, resource: 'luck_points' });
  if (!spent.ok) {
    return {
      handled: true,
      logType: 'referee_resource_unavailable',
      worldState,
      reply: 'You do not have a Luck Point available for this roll. Fate checks its pockets and finds lint.',
    };
  }

  const pending = addRerollRule(worldState.pending_roll, {
    id: 'lucky',
    source: 'Lucky',
    trigger: 'failed_total',
    consumed_resource: 'luck_points',
  });

  return {
    handled: true,
    logType: 'referee_resource_primed',
    worldState: {
      ...spent.worldState,
      pending_roll: pending,
    },
    reply: `Lucky is primed for this ${pending.label || pending.kind || 'roll'}. If the d20 test fails, the server will reroll the d20 and use the new roll. ${rollTagForPendingResource(pending)}`,
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
  if (resources.spell_uses) {
    resources.spell_uses = Object.fromEntries(Object.entries(resources.spell_uses).map(([key, use]) => [
      key,
      resetResourceUse(use, 'short_rest'),
    ]));
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
