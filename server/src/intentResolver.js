const RULE_ACTIONS = new Set([
  'attack',
  'dash',
  'disengage',
  'dodge',
  'help',
  'hide',
  'influence',
  'magic',
  'ready',
  'search',
  'study',
  'utilize',
]);

const ACTION_PATTERN = new RegExp(`\\b(?:take|use|ready)\\s+(?:the\\s+)?(${[...RULE_ACTIONS].join('|')})\\s+action\\b`, 'i');

const CHECK_RULES = [
  {
    id: 'insight',
    skill: 'insight',
    ability: 'wis',
    label: 'Wisdom (Insight)',
    pattern: /\b(?:study|read|watch|judge|size up|sense|gauge)\b.*\b(?:face|expression|motive|intent|lying|hiding|truth|reaction|demeanor|mood)\b/i,
  },
  {
    id: 'stealth',
    skill: 'stealth',
    ability: 'dex',
    label: 'Dexterity (Stealth)',
    pattern: /\b(?:hide|sneak|sneaking|blend into shadows|move quietly|avoid notice|slip past|tail them)\b/i,
  },
  {
    id: 'sleight_of_hand',
    skill: 'sleight_of_hand',
    ability: 'dex',
    label: 'Dexterity (Sleight of Hand)',
    pattern: /\b(?:pick pocket|pickpocket|palm|lift (?:his|her|their|the)|steal quietly|slip .* pocket)\b/i,
  },
  {
    id: 'survival',
    skill: 'survival',
    ability: 'wis',
    label: 'Wisdom (Survival)',
    pattern: /\b(?:track|tracks|trail|spoor|footprints|follow signs|signs of passage)\b/i,
  },
  {
    id: 'investigation',
    skill: 'investigation',
    ability: 'int',
    label: 'Intelligence (Investigation)',
    pattern: /\b(?:investigate|examine|inspect|study|search)\b.*\b(?:mechanism|lock|writing|symbol|clue|desk|drawer|book|ledger|door|trap|room)\b/i,
  },
  {
    id: 'perception',
    skill: 'perception',
    ability: 'wis',
    label: 'Wisdom (Perception)',
    pattern: /\b(?:look around|listen|watch for|keep watch|scan|search the area|check the area)\b/i,
  },
  {
    id: 'persuasion',
    skill: 'persuasion',
    ability: 'cha',
    label: 'Charisma (Persuasion)',
    pattern: /\b(?:persuade|convince|rally|calm|reassure|appeal|negotiate|bargain|plead|ask .* nicely|make .* friendly)\b/i,
  },
  {
    id: 'deception',
    skill: 'deception',
    ability: 'cha',
    label: 'Charisma (Deception)',
    pattern: /\b(?:lie|bluff|deceive|pretend|fake|mislead|pose as|pass myself off)\b/i,
  },
  {
    id: 'intimidation',
    skill: 'intimidation',
    ability: 'cha',
    label: 'Charisma (Intimidation)',
    pattern: /\b(?:intimidate|threaten|scare|menace|loom over|pressure him|pressure her|pressure them)\b/i,
  },
  {
    id: 'performance',
    skill: 'performance',
    ability: 'cha',
    label: 'Charisma (Performance)',
    pattern: /\b(?:perform|speech|oration|play music|sing|dance|entertain|distract .* crowd)\b/i,
  },
];

const SPATIAL_VERBS = /\b(?:ask|talk|speak|buy|sell|repair|open|unlock|take|grab|pick|attack|hit|pet|touch|use|read|drink|eat|climb|enter|go through)\b/i;
const MOVEMENT_VERBS = /\b(?:go|walk|head|travel|move|return|enter|leave|approach|step|run|ride|follow|continue)\s+(?:to|toward|towards|into|inside|through|along|down|up|for)\b/i;
const ROLL_RESULT = /^\s*\[ROLL RESULT:/i;

function resolveIntent(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const ruleAction = lower.match(ACTION_PATTERN)?.[1] || null;
  const check = CHECK_RULES.find((rule) => rule.pattern.test(text)) || null;
  const isRollResult = ROLL_RESULT.test(text);
  const castsSpell = /\bcast(?:ing)?\s+([a-z][a-z' -]{1,40})\b/i.test(text);

  return {
    raw: text,
    isRollResult,
    castsSpell,
    ruleAction,
    check,
    isMechanicsAction: Boolean(isRollResult || castsSpell || ruleAction || check),
    mayNeedSpatialGuard: !isRollResult && !ruleAction && !check && (SPATIAL_VERBS.test(text) || MOVEMENT_VERBS.test(text)),
  };
}

module.exports = {
  resolveIntent,
  CHECK_RULES,
};
