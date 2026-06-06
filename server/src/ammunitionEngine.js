const { byId, getContentBundle } = require('./contentData');

function buildStartingAmmunitionItems(items = [], content = getContentBundle()) {
  const ammunitionIds = [...new Set(items
    .filter((item) => item?.type === 'weapon')
    .map((weapon) => weapon.ammunition_type)
    .filter(Boolean))];
  return ammunitionIds.map((id) => {
    const ammunition = byId(content.equipment, id);
    return {
      ...(ammunition || {
        id,
        name: titleCase(id),
        type: 'ammunition',
        description: 'Ammunition for a starting weapon.',
      }),
      quantity: Number(ammunition?.bundle_quantity || 0),
    };
  });
}

function checkAmmunitionAttack({
  attack = {},
  worldState = {},
  characterSheet = {},
  actionResource = 'action',
} = {}) {
  if (!hasProperty(attack, 'ammunition')) return { ok: true };
  if (!attack.ammunitionType) {
    return blocked(`${attack.name} needs an ammunition type before the referee can fire it.`);
  }
  if (!hasFreeHandToLoad({ attack, characterSheet })) {
    return blocked(`${attack.name} needs a free hand to load its ${ammunitionLabel(attack.ammunitionType, 1)}. Free a hand before firing.`);
  }
  const ammunition = getAmmunitionEntry({ attack, worldState, characterSheet });
  if (ammunition.remaining <= 0) {
    return blocked(`You are out of ${ammunition.name}. ${attack.name} cannot fire until you find or buy more.`);
  }
  if (hasProperty(attack, 'loading') && hasLoadingReceipt({ attack, worldState, actionResource })) {
    return blocked(`${attack.name}'s Loading property allows only one piece of ammunition to be fired with this ${formatActionResource(actionResource)}.`);
  }
  return { ok: true, ammunition };
}

function spendAmmunitionForAttack({
  attack = {},
  worldState = {},
  characterSheet = {},
  actionResource = 'action',
} = {}) {
  const checked = checkAmmunitionAttack({ attack, worldState, characterSheet, actionResource });
  if (!checked.ok || !hasProperty(attack, 'ammunition')) {
    return {
      ...checked,
      worldState,
      lines: [],
    };
  }

  const ammunition = checked.ammunition;
  const remaining = Math.max(0, ammunition.remaining - 1);
  let nextState = {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      ammunition: {
        ...(worldState.player_stats?.ammunition || {}),
        [ammunition.id]: {
          id: ammunition.id,
          name: ammunition.name,
          remaining,
        },
      },
      ammunition_spent_since_recovery: {
        ...(worldState.player_stats?.ammunition_spent_since_recovery || {}),
        [ammunition.id]: Number(worldState.player_stats?.ammunition_spent_since_recovery?.[ammunition.id] || 0) + 1,
      },
    },
  };

  if (hasProperty(attack, 'loading') && nextState.combat_state?.active) {
    const turnResources = nextState.combat_state.turn_resources || {};
    const receipts = turnResources.loading_fired || {};
    nextState = {
      ...nextState,
      combat_state: {
        ...nextState.combat_state,
        turn_resources: {
          ...turnResources,
          loading_fired: {
            ...receipts,
            [actionResource]: [...new Set([...(receipts[actionResource] || []), normalizeId(attack.weaponId)])],
          },
        },
      },
    };
  }

  return {
    ok: true,
    worldState: nextState,
    lines: [`**Ammunition:** ${remaining} ${ammunitionLabel(ammunition.name, remaining)} remain.`],
  };
}

