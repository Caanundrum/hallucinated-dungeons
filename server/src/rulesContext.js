const { filterActivePartyPresenceRows } = require('./partyPresence');
const {
  REFEREE_CONTRACT_VERSION,
  assertValidEntity,
} = require('./refereeContracts');

const RULES_CONTEXT_VERSION = REFEREE_CONTRACT_VERSION;

function buildRulesContext({
  sessionId = null,
  worldState = {},
  characterSheet = null,
  partyPresence = [],
  liveCharacterIds = null,
  recentNarration = '',
} = {}) {
  const scene = worldState.scene_presence || {};
  const exactLocation = scene.exact_location || worldState.current_location || 'unknown location';
  const locationId = `location:${normalizeId(exactLocation) || 'unknown'}`;
  const entityMap = new Map();
  const position = buildPositionState(worldState, locationId, exactLocation);
  const actor = buildActor(characterSheet, worldState, sessionId);

  if (actor) {
    upsertEntity(entityMap, {
      id: actor.entity_id,
      type: 'pc',
      name: actor.name,
      aliases: [actor.name, 'player', 'active character', 'you'],
      source: 'active_character',
      character_id: actor.character_id,
      present: true,
      position,
      visibility: { visible: true },
      interactions: pcInteractions(),
    });
  }

  for (const row of filterActivePartyPresenceRows(partyPresence, { liveCharacterIds })) {
    const partyEntity = partyPresenceEntity(row, position);
    if (!partyEntity) continue;
    upsertEntity(entityMap, partyEntity);
  }

  for (const [index, name] of (scene.present_npcs || []).entries()) {
    upsertEntity(entityMap, sceneEntity({
      type: 'npc',
      name,
      source: 'scene_presence.present_npcs',
      index,
      position,
      interactions: npcInteractions(),
    }));
  }

  for (const [index, name] of (scene.present_objects || []).entries()) {
    upsertEntity(entityMap, sceneEntity({
      type: inferObjectType(name),
      name,
      source: 'scene_presence.present_objects',
      index,
      position,
      interactions: objectInteractions(name),
      objectState: objectStateFor(worldState, name),
    }));
  }

  for (const [index, item] of getCarriedObjects(worldState).entries()) {
    const name = item.name;
    upsertEntity(entityMap, sceneEntity({
      type: 'object',
      name,
      source: 'inventory_state.carried_objects',
      index,
      position: { ...position, relation: 'carried_by_player' },
      interactions: objectInteractions(name),
      objectState: objectStateFor(worldState, name) || { carried_by: 'player' },
    }));
  }

  for (const [index, name] of (scene.available_exits || []).entries()) {
    upsertEntity(entityMap, {
      id: uniqueSceneId('exit', name, index),
      type: 'location_exit',
      name,
      aliases: aliasesFor(name),
      source: 'scene_presence.available_exits',
      present: true,
      reachable: true,
      position,
      visibility: { visible: true },
      interactions: { move: true, enter: true, inspect: true },
    });
  }

  for (const [index, name] of (scene.nearby_locations || []).entries()) {
    upsertEntity(entityMap, {
      id: uniqueSceneId('nearby_location', name, index),
      type: 'known_location',
      name,
      aliases: aliasesFor(name),
      source: 'scene_presence.nearby_locations',
      present: false,
      reachable: true,
      position: { ...position, relation: 'nearby' },
      visibility: { visible: false, known: true },
      interactions: { move: true, ask_about: true },
    });
  }

  for (const [index, effect] of normalizeArray(worldState.active_effects).entries()) {
    upsertEntity(entityMap, effectEntity(effect, index, position));
  }

  mergeCombatants(entityMap, worldState, characterSheet, position);

  const entities = [...entityMap.values()].map(assertValidEntity);
  return {
    version: RULES_CONTEXT_VERSION,
    session_id: sessionId,
    actor,
    world: {
      current_location: worldState.current_location || exactLocation,
      exact_location: exactLocation,
      location_type: scene.location_type || null,
      time_state: worldState.time_state || {},
    },
    position_state: position,
    entity_state: entities,
    visibility_state: buildVisibilityState(entities),
    interaction_state: buildInteractionState(entities),
    party_state: buildPartyState({ activeActor: actor, partyPresence, liveCharacterIds }),
    combat_state: buildCombatContext(worldState, entities),
    adapters: {
      scene_presence: 'scene_presence_v1',
      position: worldState.map_state ? 'map_state_passthrough_v1' : 'scene_zone_v1',
      recent_narration_available: Boolean(String(recentNarration || '').trim()),
    },
  };
}

