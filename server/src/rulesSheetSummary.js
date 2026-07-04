const { isEquipmentEffect } = require('./equipmentEffectEngine');

function summarizeCharacterSheetForRules(characterSheet) {
  if (!characterSheet) return '';
  const identity = characterSheet.identity || {};
  const abilities = characterSheet.abilities || {};
  const derived = characterSheet.derived_stats || {};
  const details = characterSheet.character_details || {};
  const spellcasting = characterSheet.spellcasting || {};
  const attacks = derived.attack_breakdowns || [];
  const skills = derived.skill_modifiers || {};
  const saves = derived.saving_throw_modifiers || {};
  const features = characterSheet.features || [];
  const inventory = characterSheet.inventory || [];
  const tools = characterSheet.proficiencies?.tools || [];
  const progression = characterSheet.progression || {};
  const lines = [];
  const experiencePoints = identity.experience_points ?? progression.experience_points ?? 0;
  const nextLevelXp = identity.next_level_xp ?? progression.next_level_xp ?? null;
  const levelUpReady = Boolean(identity.level_up_available || progression.level_up_available?.ready);

  lines.push(`Name: ${identity.name || 'Unnamed'}`);
  lines.push(`Build: ${identity.species_name || identity.species || 'Unknown species'} ${identity.class_name || identity.class || 'Unknown class'}${identity.subclass_name ? ` (${identity.subclass_name})` : ''} level ${identity.level || derived.level || 1}`);
  lines.push(`Progression: XP ${experiencePoints}${nextLevelXp ? `/${nextLevelXp}` : ''}${levelUpReady ? '; level up available' : ''}`);
  lines.push(`Core stats: HP ${derived.hp ?? '--'}/${derived.max_hp ?? '--'}, AC ${derived.armor_class ?? '--'}, Speed ${derived.speed ?? '--'} ft, Initiative ${fmtSigned(derived.initiative)}, Proficiency ${fmtSigned(derived.proficiency_bonus)}`);
  if (derived.climb_speed) lines.push(`Movement: Speed ${derived.speed ?? '--'} ft, Climb Speed ${derived.climb_speed} ft${derived.jump_ability ? `, jump distance uses ${String(derived.jump_ability).toUpperCase()}` : ''}`);
  if ((derived.initiative_advantage_sources || []).length) lines.push(`Initiative Advantage: ${derived.initiative_advantage_sources.join(', ')}`);
  if (derived.weapon_critical_threshold) lines.push(`Weapon and Unarmed Strike Critical Hit threshold: natural ${derived.weapon_critical_threshold}-20`);
  const acSources = formatArmorClassSources(derived.armor_class_breakdown, derived.armor_class);
  if (acSources) lines.push(`AC sources: ${acSources}`);
  if (abilities.final_scores) {
    lines.push(`Ability scores: ${Object.entries(abilities.final_scores).map(([key, score]) => `${key.toUpperCase()} ${score} (${fmtSigned(abilities.modifiers?.[key])})`).join(', ')}`);
  }
  const senses = formatSenses(derived.senses);
  if (senses) lines.push(`Senses: ${senses}`);
  if ((characterSheet.resistances || []).length) {
    lines.push(`Damage resistances: ${characterSheet.resistances.join(', ')}`);
  }
  if ((characterSheet.condition_immunities || []).length) {
    lines.push(`Condition immunities: ${characterSheet.condition_immunities.join(', ')}`);
  }
  const speciesChoices = formatSpeciesChoices(characterSheet.species_choices);
  if (speciesChoices) lines.push(`Species choices: ${speciesChoices}`);
  if ((characterSheet.species_spells || []).length) {
    lines.push(`Species spells: ${characterSheet.species_spells.map((spell) => formatSpeciesSpell(spell, characterSheet)).join(', ')}`);
  }
  if (Object.keys(saves).length) {
    lines.push(`Saving throws: ${Object.entries(saves).map(([key, save]) => `${key.toUpperCase()} ${fmtSigned(save.total)}${save.proficient ? ' proficient' : ''}`).join(', ')}`);
  }
  if (Object.keys(skills).length) {
    lines.push(`Skills: ${Object.entries(skills).map(([key, skill]) => `${key.replaceAll('_', ' ')} ${fmtSigned(skill.total)}${skill.proficient ? ' proficient' : ''}`).join(', ')}`);
  }
  if (attacks.length) {
    lines.push(`Attacks: ${attacks.map((attack) => `${attack.name} hit ${fmtSigned(attack.attack_total)}, damage ${attack.damage_formula}`).join('; ')}`);
  }
  if (Array.isArray(derived.active_spell_effects) && derived.active_spell_effects.length) {
    lines.push(`Active effects: ${formatRulesActiveEffects(derived.active_spell_effects)}`);
  }
  if (Array.isArray(characterSheet.active_effects) && characterSheet.active_effects.length) {
    lines.push(`Equipped/passive defenses: ${formatRulesEquipmentEffects(characterSheet.active_effects)}`);
  }
  if (features.length) {
    lines.push(`Features: ${features.map((feature) => `${feature.name} (${feature.source || 'feature'})`).join('; ')}`);
  }
  const classChoices = formatClassChoices(characterSheet.class_choices);
  if (classChoices) lines.push(`Class choices: ${classChoices}`);
  const pactWeapon = getPactWeapon(characterSheet);
  if (pactWeapon) lines.push(`Pact weapon: ${humanizeRuleTarget(pactWeapon)} (chosen through Pact of the Blade; uses Charisma for attack and damage)`);
  if (inventory.length) {
    lines.push(`Equipment: ${inventory.map((item) => Number(item.quantity || 0) > 1 ? `${item.name} x${item.quantity}` : item.name).join(', ')}`);
  }
  if (spellcasting.ability) {
    const cantrips = spellcasting.cantrips_known || [];
    const spells = spellcasting.spells_prepared || [];
    lines.push(`Spellcasting: ${spellcasting.ability.toUpperCase()}, attack ${fmtSigned(derived.spell_attack_bonus)}, DC ${derived.spell_save_dc ?? '--'}, slots ${formatSpellSlots(spellcasting.slots)}, cantrips ${formatList(cantrips)}, prepared level 1+ spells ${formatList(spells)}`);
    if ((spellcasting.spellbook_spells || []).length) {
      lines.push(`Spellbook: ${formatList(spellcasting.spellbook_spells)}. Prepared from spellbook: ${formatList(spells)}`);
    }
    if ((spellcasting.class_choice_spells || characterSheet.class_choice_spells || []).length) {
      lines.push(`Class choice spells: ${(spellcasting.class_choice_spells || characterSheet.class_choice_spells).map((entry) => `${entry.id} from ${entry.source || 'class choice'}`).join(', ')}`);
    }
  }
  const languages = characterSheet.languages || characterSheet.proficiencies?.languages || [];
  if (languages.length) lines.push(`Languages: ${languages.join(', ')}`);
  if (tools.length) lines.push(`Tool proficiencies: ${tools.join(', ')}`);
  if (details.alignment || details.personality || details.backstory) {
    lines.push(`Character details: ${[details.alignment, details.personality, details.backstory].filter(Boolean).join(' ')}`);
  }
  return lines.join('\n');
}