function checkThrownWeaponAttack({
  attack = {},
  worldState = {},
  characterSheet = {},
} = {}) {
  if (!isThrownWeaponAttack(attack)) return { ok: true };
  if (attack.drawnByThrownWeaponFighting && !hasFreeHandToDraw({ attack, characterSheet })) {
    return blocked(`${attack.name} can be drawn as part of Thrown Weapon Fighting, but you still need a free hand to throw it. Free a hand first; the weapon will wait, pointedly.`);
  }
  const thrownWeapon = getThrownWeaponEntry({ attack, worldState, characterSheet });
  if (!thrownWeapon.tracked) return { ok: true };
  if (thrownWeapon.remaining <= 0) {
    return blocked(`You have no ${thrownWeapon.name} ready to throw. Recover one first or choose another attack.`);
  }
  return { ok: true, thrownWeapon };
}

function spendThrownWeaponForAttack({
  attack = {},
  worldState = {},
  characterSheet = {},
} = {}) {
  const checked = checkThrownWeaponAttack({ attack, worldState, characterSheet });
  if (!checked.ok || !isThrownWeaponAttack(attack) || !checked.thrownWeapon?.tracked) {
    return {
      ...checked,
      worldState,
      lines: [],
    };
  }

  const thrownWeapon = checked.thrownWeapon;
  const remaining = Math.max(0, thrownWeapon.remaining - 1);
  return {
    ok: true,
    worldState: {
      ...worldState,
      player_stats: {
        ...(worldState.player_stats || {}),
        thrown_weapons: {
          ...(worldState.player_stats?.thrown_weapons || {}),
          [thrownWeapon.id]: {
            id: thrownWeapon.id,
            name: thrownWeapon.name,
            remaining,
          },
        },
        thrown_weapons_spent_since_recovery: {
          ...(worldState.player_stats?.thrown_weapons_spent_since_recovery || {}),
          [thrownWeapon.id]: Number(worldState.player_stats?.thrown_weapons_spent_since_recovery?.[thrownWeapon.id] || 0) + 1,
        },
      },
    },
    lines: [`**Thrown weapon:** ${remaining} ${thrownWeaponLabel(thrownWeapon.name, remaining)} ready to throw remain.`],
  };
}

function recoverSpentAmmunition(worldState = {}) {
  if (worldState.combat_state?.active) {
    return blocked('Combat is active. You cannot search the battlefield for ammunition while the battlefield is still arguing back.');
  }
  const spent = worldState.player_stats?.ammunition_spent_since_recovery || {};
  const recoveries = Object.entries(spent)
    .map(([id, quantity]) => ({ id, quantity: Math.floor(Number(quantity || 0) / 2) }))
    .filter((entry) => entry.quantity > 0);
  const current = worldState.player_stats?.ammunition || {};
  const ammunition = { ...current };
  for (const recovery of recoveries) {
    const existing = current[recovery.id] || { id: recovery.id, name: titleCase(recovery.id), remaining: 0 };
    ammunition[recovery.id] = {
      ...existing,
      remaining: Number(existing.remaining || 0) + recovery.quantity,
    };
  }
  return {
    ok: true,
    worldState: {
      ...worldState,
      player_stats: {
        ...(worldState.player_stats || {}),
        ammunition,
        ammunition_spent_since_recovery: {},
      },
    },
    recoveries,
  };
}

function recoverSpentThrownWeapons(worldState = {}) {
  if (worldState.combat_state?.active) {
    return blocked('Combat is active. You cannot search the battlefield for thrown weapons while the battlefield is still offering fresh opinions.');
  }
  const spent = worldState.player_stats?.thrown_weapons_spent_since_recovery || {};
  const recoveries = Object.entries(spent)
    .map(([id, quantity]) => ({ id, quantity: Number(quantity || 0) }))
    .filter((entry) => entry.quantity > 0);
  const current = worldState.player_stats?.thrown_weapons || {};
  const thrownWeapons = { ...current };
  for (const recovery of recoveries) {
    const existing = current[recovery.id] || { id: recovery.id, name: titleCase(recovery.id), remaining: 0 };
    thrownWeapons[recovery.id] = {
      ...existing,
      remaining: Number(existing.remaining || 0) + recovery.quantity,
    };
  }
  return {
    ok: true,
    worldState: {
      ...worldState,
      player_stats: {
        ...(worldState.player_stats || {}),
        thrown_weapons: thrownWeapons,
        thrown_weapons_spent_since_recovery: {},
      },
    },
    recoveries,
  };
}