function buildPositionState(worldState, locationId, exactLocation) {
  const mapState = worldState.map_state || worldState.position_state || null;
  if (mapState?.map_id) {
    return {
      mode: mapState.mode || 'hex',
      location_id: locationId,
      exact_location: exactLocation,
      map_id: mapState.map_id,
      q: mapState.q ?? null,
      r: mapState.r ?? null,
      zone_id: mapState.zone_id || null,
    };
  }
  return {
    mode: 'scene_zone',
    location_id: locationId,
    exact_location: exactLocation,
    map_id: null,
    q: null,
    r: null,
    zone_id: normalizeId(exactLocation) || 'unknown',
  };
}

function buildActor(characterSheet, worldState, sessionId) {
  const identity = characterSheet?.identity || {};
  const derived = characterSheet?.derived_stats || {};
  const stats = worldState.player_stats || {};
  const characterId = stats.character_id || derived.character_id || identity.character_id || null;
  const name = identity.name || stats.name || null;
  if (!name && !characterId) return null;
  const idToken = characterId || normalizeId(name) || 'active_character';
  return {
    actor_id: `actor:${idToken}`,
    entity_id: `pc:${idToken}`,
    character_id: characterId,
    session_id: sessionId,
    name: name || 'Active character',
    class_id: identity.class || null,
    class_name: identity.class_name || identity.class || null,
    level: Number(identity.level || derived.level || 1),
  };
}

function partyPresenceEntity(row, position) {
  const sheet = row.characters?.character_sheet || {};
  const identity = sheet.identity || {};
  const characterId = row.character_id || sheet.derived_stats?.character_id || identity.character_id;
  const name = row.characters?.name || identity.name || characterId;
  if (!name && !characterId) return null;
  const idToken = characterId || normalizeId(name);
  return {
    id: `pc:${idToken}`,
    type: 'pc',
    name: name || 'Party character',
    aliases: [name, identity.name, row.characters?.name].filter(Boolean),
    source: 'party_presence',
    character_id: characterId || null,
    presence: row.presence || 'active',
    present: row.presence !== 'absent',
    combat_locked: Boolean(row.in_combat),
    position,
    visibility: { visible: row.presence !== 'absent' },
    interactions: pcInteractions(),
  };
}

function sceneEntity({ type, name, source, index, position, interactions, objectState = null }) {
  return {
    id: uniqueSceneId(type, name, index),
    type,
    name: String(name || '').trim(),
    aliases: aliasesFor(name),
    source,
    present: true,
    reachable: true,
    position,
    visibility: { visible: true },
    interactions,
    object_state: objectState || undefined,
  };
}

function effectEntity(effect = {}, index, position) {
  const name = effect.name || effect.id || `effect ${index + 1}`;
  return {
    id: uniqueSceneId('effect', `${name}_${effect.target || 'scene'}`, index),
    type: 'active_effect',
    name,
    aliases: aliasesFor(name),
    source: effect.source_type || 'active_effects',
    present: true,
    reachable: false,
    position,
    target: effect.target || null,
    owner: effect.source || null,
    duration: effect.duration || null,
    remaining_rounds: effect.remaining_rounds ?? null,
    remaining_minutes: effect.remaining_minutes ?? null,
    concentration: Boolean(effect.concentration),
    visibility: { visible: true },
    interactions: { inspect: true, dispel: true },
    rules_effects: effect.rules_effects || [],
  };
}

function mergeCombatants(entityMap, worldState, characterSheet, fallbackPosition) {
  const combatants = normalizeArray(worldState.combat_state?.combatants);
  for (const [index, combatant] of combatants.entries()) {
    const baseId = combatant.is_player
      ? `pc:${combatant.character_id || worldState.player_stats?.character_id || characterSheet?.derived_stats?.character_id || normalizeId(combatant.name) || 'active_character'}`
      : `creature:${normalizeId(combatant.name) || `combatant_${index}`}`;
    const existing = entityMap.get(baseId);
    const combatData = {
      active_in_combat: true,
      initiative: combatant.initiative ?? null,
      hp: combatant.hp ?? null,
      max_hp: combatant.max_hp ?? null,
      ac: combatant.ac ?? null,
      conditions: combatant.conditions || [],
      is_player: Boolean(combatant.is_player),
    };
    if (existing) {
      entityMap.set(baseId, {
        ...existing,
        present: true,
        position: combatant.position || combatant.map_position || existing.position || fallbackPosition,
        combat: combatData,
        interactions: {
          ...(existing.interactions || {}),
          attack: !combatant.is_player,
          target_spell: true,
        },
      });
      continue;
    }
    upsertEntity(entityMap, {
      id: baseId,
      type: combatant.is_player ? 'pc' : 'creature',
      name: combatant.name || `Combatant ${index + 1}`,
      aliases: aliasesFor(combatant.name),
      source: 'combat_state.combatants',
      present: true,
      reachable: true,
      position: combatant.position || combatant.map_position || fallbackPosition,
      visibility: { visible: true },
      interactions: combatant.is_player ? pcInteractions() : npcInteractions(),
      combat: combatData,
    });
  }
}

