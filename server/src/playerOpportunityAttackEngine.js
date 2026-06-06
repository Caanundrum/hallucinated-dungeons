const {
  getAttackMode,
  getAttackModeSources,
  getConditionD20Modifier,
  formatConditionD20Sources,
  getTurnBlockReason,
} = require('./conditionEngine');
const { getContentBundle } = require('./contentData');
const { rollDie } = require('./dice');
const { resolveD20Test } = require('./d20RollEngine');
const {
  consumeActiveEffects,
  getActiveBonusDice,
  getActiveDamageBonuses,
  getActiveDamageDice,
} = require('./spellEffectEngine');
const {
  applyFightingStyleToAttack,
  getBlindFightingAttackOptions,
  getFightingStyleDamageBonus,
} = require('./fightingStyleEngine');
const {
  applyWeaponMasteryOnHit,
  applyWeaponMasteryOnMiss,
  consumeVexAdvantage,
  getWeaponDamageFormula,
  getWeaponMasteryAdvantageSources,
  getWeaponPropertyAttackMode,
  getWeaponPropertyAttackSources,
  prepareWeaponAttack,
} = require('./weaponRulesEngine');
const {
  buildUnarmedAttack,
  rollWeaponDamage,
} = require('./originFeatEngine');
const { applyHelpToAttack } = require('./helpActionEngine');
const { clearPlayerHidden } = require('./hiddenStateEngine');
const { getAutoD20RerollRules } = require('./resourceEngine');
const { getWeaponReach } = require('./combatPositionEngine');

function canMakePlayerOpportunityAttack({
  worldState = {},
  characterSheet = {},
  player = {},
  target = {},
} = {}) {
  if (!worldState.combat_state?.active) return false;
  if (worldState.combat_state.turn_resources?.reaction_available === false) return false;
  if (Number(player.hp ?? worldState.player_stats?.hp ?? 0) <= 0) return false;
  if (Number(target.hp || 0) <= 0) return false;
  if (target.visible === false || target.can_be_seen === false) return false;
  if (getTurnBlockReason(player)) return false;
  const attack = getOpportunityAttackProfile({ characterSheet });
  if (!attack) return false;
  return prepareWeaponAttack({
    attack,
    message: 'opportunity attack',
    characterSheet,
    player,
    target,
  }).ok;
}

function getPlayerOpportunityReach(characterSheet = {}) {
  const attack = getOpportunityAttackProfile({ characterSheet });
  return attack ? getWeaponReach(attack) : 5;
}

function getOpportunityAttackProfile({ characterSheet = {} } = {}) {
  const explicitUnarmed = buildUnarmedAttack({ characterSheet, message: 'unarmed strike' });
  const attacks = characterSheet?.derived_stats?.attack_breakdowns || [];
  const weaponAttack = attacks
    .map((entry) => buildAttackFromBreakdown(entry))
    .find((attack) => attack && attack.attackKind === 'melee');
  return weaponAttack || explicitUnarmed || null;
}

