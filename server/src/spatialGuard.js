const ABSENT_TARGETS = [
  {
    id: 'innkeeper',
    patterns: [/\binnkeeper\b/i],
    requiredLocation: /\b(inn|tavern|alehouse|taproom|common room|leaning lantern)\b/i,
    destination: 'the inn',
  },
  {
    id: 'blacksmith',
    patterns: [/\bblacksmith\b/i, /\bsmith\b/i],
    requiredLocation: /\b(forge|smithy|blacksmith)\b/i,
    destination: 'the smithy',
  },
  {
    id: 'shopkeeper',
    patterns: [/\bshopkeeper\b/i, /\bmerchant\b/i, /\bstorekeeper\b/i],
    requiredLocation: /\b(shop|market|store|stall|merchant)\b/i,
    destination: 'the shop or market',
  },
  {
    id: 'priest',
    patterns: [/\bpriest\b/i, /\bcleric\b/i, /\bacolyte\b/i],
    requiredLocation: /\b(temple|shrine|chapel|sanctuary)\b/i,
    destination: 'the temple or shrine',
  },
  {
    id: 'guard',
    patterns: [/\bguard\b/i, /\bwatchman\b/i, /\bwatchmen\b/i],
    requiredLocation: /\b(gate|guard|watch|barracks|street|wall|tower)\b/i,
    destination: 'the nearest guard',
  },
];

const INTERACTION_VERBS = /\b(ask|talk|speak|buy|sell|repair|open|unlock|search|inspect|examine|take|grab|pick|attack|hit|pet|touch|use|read|drink|eat|climb|enter|go through)\b/i;
const MOVEMENT_VERBS = /\b(go|walk|head|travel|move|return|enter|leave|approach|step|run|ride|follow|continue)\s+(?:to|toward|towards|into|inside|through|along|down|up|for)\b/i;
const LOCATION_PREPOSITIONS = /\b(?:in|inside|at|within|on)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z' -]{2,40})\b/i;
const DEFINITE_TARGET = /\b(?:the|that)\s+([a-z][a-z' -]{2,40})\b/i;
const ASK_FOR_INFORMATION = /\b(?:ask|asks|asking|inquire|inquires|request|requests)\s+(?:about|after|for)\b/i;
const RULES_ACTION_DECLARATION = /\b(?:take|use|ready)\s+the\s+(?:attack|dash|disengage|dodge|help|hide|influence|magic|search|study|utilize|ready)\s+action\b/i;
const VAGUE_TARGETS = new Set([
  'guy',
  'person',
  'someone',
  'somebody',
  'man',
  'woman',
  'people',
  'way',
  'area',
  'place',
  'road',
  'path',
  'street',
  'town',
  'village',
  'city',
  'forest',
  'room',
  'building',
  'thing',
  'stuff',
  'ground',
  'air',
  'rain',
  'dark',
]);

function normalize(value) {
  return String(value || '').toLowerCase();
}

function compact(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function singularize(value) {
  return value.endsWith('s') && value.length > 3 ? value.slice(0, -1) : value;
}

function listIncludesTerm(list = [], term) {
  const normalizedTerm = singularize(compact(term));
  if (!normalizedTerm) return false;
  return list.some((item) => {
    const normalizedItem = singularize(compact(item));
    return normalizedItem === normalizedTerm
      || normalizedItem.includes(normalizedTerm)
      || normalizedTerm.includes(normalizedItem);
  });
}

function npcAppearsPresent(worldState, target) {
  const sceneNpcs = worldState.scene_presence?.present_npcs || [];
  const sceneHasNpc = sceneNpcs.some((npcName) => target.patterns.some((pattern) => pattern.test(String(npcName))));
  if (worldState.scene_presence?.exact_location) return sceneHasNpc;
  if (sceneHasNpc) return true;

  return (worldState.npcs_encountered || []).some((npc) => {
    const name = normalize(npc?.name);
    const lastSeen = normalize(npc?.last_seen);
    return target.patterns.some((pattern) => pattern.test(name) || pattern.test(lastSeen));
  });
}

function currentLocation(worldState) {
  return String(worldState.scene_presence?.exact_location || worldState.current_location || '');
}

function locationSummary(worldState) {
  const scene = worldState.scene_presence || {};
  return [
    currentLocation(worldState),
    scene.location_type,
    ...(scene.present_objects || []),
    ...(scene.available_exits || []),
  ].join(' ');
}

function isKnownPresentOrReachable(worldState, term) {
  const scene = worldState.scene_presence || {};
  const location = currentLocation(worldState);
  return listIncludesTerm([location, scene.location_type], term)
    || listIncludesTerm(scene.present_npcs, term)
    || listIncludesTerm(scene.present_objects, term)
    || listIncludesTerm(scene.available_exits, term)
    || listIncludesTerm(scene.nearby_locations, term);
}

function cleanCandidate(value) {
  const cleaned = compact(value)
    .replace(/\b(to|from|with|about|for|in|inside|at|on|within|before|after|while|and|or|but|as|so|because)\b.*$/i, '')
    .trim();
  if (!cleaned || cleaned.length < 3 || VAGUE_TARGETS.has(cleaned)) return '';
  return cleaned;
}

function findGenericSpatialIssue(input, worldState) {
  const scene = worldState.scene_presence;
  if (!scene || !scene.exact_location) return null;
  if (RULES_ACTION_DECLARATION.test(input)) return null;
  if (!INTERACTION_VERBS.test(input) || MOVEMENT_VERBS.test(input)) return null;
  if (ASK_FOR_INFORMATION.test(input) && (scene.present_npcs || []).length > 0) return null;

  const locationMatch = input.match(LOCATION_PREPOSITIONS);
  if (locationMatch) {
    const place = cleanCandidate(locationMatch[1]);
    if (place && !isKnownPresentOrReachable(worldState, place)) {
      return {
        target: place,
        message: `You are currently at ${currentLocation(worldState)}, and no specific ${place} has been established here. Do you look for a way to reach one, or clarify where you mean?`,
      };
    }
  }

  const targetMatch = input.match(DEFINITE_TARGET);
  if (targetMatch) {
    const target = cleanCandidate(targetMatch[1]);
    if (target && !isKnownPresentOrReachable(worldState, target)) {
      return {
        target,
        message: `You are currently at ${currentLocation(worldState)}, and ${target} is not here. Do you look around for it, or clarify where you mean?`,
      };
    }
  }

  return null;
}

function checkSpatialAction(message, worldState = {}) {
  const input = String(message || '');
  const location = currentLocation(worldState);
  if (!input.trim() || !location.trim()) return null;

  for (const target of ABSENT_TARGETS) {
    const mentionsTarget = target.patterns.some((pattern) => pattern.test(input));
    if (!mentionsTarget) continue;
    if (target.requiredLocation.test(locationSummary(worldState)) || npcAppearsPresent(worldState, target)) return null;

    return {
      target: target.id,
      message: `You are currently at ${location}, and ${target.id === 'innkeeper' ? 'the innkeeper is not here' : `the ${target.id} is not here`}. Do you head to ${target.destination}?`,
    };
  }

  return findGenericSpatialIssue(input, worldState);
}

module.exports = { checkSpatialAction };
