const { spendTurnResource } = require('./actionEconomy');
const {
  applyDamage,
  formatDamageAdjustment,
  rollDamageFormula,
} = require('./damageHealingEngine');
const {
  buildResourceState,
  spendResource,
} = require('./resourceEngine');

function resolvePaladinSmiteOnHit({
  message = '',
  worldState = {},
  characterSheet = {},
  targetName = '',
  attack = {},
  crit = false,
  rollDie,
} = {}) {
  if (!wantsDivineSmite(message)) return emptyResult(worldState);
  if (!isPaladinLevelTwo(characterSheet)) {
    return {
      worldState,
      lines: ['**Divine Smite:** this on-hit spell requires Paladin level 2. No resource is spent.'],
      damage: 0,
    };
  }

  if (attack.attackKind !== 'melee' || (!attack.isWeapon && !attack.isUnarmed)) {
    return {
      worldState,
      lines: ['**Divine Smite:** the trigger requires a hit with a Melee weapon or Unarmed Strike. No resource is spent.'],
      damage: 0,
    };
  }

  const target = findTarget(worldState, targetName);
  if (!target || Number(target.hp || 0) <= 0) {
    return {
      worldState,
      lines: ['**Divine Smite:** the weapon hit already finished the target, so no Bonus Action, free use, or spell slot is spent.'],
      damage: 0,
    };
  }

  const payment = getSmitePayment(worldState, characterSheet);
  if (!payment.ok) {
    return {
      worldState,
      lines: ['**Divine Smite:** no free Paladin\'s Smite use or level 1 spell slot remains. The weapon hit still stands.'],
      damage: 0,
    };
  }

  const spentAction = spendTurnResource(worldState, 'bonus_action', 'Divine Smite', characterSheet);
  if (!spentAction.ok) {
    return {
      worldState: spentAction.worldState,
      lines: [`**Divine Smite:** ${spentAction.reply}`],
      damage: 0,
    };
  }

  const paidState = applySmitePayment(spentAction.worldState, characterSheet, payment);
  const paidTarget = findTarget(paidState, targetName);
  const extraDie = isFiendOrUndead(paidTarget) ? 1 : 0;
  const dice = 2 + extraDie;
  const rolled = rollDamageFormula(`${dice}d8`, rollDie, { crit });
  const applied = applyDamage({
    target: paidTarget,
    amount: rolled.total,
    damageType: 'radiant',
    source: 'Divine Smite',
  });
  Object.assign(paidTarget, applied.target);
  const diceLabel = `${crit ? dice * 2 : dice}d8`;
  const creatureBonus = extraDie ? ' including the Fiend/Undead bonus' : '';

  return {
    worldState: paidState,
    lines: [
      `**Divine Smite:** you spend your Bonus Action and ${payment.label}, dealing ${applied.amount} radiant damage (${diceLabel}${creatureBonus})${formatDamageAdjustment(applied.adjustment)}. ${paidTarget.name}: (${applied.beforeHp} -> ${applied.afterHp} HP).`,
    ],
    damage: applied.amount,
  };
}

function getSmitePayment(worldState = {}, characterSheet = {}) {
  const resources = buildResourceState(characterSheet, worldState);
  if (Number(resources.paladins_smite?.remaining || 0) > 0) {
    return { ok: true, type: 'free_use', label: 'your free Paladin\'s Smite use' };
  }

  const slots = getSpellSlots(worldState, characterSheet);
  if (Number(slots['1'] || 0) > 0) {
    return { ok: true, type: 'spell_slot', level: '1', label: 'a level 1 spell slot' };
  }
  return { ok: false };
}

function applySmitePayment(worldState = {}, characterSheet = {}, payment = {}) {
  if (payment.type === 'free_use') {
    return spendResource({
      worldState,
      characterSheet,
      resource: 'paladins_smite',
    }).worldState;
  }

  const slots = getSpellSlots(worldState, characterSheet);
  return {
    ...worldState,
    player_stats: {
      ...(worldState.player_stats || {}),
      spell_slots: {
        ...slots,
        [payment.level]: Math.max(0, Number(slots[payment.level] || 0) - 1),
      },
    },
  };
}

function getSpellSlots(worldState = {}, characterSheet = {}) {
  return {
    ...(characterSheet.spellcasting?.slots || {}),
    ...(worldState.player_stats?.spell_slots || {}),
  };
}

function findTarget(worldState = {}, targetName = '') {
  const normalized = normalizeId(targetName);
  return (worldState.combat_state?.combatants || []).find((combatant) => (
    !combatant.is_player && normalizeId(combatant.name) === normalized
  ));
}

function isFiendOrUndead(target = {}) {
  const values = [
    target.creature_type,
    target.type,
    target.kind,
    ...(target.tags || []),
    target.name,
  ].map(normalizeId).filter(Boolean);
  return values.some((value) => (
    value.includes('fiend')
    || value.includes('undead')
    || /\b(?:skeleton|zombie|wight|ghoul|ghost|specter|spectre|mummy|wraith|vampire)\b/.test(value.replaceAll('_', ' '))
  ));
}

function wantsDivineSmite(message = '') {
  return /\b(?:divine\s+smite|smite(?:d|s|ing)?)\b/i.test(String(message || ''));
}

function isPaladinLevelTwo(characterSheet = {}) {
  return normalizeId(characterSheet.identity?.class || characterSheet.identity?.class_name) === 'paladin'
    && Number(characterSheet.identity?.level || characterSheet.derived_stats?.level || 1) >= 2;
}

function emptyResult(worldState) {
  return { worldState, lines: [], damage: 0 };
}

function normalizeId(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

module.exports = {
  resolvePaladinSmiteOnHit,
  wantsDivineSmite,
};