function buildVisibilityState(entities) {
  return {
    visible_entity_ids: entities.filter((entity) => entity.visibility?.visible).map((entity) => entity.id),
    known_entity_ids: entities.filter((entity) => entity.visibility?.known || entity.visibility?.visible).map((entity) => entity.id),
    hidden_entity_ids: entities.filter((entity) => entity.visibility?.hidden).map((entity) => entity.id),
    obscured_entity_ids: entities.filter((entity) => entity.visibility?.obscured).map((entity) => entity.id),
  };
}

function buildInteractionState(entities) {
  const byEntityId = {};
  for (const entity of entities) {
    byEntityId[entity.id] = {
      present: Boolean(entity.present),
      reachable: entity.reachable !== false && Boolean(entity.present || entity.type === 'known_location'),
      interactions: entity.interactions || {},
    };
  }
  return {
    by_entity_id: byEntityId,
    interactable_entity_ids: entities.filter((entity) => Object.values(entity.interactions || {}).some(Boolean)).map((entity) => entity.id),
    targetable_entity_ids: entities.filter((entity) => entity.interactions?.attack || entity.interactions?.target_spell).map((entity) => entity.id),
    reachable_entity_ids: entities.filter((entity) => byEntityId[entity.id]?.reachable).map((entity) => entity.id),
  };
}

function buildPartyState({ activeActor, partyPresence, liveCharacterIds }) {
  const rows = filterActivePartyPresenceRows(partyPresence, { liveCharacterIds });
  const members = rows.map((row) => {
    const sheet = row.characters?.character_sheet || {};
    const identity = sheet.identity || {};
    return {
      character_id: row.character_id,
      entity_id: `pc:${row.character_id || normalizeId(row.characters?.name || identity.name)}`,
      name: row.characters?.name || identity.name || row.character_id,
      presence: row.presence || 'active',
      combat_locked: Boolean(row.in_combat),
    };
  });
  if (activeActor && !members.some((member) => member.entity_id === activeActor.entity_id)) {
    members.unshift({
      character_id: activeActor.character_id,
      entity_id: activeActor.entity_id,
      name: activeActor.name,
      presence: 'active',
      combat_locked: false,
    });
  }
  return {
    active_actor_entity_id: activeActor?.entity_id || null,
    members,
    multiplayer_ready: true,
  };
}

function buildCombatContext(worldState, entities) {
  const combat = worldState.combat_state || null;
  if (!combat?.active) return { active: false };
  return {
    active: true,
    round: Number(combat.round || 1),
    turn_index: Number(combat.turn_index || 0),
    combatant_entity_ids: entities
      .filter((entity) => entity.combat?.active_in_combat)
      .map((entity) => entity.id),
    turn_resources: combat.turn_resources || null,
  };
}

function findEntity(rulesContext, target, { requirePresent = false, types = null } = {}) {
  const normalizedTarget = normalizeId(target);
  if (!normalizedTarget) return null;
  const allowedTypes = types ? new Set(types) : null;
  return (rulesContext?.entity_state || []).find((entity) => {
    if (allowedTypes && !allowedTypes.has(entity.type)) return false;
    if (requirePresent && !entity.present) return false;
    return entity.id === target
      || normalizeId(entity.name) === normalizedTarget
      || (entity.aliases || []).some((alias) => idsOverlap(alias, target));
  }) || null;
}

function canInteract(rulesContext, targetOrEntityId, interaction = 'use') {
  const entity = findEntity(rulesContext, targetOrEntityId) || (rulesContext?.entity_state || []).find((item) => item.id === targetOrEntityId);
  if (!entity) {
    return { ok: false, reason: 'entity_not_found' };
  }
  const state = rulesContext.interaction_state?.by_entity_id?.[entity.id] || {};
  if (!state.present && entity.type !== 'known_location') {
    return { ok: false, reason: 'entity_not_present', entity };
  }
  if (state.reachable === false) {
    return { ok: false, reason: 'entity_not_reachable', entity };
  }
  if (!state.interactions?.[interaction]) {
    return { ok: false, reason: 'interaction_not_supported', entity };
  }
  return { ok: true, entity };
}

