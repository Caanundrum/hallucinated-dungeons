const { grantMovement, spendTurnResource } = require('./actionEconomy');
const { getContentBundle } = require('./contentData');
const { rollDie } = require('./dice');
const {
  applyDamage,
  applyHealing,
  applyTemporaryHp,
  formatDamageAdjustment,
  rollDamageFormula,
} = require('./damageHealingEngine');
const { resolveSavingThrow } = require('./conditionEngine');
const {
  buildResourceState,
  mergeWorldResources,
  spendResource,
} = require('./resourceEngine');
const { applyActiveEffectsToWorldState } = require('./spellEffectEngine');
const { resolveGiantAncestryAction } = require('./giantAncestryEngine');
const { assertValidRulesEffects } = require('./refereeContracts');

function resolveSpeciesFeatureAction({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  const giantAncestry = resolveGiantAncestryAction({ message, worldState, characterSheet });
  if (giantAncestry) return giantAncestry;

  const intent = getSpeciesFeatureIntent(message);
  if (!intent) return null;

  if (intent.id === 'healing_hands') return resolveHealingHands({ message, worldState, characterSheet, rollDie });
  if (intent.id === 'adrenaline_rush') return resolveAdrenalineRush({ worldState, characterSheet });
  if (intent.id === 'breath_weapon') return resolveBreathWeapon({ message, worldState, characterSheet, rollDie });
  if (intent.id === 'stonecunning') return resolveStonecunning({ worldState, characterSheet });
  return null;
}

function getSpeciesFeatureIntent(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\bhealing\s+hands\b/.test(text)) return { id: 'healing_hands' };
  if (/\badrenaline\s+rush\b/.test(text)) return { id: 'adrenaline_rush' };
  if (/\b(?:breath\s+weapon|breathe?\s+(?:fire|acid|cold|lightning|poison)|draconic\s+breath)\b/.test(text)) return { id: 'breath_weapon' };
  if (/\bstonecunning\b|\b(?:sense|feel|detect)\b.*\b(?:stone|rock|masonry|cobble|ruin)\b/.test(text)) return { id: 'stonecunning' };
  return null;
}

