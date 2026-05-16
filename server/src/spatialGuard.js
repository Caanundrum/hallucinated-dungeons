const ABSENT_TARGETS = [
  {
    id: 'innkeeper',
    patterns: [/\binnkeeper\b/i, /\bkeeper\b/i],
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

function normalize(value) {
  return String(value || '').toLowerCase();
}

function npcAppearsPresent(worldState, target) {
  return (worldState.npcs_encountered || []).some((npc) => {
    const name = normalize(npc?.name);
    const lastSeen = normalize(npc?.last_seen);
    return target.patterns.some((pattern) => pattern.test(name) || pattern.test(lastSeen));
  });
}

function checkSpatialAction(message, worldState = {}) {
  const input = String(message || '');
  const location = String(worldState.current_location || '');
  if (!input.trim() || !location.trim()) return null;

  for (const target of ABSENT_TARGETS) {
    const mentionsTarget = target.patterns.some((pattern) => pattern.test(input));
    if (!mentionsTarget) continue;
    if (target.requiredLocation.test(location) || npcAppearsPresent(worldState, target)) return null;

    return {
      target: target.id,
      message: `You are currently at ${location}, and ${target.id === 'innkeeper' ? 'the innkeeper is not here' : `the ${target.id} is not here`}. Do you head to ${target.destination}?`,
    };
  }

  return null;
}

module.exports = { checkSpatialAction };
