const TURN_BLOCKING_CONDITIONS = new Set([
  'incapacitated',
  'paralyzed',
  'petrified',
  'sleep',
  'asleep',
  'stunned',
  'turn_undead',
  'unconscious',
]);

const ATTACKER_DISADVANTAGE_CONDITIONS = new Set([
  'blinded',
  'poisoned',
  'prone',
  'restrained',
  'sapped',
]);

const TARGET_ADVANTAGE_CONDITIONS = new Set([
  'blinded',
  'paralyzed',
  'petrified',
  'prone',
  'reckless_attack',
  'restrained',
  'stunned',
  'unconscious',
  'sleep',
  'asleep',
]);

const TARGET_DISADVANTAGE_CONDITIONS = new Set([
  'hidden',
  'invisible',
]);

const ATTACKER_ADVANTAGE_CONDITIONS = new Set([
  'hidden',
  'invisible',
]);

const CHECK_DISADVANTAGE_CONDITIONS = new Set([
  'poisoned',
  'frightened',
]);

const SAVE_DISADVANTAGE_BY_ABILITY = {
  dex: new Set(['restrained']),
};

const AUTO_FAIL_STR_DEX_SAVE_CONDITIONS = new Set([
  'paralyzed',
  'petrified',
  'stunned',
  'unconscious',
  'sleep',
  'asleep',
]);

function normalizeCondition(value) {
  return String(value || '').toLowerCase().trim().replace(/[\s:=-]+/g, '_');
}

function getConditions(subject = {}) {
  return (subject.conditions || []).map(normalizeConditionEntry).filter(Boolean);
}

function normalizeConditionEntry(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const id = normalizeCondition(entry.id || entry.condition || entry.name);
    if (id === 'exhaustion' && entry.level != null) return `exhaustion_${clampExhaustionLevel(entry.level)}`;
    return id;
  }
  return normalizeCondition(entry);
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

function getAttackMode({
  attacker = {},
  target = {},
  defenderDodging = false,
  ignoreAttackerConditions = [],
  ignoreTargetConditions = [],
} = {}) {
  let advantage = false;
  let disadvantage = Boolean(defenderDodging);
  const attackerConditions = new Set(getConditions(attacker));
  const targetConditions = new Set(getConditions(target));
  const ignoredAttacker = normalizeConditionSet(ignoreAttackerConditions);
  const ignoredTarget = normalizeConditionSet(ignoreTargetConditions);

  for (const condition of ATTACKER_DISADVANTAGE_CONDITIONS) {
    if (attackerConditions.has(condition) && !ignoredAttacker.has(condition)) disadvantage = true;
  }
  if (attackerConditions.has('frightened') && !ignoredAttacker.has('frightened')) disadvantage = true;

  for (const condition of ATTACKER_ADVANTAGE_CONDITIONS) {
    if (attackerConditions.has(condition) && !ignoredAttacker.has(condition)) advantage = true;
  }
  for (const condition of TARGET_ADVANTAGE_CONDITIONS) {
    if (targetConditions.has(condition) && !ignoredTarget.has(condition)) advantage = true;
  }
  for (const condition of TARGET_DISADVANTAGE_CONDITIONS) {
    if (targetConditions.has(condition) && !ignoredTarget.has(condition)) disadvantage = true;
  }

  if (advantage && disadvantage) return null;
  if (advantage) return 'advantage';
  if (disadvantage) return 'disadvantage';
  return null;
}

function getD20ConditionMode({ subject = {}, target = {}, testType = 'ability_check', ability = null, skill = null, defenderDodging = false, reason = '' } = {}) {
  if (testType === 'attack') return getAttackMode({ attacker: subject, target, defenderDodging });

  const conditions = new Set(getConditions(subject));
  const normalizedAbility = normalizeCondition(ability);
  let advantage = false;
  let disadvantage = false;

  if (testType === 'ability_check' || testType === 'skill_check') {
    for (const condition of CHECK_DISADVANTAGE_CONDITIONS) {
      if (conditions.has(condition)) disadvantage = true;
    }
    if (conditions.has('grappled') && normalizedAbility === 'str') disadvantage = true;
  }

  if (testType === 'saving_throw' || testType === 'concentration_save') {
    for (const condition of SAVE_DISADVANTAGE_BY_ABILITY[normalizedAbility] || []) {
      if (conditions.has(condition)) disadvantage = true;
    }
  }

  if (conditions.has('invisible') && (testType === 'stealth_check' || normalizeCondition(skill) === 'stealth')) advantage = true;

  return combineAdvantageMode({ advantage, disadvantage });
}