function resolveHealingHands({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  if (!isSpecies(characterSheet, 'celestial_touched')) return wrongSpecies('Healing Hands', 'Celestial-Touched', worldState);
  if (targetsSomeoneElse(message)) {
    return {
      handled: true,
      logType: 'species_healing_hands_target_needed',
      worldState,
      reply: 'Healing Hands can heal another creature, but this phase only tracks deterministic HP for the active character. Use it on yourself for now; party and map targeting are coming before anyone receives healing by vague hand-wave.',
    };
  }

  const currentHp = getActiveCharacterHp(worldState, characterSheet);
  if (currentHp.hp >= currentHp.maxHp) {
    return {
      handled: true,
      logType: 'species_healing_hands_full_hp',
      worldState,
      reply: `Healing Hands is not spent because you are already at full HP (${currentHp.hp}/${currentHp.maxHp}). Celestial power is precious; dramatic hand placement is free.`,
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'action', actionLabel: 'Healing Hands', resource: 'healing_hands' });
  if (!spent.ok) return spent.result;

  const proficiency = getProficiencyBonus(characterSheet);
  const healing = rollDamageFormula(`${proficiency}d4`, rollDie);
  const healed = healActiveCharacter(spent.worldState, characterSheet, healing.total);
  return {
    handled: true,
    logType: 'species_healing_hands',
    worldState: healed.worldState,
    reply: `You use **Healing Hands** as a Magic Action and regain ${healed.applied} HP (${healing.rolls.join(' + ')}). HP: ${healed.beforeHp} -> ${healed.afterHp}. Uses left: ${remainingResourceText(healed.worldState, characterSheet, 'healing_hands')}.`,
  };
}

function resolveAdrenalineRush({ worldState = {}, characterSheet = {} } = {}) {
  if (!isSpecies(characterSheet, 'orc')) return wrongSpecies('Adrenaline Rush', 'Orc', worldState);
  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Adrenaline Rush', resource: 'adrenaline_rush' });
  if (!spent.ok) return spent.result;

  const speed = Number(spent.worldState.player_stats?.speed ?? characterSheet.derived_stats?.speed ?? 30);
  const moved = grantMovement(spent.worldState, speed, 'Adrenaline Rush Dash', characterSheet);
  const temporary = grantTemporaryHpToActiveCharacter(moved.worldState, characterSheet, getProficiencyBonus(characterSheet));
  return {
    handled: true,
    logType: 'species_adrenaline_rush',
    worldState: temporary.worldState,
    reply: `You use **Adrenaline Rush** as a Bonus Action. You Dash and gain ${temporary.afterTempHp} temporary HP. Uses left: ${remainingResourceText(temporary.worldState, characterSheet, 'adrenaline_rush')}.`,
  };
}

function resolveBreathWeapon({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  if (!isSpecies(characterSheet, 'dragonborn')) return wrongSpecies('Breath Weapon', 'Dragonborn', worldState);
  if (!worldState.combat_state?.active) {
    return {
      handled: true,
      logType: 'species_breath_weapon_target_needed',
      worldState,
      reply: 'Breath Weapon needs a creature target in an active encounter. Declare the target once combat begins; the referee is not setting the scenery on fire recreationally.',
    };
  }

  const initialCombat = cloneCombat(worldState.combat_state);
  const initialTarget = findCombatTarget(initialCombat, message);
  if (!initialTarget) {
    return {
      handled: true,
      logType: 'species_breath_weapon_target_needed',
      worldState,
      reply: 'Name a living enemy in the encounter for Breath Weapon. Cone and line area targeting arrive with the map-aware layer; for now the referee needs one honest target.',
    };
  }

  const damageType = getDragonbornDamageType(characterSheet);
  const declaredDamageType = getDeclaredBreathDamageType(message);
  if (declaredDamageType && declaredDamageType !== damageType) {
    return {
      handled: true,
      logType: 'species_breath_weapon_wrong_ancestry',
      worldState,
      reply: `Your Draconic Ancestry produces ${damageType} damage, not ${declaredDamageType}. Breath Weapon is not spent; declare the ${damageType} breath against a present target.`,
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'action', actionLabel: 'Breath Weapon', resource: 'breath_weapon' });
  if (!spent.ok) return spent.result;

  const combat = cloneCombat(spent.worldState.combat_state);
  const target = combat.combatants.find((combatant) => combatant.name === initialTarget.name);
  const dc = 8 + Number(characterSheet.abilities?.modifiers?.con || 0) + getProficiencyBonus(characterSheet);
  const saveBonus = Number(target.saves?.dex ?? target.save_modifiers?.dex ?? target.ability_modifiers?.dex ?? 0);
  const save = resolveSavingThrow({ target, ability: 'dex', dc, rollDie, bonus: saveBonus });
  const damageFormula = getBreathWeaponDamageFormula(characterSheet);
  const damage = rollDamageFormula(damageFormula, rollDie);
  const amount = save.success ? Math.floor(damage.total / 2) : damage.total;
  const applied = applyDamage({ target, amount, damageType, source: 'Breath Weapon' });
  Object.assign(target, applied.target);

  return {
    handled: true,
    consumesTurn: true,
    logType: 'species_breath_weapon',
    worldState: {
      ...spent.worldState,
      combat_state: combat,
    },
    reply: `You replace one attack with **Breath Weapon** against ${target.name}. ${target.name} makes a DEX save: ${save.text} vs DC ${dc}. ${save.success ? 'Success halves the damage.' : 'Failure takes the full blast.'} ${damageFormula} rolls ${damage.total}, becoming ${applied.amount} ${damageType} damage${formatDamageAdjustment(applied.adjustment)}. ${target.name}: (${applied.beforeHp} -> ${applied.afterHp} HP). Uses left: ${remainingResourceText(spent.worldState, characterSheet, 'breath_weapon')}.`,
  };
}

function resolveStonecunning({ worldState = {}, characterSheet = {} } = {}) {
  if (!isSpecies(characterSheet, 'dwarf')) return wrongSpecies('Stonecunning', 'Dwarf', worldState);
  if (!isTouchingStone(worldState)) {
    return {
      handled: true,
      logType: 'species_stonecunning_stone_needed',
      worldState,
      reply: 'Stonecunning needs stone beneath you or within reach. The referee checked the scene and found no suitable stone to interrogate.',
    };
  }

  const spent = spendFeatureCost({ worldState, characterSheet, actionResource: 'bonus_action', actionLabel: 'Stonecunning', resource: 'stonecunning' });
  if (!spent.ok) return spent.result;
  const effect = {
    id: 'stonecunning',
    name: 'Stonecunning',
    source: actorName(characterSheet, spent.worldState),
    source_type: 'species_feature',
    target: actorName(characterSheet, spent.worldState),
    duration: '10 minutes',
    concentration: false,
    remaining_minutes: 10,
    remaining_rounds: 100,
    mechanical_effect: 'Tremorsense out to 60 feet while on or touching stone.',
    rules_effects: [
      { target: 'tremorsense', range: 60, requires_surface: 'stone', label: 'Stonecunning' },
    ],
  };
  const nextState = addOrReplaceFeatureEffect(spent.worldState, effect, characterSheet);
  return {
    handled: true,
    logType: 'species_stonecunning',
    worldState: nextState,
    reply: `You use **Stonecunning** as a Bonus Action. For 10 minutes, you have Tremorsense out to 60 feet while touching stone. Uses left: ${remainingResourceText(nextState, characterSheet, 'stonecunning')}.`,
  };
}

function getSpeciesD20AdvantageSources({ characterSheet = {}, testType = '', ability = '', reason = '' } = {}) {
  if (!['saving_throw', 'concentration_save'].includes(testType)) return [];
  const species = normalizeId(characterSheet.identity?.species);
  const text = String(reason || '').toLowerCase();
  const sources = [];
  if (species === 'gnome' && ['int', 'wis', 'cha'].includes(ability)) sources.push('Gnomish Cunning');
  if (species === 'dwarf' && /\b(?:poison|poisoned|venom|toxin)\b/.test(text)) sources.push('Dwarven Resilience');
  if (species === 'elf' && /\b(?:charm|charmed)\b/.test(text)) sources.push('Fey Ancestry');
  if (species === 'halfling' && /\b(?:fear|frighten|frightened)\b/.test(text)) sources.push('Brave');
  return sources;
}

function spendFeatureCost({ worldState = {}, characterSheet = {}, actionResource, actionLabel, resource, amount = 1 } = {}) {
  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources[resource]?.remaining || 0) < Number(amount || 1)) {
    return {
      ok: false,
      result: {
        handled: true,
        logType: 'species_resource_unavailable',
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
        logType: 'species_action_unavailable',
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
  const target = player || { hp: stats.hp ?? characterSheet.derived_stats?.hp ?? maxHp, max_hp: maxHp };
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

function grantTemporaryHpToActiveCharacter(worldState = {}, characterSheet = {}, amount = 0) {
  const stats = worldState.player_stats || {};
  const combat = worldState.combat_state?.active ? cloneCombat(worldState.combat_state) : worldState.combat_state;
  const player = combat?.active ? combat.combatants.find((combatant) => combatant.is_player) : null;
  const target = player || { temp_hp: stats.temp_hp ?? characterSheet.derived_stats?.temp_hp ?? 0 };
  const temporary = applyTemporaryHp({ target, amount });
  if (player) Object.assign(player, temporary.target);
  return {
    ...temporary,
    worldState: {
      ...worldState,
      combat_state: combat,
      player_stats: {
        ...stats,
        temp_hp: temporary.target.temp_hp,
      },
    },
  };
}

function addOrReplaceFeatureEffect(worldState = {}, effect, characterSheet = {}) {
  assertValidRulesEffects(effect.rules_effects || [], `rules effects for ${effect.id || 'species feature'}`);
  const activeEffects = Array.isArray(worldState.active_effects) ? worldState.active_effects : [];
  return applyActiveEffectsToWorldState(worldState, [...activeEffects.filter((item) => item.id !== effect.id), effect], characterSheet);
}

function remainingResourceText(worldState = {}, characterSheet = {}, resource) {
  return String(Number(buildResourceState(characterSheet, worldState)[resource]?.remaining || 0));
}

function findCombatTarget(combat = {}, message = '') {
  const enemies = (combat.combatants || []).filter((combatant) => !combatant.is_player && Number(combatant.hp) > 0);
  const text = normalizeId(message);
  const namedTarget = enemies.find((enemy) => text.includes(normalizeId(enemy.name)));
  if (namedTarget) return namedTarget;
  if (hasExplicitBreathTarget(message)) return null;
  return enemies.length === 1 ? enemies[0] : null;
}

function hasExplicitBreathTarget(message = '') {
  return /\b(?:at|against|toward|towards|on)\s+(?:the\s+|a\s+|an\s+)?[a-z][a-z '-]*/i.test(String(message || ''));
}

function getDeclaredBreathDamageType(message = '') {
  const match = String(message || '').toLowerCase().match(/\b(?:breathe?|breath(?:\s+weapon)?)\s+(?:of\s+)?(acid|cold|fire|lightning|poison)\b/);
  return match?.[1] || null;
}

function getBreathWeaponDamageFormula(characterSheet = {}) {
  const level = Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  if (level >= 17) return '4d10';
  if (level >= 11) return '3d10';
  if (level >= 5) return '2d10';
  return '1d10';
}

function getActiveCharacterHp(worldState = {}, characterSheet = {}) {
  const player = worldState.combat_state?.active
    ? worldState.combat_state.combatants?.find((combatant) => combatant.is_player)
    : null;
  const maxHp = Number(player?.max_hp ?? worldState.player_stats?.max_hp ?? characterSheet.derived_stats?.max_hp ?? 1);
  return {
    hp: Number(player?.hp ?? worldState.player_stats?.hp ?? characterSheet.derived_stats?.hp ?? maxHp),
    maxHp,
  };
}

function getDragonbornDamageType(characterSheet = {}) {
  const ancestryId = characterSheet.species_choices?.draconic_ancestry;
  const dragonborn = getContentBundle().species.find((species) => species.id === 'dragonborn');
  const ancestry = dragonborn?.choices?.find((choice) => choice.id === 'draconic_ancestry')?.options?.find((option) => option.id === ancestryId);
  return ancestry?.damage_type || 'fire';
}

function isTouchingStone(worldState = {}) {
  return /\b(?:stone|rock|cobble|masonry|ruin|cave|brick)\b/i.test(JSON.stringify({
    scene_presence: worldState.scene_presence,
    current_location: worldState.current_location,
  }));
}

function targetsSomeoneElse(message = '') {
  const text = String(message || '');
  if (/\b(?:myself|me|self)\b/i.test(text)) return false;
  return /\b(?:on|to|heal)\s+(?:the\s+|a\s+|an\s+)?(?:guard|clerk|ally|friend|companion|npc|boy|girl|woman|man|reeve|innkeeper|priest|wizard|fighter|rogue|paladin|bard|druid|ranger|monk|barbarian|sorcerer|warlock)\b/i.test(text);
}

function wrongSpecies(feature, speciesName, worldState = {}) {
  return {
    handled: true,
    logType: 'species_wrong_species',
    worldState,
    reply: `${feature} is a ${speciesName} feature and is not on this character sheet. The referee checked the ancestry column, which remains inconveniently specific.`,
  };
}

function actorName(characterSheet = {}, worldState = {}) {
  return characterSheet.identity?.name || worldState.player_stats?.name || 'You';
}

function getProficiencyBonus(characterSheet = {}) {
  const level = Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  return Number(characterSheet.derived_stats?.proficiency_bonus || Math.floor((level - 1) / 4) + 2);
}

function isSpecies(characterSheet = {}, speciesId) {
  return normalizeId(characterSheet.identity?.species) === speciesId;
}

function cloneCombat(combatState = {}) {
  return JSON.parse(JSON.stringify(combatState));
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function defaultRollDie(sides) {
  return rollDie(sides);
}

module.exports = {
  getSpeciesD20AdvantageSources,
  getSpeciesFeatureIntent,
  resolveSpeciesFeatureAction,
};