function summarizeRulesContextForPrompt(rulesContext = {}) {
  const entities = rulesContext.entity_state || [];
  const visible = entities
    .filter((entity) => entity.visibility?.visible && ['pc', 'npc', 'creature', 'object', 'active_effect', 'location_exit'].includes(entity.type))
    .slice(0, 16)
    .map((entity) => `${entity.id}=${entity.name}`)
    .join('; ') || 'none';
  const actor = rulesContext.actor
    ? `${rulesContext.actor.entity_id} (${rulesContext.actor.name}, ${rulesContext.actor.class_name || 'unknown class'} level ${rulesContext.actor.level})`
    : 'none';
  return [
    `Rules context version: ${rulesContext.version || RULES_CONTEXT_VERSION}.`,
    `Actor: ${actor}.`,
    `Position mode: ${rulesContext.position_state?.mode || 'scene_zone'} at ${rulesContext.world?.exact_location || 'unknown location'}.`,
    `Visible/targetable entities: ${visible}.`,
    'Use entity presence, reachability, visibility, and interactions before narrating an action as successful.',
  ].join('\n');
}

function upsertEntity(map, entity) {
  if (!entity?.id) return;
  const existing = map.get(entity.id);
  if (!existing) {
    map.set(entity.id, entity);
    return;
  }
  map.set(entity.id, {
    ...existing,
    ...entity,
    aliases: [...new Set([...(existing.aliases || []), ...(entity.aliases || [])])],
    interactions: { ...(existing.interactions || {}), ...(entity.interactions || {}) },
    visibility: { ...(existing.visibility || {}), ...(entity.visibility || {}) },
  });
}

function pcInteractions() {
  return { inspect: true, talk: true, target_spell: true, help: true };
}

function npcInteractions() {
  return { inspect: true, talk: true, attack: true, target_spell: true, influence: true };
}

function objectInteractions(name) {
  const text = String(name || '').toLowerCase();
  return {
    inspect: true,
    read: /\b(note|letter|book|paper|parchment|scroll|sign|notice|writing|symbol|rune)\b/.test(text),
    take: /\b(note|letter|coin|key|token|ring|vial|book|paper|parchment|scroll|satchel|bag|gem|bottle)\b/.test(text),
    open: /\b(door|chest|box|gate|satchel|bag|drawer|container)\b/.test(text),
    unlock: /\b(door|chest|box|gate|drawer|lock)\b/.test(text),
    attack: /\b(door|barrel|crate|object|dummy|target)\b/.test(text),
    use: true,
  };
}

function objectStateFor(worldState = {}, name = '') {
  const key = normalizeId(name);
  return worldState.object_states?.[key] || null;
}

function getCarriedObjects(worldState = {}) {
  const listed = Array.isArray(worldState.inventory_state?.carried_objects)
    ? worldState.inventory_state.carried_objects
    : [];
  const objectStateCarried = Object.values(worldState.object_states || {})
    .filter((entry) => entry?.carried_by === 'player')
    .map((entry) => ({ name: entry.name, source_location: entry.location || '' }));
  const byKey = new Map();
  for (const item of [...listed, ...objectStateCarried]) {
    if (!item?.name) continue;
    byKey.set(normalizeId(item.name), { name: item.name, source_location: item.source_location || '' });
  }
  return [...byKey.values()];
}

function inferObjectType(name) {
  return /\b(trap|hazard|fire|pit|acid|poison|gas|flame)\b/i.test(String(name || '')) ? 'hazard' : 'object';
}

function aliasesFor(name) {
  const clean = String(name || '').trim();
  const normalized = normalizeId(clean);
  return [...new Set([clean, normalized, singularize(normalized).replaceAll('_', ' ')].filter(Boolean))];
}

function uniqueSceneId(type, name, index = 0) {
  const normalized = normalizeId(name) || `${type}_${index + 1}`;
  return `${type}:${normalized}`;
}

function idsOverlap(left, right) {
  const leftId = normalizeId(left);
  const rightId = normalizeId(right);
  if (!leftId || !rightId) return false;
  if (leftId === rightId || leftId.includes(rightId) || rightId.includes(leftId)) return true;
  const leftTokens = new Set(leftId.split('_').filter((token) => token.length >= 4));
  return rightId.split('_').some((token) => token.length >= 4 && leftTokens.has(token));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function singularize(value) {
  return value.endsWith('s') && value.length > 3 ? value.slice(0, -1) : value;
}

module.exports = {
  RULES_CONTEXT_VERSION,
  buildRulesContext,
  findEntity,
  canInteract,
  summarizeRulesContextForPrompt,
};
