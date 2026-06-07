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
    id: 'athletics',
    skill: 'athletics',
    ability: 'str',
    label: 'Strength (Athletics)',
    pattern: /\b(?:swim|climb|scramble|jump|leap|dive|pull myself|haul myself|hold on|grab hold)\b.*\b(?:dark water|water|river|stream|current|bridge support|ledge|wall|cliff|rope|rail|pit|drop)\b/i,
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
    pattern: /\b(?:persuade|convince|rally|calm|reassure|appeal|negotiate|bargain|plead|ask .* nicely|make .* friendly|befriend|win .* over|put .* at ease|set .* at ease|disarm .* with (?:kindness|charm|a smile))\b/i,
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
    pattern: /\b(?:perform|speech|oration|give .* speech|make .* speech|address .* crowd|play music|sing|dance|entertain|distract .* crowd)\b/i,
  },
];

const ACTION_CHECKS = {
  hide: 'stealth',
  search: 'perception',
  study: 'investigation',
  influence: 'persuasion',
};

const SAVE_RULES = [
  {
    id: 'dex',
    ability: 'dex',
    label: 'Dexterity Saving Throw',
    pattern: /\b(?:dive|duck|leap|jump|roll|twist|throw myself|avoid|evade|get out of the way)\b.*\b(?:trap|blast|fire|flame|lightning|falling|collapsing|rocks?|debris|spray|explosion|pit|arrow|dart)\b/i,
  },
  {
    id: 'con',
    ability: 'con',
    label: 'Constitution Saving Throw',
    pattern: /\b(?:resist|endure|withstand|shake off|hold my breath|push through)\b.*\b(?:poison|venom|disease|fumes|gas|toxin|cold|heat|exhaustion|pain|nausea)\b/i,
  },
  {
    id: 'wis',
    ability: 'wis',
    label: 'Wisdom Saving Throw',
    pattern: /\b(?:resist|shake off|steel my mind|clear my head|fight off)\b.*\b(?:charm|fear|illusion|compulsion|mind|whisper|enchantment|panic)\b/i,
  },
  {
    id: 'str',
    ability: 'str',
    label: 'Strength Saving Throw',
    pattern: /\b(?:hold on|brace|resist|stand firm|plant my feet)\b.*\b(?:push|pull|shove|drag|current|gust|force|grapple)\b/i,
  },
  {
    id: 'cha',
    ability: 'cha',
    label: 'Charisma Saving Throw',
    pattern: /\b(?:resist|reject|defy)\b.*\b(?:possession|banishment|planar|binding|curse)\b/i,
  },
  {
    id: 'int',
    ability: 'int',
    label: 'Intelligence Saving Throw',
    pattern: /\b(?:resist|solve|disbelieve|fight off)\b.*\b(?:psychic|mind blast|mental assault|phantasm|maze)\b/i,
  },
];

