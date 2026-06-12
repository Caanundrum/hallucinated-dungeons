const {
  grantActionSurgeAction,
  spendTurnResource,
} = require('./actionEconomy');
const { rollDie } = require('./dice');
const {
  buildResourceState,
  mergeWorldResources,
  spendResource,
} = require('./resourceEngine');
const {
  applyActiveEffectsToWorldState,
} = require('./spellEffectEngine');
const {
  applyHealing,
  rollDamageFormula,
} = require('./damageHealingEngine');
const { assertValidRulesEffects } = require('./refereeContracts');

function resolveFeatureAction({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  const intent = getFeatureIntent(message);
  if (!intent) return null;

  if (intent.id === 'rage') return resolveRage({ worldState, characterSheet });
  if (intent.id === 'action_surge') return resolveActionSurge({ worldState, characterSheet });
  if (intent.id === 'second_wind') return resolveSecondWind({ worldState, characterSheet, rollDie });
  if (intent.id === 'lay_on_hands') return resolveLayOnHands({ message, worldState, characterSheet });
  if (intent.id === 'innate_sorcery') return resolveInnateSorcery({ worldState, characterSheet });
  if (intent.id === 'bardic_inspiration') return resolveBardicInspiration({ message, worldState, characterSheet });
  if (intent.id === 'arcane_recovery') {
    return {
      handled: true,
      logType: 'feature_arcane_recovery_rest_required',
      worldState,
      reply: 'Arcane Recovery happens when you finish a Short Rest. Take a Short Rest and the referee will restore an eligible expended spell slot automatically if the resource is available.',
    };
  }

  return null;
}

function getFeatureIntent(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\b(?:enter|use|start|activate|go into)?\s*rage\b/.test(text)) return { id: 'rage' };
  if (/\baction\s+surge\b/.test(text)) return { id: 'action_surge' };
  if (/\bsecond\s+wind\b/.test(text)) return { id: 'second_wind' };
  if (/\blay\s+on\s+hands\b/.test(text)) return { id: 'lay_on_hands' };
  if (/\binnate\s+sorcery\b/.test(text)) return { id: 'innate_sorcery' };
  if (/\bbardic\s+inspiration\b/.test(text)) return { id: 'bardic_inspiration' };
  if (/\barcane\s+recovery\b/.test(text)) return { id: 'arcane_recovery' };
  return null;
}

function resolveActionSurge({ worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'fighter')) return wrongClass('Action Surge', 'Fighter', worldState);
  if (getCharacterLevel(characterSheet) < 2) {
    return {
      handled: true,
      logType: 'feature_action_surge_level_required',
      worldState,
      reply: 'Action Surge is a level 2 Fighter feature. At level 1, the tactical lightning has not been installed yet.',
    };
  }

  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources.action_surge?.remaining || 0) <= 0) {
    return {
      handled: true,
      logType: 'feature_action_surge_unavailable',
      worldState: mergeWorldResources(worldState, resources),
      reply: 'Action Surge has no uses left until a Short or Long Rest restores it.',
    };
  }

  const surged = grantActionSurgeAction(worldState, characterSheet);
  if (!surged.ok) {
    return {
      handled: true,
      logType: 'feature_action_surge_unavailable',
      worldState: surged.worldState,
      reply: surged.reply,
    };
  }

  const spent = spendResource({ worldState: surged.worldState, characterSheet, resource: 'action_surge' });
  return {
    handled: true,
    logType: 'feature_action_surge',
    worldState: spent.worldState,
    reply: `You use **Action Surge** and gain one extra action this turn. The extra action cannot be the Magic action. Uses left: ${remainingResourceText(spent.worldState, characterSheet, 'action_surge')}.`,
  };
}

