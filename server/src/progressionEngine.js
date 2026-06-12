const XP_THRESHOLDS = require('../data/xp_thresholds.json');

const MAX_STORED_AWARDS = 200;

function applyProgressionAwards({
  beforeWorldState = {},
  afterWorldState = {},
  characterSheet = {},
  currentTurn = 0,
} = {}) {
  if (!characterSheet?.identity) {
    return {
      worldState: afterWorldState,
      characterSheet,
      awards: [],
      levelUpAvailable: null,
    };
  }

  const progression = normalizeProgression(afterWorldState.progression);
  const existingAwardIds = new Set([
    ...Object.keys(progression.awarded_source_ids || {}),
    ...(progression.xp_awards || []).map((award) => award.source_id).filter(Boolean),
  ]);

  const candidateAwards = [
    ...detectCombatAwards({ beforeWorldState, afterWorldState, currentTurn }),
    ...detectDiscoveryAwards({ beforeWorldState, afterWorldState }),
    ...detectSocialAwards({ beforeWorldState, afterWorldState }),
  ];

  const timestamp = new Date().toISOString();
  const awards = [];
  for (const award of candidateAwards) {
    if (!award.source_id || existingAwardIds.has(award.source_id)) continue;
    existingAwardIds.add(award.source_id);
    awards.push({
      id: `xp_${normalizeId(award.source_id)}_${currentTurn || afterWorldState.session_turn || 0}`,
      amount: Math.max(0, Number(award.amount || 0)),
      source_type: award.source_type || 'unknown',
      source_id: award.source_id,
      reason: award.reason || 'meaningful progress',
      session_turn: Number(currentTurn ?? afterWorldState.session_turn ?? 0),
      awarded_at: timestamp,
      metadata: award.metadata || {},
    });
  }

  const totalAwarded = awards.reduce((sum, award) => sum + Number(award.amount || 0), 0);
  if (totalAwarded <= 0) {
    return {
      worldState: afterWorldState,
      characterSheet,
      awards: [],
      levelUpAvailable: progression.level_up_available || null,
    };
  }

  const currentXp = getCharacterXp(characterSheet);
  const nextXp = currentXp + totalAwarded;
  const currentLevel = getCharacterLevel(characterSheet);
  const nextLevel = currentLevel + 1;
  const nextThreshold = getXpThreshold(nextLevel);
  const levelUpAvailable = nextThreshold !== null && nextXp >= nextThreshold
    ? {
        ready: true,
        current_level: currentLevel,
        next_level: nextLevel,
        threshold: nextThreshold,
        current_xp: nextXp,
      }
    : progression.level_up_available || null;

  const awardedSourceIds = {
    ...(progression.awarded_source_ids || {}),
    ...Object.fromEntries(awards.map((award) => [award.source_id, award.awarded_at])),
  };
  const xpAwards = [...(progression.xp_awards || []), ...awards].slice(-MAX_STORED_AWARDS);
  const nextProgression = {
    ...progression,
    xp_awards: xpAwards,
    awarded_source_ids: awardedSourceIds,
    last_awards: awards,
    total_xp_awarded: Number(progression.total_xp_awarded || 0) + totalAwarded,
    level_up_available: levelUpAvailable,
  };

  const nextSheet = withProgressionOnCharacterSheet({
    characterSheet,
    xp: nextXp,
    levelUpAvailable,
    xpAwards,
  });
  const nextWorldState = {
    ...afterWorldState,
    progression: nextProgression,
    player_stats: {
      ...(afterWorldState.player_stats || {}),
      experience_points: nextXp,
      level_up_available: levelUpAvailable,
    },
  };

  return {
    worldState: nextWorldState,
    characterSheet: nextSheet,
    awards,
    levelUpAvailable,
  };
}

function formatProgressionAwardSummary({ awards = [], characterSheet = {} } = {}) {
  if (!awards.length) return '';
  const totalAwarded = awards.reduce((sum, award) => sum + Number(award.amount || 0), 0);
  const xp = getCharacterXp(characterSheet);
  const level = getCharacterLevel(characterSheet);
  const threshold = getXpThreshold(level + 1);
  const reasons = awards.map((award) => `${award.amount} for ${award.reason}`).join('; ');
  const thresholdText = threshold === null ? `${xp} XP` : `${xp}/${threshold} XP`;
  const levelUp = characterSheet.progression?.level_up_available?.ready
    ? `\n\n**Level Up Available:** you have enough XP for level ${characterSheet.progression.level_up_available.next_level}. Open your character sheet when the level-up flow is available.`
    : '';
  return `**XP:** +${totalAwarded} (${reasons}). Total: ${thresholdText}.${levelUp}`;
}