function resolvePlayerOpportunityAttack({
  worldState = {},
  characterSheet = {},
  combat = {},
  player = {},
  target = {},
  rollDie = defaultRollDie,
} = {}) {
  let nextWorldState = worldState;
  const lines = [];
  let nextCombat = combat;
  let attacker = nextCombat.combatants?.find((combatant) => combatant.is_player) || player;
  let defender = findCombatantByName(nextCombat, target.name) || target;
  const baseAttack = getOpportunityAttackProfile({ characterSheet });
  if (!baseAttack) {
    return {
      worldState,
      combat,
      player,
      target,
      lines: ['**Opportunity Attack:** no melee attack is available on the character sheet. The Reaction is not spent by wishful thinking.'],
      damageEvents: [],
    };
  }

  const attack = applyFightingStyleToAttack({
    attack: baseAttack,
    characterSheet,
    message: 'opportunity attack',
  });
  const prepared = prepareWeaponAttack({
    attack,
    message: 'opportunity attack',
    characterSheet,
    player: attacker,
    target: defender,
  });
  if (!prepared.ok) {
    return {
      worldState,
      combat,
      player,
      target,
      lines: [`**Opportunity Attack:** ${prepared.reply}`],
      damageEvents: [],
    };
  }

  const propertyMode = getWeaponPropertyAttackMode({
    attack: prepared.attack,
    characterSheet,
    player: attacker,
    target: defender,
    combat: nextCombat,
  });
  const visionOptions = getBlindFightingAttackOptions({
    characterSheet,
    attack: prepared.attack,
    attacker,
    target: defender,
    spatialMode: prepared.spatialMode,
  });
  let advantageSources = [
    ...getAttackAdvantageSources(attacker, defender, visionOptions),
    ...getWeaponPropertyAttackSources({ attack: prepared.attack, characterSheet, player: attacker, target: defender, combat: nextCombat }),
  ];
  const helped = applyHelpToAttack({
    worldState: nextWorldState,
    combat: nextCombat,
    attacker,
    target: defender,
    advantageMode: combineAdvantageModes(getAttackAdvantageMode(attacker, defender, visionOptions), propertyMode),
    sources: advantageSources,
  });
  nextWorldState = helped.worldState;
  nextCombat = helped.combat;
  attacker = helped.attacker;
  defender = helped.target;
  advantageSources = helped.sources;
  const advantageMode = helped.advantageMode;
  Object.assign(defender, consumeVexAdvantage(defender));
  const conditionAttackModifier = getConditionD20Modifier(attacker);
  const attackRoll = resolveD20Test({
    kind: 'attack',
    modifier: prepared.attack.attackBonus + conditionAttackModifier,
    dc: Number(defender.ac || 10),
    advantageMode,
    bonusDice: getActiveBonusDice(nextWorldState, 'attack'),
    rerollRules: getAutoD20RerollRules(characterSheet),
    rollDie,
  });
  const natural = attackRoll.natural;
  const criticalHit = natural === 20;
  const criticalMiss = natural === 1;
  const hit = !criticalMiss && (criticalHit || attackRoll.total >= Number(defender.ac || 10));
  const consumeEffectIds = [...(attackRoll.bonusDice?.expireEffectIds || [])];
  lines.push(`**Opportunity Attack:** you strike ${defender.name} with ${prepared.attack.name}. Attack roll: ${attackRoll.rollText} vs AC ${defender.ac}.`);
  if (visionOptions.note) lines.push(visionOptions.note);
  if (advantageMode) lines.push(`Opportunity Attack has ${advantageMode} from ${formatList(advantageSources)}.`);
  if (conditionAttackModifier) lines.push(`Condition modifier: ${formatConditionD20Sources(attacker).join(', ')}.`);
  const reveal = clearPlayerHidden({ worldState: nextWorldState, reason: 'attack' });
  if (reveal.revealed) {
    nextWorldState = reveal.worldState;
    nextCombat = reveal.combat;
    attacker = nextCombat.combatants?.find((combatant) => combatant.is_player) || attacker;
    defender = findCombatantByName(nextCombat, defender.name) || defender;
    lines.push(reveal.line);
  }

  if (hit) {
    const damage = rollWeaponDamage({
      formula: getWeaponDamageFormula({ attack: prepared.attack, message: 'opportunity attack', characterSheet }),
      characterSheet,
      rollDie,
      crit: criticalHit,
      attack: prepared.attack,
    });
    const bonusDamage = rollBonusDice(getActiveDamageDice(nextWorldState, defender), rollDie);
    const flatBonuses = getActiveDamageBonuses(nextWorldState, { attack: prepared.attack, characterSheet });
    const fightingStyleBonus = getFightingStyleDamageBonus({ characterSheet, attack: prepared.attack, message: 'opportunity attack' });
    const totalDamage = damage.total
      + bonusDamage.total
      + flatBonuses.reduce((sum, bonus) => sum + Number(bonus.value || 0), 0)
      + fightingStyleBonus.total;
    const before = Number(defender.hp || 0);
    defender.hp = Math.max(0, before - totalDamage);
    const damageParts = [
      `${damage.total} weapon`,
      bonusDamage.total ? bonusDamage.summary : '',
      flatBonuses.length ? flatBonuses.map((bonus) => `${bonus.label} ${formatSigned(bonus.value)}`).join(' + ') : '',
      fightingStyleBonus.total ? `${fightingStyleBonus.label} ${formatSigned(fightingStyleBonus.total)}` : '',
    ].filter(Boolean);
    lines.push(`${criticalHit ? '**Critical hit.** ' : ''}Hit for ${totalDamage} damage${damageParts.length > 1 ? ` (${damageParts.join(' + ')})` : ''}. ${defender.name}: (${before} -> ${defender.hp} HP).`);
    if (damage.note) lines.push(damage.note);
    consumeEffectIds.push(...bonusDamage.expireEffectIds);
    lines.push(...applyWeaponMasteryOnHit({
      attack: prepared.attack,
      target: defender,
      combat: nextCombat,
      characterSheet,
      damageDealt: totalDamage,
      rollDie,
    }).lines);
    if (Number(defender.hp) <= 0) lines.push(`${defender.name} falls before leaving your reach.`);
  } else if (criticalMiss) {
    lines.push('**Critical miss.** The Opportunity Attack misses automatically.');
    lines.push(...applyWeaponMasteryOnMiss({ attack: prepared.attack, target: defender, characterSheet }).lines);
  } else {
    lines.push('The Opportunity Attack misses.');
    lines.push(...applyWeaponMasteryOnMiss({ attack: prepared.attack, target: defender, characterSheet }).lines);
  }

  if (consumeEffectIds.length) {
    nextWorldState = consumeActiveEffects({
      ...nextWorldState,
      combat_state: nextCombat,
    }, consumeEffectIds, characterSheet);
    nextCombat = nextWorldState.combat_state;
    defender = findCombatantByName(nextCombat, defender.name) || defender;
    attacker = nextCombat.combatants?.find((combatant) => combatant.is_player) || attacker;
  }

  return {
    worldState: {
      ...nextWorldState,
      combat_state: nextCombat,
    },
    combat: nextCombat,
    player: attacker,
    target: defender,
    lines,
    damageEvents: [],
  };
}