function formatClassChoices(choices = {}) {
  const visible = Object.entries(choices || {})
    .filter(([key, value]) => value !== null && value !== undefined && value !== '' && key !== 'subclass')
    .map(([key, value]) => `${humanizeRuleTarget(key)}: ${Array.isArray(value) ? value.join(', ') : humanizeRuleTarget(value)}`);
  return visible.join('; ');
}

function getPactWeapon(characterSheet = {}) {
  return characterSheet.class_choice_details?.pact_of_the_blade?.pact_weapon
    || characterSheet.class_choice_details?.eldritch_invocations?.pact_weapon
    || characterSheet.class_choice_details?.eldritch_invocation?.pact_weapon
    || '';
}

function formatArmorClassSources(parts = [], total = null) {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const sourceText = parts.map(formatArmorClassPart).filter(Boolean);
  if (total !== null && total !== undefined) sourceText.push(`Total AC ${total}`);
  return sourceText.join(', ');
}

function formatArmorClassPart(part = {}) {
  const label = String(part.label || 'AC source').trim();
  const value = Number(part.value || 0);
  if (!label) return '';
  if (label === 'Defense Fighting Style') {
    return `Fighting Style: Defense ${formatRuleValue(value)} while wearing armor`;
  }
  if (value >= 10 && !/\b(?:modifier|bonus|style)\b/i.test(label)) {
    return `${label}: ${value}`;
  }
  return `${label}: ${formatRuleValue(value)}`;
}

function formatRulesActiveEffects(effects = []) {
  if (!Array.isArray(effects) || effects.length === 0) return 'none';
  return effects.map((effect) => {
    if (isEquipmentEffect(effect)) return formatRulesEquipmentEffect(effect);
    const remaining = effect.remaining_rounds != null
      ? `${effect.remaining_rounds} rounds left`
      : effect.remaining_minutes != null
        ? `${effect.remaining_minutes} minutes left`
        : effect.duration || 'duration unknown';
    const rules = (effect.rules_effects || [])
      .map((rule) => `${rule.label || humanizeRuleTarget(rule.target)}: ${rule.value != null ? formatRuleValue(rule.value) : rule.die || humanizeRuleTarget(rule.target)}`)
      .join(', ');
    return [
      effect.name || effect.id || 'effect',
      `target ${effect.target || 'self/scene'}`,
      effect.mechanical_effect || null,
      rules || null,
      remaining,
      effect.concentration ? 'concentration' : null,
    ].filter(Boolean).join(' | ');
  }).join('; ');
}

