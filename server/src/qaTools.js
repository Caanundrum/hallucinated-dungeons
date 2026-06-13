const crypto = require('crypto');

const { getXpThreshold, setCharacterXp } = require('./progressionEngine');

function isQaToolsEnabled(env = process.env) {
  return Boolean(String(env.QA_TOOLS_SECRET || '').trim());
}

function hasValidQaToolsSecret(req, env = process.env) {
  const expected = String(env.QA_TOOLS_SECRET || '').trim();
  if (!expected) return false;

  const supplied = getQaSecretFromRequest(req);
  if (!supplied) return false;
  return timingSafeEqualString(supplied, expected);
}

function getQaSecretFromRequest(req = {}) {
  const headerValue = getHeader(req, 'x-qa-tools-secret');
  if (headerValue) return String(headerValue).trim();

  const authorization = getHeader(req, 'authorization');
  const bearer = String(authorization || '').match(/^Bearer\s+(.+)$/i);
  return bearer ? bearer[1].trim() : '';
}

function buildLevelUpReadySheet(characterSheet = {}, options = {}) {
  const currentLevel = Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
  const nextLevel = currentLevel + 1;
  const threshold = getXpThreshold(nextLevel);
  if (threshold === null) {
    return {
      ok: false,
      error: `No XP threshold is configured for level ${nextLevel}.`,
    };
  }

  const requestedXp = options.xp === undefined || options.xp === null
    ? threshold
    : Number(options.xp);
  const targetXp = Math.max(threshold, Number.isFinite(requestedXp) ? Math.floor(requestedXp) : threshold);
  const nextSheet = setCharacterXp(characterSheet, targetXp, {
    sourceType: 'qa',
    sourceId: options.sourceId || `qa:level_up_ready:${nextLevel}`,
    reason: options.reason || `QA level-up readiness for level ${nextLevel}`,
    metadata: {
      tool: 'qa_level_up_ready',
      target_level: nextLevel,
      ...(options.metadata || {}),
    },
  });

  return {
    ok: true,
    characterSheet: nextSheet,
    currentLevel,
    nextLevel,
    threshold,
    targetXp,
  };
}

function normalizeQaCharacterName(value = '') {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!/^qa\b/i.test(name)) return null;
  return name;
}

function getHeader(req, name) {
  if (typeof req.get === 'function') return req.get(name);
  const headers = req.headers || {};
  const lowerName = String(name).toLowerCase();
  return headers[name] || headers[lowerName] || '';
}

function timingSafeEqualString(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  if (first.length !== second.length) return false;
  return crypto.timingSafeEqual(first, second);
}

module.exports = {
  buildLevelUpReadySheet,
  getQaSecretFromRequest,
  hasValidQaToolsSecret,
  isQaToolsEnabled,
  normalizeQaCharacterName,
};