function getAmmunitionEntry({ attack = {}, worldState = {}, characterSheet = {} } = {}) {
  const id = attack.ammunitionType;
  const worldEntry = worldState.player_stats?.ammunition?.[id];
  if (worldEntry) {
    return {
      id,
      name: worldEntry.name || titleCase(id),
      remaining: Number(worldEntry.remaining || 0),
    };
  }
  const inventoryEntry = (characterSheet.inventory || []).find((item) => normalizeId(item.id) === normalizeId(id));
  return {
    id,
    name: inventoryEntry?.name || titleCase(id),
    remaining: Number(inventoryEntry?.quantity ?? attack.ammunitionBundleQuantity ?? 0),
  };
}

function getThrownWeaponEntry({ attack = {}, worldState = {}, characterSheet = {} } = {}) {
  const id = normalizeId(attack.weaponId);
  const worldEntry = worldState.player_stats?.thrown_weapons?.[id];
  if (worldEntry) {
    return {
      id,
      name: worldEntry.name || attack.name || titleCase(id),
      remaining: Number(worldEntry.remaining || 0),
      tracked: true,
    };
  }
  const inventoryEntry = (characterSheet.inventory || []).find((item) => normalizeId(item.id) === id && item.type === 'weapon');
  if (!inventoryEntry) {
    return {
      id,
      name: attack.name || titleCase(id),
      remaining: Number.POSITIVE_INFINITY,
      tracked: false,
    };
  }
  return {
    id,
    name: inventoryEntry.name || attack.name || titleCase(id),
    remaining: Number(inventoryEntry.quantity ?? 1),
    tracked: true,
  };
}

function hasFreeHandToLoad({ attack = {}, characterSheet = {} } = {}) {
  if (hasProperty(attack, 'two-handed')) return true;
  const weaponId = normalizeId(attack.weaponId);
  return [characterSheet.equipped?.main_hand, characterSheet.equipped?.off_hand]
    .filter(Boolean)
    .every((itemId) => normalizeId(itemId) === weaponId);
}

function hasFreeHandToDraw({ attack = {}, characterSheet = {} } = {}) {
  const weaponId = normalizeId(attack.weaponId);
  const hands = [characterSheet.equipped?.main_hand, characterSheet.equipped?.off_hand]
    .filter(Boolean)
    .map(normalizeId);
  return hands.length < 2 || hands.includes(weaponId);
}

function isThrownWeaponAttack(attack = {}) {
  return Boolean(attack.isThrownAttack || (hasProperty(attack, 'thrown') && attack.attackKind === 'ranged'));
}

function hasLoadingReceipt({ attack = {}, worldState = {}, actionResource = 'action' } = {}) {
  const receipts = worldState.combat_state?.turn_resources?.loading_fired?.[actionResource] || [];
  return receipts.map(normalizeId).includes(normalizeId(attack.weaponId));
}

function ammunitionLabel(value, quantity) {
  const name = String(value || 'ammunition');
  return Number(quantity) === 1 && name.endsWith('s') ? name.slice(0, -1) : name;
}

function thrownWeaponLabel(value, quantity) {
  const name = String(value || 'thrown weapon');
  return Number(quantity) === 1 && name.endsWith('s') ? name.slice(0, -1) : name;
}

function formatActionResource(resource = '') {
  return String(resource || 'action').replaceAll('_', ' ');
}

function hasProperty(item = {}, property) {
  return (item.properties || []).map(normalizeId).includes(normalizeId(property));
}

function blocked(reply) {
  return { ok: false, reply };
}

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function titleCase(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

module.exports = {
  buildStartingAmmunitionItems,
  checkAmmunitionAttack,
  checkThrownWeaponAttack,
  recoverSpentAmmunition,
  recoverSpentThrownWeapons,
  spendAmmunitionForAttack,
  spendThrownWeaponForAttack,
};