const SPATIAL_VERBS = /\b(?:ask|talk|speak|buy|sell|repair|open|unlock|take|grab|pick|attack|hit|pet|touch|use|read|drink|eat|climb|enter|go through)\b/i;
const MOVEMENT_VERBS = /\b(?:go|walk|head|travel|move|return|enter|leave|approach|step|run|ride|follow|continue)\s+(?:to|toward|towards|into|inside|through|along|down|up|for)\b|\b(?:follow|track)\b.{0,80}\b(?:to|toward|towards|into|inside|through|along|down|up)\b/i;
const ROLL_RESULT = /^\s*\[ROLL RESULT:/i;
const ABILITY_LABELS = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

function resolveIntent(message, options = {}) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const ruleAction = lower.match(ACTION_PATTERN)?.[1] || null;
  const check = parseExplicitCheck(text)
    || CHECK_RULES.find((rule) => rule.pattern.test(text))
    || inferContextualCheck(text, options.worldState)
    || checkForRuleAction(ruleAction);
  const save = parseExplicitSave(text) || SAVE_RULES.find((rule) => rule.pattern.test(text)) || null;
  const isRollResult = ROLL_RESULT.test(text);
  const castsSpell = /\bcast(?:ing)?\s+([a-z][a-z' -]{1,40})\b/i.test(text);

  return {
    raw: text,
    isRollResult,
    castsSpell,
    ruleAction,
    check,
    save,
    isMechanicsAction: Boolean(isRollResult || castsSpell || ruleAction || check || save),
    mayNeedSpatialGuard: !isRollResult && !ruleAction && !check && !save && (SPATIAL_VERBS.test(text) || MOVEMENT_VERBS.test(text)),
  };
}

function parseExplicitCheck(text) {
  const explicitSkill = String(text || '').match(/\b(?:make|roll|attempt)\s+(?:a\s+)?(?:dc\s+\d+\s+)?([a-z_ ]+?)\s+(?:skill\s+)?check\b/i);
  if (explicitSkill?.[1]) {
    const normalized = normalizeId(explicitSkill[1]);
    const skillRule = CHECK_RULES.find((rule) => rule.skill === normalized || rule.id === normalized);
    if (skillRule) return skillRule;
    const ability = parseAbility(normalized);
    if (ability) return abilityCheck(ability);
  }

  const abilityCheckMatch = String(text || '').match(/\b(strength|dexterity|constitution|intelligence|wisdom|charisma|str|dex|con|int|wis|cha)\s+(?:ability\s+)?check\b/i);
  const ability = parseAbility(abilityCheckMatch?.[1]);
  return ability ? abilityCheck(ability) : null;
}

function parseExplicitSave(text) {
  const match = String(text || '').match(/\b(strength|dexterity|constitution|intelligence|wisdom|charisma|str|dex|con|int|wis|cha)\s+(?:saving\s+throw|save)\b/i);
  const ability = parseAbility(match?.[1]);
  return ability ? saveRule(ability) : null;
}

function checkForRuleAction(ruleAction) {
  const skill = ACTION_CHECKS[ruleAction];
  return skill ? CHECK_RULES.find((rule) => rule.skill === skill) : null;
}

function inferContextualCheck(text, worldState = {}) {
  const npcs = normalizeList(worldState?.scene_presence?.present_npcs);
  const objects = normalizeList(worldState?.scene_presence?.present_objects);
  const lower = String(text || '').toLowerCase();

  if (isContextualPersuasion(lower, npcs)) return skillRule('persuasion');
  if (isContextualInsight(lower, npcs, objects)) return skillRule('insight');
  if (isContextualAthletics(lower, worldState)) return skillRule('athletics');
  if (isContextualInvestigation(lower, objects, npcs)) return skillRule('investigation');
  return null;
}

function isContextualPersuasion(text, npcs) {
  if (!/\b(?:introduce myself|be nice|friendly|polite|politely|warmly|gently|reassure|calm|appeal|disarm|befriend|win .* over|put .* at ease|set .* at ease|convince|persuade|negotiate)\b/i.test(text)) {
    return false;
  }
  return referencesAnyEntity(text, npcs) || npcs.length === 1;
}

function isContextualInsight(text, npcs, objects) {
  if (!/\b(?:study|watch|observe|read|size up|assess|gauge|scrutinize|look over)\b/i.test(text)) return false;
  if (referencesAnyEntity(text, objects)) return false;
  return referencesAnyEntity(text, npcs) || (npcs.length === 1 && !referencesObjectishNoun(text));
}

function isContextualInvestigation(text, objects, npcs) {
  if (!/\b(?:investigate|examine|inspect|study|search|check|read|look over|look at)\b/i.test(text)) return false;
  if (referencesAnyEntity(text, npcs) && !referencesAnyEntity(text, objects)) return false;
  return referencesAnyEntity(text, objects) || referencesObjectishNoun(text);
}

function isContextualAthletics(text, worldState = {}) {
  if (!/\b(?:swim|climb|scramble|jump|leap|dive|pull myself|haul myself|hold on|grab hold)\b/i.test(text)) return false;
  const sceneText = compact(JSON.stringify({
    location: worldState.current_location,
    scene: worldState.scene_presence,
    objects: worldState.object_states,
  }));
  const combined = `${compact(text)} ${sceneText}`;
  return /\b(?:water|river|stream|current|bridge|support|ledge|wall|cliff|pit|drop|dark|rain|slick|mud|rope|rail)\b/.test(combined);
}

function skillRule(skill) {
  return CHECK_RULES.find((rule) => rule.skill === skill) || null;
}

function abilityCheck(ability) {
  return {
    id: `${ability}_check`,
    skill: null,
    ability,
    label: `${ABILITY_LABELS[ability]} Check`,
    pattern: null,
  };
}

function saveRule(ability) {
  return {
    id: ability,
    ability,
    label: `${ABILITY_LABELS[ability]} Saving Throw`,
    pattern: null,
  };
}

function parseAbility(value) {
  const normalized = normalizeId(value);
  const aliases = {
    strength: 'str',
    dexterity: 'dex',
    constitution: 'con',
    intelligence: 'int',
    wisdom: 'wis',
    charisma: 'cha',
  };
  return aliases[normalized] || (ABILITY_LABELS[normalized] ? normalized : null);
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '')).filter(Boolean) : [];
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function referencesAnyEntity(text, entities = []) {
  const compactText = compact(text);
  if (!compactText || entities.length === 0) return false;
  return entities.some((entity) => referencesEntity(compactText, entity));
}

function referencesEntity(compactText, entity) {
  const compactEntity = compact(entity);
  if (!compactEntity) return false;
  if (compactText.includes(compactEntity)) return true;

  const entityTokens = compactEntity.split(' ').filter(isMeaningfulToken);
  return entityTokens.some((token) => compactText.includes(token));
}

function isMeaningfulToken(token) {
  return token.length >= 4 && ![
    'with',
    'that',
    'this',
    'from',
    'near',
    'door',
    'room',
    'road',
    'gate',
  ].includes(token);
}

function referencesObjectishNoun(text) {
  return /\b(?:note|letter|book|ledger|door|lock|chest|trap|room|writing|symbol|rune|clue|mechanism|drawer|desk|satchel|token|ash|mark|tracks?|footprints?|contents?)\b/i.test(text);
}

module.exports = {
  resolveIntent,
};