function getD20ConditionSources({ subject = {}, target = {}, testType = 'ability_check', ability = null, skill = null, defenderDodging = false, reason = '' } = {}) {
  if (testType === 'attack') return getAttackModeSources({ attacker: subject, target, defenderDodging });

  const conditions = new Set(getConditions(subject));
  const normalizedAbility = normalizeCondition(ability);
  const sources = [];

  if (testType === 'ability_check' || testType === 'skill_check') {
    for (const condition of CHECK_DISADVANTAGE_CONDITIONS) {
      if (conditions.has(condition)) sources.push(`${formatCondition(condition)} condition`);
    }
    if (conditions.has('grappled') && normalizedAbility === 'str') sources.push('Grappled condition');
  }

  if (testType === 'saving_throw' || testType === 'concentration_save') {
    for (const condition of SAVE_DISADVANTAGE_BY_ABILITY[normalizedAbility] || []) {
      if (conditions.has(condition)) sources.push(`${formatCondition(condition)} condition`);
    }
  }

  if (conditions.has('invisible') && (testType === 'stealth_check' || normalizeCondition(skill) === 'stealth')) sources.push('Invisible condition');
  return sources;
}

function getAttackModeSources({
  attacker = {},
  target = {},
  defenderDodging = false,
  ignoreAttackerConditions = [],
  ignoreTargetConditions = [],
} = {}) {
  const sources = [];
  const attackerConditions = new Set(getConditions(attacker));
  const targetConditions = new Set(getConditions(target));
  const ignoredAttacker = normalizeConditionSet(ignoreAttackerConditions);
  const ignoredTarget = normalizeConditionSet(ignoreTargetConditions);

  for (const condition of ATTACKER_DISADVANTAGE_CONDITIONS) {
    if (attackerConditions.has(condition) && !ignoredAttacker.has(condition)) sources.push(`${formatCondition(condition)} on attacker`);
  }
  if (attackerConditions.has('frightened') && !ignoredAttacker.has('frightened')) sources.push('Frightened attacker');
  if (defenderDodging) sources.push('Dodge');

  for (const condition of ATTACKER_ADVANTAGE_CONDITIONS) {
    if (attackerConditions.has(condition) && !ignoredAttacker.has(condition)) sources.push(`${formatCondition(condition)} attacker`);
  }
  for (const condition of TARGET_ADVANTAGE_CONDITIONS) {
    if (targetConditions.has(condition) && !ignoredTarget.has(condition)) sources.push(`${formatCondition(condition)} target`);
  }
  for (const condition of TARGET_DISADVANTAGE_CONDITIONS) {
    if (targetConditions.has(condition) && !ignoredTarget.has(condition)) sources.push(`${formatCondition(condition)} target`);
  }

  return sources;
}

function resolveSavingThrow({ target = {}, ability, dc, rollDie, bonus = 0, mode = null } = {}) {
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

  const conditionModifier = getConditionD20Modifier(target);
  const totalBonus = Number(bonus || 0) + conditionModifier;
  const first = rollDie(20);
  const second = mode ? rollDie(20) : null;
  const natural = mode === 'advantage'
    ? Math.max(first, second)
    : mode === 'disadvantage'
      ? Math.min(first, second)
      : first;
  const total = natural + totalBonus;
  return {
    natural,
    total,
    success: total >= Number(dc || 10),
    automaticFailure: false,
    text: `${mode ? `${first}/${second} with ${mode}, using ${natural}` : natural}${formatSigned(totalBonus)} = ${total}${conditionModifier ? ` (${formatConditionD20Sources(target).join(', ')})` : ''}`,
  };
}

