function normalizeIdSet(ids) {
  if (ids == null) return null;
  return new Set([...ids].filter(Boolean).map(String));
}

function filterActivePartyPresenceRows(rows = [], { liveCharacterIds = null, excludeCharacterId = null } = {}) {
  const liveIds = normalizeIdSet(liveCharacterIds);
  const excluded = excludeCharacterId ? String(excludeCharacterId) : null;

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || row.presence !== 'present') return false;
    const characterId = row.character_id ? String(row.character_id) : '';
    if (excluded && characterId === excluded) return false;

    // Combatants stay present and vulnerable until combat ends, even if their
    // browser vanishes mid-fight.
    if (row.in_combat) return true;

    // If no live registry was provided, preserve existing behavior for callers
    // outside the Socket.io runtime.
    if (liveIds == null) return true;
    return liveIds.has(characterId);
  });
}

module.exports = {
  filterActivePartyPresenceRows,
};