function detectCombatAwards({ beforeWorldState = {}, afterWorldState = {}, currentTurn = 0 } = {}) {
  const beforeCombat = beforeWorldState.combat_state;
  const afterCombat = afterWorldState.combat_state;
  if (!beforeCombat?.active || afterCombat?.active) return [];

  const enemies = (beforeCombat.combatants || [])
    .filter((combatant) => !combatant.is_player);
  if (!enemies.length) return [];

  const amount = enemies.reduce((sum, enemy) => sum + getCombatantXp(enemy), 0);
  if (amount <= 0) return [];

  const enemyNames = enemies.map((enemy) => enemy.name || enemy.id || 'enemy').join(', ');
  const sourceId = [
    'combat',
    beforeCombat.encounter_id || beforeCombat.combat_id || beforeCombat.started_turn || beforeWorldState.session_turn || currentTurn || 'turn',
    normalizeId(enemyNames),
  ].join(':');

  return [{
    source_type: 'combat',
    source_id: sourceId,
    amount,
    reason: `resolving combat with ${enemyNames}`,
    metadata: {
      enemies: enemies.map((enemy) => ({
        id: enemy.id || null,
        name: enemy.name || 'Enemy',
        xp: getCombatantXp(enemy),
        max_hp: Number(enemy.max_hp || enemy.hp || 0),
      })),
    },
  }];
}

function detectDiscoveryAwards({ beforeWorldState = {}, afterWorldState = {} } = {}) {
  const before = normalizeDiscoveryState(beforeWorldState.discovery_state);
  const after = normalizeDiscoveryState(afterWorldState.discovery_state);
  const awards = [];

  for (const bucket of ['searches', 'studies']) {
    const action = bucket === 'searches' ? 'search' : 'study';
    for (const [key, entry] of Object.entries(after[bucket] || {})) {
      const previous = before[bucket]?.[key] || {};
      if (!isSuccessfulDiscovery(entry) || isSuccessfulDiscovery(previous)) continue;
      const subject = entry.subject ? ` about ${entry.subject}` : '';
      awards.push({
        source_type: 'discovery',
        source_id: `discovery:${action}:${key}:${normalizeId(entry.subject || '')}`,
        amount: 25,
        reason: `${action} discovery for ${entry.target || key}${subject}`,
        metadata: {
          action,
          target: entry.target || key,
          subject: entry.subject || '',
          location: entry.location || '',
        },
      });
    }
  }

  return awards;
}

function detectSocialAwards({ beforeWorldState = {}, afterWorldState = {} } = {}) {
  const beforeStates = beforeWorldState.npc_states || {};
  const afterStates = afterWorldState.npc_states || {};
  const awards = [];

  for (const [key, entry] of Object.entries(afterStates)) {
    const latest = entry?.last_influence || {};
    if (latest.outcome !== 'success') continue;
    const previous = beforeStates[key]?.last_influence || {};
    if (
      previous.outcome === latest.outcome
      && previous.skill === latest.skill
      && Number(previous.total || 0) === Number(latest.total || 0)
      && Number(previous.dc || 0) === Number(latest.dc || 0)
    ) {
      continue;
    }
    const history = Array.isArray(entry.influence_history) ? entry.influence_history : [];
    const intent = history.at(-1)?.intent || `${latest.skill || 'social'} ${entry.name || key}`;
    awards.push({
      source_type: 'social',
      source_id: `social:${key}:${latest.skill || 'influence'}:${normalizeId(intent).slice(0, 64)}`,
      amount: 25,
      reason: `meaningful ${latest.skill || 'social'} success with ${entry.name || key}`,
      metadata: {
        target: entry.name || key,
        skill: latest.skill || '',
        attitude: entry.attitude || '',
        leverage: entry.leverage || '',
      },
    });
  }

  return awards;
}