function getSensoryCheckBlock({ subject = {}, ability = null, skill = null, reason = '' } = {}) {
  const conditions = new Set(getConditions(subject));
  if (isHearingDependentCheck({ conditions, skill, ability, reason })) {
    return {
      blocked: true,
      condition: 'deafened',
      source: 'Deafened condition',
      sense: 'hearing',
      reason: 'the task depends on hearing',
    };
  }
  if (isSightDependentCheck({ conditions, skill, ability, reason })) {
    return {
      blocked: true,
      condition: 'blinded',
      source: 'Blinded condition',
      sense: 'sight',
      reason: 'the task depends on sight',
    };
  }
  return null;
}

function getExhaustionLevel(subject = {}) {
  const direct = subject.exhaustion_level ?? subject.exhaustionLevel ?? subject.exhaustion;
  const directLevel = Number(direct);
  const conditionLevels = getConditions(subject)
    .map((condition) => {
      if (condition === 'exhaustion') return 1;
      const match = condition.match(/^exhaustion_(\d+)$/);
      return match ? Number(match[1]) : 0;
    });
  return clampExhaustionLevel(Math.max(0, directLevel || 0, ...conditionLevels));
}

function getConditionD20Modifier(subject = {}) {
  return -2 * getExhaustionLevel(subject);
}

function formatConditionD20Sources(subject = {}) {
  const level = getExhaustionLevel(subject);
  return level > 0 ? [`Exhaustion level ${level} ${formatSigned(-2 * level)}`] : [];
}

function getConditionSpeedPenalty(subject = {}) {
  return 5 * getExhaustionLevel(subject);
}

function applyConditionSpeedPenalty(speed, subject = {}) {
  return Math.max(0, Number(speed || 0) - getConditionSpeedPenalty(subject));
}

function isHearingDependentCheck({ conditions, skill, ability, reason = '' } = {}) {
  if (!conditions?.has('deafened')) return false;
  const text = String(reason || '').toLowerCase();
  const perceptionLike = normalizeCondition(skill) === 'perception' || normalizeCondition(ability) === 'wis';
  return perceptionLike && /\b(?:hear|hearing|listen|sound|noise|voice|voices|footsteps?|whisper|whispers|echo|ringing|bell|bells)\b/.test(text);
}

function isSightDependentCheck({ conditions, skill, ability, reason = '' } = {}) {
  if (!conditions?.has('blinded')) return false;
  const text = String(reason || '').toLowerCase();
  const normalizedSkill = normalizeCondition(skill);
  const normalizedAbility = normalizeCondition(ability);
  const sightLike = ['perception', 'investigation', 'insight'].includes(normalizedSkill)
    || ['wis', 'int'].includes(normalizedAbility);
  if (!sightLike) return false;

  const obviousSightIntent = /\b(?:look|see|sight|watch|scan|spot|peer|gaze|stare|observe|visually|visible)\b/.test(text);
  const readingIntent = /\b(?:read|reading|writing|written|inscription|runes?|glyphs?|symbol|symbols|text|sign|notice|map|note|letter|page|book|scroll|parchment)\b/.test(text);
  const visualInspectionIntent = /\b(?:inspect|examine|study)\b/.test(text)
    && /\b(?:face|expression|eyes|mark|marks|blood|color|colour|paint|symbol|symbols|writing|note|letter|map|runes?|glyphs?|tracks?)\b/.test(text);
  return obviousSightIntent || readingIntent || visualInspectionIntent;
}

function clampExhaustionLevel(value) {
  const level = Math.floor(Number(value || 0));
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(6, level);
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

function combineAdvantageMode({ advantage = false, disadvantage = false } = {}) {
  if (advantage && disadvantage) return null;
  if (advantage) return 'advantage';
  if (disadvantage) return 'disadvantage';
  return null;
}

function normalizeConditionSet(values = []) {
  return new Set((values || []).map(normalizeCondition));
}

module.exports = {
  getConditions,
  hasCondition,
  getTurnBlockReason,
  getAttackMode,
  getAttackModeSources,
  getD20ConditionMode,
  getD20ConditionSources,
  getSensoryCheckBlock,
  getExhaustionLevel,
  getConditionD20Modifier,
  formatConditionD20Sources,
  getConditionSpeedPenalty,
  applyConditionSpeedPenalty,
  resolveSavingThrow,
};