function resolveRage({ worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'barbarian')) return wrongClass('Rage', 'Barbarian', worldState);
  if (hasActiveEffect(worldState, 'rage')) {
    return {
      handled: true,
      logType: 'feature_rage_already_active',
      worldState,
      reply: 'Rage is already active. The fury drawer is open; no need to open a second fury drawer.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Rage', resource: 'rage' });
  if (!spent.ok) return spent.result;

  const effect = {
    id: 'rage',
    name: 'Rage',
    source: actorName(characterSheet, spent.worldState),
    source_type: 'class_feature',
    target: actorName(characterSheet, spent.worldState),
    duration: 'up to 10 minutes',
    concentration: false,
    remaining_minutes: 10,
    remaining_rounds: 100,
    mechanical_effect: 'Physical damage resistance, advantage on Strength tests, and extra Strength-based weapon damage while active.',
    rules_effects: [
      { target: 'damage_resistance', damage_types: ['bludgeoning', 'piercing', 'slashing'], label: 'Rage' },
      { target: 'ability_check_advantage', ability: 'str', label: 'Rage' },
      { target: 'saving_throw_advantage', ability: 'str', label: 'Rage' },
      { target: 'weapon_damage_bonus', value: 2, ability: 'str', label: 'Rage' },
    ],
  };
  const nextState = addOrReplaceFeatureEffect(spent.worldState, effect, characterSheet);

  return {
    handled: true,
    logType: 'feature_rage',
    worldState: nextState,
    reply: `You enter **Rage** as a Bonus Action. You gain physical damage resistance, Strength advantage, and +2 damage on Strength-based weapon attacks while it lasts. Rage uses left: ${remainingResourceText(nextState, characterSheet, 'rage')}.`,
  };
}

function resolveSecondWind({ worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  if (!isClass(characterSheet, 'fighter')) return wrongClass('Second Wind', 'Fighter', worldState);
  const missingHp = getMissingHp(worldState, characterSheet);
  if (missingHp <= 0) {
    return {
      handled: true,
      logType: 'feature_second_wind_full_hp',
      worldState: mergeWorldResources(worldState, buildResourceState(characterSheet, worldState)),
      reply: 'You are already at full HP, so **Second Wind** would not restore anything. No use is spent; save the heroic inhale for when something has actually dented you.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Second Wind', resource: 'second_wind' });
  if (!spent.ok) return spent.result;

  const level = getCharacterLevel(characterSheet);
  const healingRoll = rollDamageFormula(`1d10+${level}`, rollDie);
  const healed = healActiveCharacter(spent.worldState, characterSheet, healingRoll.total);

  return {
    handled: true,
    logType: 'feature_second_wind',
    worldState: healed.worldState,
    reply: `You use **Second Wind** as a Bonus Action and regain ${healed.applied} HP (${healingRoll.rolls.join(' + ')} + ${level}). HP: ${healed.beforeHp} -> ${healed.afterHp}. Uses left: ${remainingResourceText(healed.worldState, characterSheet, 'second_wind')}.`,
  };
}

function resolveLayOnHands({ message = '', worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'paladin')) return wrongClass('Lay on Hands', 'Paladin', worldState);
  if (targetsSomeoneElse(message)) {
    return {
      handled: true,
      logType: 'feature_lay_on_hands_target_needed',
      worldState,
      reply: 'Lay on Hands can heal another creature, but this phase only has deterministic HP tracking for the active character. Use it on yourself for now, or wait for party/map targeting before healing someone else without making the rules wear a fake mustache.',
    };
  }

  const resources = buildResourceState(characterSheet, worldState);
  const pool = Number(resources.lay_on_hands?.remaining || 0);
  const missingHp = getMissingHp(worldState, characterSheet);
  const requested = parseHealingAmount(message) || missingHp || Math.min(pool, 1);
  const amount = Math.min(pool, Math.max(0, requested), Math.max(1, missingHp || requested));
  if (amount <= 0 || pool <= 0) {
    return {
      handled: true,
      logType: 'feature_lay_on_hands_unavailable',
      worldState: mergeWorldResources(worldState, resources),
      reply: pool <= 0
        ? 'Lay on Hands has no healing pool left until a Long Rest.'
        : 'You are already at full HP, so Lay on Hands has nothing useful to patch. Very tidy of you.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Lay on Hands', resource: 'lay_on_hands', amount });
  if (!spent.ok) return spent.result;

  const healed = healActiveCharacter(spent.worldState, characterSheet, amount);
  return {
    handled: true,
    logType: 'feature_lay_on_hands',
    worldState: healed.worldState,
    reply: `You use **Lay on Hands** as a Bonus Action and restore ${healed.applied} HP. HP: ${healed.beforeHp} -> ${healed.afterHp}. Healing pool left: ${remainingResourceText(healed.worldState, characterSheet, 'lay_on_hands')} HP.`,
  };
}

