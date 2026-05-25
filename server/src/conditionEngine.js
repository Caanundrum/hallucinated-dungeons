const TURN_BLOCKING_CONDITIONS = new Set([
  'incapacitated',
  'paralyzed',
  'petrified',
  'sleep',
  'asleep',
  'stunned',
  'unconscious',
]);

const ATTACKER_DISADVANTAGE_CONDITIONS = new Set([
  'blinded',
  'poisoned',
  'restrained',
]);

const TARGET_ADVANTAGE_CONDITIONS = new Set([
  'blinded',
  'paralyzed',
  'petrified',
  'restrained',
  'stunned',
  'unconscious',
  'sleep',
  'asleep',
]);

const TARGET_DISADVANTAGE_CONDITIONS = new Set([
  'invisible',
]);

const AUTO_FAIL_STR_DEX_SAVE_CONDITIONS = new Set([
  'paralyzed',
  'petrified',
  'stunned',
  'unconscious',
  'sleep',
  'asleep',
]);

function normalizeCondition(value) {
  return String(value || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
}

function getConditions(subject = {}) {
  return (subject.conditions || []).map(normalizeCondition).filter(Boolean);
}

function hasCondition(subject, candidates = []) {
  const conditions = new Set(getConditions(subject));
  return candidates.some((condition) => conditions.has(normalizeCondition(condition)));
}

function getTurnBlockReason(subject = {}) {
  const conditions = new Set(getConditions(subject));
  if ([...TURN_BLOCKING_CONDITIONS].some((condition) => conditions.has(condition))) {
    return 'it is unable to act';
  }
  if (conditions.has('command')) {
    return 'Command overrides its action for this round';
  }
  if (conditions.has('charm_person') || conditions.has('charmed')) {
    return 'it is charmed and cannot attack you right now';
  }
  return null;
}

function getAttackMode({ attacker = {}, target = {}, defenderDodging = false } = {}) {
  let advantage = false;
  let disadvantage = Boolean(defenderDodging);
  const attackerConditions = new Set(getConditions(attacker));
  const targetConditions = new Set(getConditions(target));

  for (const condition of ATTACKER_DISADVANTAGE_CONDITIONS) {
    if (attackerConditions.has(condition)) disadvantage = true;
  }
  if (attackerConditions.has('frightened')) disadvantage = true;

  for (const condition of TARGET_ADVANTAGE_CONDITIONS) {
    if (targetConditions.has(condition)) advantage = true;
  }
  for (const condition of TARGET_DISADVANTAGE_CONDITIONS) {
    if (targetConditions.has(condition)) disadvantage = true;
  }

  if (advantage && disadvantage) return null;
  if (advantage) return 'advantage';
  if (disadvantage) return 'disadvantage';
  return null;
}

function getAttackModeSources({ attacker = {}, target = {}, defenderDodging = false } = {}) {
  const sources = [];
  const attackerConditions = new Set(getConditions(attacker));
  const targetConditions = new Set(getConditions(target));

  for (const condition of ATTACKER_DISADVANTAGE_CONDITIONS) {
    if (attackerConditions.has(condition)) sources.push(`${formatCondition(condition)} on attacker`);
  }
  if (attackerConditions.has('frightened')) sources.push('Frightened attacker');
  if (defenderDodging) sources.push('Dodge');

  for (const condition of TARGET_ADVANTAGE_CONDITIONS) {
    if (targetConditions.has(condition)) sources.push(`${formatCondition(condition)} target`);
  }
  for (const condition of TARGET_DISADVANTAGE_CONDITIONS) {
    if (targetConditions.has(condition)) sources.push(`${formatCondition(condition)} target`);
  }

  return sources;
}

function resolveSavingThrow({ target = {}, ability, dc, rollDie, bonus = 0 } = {}) {
  const normalizedAbility = normalizeCondition(ability);
  if ((normalizedAbility === 'str' || normalizedAbility === 'dex') && hasCondition(target, [...AUTO_FAIL_STR_DEX_SAVE_CONDITIONS])) {
    return {
      natural: null,
      total: null,
      success: false,
      automaticFailure: true,
      text: `${formatCondition(normalizedAbility)} save automatically fails because of ${formatConditionList(getConditions(target))}`,
    };
  }

  const natural = rollDie(20);
  const total = natural + Number(bonus || 0);
  return {
    natural,
    total,
    success: total >= Number(dc || 10),
    automaticFailure: false,
    text: `${natural}${formatSigned(bonus)} = ${total}`,
  };
}

function formatCondition(value) {
  const key = normalizeCondition(value);
  const labels = {
    str: 'STR',
    dex: 'DEX',
    con: 'CON',
    int: 'INT',
    wis: 'WIS',
    cha: 'CHA',
  };
  return labels[key] || key.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatConditionList(conditions = []) {
  const list = conditions.map(formatCondition);
  if (list.length === 0) return 'a condition';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function formatSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

module.exports = {
  getTurnBlockReason,
  getAttackMode,
  getAttackModeSources,
  resolveSavingThrow,
};
