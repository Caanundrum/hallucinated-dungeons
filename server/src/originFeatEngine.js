const { spendTurnResource } = require('./actionEconomy');
const {
  applyHealing,
  rollDamageFormula,
} = require('./damageHealingEngine');
const {
  buildResourceState,
  spendResource,
} = require('./resourceEngine');

function resolveOriginFeatAction({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  const intent = getOriginFeatIntent(message);
  if (!intent) return null;
  if (intent.id === 'healer') return resolveBattleMedic({ message, worldState, characterSheet, rollDie });
  if (intent.id === 'lucky_defense') return primeLuckyDefense({ worldState, characterSheet });
  return null;
}

function getOriginFeatIntent(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\bbattle medic\b|\b(?:use|apply|open|spend|heal|treat|patch)\b.*\b(?:healer'?s kit|healing kit)\b/.test(text)) return { id: 'healer' };
  if (/\b(?:use|spend|burn|prime)\s+(?:my\s+)?luck(?:y| point| points)?\b.*\b(?:defense|defence|defensively|against the next attack|make the next attack harder)\b/.test(text)) {
    return { id: 'lucky_defense' };
  }
  return null;
}

function resolveBattleMedic({ message = '', worldState = {}, characterSheet = {}, rollDie = defaultRollDie } = {}) {
  if (!hasOriginFeat(characterSheet, 'healer')) return wrongFeat('Healer', worldState);
  if (targetsSomeoneElse(message)) {
    return {
      handled: true,
      logType: 'origin_healer_target_needed',
      worldState,
      reply: 'Battle Medic can help another creature, but this phase only tracks deterministic Hit Dice for the active character. Use the Healer kit on yourself for now; party targeting comes with the multiplayer state layer.',
    };
  }

  const hitDice = getHitDiceState(characterSheet, worldState);
  if (hitDice.remaining <= 0) {
    return {
      handled: true,
      logType: 'origin_healer_hit_die_unavailable',
      worldState,
      reply: 'Battle Medic needs an available Hit Die from the creature being treated. You have none left to spend right now. The kit contains bandages, not replacement stamina.',
    };
  }

  const spentAction = spendTurnResource(worldState, 'action', 'Battle Medic', characterSheet);
  if (!spentAction.ok) {
    return {
      handled: true,
      logType: 'origin_healer_action_unavailable',
      worldState: spentAction.worldState,
      reply: spentAction.reply,
    };
  }

  const proficiency = getProficiencyBonus(characterSheet);
  const healing = rollDamageFormula(`1d${hitDice.die}+${proficiency}`, rollDie, { rerollOnes: true });
  const healed = healActiveCharacter(spentAction.worldState, characterSheet, healing.total);
  const remaining = hitDice.remaining - 1;
  const nextState = {
    ...healed.worldState,
    player_stats: {
      ...(healed.worldState.player_stats || {}),
      hit_dice: {
        die: hitDice.die,
        remaining,
        max: hitDice.max,
      },
      hit_dice_remaining: remaining,
    },
  };
  return {
    handled: true,
    logType: 'origin_healer_battle_medic',
    worldState: nextState,
    reply: `You use **Battle Medic** with a Healer's Kit and spend one Hit Die. You regain ${healed.applied} HP (${healing.rolls.join(' + ')} + ${proficiency}). HP: ${healed.beforeHp} -> ${healed.afterHp}. Hit Dice left: ${remaining}.`,
  };
}

function primeLuckyDefense({ worldState = {}, characterSheet = {} } = {}) {
  if (!hasOriginFeat(characterSheet, 'lucky')) return wrongFeat('Lucky', worldState);
  if (worldState.player_stats?.lucky_defense_primed) {
    return {
      handled: true,
      logType: 'origin_lucky_defense_already_primed',
      worldState,
      reply: 'Lucky is already primed against the next attack roll targeting you. Fate is on hold and listening to extremely repetitive music.',
    };
  }

  const spent = spendResource({ worldState, characterSheet, resource: 'luck_points' });
  if (!spent.ok) {
    return {
      handled: true,
      logType: 'origin_lucky_unavailable',
      worldState,
      reply: 'You do not have a Luck Point available. Fate checks the ledger and makes an apologetic face.',
    };
  }
  return {
    handled: true,
    logType: 'origin_lucky_defense_primed',
    worldState: {
      ...spent.worldState,
      player_stats: {
        ...(spent.worldState.player_stats || {}),
        lucky_defense_primed: true,
      },
    },
    reply: '**Lucky** is primed defensively. The next attack roll targeting you has Disadvantage.',
  };
}

function applyLuckyToImmediateD20({ message = '', worldState = {}, characterSheet = {}, advantageMode = null, sources = [] } = {}) {
  if (!wantsLuckyOnImmediateRoll(message)) {
    return { worldState, advantageMode, sources, note: '' };
  }
  if (!hasOriginFeat(characterSheet, 'lucky')) {
    return { worldState, advantageMode, sources, note: 'Lucky was requested, but this character does not have the Lucky feat.' };
  }

  const spent = spendResource({ worldState, characterSheet, resource: 'luck_points' });
  if (!spent.ok) {
    return { worldState, advantageMode, sources, note: 'Lucky was requested, but no Luck Point remains.' };
  }
  return {
    worldState: spent.worldState,
    advantageMode: combineAdvantageModes(advantageMode, 'advantage'),
    sources: [...new Set([...(sources || []), 'Lucky'])],
    note: 'Lucky spends 1 Luck Point for Advantage.',
  };
}

function rollWeaponDamage({ formula, characterSheet = {}, rollDie = defaultRollDie, crit = false, attack = {} } = {}) {
  const options = {
    crit,
    rerollOnes: Boolean(attack.rerollDamageOnes),
  };
  const first = rollDamageFormula(formula, rollDie, options);
  if (!attack.isWeapon || !hasOriginFeat(characterSheet, 'savage_attacker')) {
    return { ...first, note: first.rerolls?.length ? 'Tavern Brawler rerolled damage die results of 1.' : '' };
  }

  const second = rollDamageFormula(formula, rollDie, options);
  const selected = second.total > first.total ? second : first;
  return {
    ...selected,
    note: `Savage Attacker rolled weapon damage twice (${first.total}/${second.total}) and used ${selected.total}.`,
    savageAttacker: { first, second, selected: selected.total },
  };
}

function buildUnarmedAttack({ characterSheet = {}, message = '' } = {}) {
  if (!isUnarmedAttackIntent(message)) return null;
  const proficiency = getProficiencyBonus(characterSheet);
  const modifiers = characterSheet.abilities?.modifiers || {};
  const monk = normalizeId(characterSheet.identity?.class) === 'monk';
  const tavernBrawler = hasOriginFeat(characterSheet, 'tavern_brawler');
  const ability = monk && Number(modifiers.dex || 0) > Number(modifiers.str || 0) ? 'dex' : 'str';
  const modifier = Number(modifiers[ability] || 0);
  const formula = monk
    ? `1d6+${modifier}`
    : tavernBrawler
      ? `1d4+${modifier}`
      : String(Math.max(0, 1 + modifier));
  return {
    name: 'Unarmed Strike',
    ability,
    attackBonus: modifier + proficiency,
    damageFormula: formula,
    isWeapon: false,
    isUnarmed: true,
    rerollDamageOnes: tavernBrawler,
    tavernBrawlerPush: tavernBrawler && /\b(?:push|shove|knock|drive)\b.*\b(?:back|away)\b/i.test(message),
    properties: [],
    weaponCategory: null,
  };
}

function isUnarmedAttackIntent(message = '') {
  return /\b(?:punch|kick|headbutt|elbow|unarmed strike|strike with (?:my )?(?:fist|foot|elbow|head)|hit .+ with (?:my )?(?:fist|foot|elbow|head))\b/i.test(String(message || ''));
}

function wantsLuckyOnImmediateRoll(message = '') {
  return /\b(?:(?:use|using|spend|burn|with)\s+(?:my\s+)?luck(?:y| point| points)?|lucky\s+(?:attack|spell|strike))\b/i.test(String(message || ''));
}

function hasOriginFeat(characterSheet = {}, featId) {
  const target = normalizeId(featId);
  const origin = characterSheet.origin || {};
  return normalizeId(origin.background_feat) === target
    || normalizeId(origin.human_origin_feat) === target
    || (characterSheet.features || []).some((feature) => normalizeId(feature.name) === target);
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

function getHitDiceState(characterSheet = {}, worldState = {}) {
  const die = Number(characterSheet.resources?.hit_dice?.die || characterSheet.identity?.hit_die || getClassHitDie(characterSheet.identity?.class) || 8);
  const max = Number(characterSheet.resources?.hit_dice?.max || characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  const remaining = Number(worldState.player_stats?.hit_dice?.remaining ?? worldState.player_stats?.hit_dice_remaining ?? characterSheet.resources?.hit_dice?.remaining ?? max);
  return { die, max: Math.max(1, max), remaining: Math.max(0, Math.min(Math.max(1, max), remaining)) };
}

function getClassHitDie(classId) {
  const hitDice = { barbarian: 12, fighter: 10, paladin: 10, ranger: 10, bard: 8, cleric: 8, druid: 8, monk: 8, rogue: 8, warlock: 8, sorcerer: 6, wizard: 6 };
  return hitDice[normalizeId(classId)] || 8;
}

function targetsSomeoneElse(message = '') {
  const text = String(message || '');
  if (/\b(?:myself|me|self)\b/i.test(text)) return false;
  return /\b(?:on|to|heal|treat)\s+(?:the\s+|a\s+|an\s+)?(?:guard|clerk|ally|friend|companion|npc|boy|girl|woman|man|reeve|innkeeper|priest|wizard|fighter|rogue|paladin|bard|druid|ranger|monk|barbarian|sorcerer|warlock)\b/i.test(text);
}

function getProficiencyBonus(characterSheet = {}) {
  const level = Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  return Number(characterSheet.derived_stats?.proficiency_bonus || Math.floor((level - 1) / 4) + 2);
}

function wrongFeat(feat, worldState = {}) {
  return {
    handled: true,
    logType: 'origin_feat_unavailable',
    worldState,
    reply: `${feat} is not on this character sheet. The referee checked the feat list twice and found no secret appendix.`,
  };
}

function cloneCombat(combatState = {}) {
  return JSON.parse(JSON.stringify(combatState));
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function combineAdvantageModes(left = null, right = null) {
  if (left && right && left !== right) return null;
  return left || right || null;
}

function defaultRollDie(sides) {
  return Math.ceil(Math.random() * Number(sides || 20));
}

module.exports = {
  applyLuckyToImmediateD20,
  buildUnarmedAttack,
  getOriginFeatIntent,
  hasOriginFeat,
  isUnarmedAttackIntent,
  resolveOriginFeatAction,
  rollWeaponDamage,
};