function formatRulesEquipmentEffects(effects = []) {
  const equipmentEffects = (effects || []).filter((effect) => isEquipmentEffect(effect) || effect.source_item_name || effect.source_item_id);
  if (!equipmentEffects.length) return 'none';
  return equipmentEffects.map(formatRulesEquipmentEffect).join('; ');
}

function formatRulesEquipmentEffect(effect = {}) {
  const rules = (effect.rules_effects || [effect])
    .map((rule) => formatEquipmentRule(rule, effect))
    .filter(Boolean)
    .join(', ');
  return [
    effect.name || effect.source_item_name || effect.id || 'equipment',
    'equipped/passive defense, not a temporary spell effect',
    effect.mechanical_effect || null,
    rules || null,
  ].filter(Boolean).join(' | ');
}

function formatEquipmentRule(rule = {}, effect = {}) {
  const target = rule.target || effect.target || '';
  const label = rule.label || rule.source_item_name || effect.name || effect.source_item_name || humanizeRuleTarget(target) || 'rule';

  if (target === 'armor_formula') {
    const dexCap = rule.dex_cap === null || rule.dex_cap === undefined ? 'no Dex cap' : `Dex cap ${rule.dex_cap}`;
    return `${label}: base AC ${rule.base ?? '--'}, ${dexCap}`;
  }
  if (target === 'shield_bonus' || target === 'armor_class_bonus') {
    return `${label}: AC ${formatRuleValue(rule.value ?? effect.value ?? 0)}`;
  }
  if (target === 'initiative_bonus') {
    return `${label}: initiative ${formatRuleValue(rule.value ?? effect.value ?? 0)}`;
  }
  if (target === 'initiative_proficiency') {
    return `${label}: add proficiency to initiative`;
  }
  if (target === 'skill_check_bonus') {
    return `${label}: ${humanizeRuleTarget(rule.skill || 'skill')} checks ${formatRuleValue(rule.value ?? effect.value ?? 0)}`;
  }
  if (target === 'saving_throw_bonus') {
    return `${label}: ${humanizeRuleTarget(rule.ability || 'saving throw')} saves ${formatRuleValue(rule.value ?? effect.value ?? 0)}`;
  }
  if (target === 'weapon_attack_bonus') {
    return `${label}: weapon attacks ${formatRuleValue(rule.value ?? effect.value ?? 0)}`;
  }
  if (target === 'weapon_damage_bonus') {
    return `${label}: weapon damage ${formatRuleValue(rule.value ?? effect.value ?? 0)}`;
  }
  if (rule.value !== null && rule.value !== undefined) {
    return `${label}: ${humanizeRuleTarget(target)} ${formatRuleValue(rule.value)}`.trim();
  }
  return `${label}: ${humanizeRuleTarget(rule.mechanical_effect || target || 'passive rule')}`;
}

function humanizeRuleTarget(value = '') {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatRuleValue(value) {
  return typeof value === 'number' && value >= 0 ? `+${value}` : String(value);
}

function fmtSigned(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function formatSpellSlots(slots = {}) {
  const entries = Object.entries(slots || {});
  if (entries.length === 0) return 'none';
  return entries.map(([level, count]) => `L${level}:${count}`).join(', ');
}

function formatList(value) {
  return Array.isArray(value) && value.length ? value.join(', ') : 'none';
}

function formatSenses(senses = {}) {
  const entries = [];
  if (Number(senses.darkvision || 0) > 0) entries.push(`Darkvision ${senses.darkvision} ft`);
  for (const [sense, range] of Object.entries(senses || {})) {
    if (['darkvision', 'special'].includes(sense) || !range) continue;
    entries.push(`${humanizeRuleTarget(sense)} ${range} ft`);
  }
  return entries.join(', ');
}

function formatSpeciesChoices(choices = {}) {
  return Object.entries(choices || {})
    .map(([choice, value]) => `${humanizeRuleTarget(choice)}: ${humanizeRuleTarget(value)}`)
    .join(', ');
}

function formatSpeciesSpell(spell = {}, characterSheet = {}) {
  if (typeof spell === 'string') return humanizeRuleTarget(spell);
  if (!spell.ability) return humanizeRuleTarget(spell.id);
  const ability = String(spell.ability).toLowerCase();
  const modifier = Number(characterSheet.abilities?.modifiers?.[ability] || 0);
  const proficiency = Number(characterSheet.derived_stats?.proficiency_bonus || 2);
  return `${humanizeRuleTarget(spell.id)} (${ability.toUpperCase()}, attack ${fmtSigned(modifier + proficiency)}, DC ${8 + modifier + proficiency})`;
}

module.exports = {
  formatArmorClassSources,
  formatRulesActiveEffects,
  formatRulesEquipmentEffects,
  summarizeCharacterSheetForRules,
};
