const { rollDie } = require('./dice');

function rollDamageFormula(formula = '1d6', rollDie = defaultRollDie, { crit = false, spellMod = 0, rerollOnes = false, minimumDieRoll = null } = {}) {
  const normalized = String(formula || '1')
    .replace(/\s+/g, '')
    .replace(/spell_mod_min_1/g, String(Math.max(1, Number(spellMod || 0))))
    .replace(/spell_mod/g, String(spellMod));
  const match = normalized.match(/(\d+)d(\d+)((?:[+-]\d+)*)/i);
  if (!match) return { total: Number(normalized) || 0, rolls: [], modifier: 0 };

  const diceCount = Number(match[1]);
  const dieSides = Number(match[2]);
  const modifierText = match[3] || '';
  const modifier = (modifierText.match(/[+-]\d+/g) || [])
    .reduce((sum, value) => sum + Number(value), 0);
  const rollCount = crit ? diceCount * 2 : diceCount;
  const rerolls = [];
  const rolls = Array.from({ length: rollCount }, () => {
    const first = rollDie(dieSides);
    if (!rerollOnes || first !== 1) return first;
    const replacement = rollDie(dieSides);
    rerolls.push({ from: first, to: replacement });
    return replacement;
  });
  const adjustedRolls = minimumDieRoll
    ? rolls.map((roll) => Math.max(Number(minimumDieRoll), roll))
    : rolls;
  return {
    total: adjustedRolls.reduce((sum, roll) => sum + roll, 0) + modifier,
    rolls: adjustedRolls,
    originalRolls: minimumDieRoll ? rolls : undefined,
    modifier,
    rerolls,
  };
}

function applyDamage({ target = {}, amount = 0, damageType = null, source = null } = {}) {
  const rawAmount = Math.max(0, Number(amount || 0));
  const adjustment = getDamageAdjustment(target, damageType);
  const adjustedAmount = adjustDamageAmount(rawAmount, adjustment.multiplier);
  const beforeTempHp = Number(target.temp_hp || 0);
  const absorbed = Math.min(beforeTempHp, adjustedAmount);
  const hpDamage = Math.max(0, adjustedAmount - absorbed);
  const beforeHp = Number(target.hp ?? target.max_hp ?? 0);
  const nextTarget = {
    ...target,
    temp_hp: Math.max(0, beforeTempHp - absorbed),
    hp: Math.max(0, beforeHp - hpDamage),
  };
  return {
    target: nextTarget,
    rawAmount,
    amount: adjustedAmount,
    hpDamage,
    absorbed,
    beforeHp,
    afterHp: nextTarget.hp,
    beforeTempHp,
    afterTempHp: nextTarget.temp_hp,
    damageType,
    source,
    adjustment,
  };
}

function applyHealing({ target = {}, amount = 0, maxHp = null } = {}) {
  const healAmount = Math.max(0, Number(amount || 0));
  const beforeHp = Number(target.hp ?? 0);
  const effectiveMax = Number(maxHp ?? target.max_hp ?? beforeHp);
  const nextHp = Math.min(effectiveMax, beforeHp + healAmount);
  return {
    target: {
      ...target,
      hp: nextHp,
      max_hp: effectiveMax,
    },
    amount: healAmount,
    applied: Math.max(0, nextHp - beforeHp),
    beforeHp,
    afterHp: nextHp,
    maxHp: effectiveMax,
  };
}

function applyTemporaryHp({ target = {}, amount = 0 } = {}) {
  const tempAmount = Math.max(0, Number(amount || 0));
  const beforeTempHp = Number(target.temp_hp || 0);
  const nextTempHp = Math.max(beforeTempHp, tempAmount);
  return {
    target: {
      ...target,
      temp_hp: nextTempHp,
    },
    amount: tempAmount,
    applied: Math.max(0, nextTempHp - beforeTempHp),
    beforeTempHp,
    afterTempHp: nextTempHp,
  };
}

function getDamageAdjustment(target = {}, damageType = null) {
  const type = normalizeDamageType(damageType);
  if (!type) return { multiplier: 1, reason: null };
  if (hasDamageType(target.immunities || target.damage_immunities, type)) {
    return { multiplier: 0, reason: `${type} immunity` };
  }
  if (hasDamageType(target.vulnerabilities || target.damage_vulnerabilities, type)) {
    return { multiplier: 2, reason: `${type} vulnerability` };
  }
  if (hasDamageType(target.resistances || target.damage_resistances, type)) {
    return { multiplier: 0.5, reason: `${type} resistance` };
  }
  return { multiplier: 1, reason: null };
}

function formatDamageAdjustment(adjustment = {}) {
  return adjustment.reason ? ` after ${adjustment.reason}` : '';
}

function adjustDamageAmount(amount, multiplier = 1) {
  if (Number(multiplier) === 0) return 0;
  if (Number(multiplier) === 0.5) return Math.floor(Number(amount || 0) / 2);
  return Math.floor(Number(amount || 0) * Number(multiplier || 1));
}

function hasDamageType(values = [], type) {
  return (values || []).map(normalizeDamageType).includes(type);
}

function normalizeDamageType(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
}

function defaultRollDie(sides) {
  return rollDie(sides);
}

module.exports = {
  rollDamageFormula,
  applyDamage,
  applyHealing,
  applyTemporaryHp,
  getDamageAdjustment,
  formatDamageAdjustment,
};
