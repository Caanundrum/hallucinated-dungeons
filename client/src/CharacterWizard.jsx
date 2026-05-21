import { useState } from 'react';

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABILITY_LABELS = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const POINT_BUY_COSTS = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

function mod(score) {
  return Math.floor((Number(score || 10) - 10) / 2);
}

function fmtMod(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return value >= 0 ? `+${value}` : String(value);
}

function emptyScores(value = 10) {
  return Object.fromEntries(ABILITIES.map((ability) => [ability, value]));
}

function emptyRolledAssignments() {
  return Object.fromEntries(ABILITIES.map((ability) => [ability, '']));
}

function scoresFromRolledAssignments(rolledStats, rolledAssignment) {
  return Object.fromEntries(ABILITIES.map((ability) => {
    const rollIndex = rolledAssignment?.[ability];
    const rollEntry = rollIndex === '' || rollIndex === undefined ? null : rolledStats?.currentSet?.[Number(rollIndex)];
    return [ability, rollEntry ? rollEntry.total : ''];
  }));
}

export default function CharacterWizard({ content, error, saving, rollingStats, onRollStats, onClearError, onSave }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(() => ({
    name: '',
    speciesId: '',
    classId: '',
    backgroundId: '',
    abilityMethod: 'standard_array',
    abilityScores: Object.fromEntries(ABILITIES.map((ability, index) => [ability, STANDARD_ARRAY[index]])),
    backgroundBonus: {},
    rolledAssignment: emptyRolledAssignments(),
    selectedSkills: [],
    equipmentChoice: 'pack',
    cantripsKnown: [],
    spellsKnown: [],
    rolledStats: { attemptsUsed: 0, currentSet: [], acceptedSet: [], rollToken: null },
  }));

  const selectedSpecies = content.species.find((item) => item.id === draft.speciesId);
  const selectedClass = content.classes.find((item) => item.id === draft.classId);
  const selectedBackground = content.backgrounds.find((item) => item.id === draft.backgroundId);
  const isCaster = Boolean(selectedClass?.spellcasting);
  const totalSteps = isCaster ? 8 : 7;
  const visibleStepName = stepsForClass(isCaster)[step];
  const backgroundBonus = normalizeBackgroundBonus(draft.backgroundBonus, selectedBackground);
  const finalScores = Object.fromEntries(ABILITIES.map((ability) => [
    ability,
    draft.abilityScores[ability] === '' || draft.abilityScores[ability] === null || draft.abilityScores[ability] === undefined
      ? null
      : Number(draft.abilityScores[ability] || 0) + Number(backgroundBonus[ability] || 0),
  ]));
  const abilityMods = Object.fromEntries(ABILITIES.map((ability) => [ability, finalScores[ability] === null ? null : mod(finalScores[ability])]));
  const backgroundSkills = new Set(selectedBackground?.skills || []);
  const skillMap = Object.fromEntries(content.skills.map((skill) => [skill.id, skill]));
  const selectedClassSkills = new Set(draft.selectedSkills);
  const allSkillIds = new Set([...backgroundSkills, ...selectedClassSkills]);
  const cantripOptions = content.spells.filter((spell) => spell.level === 0 && spell.classes.includes(draft.classId));
  const spellOptions = content.spells.filter((spell) => spell.level === 1 && spell.classes.includes(draft.classId));
  const requiredCantrips = selectedClass?.spellcasting?.cantrips || 0;
  const requiredSpells = requiredSpellCount(selectedClass, abilityMods);
  const equipmentItems = (selectedClass?.equipment_pack || [])
    .map((id) => content.equipment.find((item) => item.id === id))
    .filter(Boolean);
  const armorItem = equipmentItems.find((item) => item.type === 'armor');
  const shieldItem = equipmentItems.find((item) => item.type === 'shield');
  const hasCompleteScores = ABILITIES.every((ability) => isFilledInteger(draft.abilityScores[ability]));
  const acPreview = selectedClass && hasCompleteScores ? calculateAcPreview(armorItem, shieldItem, abilityMods, selectedClass) : null;
  const hpPreview = selectedClass && hasCompleteScores ? Math.max(1, (selectedClass.hit_die || 8) + (abilityMods.con || 0)) : null;

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateScore(ability, value) {
    setDraft((current) => ({
      ...current,
      abilityScores: { ...current.abilityScores, [ability]: Number(value) },
    }));
  }

  function updateRolledAssignment(ability, rollIndex) {
    setDraft((current) => {
      const nextAssignment = { ...current.rolledAssignment, [ability]: rollIndex };
      const rollEntry = current.rolledStats.currentSet[Number(rollIndex)];
      return {
        ...current,
        rolledAssignment: nextAssignment,
        abilityScores: {
          ...current.abilityScores,
          [ability]: rollEntry ? rollEntry.total : '',
        },
      };
    });
  }

  function updateBackgroundBonus(ability, value) {
    setDraft((current) => ({
      ...current,
      backgroundBonus: normalizeBackgroundBonus({ ...current.backgroundBonus, [ability]: value }, selectedBackground),
    }));
  }

  function setAbilityMethod(method) {
    onClearError?.();
    setDraft((current) => ({
      ...current,
      abilityMethod: method,
      abilityScores: method === 'standard_array'
        ? Object.fromEntries(ABILITIES.map((ability, index) => [ability, STANDARD_ARRAY[index]]))
        : method === 'point_buy'
          ? emptyScores(8)
          : scoresFromRolledAssignments(current.rolledStats, current.rolledAssignment),
    }));
  }

  async function handleRollStats() {
    const roll = await onRollStats();
    if (!roll) return;
    setDraft((current) => ({
      ...current,
      rolledStats: roll,
      rolledAssignment: emptyRolledAssignments(),
      abilityScores: Object.fromEntries(ABILITIES.map((ability) => [ability, ''])),
    }));
  }

  function toggleSkill(skillId) {
    setDraft((current) => {
      const next = new Set(current.selectedSkills);
      if (next.has(skillId)) next.delete(skillId);
      else if (next.size < (selectedClass?.skill_count || 0)) next.add(skillId);
      return { ...current, selectedSkills: [...next] };
    });
  }

  function toggleSpell(field, spellId, limit) {
    setDraft((current) => {
      const next = new Set(current[field]);
      if (next.has(spellId)) next.delete(spellId);
      else if (next.size < limit) next.add(spellId);
      return { ...current, [field]: [...next] };
    });
  }

  function canAdvance() {
    if (step === 0) return draft.name.trim().length > 0 && draft.name.trim().length <= 30 && draft.speciesId;
    if (step === 1) return Boolean(draft.classId);
    if (step === 2) return Boolean(draft.backgroundId) && validBackgroundBonus(backgroundBonus, selectedBackground);
    if (step === 3) return validAbilityScores(draft);
    if (step === 4) return draft.selectedSkills.length === (selectedClass?.skill_count || 0);
    if (step === 5) return Boolean(draft.equipmentChoice);
    if (isCaster && step === 6) return draft.cantripsKnown.length === requiredCantrips && draft.spellsKnown.length === requiredSpells;
    return true;
  }

  function next() {
    const nextStep = Math.min(step + 1, totalSteps - 1);
    setStep(nextStep);
  }

  function back() {
    setStep(Math.max(0, step - 1));
  }

  function submit() {
    onSave({
      ...draft,
      name: draft.name.trim(),
      abilityScores: {
        ...draft.abilityScores,
        backgroundBonus,
      },
      rolledStats: {
        attemptsUsed: draft.rolledStats.attemptsUsed,
        acceptedSet: draft.abilityMethod === 'rolled' ? draft.rolledStats.acceptedSet : [],
        rollToken: draft.abilityMethod === 'rolled' ? draft.rolledStats.rollToken : null,
      },
    });
  }

  return (
    <main className="creation-shell">
      <section className="creation-main">
        <div className="wizard-header">
          <div>
            <p className="eyebrow">Phase 4A Character Creation</p>
            <h2>{visibleStepName}</h2>
          </div>
          <span className="step-pill">Step {step + 1} of {totalSteps}</span>
        </div>
        <div className="wizard-progress">
          <span style={{ width: `${((step + 1) / totalSteps) * 100}%` }} />
        </div>

        {error && <div className="wizard-error">{error.message}</div>}

        <div className="wizard-body">
          {step === 0 && (
            <ChoiceStep title="Name and Species">
              <label className="field-label">
                Character name
                <input value={draft.name} maxLength={30} onChange={(e) => update('name', e.target.value)} placeholder="Kael the Bold-ish" />
              </label>
              <CardGrid items={content.species} selectedId={draft.speciesId} onSelect={(id) => update('speciesId', id)} />
            </ChoiceStep>
          )}

          {step === 1 && (
            <ChoiceStep title="Class">
              <CardGrid items={content.classes} selectedId={draft.classId} onSelect={(id) => {
                update('classId', id);
                setDraft((current) => ({ ...current, classId: id, selectedSkills: [], cantripsKnown: [], spellsKnown: [] }));
              }} />
            </ChoiceStep>
          )}

          {step === 2 && (
            <ChoiceStep title="Background">
              <CardGrid items={content.backgrounds} selectedId={draft.backgroundId} onSelect={(id) => {
                update('backgroundId', id);
                setDraft((current) => ({ ...current, backgroundId: id, backgroundBonus: {}, selectedSkills: [] }));
              }} />
              <div className="impact-box">
                <h3>Background ability bonus</h3>
                <p>Assign +2 to one eligible ability and +1 to the other. The modifier preview updates immediately.</p>
                <div className="asi-row">
                  {(selectedBackground?.asi_options || []).map((ability) => (
                    <label key={ability}>
                      {ABILITY_LABELS[ability]}
                      <select value={backgroundBonus[ability] || 0} onChange={(e) => updateBackgroundBonus(ability, Number(e.target.value))}>
                        <option value={0}>+0</option>
                        <option value={1}>+1</option>
                        <option value={2}>+2</option>
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </ChoiceStep>
          )}

          {step === 3 && (
            <ChoiceStep title="Ability Scores">
              <div className="method-tabs">
                {content.abilityScoreMethods.map((method) => (
                  <button key={method.id} className={draft.abilityMethod === method.id ? 'active' : ''} onClick={() => setAbilityMethod(method.id)} type="button">
                    {method.name}
                  </button>
                ))}
              </div>
              {draft.abilityMethod === 'rolled' && (
                <div className="impact-box">
                  <h3>Rolled Stats</h3>
                  <p>Each attempt rolls six scores using 4d6 drop the lowest. Switching methods will not reset your roll attempts. Rolling again replaces the current set, because the dice do not offer refunds.</p>
                  <button type="button" className="secondary-btn" disabled={rollingStats || draft.rolledStats.attemptsUsed >= 3} onClick={handleRollStats}>
                    {rollingStats ? 'Rolling...' : draft.rolledStats.attemptsUsed >= 3 ? 'No Rolls Left' : draft.rolledStats.attemptsUsed === 0 ? 'Roll Stats' : 'Roll Again'} ({draft.rolledStats.attemptsUsed}/3 used)
                  </button>
                  {draft.rolledStats.attemptsUsed >= 3 && (
                    <p className="helper-text">All three attempts are used. Assign the current set to continue.</p>
                  )}
                  {draft.rolledStats.currentSet.length > 0 && (
                    <div className="roll-set" aria-label="Rolled stat results">
                      {draft.rolledStats.currentSet.map((entry, index) => (
                        <span key={index}>
                          <strong>{entry.total}</strong>
                          <small>Roll {index + 1}: {entry.dice.join(', ')}</small>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {draft.abilityMethod === 'point_buy' && (
                <p className="helper-text">Point Buy spent: {pointBuySpent(draft.abilityScores)} / 27</p>
              )}
              <ScoreGrid
                scores={draft.abilityScores}
                finalScores={finalScores}
                backgroundBonus={backgroundBonus}
                onChange={updateScore}
                method={draft.abilityMethod}
                rolledStats={draft.rolledStats}
                rolledAssignment={draft.rolledAssignment}
                onAssignRoll={updateRolledAssignment}
              />
            </ChoiceStep>
          )}

          {step === 4 && (
            <ChoiceStep title="Skill Proficiencies">
              <p className="helper-text">Background skills are already granted: {(selectedBackground?.skills || []).map((id) => skillMap[id]?.name).join(', ') || 'None'}.</p>
              <p className="helper-text">Choose {selectedClass?.skill_count || 0} class skills. Selected: {draft.selectedSkills.length}.</p>
              <div className="option-list">
                {(selectedClass?.skill_options || []).map((skillId) => {
                  const skill = skillMap[skillId];
                  const checked = draft.selectedSkills.includes(skillId);
                  const locked = backgroundSkills.has(skillId);
                  return (
                    <label key={skillId} className={`check-card ${checked ? 'selected' : ''} ${locked ? 'locked' : ''}`}>
                      <input type="checkbox" checked={checked || locked} disabled={locked} onChange={() => toggleSkill(skillId)} />
                      <span><strong>{skill?.name}</strong> ({skill?.ability?.toUpperCase()} {fmtMod((abilityMods[skill?.ability] || 0) + (checked || locked ? 2 : 0))})</span>
                      <small>{skill?.description}</small>
                    </label>
                  );
                })}
              </div>
            </ChoiceStep>
          )}

          {step === 5 && (
            <ChoiceStep title="Starting Equipment">
              <div className="method-tabs">
                <button type="button" className={draft.equipmentChoice === 'pack' ? 'active' : ''} onClick={() => update('equipmentChoice', 'pack')}>Equipment Pack</button>
                <button type="button" className={draft.equipmentChoice === 'gold' ? 'active' : ''} onClick={() => update('equipmentChoice', 'gold')}>Starting Gold</button>
              </div>
              {draft.equipmentChoice === 'pack' ? (
                <div className="equipment-list">
                  {equipmentItems.map((item) => <InfoRow key={item.id} title={item.name} body={item.description} meta={item.type} />)}
                </div>
              ) : <p className="helper-text">Gold purchasing is saved as a choice for now. The full shop economy is not Phase 4A.</p>}
            </ChoiceStep>
          )}

          {isCaster && step === 6 && (
            <ChoiceStep title="Spells and Cantrips">
              <p className="helper-text">Choose {requiredCantrips} cantrips and {requiredSpells} level 1 spells.</p>
              <SpellPicker title="Cantrips" spells={cantripOptions} selected={draft.cantripsKnown} limit={requiredCantrips} onToggle={(id) => toggleSpell('cantripsKnown', id, requiredCantrips)} />
              <SpellPicker title="Level 1 Spells" spells={spellOptions} selected={draft.spellsKnown} limit={requiredSpells} onToggle={(id) => toggleSpell('spellsKnown', id, requiredSpells)} />
            </ChoiceStep>
          )}

          {step === totalSteps - 1 && (
            <ChoiceStep title="Review and Confirm">
              <ReviewPanel draft={draft} content={content} finalScores={finalScores} abilityMods={abilityMods} backgroundBonus={backgroundBonus} acPreview={acPreview} hpPreview={hpPreview} selectedClass={selectedClass} selectedSpecies={selectedSpecies} selectedBackground={selectedBackground} equipmentItems={equipmentItems} allSkillIds={allSkillIds} />
            </ChoiceStep>
          )}
        </div>

        <div className="wizard-actions">
          <button type="button" className="secondary-btn" onClick={back} disabled={step === 0 || saving}>Back</button>
          {step < totalSteps - 1 ? (
            <button type="button" className="primary-btn" onClick={next} disabled={!canAdvance() || saving}>Next</button>
          ) : (
            <button type="button" className="primary-btn" onClick={submit} disabled={!canAdvance() || saving}>{saving ? 'Saving...' : 'Confirm Character'}</button>
          )}
        </div>
      </section>

      <aside className="creation-detail">
        <h3>Selection Details</h3>
        <CharacterSummary
          step={step}
          draft={draft}
          selectedSpecies={selectedSpecies}
          selectedClass={selectedClass}
          selectedBackground={selectedBackground}
          skillMap={skillMap}
          backgroundBonus={backgroundBonus}
          finalScores={finalScores}
          abilityMods={abilityMods}
          allSkillIds={allSkillIds}
          equipmentItems={equipmentItems}
          acPreview={acPreview}
          hpPreview={hpPreview}
        />
      </aside>
    </main>
  );
}

function ChoiceStep({ children }) {
  return <div className="choice-step">{children}</div>;
}

function CardGrid({ items, selectedId, onSelect }) {
  return (
    <div className="card-grid">
      {items.map((item) => (
        <button type="button" key={item.id} className={`choice-card ${selectedId === item.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)}>
          <strong>{item.name}</strong>
          <span>{item.description}</span>
        </button>
      ))}
    </div>
  );
}

function ScoreGrid({ scores, finalScores, backgroundBonus, onChange, method, rolledStats, rolledAssignment, onAssignRoll }) {
  const assignedRolls = new Set(Object.values(rolledAssignment || {}).filter((value) => value !== ''));
  return (
    <div className="score-grid">
      {ABILITIES.map((ability) => (
        <label key={ability} className="score-card">
          <span>{ABILITY_LABELS[ability]}</span>
          {method === 'rolled' ? (
            <select
              value={rolledAssignment?.[ability] ?? ''}
              onChange={(e) => onAssignRoll(ability, e.target.value)}
              disabled={!rolledStats?.currentSet?.length}
            >
              <option value="">Assign roll</option>
              {(rolledStats?.currentSet || []).map((entry, index) => {
                const value = String(index);
                const usedElsewhere = assignedRolls.has(value) && rolledAssignment?.[ability] !== value;
                return (
                  <option key={value} value={value} disabled={usedElsewhere}>
                    {entry.total} - Roll {index + 1}
                  </option>
                );
              })}
            </select>
          ) : (
            <input type="number" min={method === 'point_buy' ? 8 : 8} max={15} value={scores[ability]} onChange={(e) => onChange(ability, e.target.value)} />
          )}
          <small>
            {scores[ability] === '' || finalScores[ability] === null
              ? 'Choose a base score'
              : `Base ${scores[ability]} + ${backgroundBonus[ability] || 0} = ${finalScores[ability]} (${fmtMod(mod(finalScores[ability]))})`}
          </small>
        </label>
      ))}
    </div>
  );
}

function SpellPicker({ title, spells, selected, limit, onToggle }) {
  if (limit === 0) return null;
  return (
    <div className="spell-picker">
      <h3>{title} ({selected.length}/{limit})</h3>
      <div className="option-list">
        {spells.map((spell) => (
          <label key={spell.id} className={`check-card ${selected.includes(spell.id) ? 'selected' : ''}`}>
            <input type="checkbox" checked={selected.includes(spell.id)} onChange={() => onToggle(spell.id)} />
            <span><strong>{spell.name}</strong> ({spell.casting_time}, {spell.range})</span>
            <small>{spell.description}</small>
          </label>
        ))}
      </div>
    </div>
  );
}

function DetailBlock({ title, body, items = [] }) {
  if (!title) return null;
  return (
    <div className="detail-block">
      <h4>{title}</h4>
      {body && <p>{body}</p>}
      <ul>
        {items.filter(Boolean).map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function InfoRow({ title, body, meta }) {
  return (
    <div className="info-row">
      <strong>{title}</strong>
      <span>{meta}</span>
      <p>{body}</p>
    </div>
  );
}

function ReviewPanel({ draft, content, finalScores, abilityMods, backgroundBonus, acPreview, hpPreview, selectedClass, selectedSpecies, selectedBackground, equipmentItems, allSkillIds }) {
  const skillMap = Object.fromEntries(content.skills.map((skill) => [skill.id, skill]));
  return (
    <div className="review-grid">
      <InfoRow title={draft.name} meta={`${selectedSpecies?.name} ${selectedClass?.name}`} body={selectedBackground?.name} />
      <InfoRow title="Hit Points" meta={hpPreview} body={`d${selectedClass?.hit_die} + CON ${fmtMod(abilityMods.con)}`} />
      <InfoRow title="Armor Class" meta={acPreview.total} body={acPreview.parts.map((part) => `${part.label} ${fmtMod(part.value)}`).join(', ')} />
      <InfoRow title="Ability Scores" meta="Final" body={ABILITIES.map((ability) => `${ability.toUpperCase()} ${finalScores[ability]} (${fmtMod(abilityMods[ability])}; base ${draft.abilityScores[ability]} + ${backgroundBonus[ability] || 0})`).join('; ')} />
      <InfoRow title="Skills" meta={`${allSkillIds.size} proficient`} body={[...allSkillIds].map((id) => skillMap[id]?.name).filter(Boolean).join(', ')} />
      <InfoRow title="Equipment" meta={draft.equipmentChoice} body={equipmentItems.map((item) => item.name).join(', ') || 'Starting gold'} />
      {selectedClass?.spellcasting && <InfoRow title="Spells" meta={selectedClass.spellcasting.ability.toUpperCase()} body={[...draft.cantripsKnown, ...draft.spellsKnown].map((id) => content.spells.find((spell) => spell.id === id)?.name).filter(Boolean).join(', ')} />}
    </div>
  );
}

function CharacterSummary({
  step,
  draft,
  selectedSpecies,
  selectedClass,
  selectedBackground,
  skillMap,
  backgroundBonus,
  finalScores,
  abilityMods,
  allSkillIds,
  equipmentItems,
  acPreview,
  hpPreview,
}) {
  const showSpecies = Boolean(selectedSpecies);
  const showClass = step >= 1 && Boolean(selectedClass);
  const showBackground = step >= 2 && Boolean(selectedBackground);
  const showAbilities = step >= 3 && validAbilityScores(draft);
  const showSkills = step >= 4 && allSkillIds.size > 0;
  const showEquipment = step >= 5 && Boolean(draft.equipmentChoice);

  return (
    <>
      {!showSpecies && !showClass && !showBackground && (
        <p className="helper-text">Selections will appear here as you make them.</p>
      )}
      {showSpecies && (
        <DetailBlock
          title={selectedSpecies.name}
          body={selectedSpecies.description}
          items={selectedSpecies.traits?.map((trait) => `${trait.name}: ${trait.description}`)}
        />
      )}
      {showClass && (
        <DetailBlock
          title={selectedClass.name}
          body={selectedClass.description}
          items={[
            `Hit Die: d${selectedClass.hit_die}`,
            `Primary: ${selectedClass.primary_ability?.toUpperCase()}`,
            `Saves: ${(selectedClass.saving_throws || []).map((save) => save.toUpperCase()).join(', ')}`,
            selectedClass.spellcasting ? `Spellcasting: ${selectedClass.spellcasting.ability.toUpperCase()}` : 'No level 1 spellcasting',
          ]}
        />
      )}
      {showBackground && (
        <DetailBlock
          title={selectedBackground.name}
          body={selectedBackground.description}
          items={[
            `Skills: ${(selectedBackground.skills || []).map((id) => skillMap[id]?.name).join(', ')}`,
            `Ability bonus: ${(selectedBackground.asi_options || []).map((id) => `${id.toUpperCase()} +${backgroundBonus[id] || 0}`).join(', ')}`,
            `Tool: ${selectedBackground.tool}`,
          ]}
        />
      )}
      {showAbilities && (
        <DetailBlock
          title="Ability Scores"
          body={ABILITIES.map((ability) => `${ability.toUpperCase()} ${finalScores[ability]} (${fmtMod(abilityMods[ability])})`).join('; ')}
        />
      )}
      {showSkills && (
        <DetailBlock
          title="Skills"
          body={[...allSkillIds].map((id) => skillMap[id]?.name).filter(Boolean).join(', ')}
        />
      )}
      {showEquipment && (
        <DetailBlock
          title="Equipment"
          body={draft.equipmentChoice === 'pack' ? equipmentItems.map((item) => item.name).join(', ') : 'Starting gold'}
        />
      )}
      <div className="impact-box">
        <h3>Live Impact</h3>
        <p>HP: {showAbilities ? hpPreview ?? '--' : '--'}</p>
        <p>
          AC: {showAbilities && acPreview ? `${acPreview.total} (${acPreview.parts.map((part) => `${part.label} ${fmtMod(part.value)}`).join(', ')})` : '--'}
        </p>
        <p>Initiative: {showAbilities ? fmtMod(abilityMods.dex) : '--'}</p>
      </div>
    </>
  );
}

function normalizeBackgroundBonus(input, background) {
  const allowed = background?.asi_options || [];
  const bonus = Object.fromEntries(ABILITIES.map((ability) => [ability, 0]));
  for (const ability of allowed) {
    bonus[ability] = Number(input?.[ability] || 0);
  }
  return bonus;
}

function validBackgroundBonus(bonus, background) {
  const values = (background?.asi_options || []).map((ability) => Number(bonus[ability] || 0)).sort((a, b) => b - a);
  return JSON.stringify(values) === JSON.stringify([2, 1]);
}

function pointBuySpent(scores) {
  return Object.values(scores).reduce((sum, score) => sum + (POINT_BUY_COSTS[Number(score)] ?? 99), 0);
}

function validAbilityScores(draft) {
  if (ABILITIES.some((ability) => !isFilledInteger(draft.abilityScores[ability]))) return false;
  const values = ABILITIES.map((ability) => Number(draft.abilityScores[ability]));
  if (draft.abilityMethod === 'standard_array') return JSON.stringify([...values].sort((a, b) => b - a)) === JSON.stringify(STANDARD_ARRAY);
  if (draft.abilityMethod === 'point_buy') return pointBuySpent(draft.abilityScores) === 27 && values.every((value) => value >= 8 && value <= 15);
  if (draft.abilityMethod === 'rolled') {
    const assignments = Object.values(draft.rolledAssignment || {});
    const uniqueAssignments = new Set(assignments.filter((value) => value !== ''));
    return Boolean(draft.rolledStats.rollToken)
      && draft.rolledStats.acceptedSet.length === 6
      && uniqueAssignments.size === 6
      && JSON.stringify([...values].sort((a, b) => b - a)) === JSON.stringify([...draft.rolledStats.acceptedSet].sort((a, b) => b - a));
  }
  return false;
}

function isFilledInteger(value) {
  return value !== '' && value !== null && value !== undefined && Number.isInteger(Number(value));
}

function requiredSpellCount(selectedClass, abilityMods) {
  const config = selectedClass?.spellcasting;
  if (!config) return 0;
  if (config.spells_known) return config.spells_known;
  return Math.max(1, (abilityMods[config.ability] || 0) + 1);
}

function calculateAcPreview(armor, shield, abilityMods, selectedClass) {
  const dexMod = abilityMods.dex || 0;
  const base = armor?.ac_base || 10;
  const dexCap = armor ? armor.dex_cap : null;
  const dexApplied = dexCap === null || dexCap === undefined ? dexMod : Math.min(dexMod, dexCap);
  const unarmoredDefense = !armor ? selectedClass?.unarmored_defense : null;
  const unarmoredAbility = unarmoredDefense?.ability;
  const unarmoredBonus = unarmoredAbility ? (abilityMods[unarmoredAbility] || 0) : 0;
  const shieldBonus = shield && (!unarmoredDefense || unarmoredDefense.allows_shield) ? 2 : 0;
  return {
    total: base + dexApplied + unarmoredBonus + shieldBonus,
    parts: [
      { label: armor?.name || 'Unarmored', value: base },
      { label: dexCap === null || dexCap === undefined ? 'DEX' : `DEX cap ${dexCap}`, value: dexApplied },
      ...(unarmoredBonus ? [{ label: `${unarmoredDefense.label} ${unarmoredAbility.toUpperCase()}`, value: unarmoredBonus }] : []),
      ...(shieldBonus ? [{ label: 'Shield', value: shieldBonus }] : []),
    ],
  };
}

function stepsForClass(isCaster) {
  const steps = ['Name and Species', 'Class', 'Background', 'Ability Scores', 'Skills', 'Equipment'];
  if (isCaster) steps.push('Spells');
  steps.push('Review');
  return steps;
}