function resolveInnateSorcery({ worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'sorcerer')) return wrongClass('Innate Sorcery', 'Sorcerer', worldState);
  if (hasActiveEffect(worldState, 'innate_sorcery')) {
    return {
      handled: true,
      logType: 'feature_innate_sorcery_already_active',
      worldState,
      reply: 'Innate Sorcery is already active. The magic is awake and making eye contact.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Innate Sorcery', resource: 'innate_sorcery' });
  if (!spent.ok) return spent.result;

  const effect = {
    id: 'innate_sorcery',
    name: 'Innate Sorcery',
    source: actorName(characterSheet, spent.worldState),
    source_type: 'class_feature',
    target: actorName(characterSheet, spent.worldState),
    duration: '1 minute',
    concentration: false,
    remaining_minutes: 1,
    remaining_rounds: 10,
    mechanical_effect: 'Sorcerer spell save DC increases by 1 and Sorcerer spell attacks have advantage.',
    rules_effects: [
      { target: 'spell_save_dc_bonus', class_id: 'sorcerer', value: 1, label: 'Innate Sorcery' },
      { target: 'spell_attack_advantage', class_id: 'sorcerer', label: 'Innate Sorcery' },
    ],
  };
  const nextState = addOrReplaceFeatureEffect(spent.worldState, effect, characterSheet);

  return {
    handled: true,
    logType: 'feature_innate_sorcery',
    worldState: nextState,
    reply: `You activate **Innate Sorcery** as a Bonus Action. For 1 minute, your Sorcerer spell save DC is +1 and your Sorcerer spell attacks have Advantage. Uses left: ${remainingResourceText(nextState, characterSheet, 'innate_sorcery')}.`,
  };
}

function resolveBardicInspiration({ message = '', worldState = {}, characterSheet = {} } = {}) {
  if (!isClass(characterSheet, 'bard')) return wrongClass('Bardic Inspiration', 'Bard', worldState);
  const target = inferBardicTarget(message, worldState);
  if (!target || isSelfTarget(target, characterSheet, worldState)) {
    return {
      handled: true,
      logType: 'feature_bardic_inspiration_target_needed',
      worldState,
      reply: 'Bardic Inspiration needs another creature you can inspire. Name an ally or NPC present in the scene; inspiring yourself is still handled by confidence, snacks, and questionable theater, not this feature.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Bardic Inspiration', resource: 'bardic_inspiration' });
  if (!spent.ok) return spent.result;

  const effect = {
    id: `bardic_inspiration_${normalizeId(target)}`,
    name: 'Bardic Inspiration',
    source: actorName(characterSheet, spent.worldState),
    source_type: 'class_feature',
    target,
    duration: '1 hour',
    concentration: false,
    remaining_minutes: 60,
    remaining_rounds: 600,
    mechanical_effect: 'Another creature can add the Bardic Inspiration die to a failed D20 Test if it can turn the roll into a success.',
    rules_effects: [
      { target: 'bardic_inspiration_die', die: '1d6', label: 'Bardic Inspiration', target_bound: true },
    ],
  };
  const nextState = addOrReplaceFeatureEffect(spent.worldState, effect, characterSheet);
  return {
    handled: true,
    logType: 'feature_bardic_inspiration',
    worldState: nextState,
    reply: `You grant **Bardic Inspiration** to ${target} as a Bonus Action. They carry a d6 that can help a failed d20 test if it is enough to matter. Uses left: ${remainingResourceText(nextState, characterSheet, 'bardic_inspiration')}.`,
  };
}

function spendFeatureCost({ worldState = {}, characterSheet = {}, actionResource, actionLabel, resource, amount = 1 } = {}) {
  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources[resource]?.remaining || 0) < Number(amount || 1)) {
    return {
      ok: false,
      result: {
        handled: true,
        logType: 'feature_resource_unavailable',
        worldState: mergeWorldResources(worldState, resources),
        reply: `${actionLabel} is not available right now; the resource is spent until the appropriate rest restores it.`,
      },
    };
  }

  const spentAction = spendTurnResource(worldState, actionResource, actionLabel, characterSheet);
  if (!spentAction.ok) {
    return {
      ok: false,
      result: {
        handled: true,
        logType: 'feature_action_unavailable',
        worldState: spentAction.worldState,
        reply: spentAction.reply,
      },
    };
  }

  const spentResource = spendResource({ worldState: spentAction.worldState, characterSheet, resource, amount });
  return { ok: true, worldState: spentResource.worldState };
}

