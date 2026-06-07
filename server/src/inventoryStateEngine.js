const { getContentBundle } = require('./contentData');

function syncInventoryStateFromCharacterSheet(worldState = {}, characterSheet = {}, content = getContentBundle(), options = {}) {
  const currentInventory = normalizeInventoryState(worldState.inventory_state);
  const sheetObjects = buildSheetCarriedObjects(characterSheet, content);
  const characterId = options.characterId
    || characterSheet.derived_stats?.character_id
    || characterSheet.identity?.character_id
    || null;
  const sameOwner = !characterId || !currentInventory.character_id || currentInventory.character_id === characterId;
  const currentCarried = sameOwner && !options.resetCarriedObjects
    ? currentInventory.carried_objects
    : [];
  const carriedObjects = mergeCarriedObjects(currentCarried, sheetObjects, worldState.object_states);

  return {
    ...worldState,
    inventory_state: {
      ...currentInventory,
      character_id: characterId || currentInventory.character_id || null,
      carried_objects: carriedObjects,
    },
  };
}

function buildSheetCarriedObjects(characterSheet = {}, content = getContentBundle()) {
  const equipmentById = new Map((content.equipment || []).map((item) => [item.id, item]));
  const objects = [];

  for (const item of characterSheet.inventory || []) {
    if (!item || item.type === 'currency') continue;
    const catalogItem = equipmentById.get(item.id) || item;
    objects.push(toCarriedObject(catalogItem, {
      quantity: item.quantity,
      source: 'character_sheet',
    }));

    if (catalogItem.type === 'pack' && Array.isArray(catalogItem.contents)) {
      for (const contentItem of catalogItem.contents) {
        objects.push(toCarriedObject(contentItem, {
          source: 'pack_contents',
          sourceContainer: catalogItem.name,
          sourceContainerId: catalogItem.id,
        }));
      }
    }
  }

  return objects;
}

function mergeCarriedObjects(current = [], incoming = [], objectStates = {}) {
  const byKey = new Map();
  for (const item of [...normalizeCarriedObjects(current), ...normalizeCarriedObjects(incoming)]) {
    if (!item.name || isExplicitlyNotCarried(item, objectStates)) continue;
    const key = carriedObjectKey(item);
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeCarriedObject(existing, item) : item);
  }
  return [...byKey.values()];
}

function toCarriedObject(item = {}, options = {}) {
  return {
    id: item.id || normalizeId(item.name),
    name: item.name || item.id || 'Unknown item',
    type: item.type || 'item',
    quantity: Number(item.quantity ?? options.quantity ?? 1),
    source: options.source || item.source || 'inventory',
    source_container: options.sourceContainer || item.source_container || null,
    source_container_id: options.sourceContainerId || item.source_container_id || null,
    description: item.description || '',
  };
}

function normalizeInventoryState(value = {}) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...state,
    carried_objects: normalizeCarriedObjects(state.carried_objects),
  };
}

function normalizeCarriedObjects(value = []) {
  return Array.isArray(value)
    ? value
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        ...item,
        id: item.id || normalizeId(item.name),
        name: item.name || item.id || '',
        quantity: Number(item.quantity ?? 1),
      }))
    : [];
}

function isExplicitlyNotCarried(item = {}, objectStates = {}) {
  const state = objectStates?.[normalizeId(item.name)] || objectStates?.[normalizeId(item.id)];
  return Boolean(state && state.carried_by && state.carried_by !== 'player');
}

function carriedObjectKey(item = {}) {
  return [
    normalizeId(item.id || item.name),
    normalizeId(item.source_container_id || item.source_container || ''),
  ].join(':');
}

function mergeCarriedObject(left = {}, right = {}) {
  return {
    ...right,
    ...left,
    quantity: Number(left.quantity ?? right.quantity ?? 1),
    description: left.description || right.description || '',
  };
}

function normalizeId(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  buildSheetCarriedObjects,
  syncInventoryStateFromCharacterSheet,
};