function buildAttackFromBreakdown(attack = {}) {
  if (!attack) return null;
  const weaponId = attack.weapon_id || attack.weaponId || null;
  const weapon = weaponId
    ? getContentBundle().equipment.find((item) => item.id === weaponId)
    : null;
  const attackKind = weapon?.attack_kind || attack.attack_kind || attack.attackKind || 'melee';
  if (attackKind !== 'melee') return null;
  return {
    name: attack.name || weapon?.name || 'weapon',
    weaponId,
    ability: attack.ability || weapon?.ability || null,
    properties: weapon?.properties || attack.properties || [],
    weaponCategory: weapon?.weapon_category || attack.weapon_category || null,
    attackKind,
    attackBonus: Number(attack.attack_total ?? attack.attackBonus ?? 0),
    fightingStyleAttackBonus: Number(attack.fighting_style_attack_bonus || 0),
    damageFormula: attack.damage_formula || attack.damageFormula || weapon?.damage || '1d4',
    damageType: weapon?.damage_type || attack.damage_type || null,
    mastery: weapon?.mastery || attack.mastery || null,
    versatileDamage: weapon?.versatile_damage || attack.versatile_damage || null,
    range: weapon?.range || attack.range || null,
    isWeapon: Boolean(weaponId || attack.isWeapon),
  };
}

function getAttackAdvantageMode(attacker = {}, target = {}, options = {}) {
  const conditionMode = getAttackMode({ attacker, target, ...options });
  const masteryAdvantage = getWeaponMasteryAdvantageSources(target).length ? 'advantage' : null;
  return combineAdvantageModes(conditionMode, masteryAdvantage);
}

function getAttackAdvantageSources(attacker = {}, target = {}, options = {}) {
  return [
    ...getAttackModeSources({ attacker, target, ...options }),
    ...getWeaponMasteryAdvantageSources(target),
  ];
}

function rollBonusDice(bonuses = [], rollDie) {
  const parts = [];
  const expireEffectIds = [];
  let total = 0;
  for (const bonus of bonuses || []) {
    const rolled = rollDiceExpression(bonus.die, rollDie);
    if (!rolled) continue;
    total += rolled.total;
    parts.push(`${bonus.label} ${bonus.die}=${rolled.total}`);
    if (bonus.expiresOnUse || bonus.expiresOnHit) expireEffectIds.push(bonus.effectId);
  }
  return {
    total,
    summary: parts.join(' + '),
    expireEffectIds,
  };
}

function rollDiceExpression(expression, rollDie = defaultRollDie) {
  const parsed = String(expression || '').match(/^(\d+)d(\d+)$/i);
  if (!parsed) return null;
  const diceCount = Number(parsed[1]);
  const dieSides = Number(parsed[2]);
  const rolls = Array.from({ length: diceCount }, () => rollDie(dieSides));
  return {
    total: rolls.reduce((sum, value) => sum + value, 0),
    rolls,
  };
}

function findCombatantByName(combat = {}, name = '') {
  const target = normalizeText(name);
  return (combat.combatants || []).find((combatant) => normalizeText(combatant.name) === target) || null;
}

function combineAdvantageModes(left = null, right = null) {
  if (left && right && left !== right) return null;
  return left || right || null;
}

function formatList(items = []) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return 'unknown sources';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function defaultRollDie(sides) {
  return rollDie(sides);
}

module.exports = {
  canMakePlayerOpportunityAttack,
  getOpportunityAttackProfile,
  getPlayerOpportunityReach,
  resolvePlayerOpportunityAttack,
};