function healActiveCharacter(worldState = {}, characterSheet = {}, amount = 0) {
  const stats = worldState.player_stats || {};
  const combat = worldState.combat_state?.active ? cloneCombat(worldState.combat_state) : worldState.combat_state;
  const player = combat?.active ? combat.combatants.find((combatant) => combatant.is_player) : null;
  const maxHp = Number(player?.max_hp ?? stats.max_hp ?? characterSheet.derived_stats?.max_hp ?? stats.hp ?? 1);
  const target = player || {
    hp: stats.hp ?? characterSheet.derived_stats?.hp ?? maxHp,
    max_hp: maxHp,
  };
  const healed = applyHealing({ target, amount, maxHp });
  if (player) Object.assign(player, healed.target);

  return {
    ...healed,
    worldState: {
      ...worldState,
      combat_state: combat,
      player_stats: {
        ...stats,
        hp: healed.target.hp,
        max_hp: healed.target.max_hp,
      },
    },
  };
}

function addOrReplaceFeatureEffect(worldState = {}, effect, characterSheet = {}) {
  assertValidRulesEffects(effect.rules_effects || [], `rules effects for ${effect.id || 'class feature'}`);
  const activeEffects = Array.isArray(worldState.active_effects) ? worldState.active_effects : [];
  const retained = activeEffects.filter((item) => item.id !== effect.id);
  return applyActiveEffectsToWorldState(worldState, [...retained, effect], characterSheet);
}

function hasActiveEffect(worldState = {}, effectId) {
  return (worldState.active_effects || []).some((effect) => effect.id === effectId);
}

function remainingResourceText(worldState = {}, characterSheet = {}, resource) {
  const resources = buildResourceState(characterSheet, worldState);
  return String(Number(resources[resource]?.remaining || 0));
}

function parseHealingAmount(message = '') {
  const match = String(message || '').match(/\b(?:heal|restore|spend|use)\s+(\d+)\b|\b(\d+)\s*(?:hp|hit points?)\b/i);
  return Number(match?.[1] || match?.[2] || 0);
}

function getMissingHp(worldState = {}, characterSheet = {}) {
  const stats = worldState.player_stats || {};
  const hp = Number(stats.hp ?? characterSheet.derived_stats?.hp ?? characterSheet.derived_stats?.max_hp ?? 0);
  const maxHp = Number(stats.max_hp ?? characterSheet.derived_stats?.max_hp ?? hp);
  return Math.max(0, maxHp - hp);
}

function targetsSomeoneElse(message = '') {
  const text = String(message || '').toLowerCase();
  return /\b(?:on|to|heal)\s+(?:the\s+|a\s+|an\s+)?(guard|clerk|ally|friend|companion|npc|boy|girl|woman|man|reeve|innkeeper|priest)\b/.test(text)
    && !/\b(?:myself|me|self)\b/.test(text);
}

function inferBardicTarget(message = '', worldState = {}) {
  const match = String(message || '').match(/\b(?:inspire|bardic inspiration (?:to|on|for)|give bardic inspiration to)\s+(?:the\s+|a\s+|an\s+|my\s+|our\s+)?([a-z][a-z' -]{1,40}?)(?:[.!?]|$|\s+(?:with|before|after|and|while|because)\b)/i);
  if (match?.[1]) return cleanTargetName(match[1]);
  const present = [
    ...(worldState.scene_presence?.present_npcs || []),
    ...(worldState.scene_presence?.present_characters || []),
  ].filter(Boolean);
  return present.length === 1 ? present[0] : '';
}

function isSelfTarget(target = '', characterSheet = {}, worldState = {}) {
  const normalized = normalizeId(target);
  return ['self', 'me', 'myself', 'you'].includes(normalized)
    || normalized === normalizeId(actorName(characterSheet, worldState));
}

function wrongClass(feature, className, worldState = {}) {
  return {
    handled: true,
    logType: 'feature_wrong_class',
    worldState,
    reply: `${feature} is a ${className} feature and is not on this character sheet. The referee checked the pockets twice.`,
  };
}

function isClass(characterSheet = {}, classId) {
  return normalizeId(characterSheet.identity?.class || characterSheet.identity?.class_name) === classId;
}

function getCharacterLevel(characterSheet = {}) {
  return Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
}

function actorName(characterSheet = {}, worldState = {}) {
  return characterSheet.identity?.name || worldState.player_stats?.name || 'You';
}

function cloneCombat(combatState = {}) {
  return JSON.parse(JSON.stringify(combatState));
}

function cleanTargetName(value = '') {
  return String(value || '')
    .replace(/\b(?:the|a|an|my|our)\b/gi, '')
    .trim();
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function defaultRollDie(sides) {
  return rollDie(sides);
}

module.exports = {
  getFeatureIntent,
  resolveFeatureAction,
};
