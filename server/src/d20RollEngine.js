function resolveD20Test({
  kind = 'd20_test',
  modifier = 0,
  dc = null,
  advantageMode = null,
  bonusDice = [],
  rerollRules = [],
  rollDie,
} = {}) {
  const roller = rollDie || defaultRollDie;
  const mode = normalizeAdvantageMode(advantageMode);
  const d20 = rollD20Group({ mode, rerollRules, rollDie: roller });
  const bonus = rollBonusDice(bonusDice, roller);
  let natural = d20.natural;
  let total = natural + Number(modifier || 0) + bonus.total;
  const postRollRerolls = [];

  for (const rule of rerollRules || []) {
    if (!shouldApplyPostRollReroll(rule, { kind, natural, total, dc })) continue;
    const replacement = roller(20);
    postRollRerolls.push({
      id: rule.id || normalizeId(rule.source || 'reroll'),
      source: rule.source || 'reroll',
      from: natural,
      to: replacement,
    });
    natural = replacement;
    total = natural + Number(modifier || 0) + bonus.total;
  }

  const parts = [
    `natural ${natural}`,
    `${d20.text}${formatSigned(modifier)}=${natural + Number(modifier || 0)}`,
    ...bonus.parts,
    ...postRollRerolls.map((reroll) => `${reroll.source} reroll ${reroll.from}->${reroll.to}`),
  ];

  return {
    kind,
    natural,
    total,
    rollText: `${total} (${parts.join('; ')})`,
    d20,
    bonusDice: bonus,
    rerolls: [...d20.rerolls, ...postRollRerolls],
    expireEffectIds: bonus.expireEffectIds,
  };
}

function rollD20WithMode(rollDie, advantageMode = null, rerollRules = []) {
  const d20 = rollD20Group({ mode: normalizeAdvantageMode(advantageMode), rerollRules, rollDie: rollDie || defaultRollDie });
  return {
    natural: d20.natural,
    text: d20.text,
    rolls: d20.rolls,
    rerolls: d20.rerolls,
  };
}

function rollD20Group({ mode = null, rerollRules = [], rollDie = defaultRollDie } = {}) {
  const rollCount = mode === 'advantage' || mode === 'disadvantage' ? 2 : 1;
  const rawRolls = Array.from({ length: rollCount }, () => rollDie(20));
  const rerolled = rawRolls.map((value, index) => applyAutoRerolls(value, index, rerollRules, rollDie));
  const rolls = rerolled.map((item) => item.value);
  const selected = selectD20Roll(rolls, mode);
  const rollText = mode
    ? `${rolls.join('/')} with ${mode}, using ${selected}`
    : String(selected);
  const rerollText = rerolled.flatMap((item) => item.rerolls)
    .map((item) => `${item.source} rerolled ${item.from}->${item.to}`)
    .join('; ');

  return {
    natural: selected,
    text: rerollText ? `${rollText} (${rerollText})` : rollText,
    mode,
    rawRolls,
    rolls,
    rerolls: rerolled.flatMap((item) => item.rerolls),
  };
}

function applyAutoRerolls(value, dieIndex, rerollRules = [], rollDie = defaultRollDie) {
  let current = value;
  const rerolls = [];
  for (const rule of rerollRules || []) {
    if (rule.trigger !== 'natural_1') continue;
    if (current !== 1) continue;
    const replacement = rollDie(20);
    rerolls.push({
      id: rule.id || normalizeId(rule.source || 'natural_1_reroll'),
      source: rule.source || 'natural 1 reroll',
      dieIndex,
      from: current,
      to: replacement,
    });
    current = replacement;
    if (!rule.repeat) break;
  }
  return { value: current, rerolls };
}

function shouldApplyPostRollReroll(rule = {}, { natural, total, dc }) {
  if (rule.trigger === 'failed_total') {
    if (dc == null) return natural === 1;
    return Number(total) < Number(dc);
  }
  if (rule.trigger === 'natural_1_post') return Number(natural) === 1;
  return false;
}

function selectD20Roll(rolls = [], mode = null) {
  if (mode === 'advantage') return Math.max(...rolls);
  if (mode === 'disadvantage') return Math.min(...rolls);
  return Number(rolls[0] || 1);
}

function combineAdvantageMode({ advantage = false, disadvantage = false } = {}) {
  if (advantage && disadvantage) return null;
  if (advantage) return 'advantage';
  if (disadvantage) return 'disadvantage';
  return null;
}

function normalizeAdvantageMode(value) {
  if (value === 'advantage' || value === 'disadvantage') return value;
  return null;
}

function rollBonusDice(bonuses = [], rollDie = defaultRollDie) {
  const parts = [];
  const expireEffectIds = [];
  let total = 0;
  for (const bonus of bonuses || []) {
    const rolled = rollDiceExpression(bonus.die, rollDie);
    if (!rolled) continue;
    total += rolled.total;
    parts.push(`${bonus.label || bonus.source || 'bonus'} ${bonus.die}=${rolled.total}`);
    if (bonus.expiresOnUse || bonus.expiresOnHit) expireEffectIds.push(bonus.effectId);
  }
  return {
    total,
    parts,
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

function defaultRollDie(sides) {
  return Math.ceil(Math.random() * Number(sides || 20));
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  resolveD20Test,
  rollD20WithMode,
  rollBonusDice,
  rollDiceExpression,
  combineAdvantageMode,
};