function withProgressionOnCharacterSheet({
  characterSheet = {},
  xp = 0,
  levelUpAvailable = null,
  xpAwards = [],
} = {}) {
  const level = getCharacterLevel(characterSheet);
  const nextThreshold = getXpThreshold(level + 1);
  return {
    ...characterSheet,
    identity: {
      ...(characterSheet.identity || {}),
      experience_points: xp,
      next_level_xp: nextThreshold,
      level_up_available: Boolean(levelUpAvailable?.ready),
    },
    progression: {
      ...(characterSheet.progression || {}),
      experience_points: xp,
      next_level_xp: nextThreshold,
      xp_awards: xpAwards,
      level_up_available: levelUpAvailable,
    },
  };
}

function setCharacterXp(characterSheet = {}, xp = 0, options = {}) {
  const priorProgression = characterSheet.progression || {};
  const progression = normalizeProgression(priorProgression);
  const currentXp = getCharacterXp(characterSheet);
  const nextXp = Math.max(0, Math.floor(Number(xp || 0)));
  const level = getCharacterLevel(characterSheet);
  const nextThreshold = getXpThreshold(level + 1);
  const levelUpAvailable = nextThreshold !== null && nextXp >= nextThreshold
    ? {
        ready: true,
        current_level: level,
        next_level: level + 1,
        threshold: nextThreshold,
        current_xp: nextXp,
      }
    : null;

  const awardedSourceIds = { ...(progression.awarded_source_ids || {}) };
  const xpAwards = [...(progression.xp_awards || [])];
  const sourceId = options.sourceId || null;
  const amount = Math.max(0, nextXp - currentXp);
  let totalXpAwarded = Number(progression.total_xp_awarded || 0);

  if (sourceId && amount > 0 && !awardedSourceIds[sourceId]) {
    const timestamp = new Date().toISOString();
    awardedSourceIds[sourceId] = timestamp;
    totalXpAwarded += amount;
    xpAwards.push({
      id: `xp_${normalizeId(sourceId)}_${Date.now()}`,
      amount,
      source_type: options.sourceType || 'manual',
      source_id: sourceId,
      reason: options.reason || 'manual XP adjustment',
      session_turn: Number(options.sessionTurn || 0),
      awarded_at: timestamp,
      metadata: options.metadata || {},
    });
  }

  return {
    ...withProgressionOnCharacterSheet({
      characterSheet,
      xp: nextXp,
      levelUpAvailable,
      xpAwards: xpAwards.slice(-MAX_STORED_AWARDS),
    }),
    progression: {
      ...priorProgression,
      ...progression,
      experience_points: nextXp,
      next_level_xp: nextThreshold,
      xp_awards: xpAwards.slice(-MAX_STORED_AWARDS),
      awarded_source_ids: awardedSourceIds,
      total_xp_awarded: totalXpAwarded,
      level_up_available: levelUpAvailable,
    },
  };
}

function normalizeProgression(value = {}) {
  const progression = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    xp_awards: Array.isArray(progression.xp_awards) ? progression.xp_awards : [],
    awarded_source_ids: progression.awarded_source_ids && typeof progression.awarded_source_ids === 'object'
      ? progression.awarded_source_ids
      : {},
    last_awards: Array.isArray(progression.last_awards) ? progression.last_awards : [],
    total_xp_awarded: Number(progression.total_xp_awarded || 0),
    level_up_available: progression.level_up_available || null,
  };
}

function normalizeDiscoveryState(value = {}) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    searches: state.searches || {},
    studies: state.studies || {},
  };
}

function isSuccessfulDiscovery(entry = {}) {
  return Boolean(entry?.discovered) || entry?.best_outcome === 'success';
}

function getCombatantXp(combatant = {}) {
  const explicit = Number(combatant.xp_value ?? combatant.xp ?? combatant.experience_points);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const maxHp = Number(combatant.max_hp || combatant.hp || 0);
  if (maxHp <= 8) return 25;
  if (maxHp <= 15) return 50;
  if (maxHp <= 30) return 100;
  return 200;
}

function getCharacterXp(characterSheet = {}) {
  return Number(
    characterSheet.identity?.experience_points
      ?? characterSheet.progression?.experience_points
      ?? 0
  );
}

function getCharacterLevel(characterSheet = {}) {
  return Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1);
}

function getXpThreshold(level) {
  const value = XP_THRESHOLDS[String(level)];
  return value === undefined ? null : Number(value);
}

function normalizeId(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

module.exports = {
  applyProgressionAwards,
  detectCombatAwards,
  detectDiscoveryAwards,
  detectSocialAwards,
  formatProgressionAwardSummary,
  getXpThreshold,
  setCharacterXp,
};
