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
    speciesChoices: {},
    languages: [],
    characterDetails: { alignment: '', appearance: '', personality: '', backstory: '' },
    classId: '',
    backgroundId: '',
    abilityMethod: 'standard_array',
    abilityScores: Object.fromEntries(ABILITIES.map((ability, index) => [ability, STANDARD_ARRAY[index]])),
    backgroundBonus: {},
    humanSkillId: '',
    humanOriginFeatId: '',
    featSkillChoices: {},
    magicInitiateChoices: {},
    rolledAssignment: emptyRolledAssignments(),
    selectedSkills: [],
    equipmentChoice: 'pack',
    backgroundEquipmentChoice: 'equipment',
    cantripsKnown: [],
    spellsKnown: [],
    rolledStats: { attemptsUsed: 0, currentSet: [], acceptedSet: [], rollToken: null },
  }));

  const selectedSpecies = content.species.find((item) => item.id === draft.speciesId);
  const selectedClass = content.classes.find((item) => item.id === draft.classId);
  const selectedBackground = content.backgrounds.find((item) => item.id === draft.backgroundId);
  const isCaster = Boolean(selectedClass?.spellcasting);
  const totalSteps = isCaster ? 10 : 9;
  const visibleStepName = stepsForClass(isCaster)[step];
  const originFeatMap = Object.fromEntries((content.feats || []).map((feat) => [feat.id, feat]));
  const backgroundOriginFeat = originFeatMap[selectedBackground?.origin_feat];
  const humanOriginFeat = originFeatMap[draft.humanOriginFeatId];
  const isHuman = selectedSpecies?.id === 'human';
  const speciesSkillIds = new Set(getSpeciesSkillIds(draft, selectedSpecies));
  const originFeatEntries = [
    backgroundOriginFeat ? { source: 'background_feat', label: 'Background Origin Feat', feat: backgroundOriginFeat } : null,
    isHuman && humanOriginFeat ? { source: 'human_feat', label: 'Human Versatile Feat', feat: humanOriginFeat } : null,
  ].filter(Boolean);
  const backgroundBonus = normalizeBackgroundBonus(draft.backgroundBonus, selectedBackground);
  const finalScores = Object.fromEntries(ABILITIES.map((ability) => [
    ability,
    draft.abilityScores[ability] === '' || draft.abilityScores[ability] === null || draft.abilityScores[ability] === undefined
      ? null
      : Number(draft.abilityScores[ability] || 0) + Number(backgroundBonus[ability] || 0),
  ]));
  const abilityMods = Object.fromEntries(ABILITIES.map((ability) => [ability, finalScores[ability] === null ? null : mod(finalScores[ability])]));
  const originSkillIds = new Set([
    ...(draft.humanSkillId ? [draft.humanSkillId] : []),
    ...Object.values(draft.featSkillChoices || {}).flat(),
  ]);
  const backgroundSkills = new Set(selectedBackground?.skills || []);
  const skillMap = Object.fromEntries(content.skills.map((skill) => [skill.id, skill]));
  const selectedClassSkills = new Set(draft.selectedSkills);
  const allSkillIds = new Set([...speciesSkillIds, ...backgroundSkills, ...selectedClassSkills, ...originSkillIds]);
  const languageMap = Object.fromEntries((content.languages || []).map((language) => [language.id, language]));
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
  const showAbilityMath = step >= 5 && hasCompleteScores;
  const activeCreationEffects = [
    ...getSpeciesEffects(selectedSpecies, draft.speciesChoices),
    ...originFeatEntries.flatMap((entry) => entry.feat.effects || []),
  ];
  const hpStaticBonus = activeCreationEffects
    .filter((effect) => effect.target === 'max_hp_per_level_bonus')
    .reduce((sum, effect) => sum + Number(effect.value || 0), 0);
  const acPreview = selectedClass && showAbilityMath ? calculateAcPreview(armorItem, shieldItem, abilityMods, selectedClass) : null;
  const hpPreview = selectedClass && showAbilityMath ? Math.max(1, (selectedClass.hit_die || 8) + (abilityMods.con || 0) + hpStaticBonus) : null;
  const acGuidance = selectedClass && showAbilityMath ? getAcGuidance(acPreview, selectedClass, abilityMods, armorItem) : null;
  const guidanceNotes = getGuidanceNotes({
    selectedClass,
    selectedBackground,
    abilityMods,
    showAbilityMath,
    hpPreview,
    acGuidance,
    equipmentItems,
    allSkillIds,
    skillMap,
    originFeatEntries,
  });

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function updateSpeciesChoice(choiceId, value) {
    setDraft((current) => ({
      ...current,
      speciesChoices: { ...current.speciesChoices, [choiceId]: value },
      selectedSkills: [],
    }));
  }

  function toggleLanguage(languageId) {
    setDraft((current) => {
      const selected = new Set(current.languages || []);
      if (selected.has(languageId)) selected.delete(languageId);
      else if (selected.size < 2) selected.add(languageId);
      return { ...current, languages: [...selected] };
    });
  }

  function updateDetail(field, value) {
    setDraft((current) => ({
      ...current,
      characterDetails: { ...current.characterDetails, [field]: value },
    }));
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

  function updateFeatSkillChoice(source, skillId) {
    setDraft((current) => {
      const selected = new Set(current.featSkillChoices[source] || []);
      if (selected.has(skillId)) selected.delete(skillId);
      else if (selected.size < 3) selected.add(skillId);
      return {
        ...current,
        featSkillChoices: { ...current.featSkillChoices, [source]: [...selected] },
      };
    });
  }

  function updateMagicInitiate(source, field, value) {
    setDraft((current) => {
      const currentChoice = current.magicInitiateChoices[source] || { cantrips: [], spell: '' };
      if (field === 'cantrips') {
        const selected = new Set(currentChoice.cantrips || []);
        if (selected.has(value)) selected.delete(value);
        else if (selected.size < 2) selected.add(value);
        return {
          ...current,
          magicInitiateChoices: {
            ...current.magicInitiateChoices,
            [source]: { ...currentChoice, cantrips: [...selected] },
          },
        };
      }
      return {
        ...current,
        magicInitiateChoices: {
          ...current.magicInitiateChoices,
          [source]: { ...currentChoice, [field]: value },
        },
      };
    });
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
    if (speciesSkillIds.has(skillId) || backgroundSkills.has(skillId) || originSkillIds.has(skillId)) return;
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
    if (step === 0) return draft.name.trim().length > 0
      && draft.name.trim().length <= 30
      && draft.speciesId
      && validSpeciesChoices(draft, selectedSpecies, content)
      && validLanguages(draft, content);
    if (step === 1) return validCharacterDetails(draft.characterDetails);
    if (step === 2) return Boolean(draft.classId);
    if (step === 3) return Boolean(draft.backgroundId) && validBackgroundBonus(backgroundBonus, selectedBackground);
    if (step === 4) return validOriginChoices(draft, selectedSpecies, selectedBackground, originFeatEntries, content, speciesSkillIds);
    if (step === 5) return validAbilityScores(draft);
    if (step === 6) return draft.selectedSkills.length === (selectedClass?.skill_count || 0);
    if (step === 7) return Boolean(draft.equipmentChoice) && Boolean(draft.backgroundEquipmentChoice);
    if (isCaster && step === 8) return draft.cantripsKnown.length === requiredCantrips && draft.spellsKnown.length === requiredSpells;
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
              <CardGrid items={content.species} selectedId={draft.speciesId} onSelect={(id) => setDraft((current) => ({
                ...current,
                speciesId: id,
                speciesChoices: {},
                languages: [],
                humanSkillId: '',
                humanOriginFeatId: '',
                featSkillChoices: {},
                magicInitiateChoices: {},
                selectedSkills: [],
              }))} />
              {selectedSpecies && (
                <>
                  <SpeciesChoiceStep
                    species={selectedSpecies}
                    content={content}
                    choices={draft.speciesChoices}
                    onChoice={updateSpeciesChoice}
                  />
                  <LanguageStep
                    languages={content.languages || []}
                    selectedLanguages={draft.languages}
                    onToggle={toggleLanguage}
                  />
                </>
              )}
            </ChoiceStep>
          )}

          {step === 1 && (
            <ChoiceStep title="Character Details">
              <p className="helper-text">Optional story details help the DM keep the character consistent. Skip anything you want to discover during play.</p>
              <label className="field-label">
                Alignment
                <select value={draft.characterDetails.alignment} onChange={(e) => updateDetail('alignment', e.target.value)}>
                  <option value="">Undecided</option>
                  {['Lawful Good', 'Neutral Good', 'Chaotic Good', 'Lawful Neutral', 'Neutral', 'Chaotic Neutral', 'Lawful Evil', 'Neutral Evil', 'Chaotic Evil'].map((alignment) => (
                    <option key={alignment} value={alignment}>{alignment}</option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Appearance
                <textarea maxLength={500} value={draft.characterDetails.appearance} onChange={(e) => updateDetail('appearance', e.target.value)} placeholder="What would someone notice at a glance?" />
              </label>
              <label className="field-label">
                Personality
                <textarea maxLength={500} value={draft.characterDetails.personality} onChange={(e) => updateDetail('personality', e.target.value)} placeholder="Habits, ideals, flaws, vibes, suspicious confidence..." />
              </label>
              <label className="field-label">
                Backstory note
                <textarea maxLength={800} value={draft.characterDetails.backstory} onChange={(e) => updateDetail('backstory', e.target.value)} placeholder="One paragraph is plenty. The campaign can uncover the rest." />
              </label>
            </ChoiceStep>
          )}

          {step === 2 && (
            <ChoiceStep title="Class">
              <CardGrid items={content.classes} selectedId={draft.classId} onSelect={(id) => {
                update('classId', id);
                setDraft((current) => ({ ...current, classId: id, selectedSkills: [], cantripsKnown: [], spellsKnown: [] }));
              }} />
            </ChoiceStep>
          )}

          {step === 3 && (
            <ChoiceStep title="Background">
              <CardGrid items={content.backgrounds} selectedId={draft.backgroundId} onSelect={(id) => {
                update('backgroundId', id);
                setDraft((current) => ({
                  ...current,
                  backgroundId: id,
                  backgroundBonus: {},
                  selectedSkills: [],
                  featSkillChoices: { ...current.featSkillChoices, background_feat: [] },
                  magicInitiateChoices: { ...current.magicInitiateChoices, background_feat: { cantrips: [], spell: '' } },
                }));
              }} />
              <div className="impact-box">
                <h3>Background ability bonus</h3>
                <p>Assign +2/+1 to two eligible abilities, or +1/+1/+1 to all three. The modifier preview updates immediately.</p>
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

          {step === 4 && (
            <ChoiceStep title="Origin Feats">
              <OriginStep
                content={content}
                selectedSpecies={selectedSpecies}
                backgroundOriginFeat={backgroundOriginFeat}
                backgroundSkillIds={new Set([...speciesSkillIds, ...backgroundSkills])}
                humanOriginFeatId={draft.humanOriginFeatId}
                onHumanFeatChange={(id) => setDraft((current) => ({
                  ...current,
                  humanOriginFeatId: id,
                  featSkillChoices: { ...current.featSkillChoices, human_feat: [] },
                  magicInitiateChoices: { ...current.magicInitiateChoices, human_feat: { cantrips: [], spell: '' } },
                }))}
                humanSkillId={draft.humanSkillId}
                onHumanSkillChange={(id) => update('humanSkillId', id)}
                originFeatEntries={originFeatEntries}
                featSkillChoices={draft.featSkillChoices}
                onFeatSkillChoice={updateFeatSkillChoice}
                magicInitiateChoices={draft.magicInitiateChoices}
                onMagicInitiateChange={updateMagicInitiate}
              />
            </ChoiceStep>
          )}

          {step === 5 && (
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

          {step === 6 && (
            <ChoiceStep title="Skill Proficiencies">
              <p className="helper-text">
                Already granted: {[...new Set([...speciesSkillIds, ...(selectedBackground?.skills || []), ...originSkillIds])]
                  .map((id) => skillMap[id]?.name)
                  .filter(Boolean)
                  .join(', ') || 'None'}.
              </p>
              <p className="helper-text">Choose {selectedClass?.skill_count || 0} class skills. Selected: {draft.selectedSkills.length}.</p>
              <div className="option-list">
                {(selectedClass?.skill_options || []).map((skillId) => {
                  const skill = skillMap[skillId];
                  const checked = draft.selectedSkills.includes(skillId);
                  const locked = speciesSkillIds.has(skillId) || backgroundSkills.has(skillId) || originSkillIds.has(skillId);
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

          {step === 7 && (
            <ChoiceStep title="Starting Equipment">
              <h3>Class Equipment</h3>
              <div className="method-tabs">
                <button type="button" className={draft.equipmentChoice === 'pack' ? 'active' : ''} onClick={() => update('equipmentChoice', 'pack')}>Equipment Pack</button>
                <button type="button" className={draft.equipmentChoice === 'gold' ? 'active' : ''} onClick={() => update('equipmentChoice', 'gold')}>Starting Gold</button>
              </div>
              {draft.equipmentChoice === 'pack' ? (
                <div className="equipment-list">
                  {equipmentItems.map((item) => <InfoRow key={item.id} title={item.name} body={item.description} meta={item.type} />)}
                </div>
              ) : <p className="helper-text">Gold purchasing is saved as a choice for now. The full shop economy is not Phase 4A.</p>}
              <h3>Background Equipment</h3>
              <div className="method-tabs">
                <button type="button" className={draft.backgroundEquipmentChoice === 'equipment' ? 'active' : ''} onClick={() => update('backgroundEquipmentChoice', 'equipment')}>Background Package</button>
                <button type="button" className={draft.backgroundEquipmentChoice === 'gold' ? 'active' : ''} onClick={() => update('backgroundEquipmentChoice', 'gold')}>50 GP</button>
              </div>
              {draft.backgroundEquipmentChoice === 'equipment' ? (
                <InfoRow
                  title={`${selectedBackground?.name || 'Background'} Equipment`}
                  meta={selectedBackground?.tool || 'Background tool'}
                  body="Records the background's starting package and personal gear for Phase 4 inventory tracking."
                />
              ) : <p className="helper-text">50 GP alternative selected. Shopping and exact item purchasing remain outside Phase 4A.</p>}
            </ChoiceStep>
          )}

          {isCaster && step === 8 && (
            <ChoiceStep title="Spells and Cantrips">
              <p className="helper-text">Choose {requiredCantrips} cantrips and {requiredSpells} level 1 spells.</p>
              <SpellPicker title="Cantrips" spells={cantripOptions} selected={draft.cantripsKnown} limit={requiredCantrips} onToggle={(id) => toggleSpell('cantripsKnown', id, requiredCantrips)} />
              <SpellPicker title="Level 1 Spells" spells={spellOptions} selected={draft.spellsKnown} limit={requiredSpells} onToggle={(id) => toggleSpell('spellsKnown', id, requiredSpells)} />
            </ChoiceStep>
          )}

          {step === totalSteps - 1 && (
            <ChoiceStep title="Review and Confirm">
              <ReviewPanel draft={draft} content={content} finalScores={finalScores} abilityMods={abilityMods} backgroundBonus={backgroundBonus} acPreview={acPreview} hpPreview={hpPreview} guidanceNotes={guidanceNotes} selectedClass={selectedClass} selectedSpecies={selectedSpecies} selectedBackground={selectedBackground} originFeatEntries={originFeatEntries} equipmentItems={equipmentItems} allSkillIds={allSkillIds} />
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
          originFeatEntries={originFeatEntries}
          skillMap={skillMap}
          backgroundBonus={backgroundBonus}
          finalScores={finalScores}
          abilityMods={abilityMods}
          allSkillIds={allSkillIds}
          languageMap={languageMap}
          equipmentItems={equipmentItems}
          acPreview={acPreview}
          hpPreview={hpPreview}
          guidanceNotes={guidanceNotes}
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

function SpeciesChoiceStep({ species, content, choices, onChoice }) {
  const skillMap = Object.fromEntries(content.skills.map((skill) => [skill.id, skill]));
  return (
    <div className="impact-box">
      <h3>{species.name} choices</h3>
      {(species.choices || []).length === 0 ? (
        <p className="helper-text">No extra level 1 species choices are needed.</p>
      ) : (
        <div className="option-list">
          {species.choices.map((choice) => (
            <label key={choice.id} className="field-label">
              {choice.label}
              <select value={choices[choice.id] || ''} onChange={(event) => onChoice(choice.id, event.target.value)}>
                <option value="">Choose {choice.label}</option>
                {choice.type === 'skill' && (choice.options || []).map((skillId) => (
                  <option key={skillId} value={skillId}>
                    {skillMap[skillId]?.name || skillId} ({skillMap[skillId]?.ability?.toUpperCase() || '?'})
                  </option>
                ))}
                {choice.type === 'ability' && (choice.options || []).map((ability) => (
                  <option key={ability} value={ability}>{ABILITY_LABELS[ability]}</option>
                ))}
                {choice.type === 'option' && (choice.options || []).map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
              {choice.type === 'option' && choices[choice.id] && (
                <small>{choice.options.find((option) => option.id === choices[choice.id])?.description}</small>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function LanguageStep({ languages, selectedLanguages, onToggle }) {
  const standard = languages.filter((language) => language.category === 'standard' && language.id !== 'common');
  return (
    <div className="impact-box">
      <h3>Languages</h3>
      <p className="helper-text">Common is automatic. Choose two more standard languages. Selected: {selectedLanguages.length}/2.</p>
      <div className="option-list">
        {standard.map((language) => {
          const selected = selectedLanguages.includes(language.id);
          return (
            <label key={language.id} className={`check-card ${selected ? 'selected' : ''}`}>
              <input
                type="checkbox"
                checked={selected}
                disabled={!selected && selectedLanguages.length >= 2}
                onChange={() => onToggle(language.id)}
              />
              <span><strong>{language.name}</strong></span>
              <small>{language.description}</small>
            </label>
          );
        })}
      </div>
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

function OriginStep({
  content,
  selectedSpecies,
  backgroundOriginFeat,
  backgroundSkillIds,
  humanOriginFeatId,
  onHumanFeatChange,
  humanSkillId,
  onHumanSkillChange,
  originFeatEntries,
  featSkillChoices,
  onFeatSkillChoice,
  magicInitiateChoices,
  onMagicInitiateChange,
}) {
  const originFeats = (content.feats || []).filter((feat) => feat.category === 'origin');
  const isHuman = selectedSpecies?.id === 'human';
  const backgroundGrantedSkills = backgroundSkillIds || new Set();
  return (
    <div className="option-list">
      {backgroundOriginFeat && (
        <InfoRow title="Background Origin Feat" meta={backgroundOriginFeat.name} body={backgroundOriginFeat.description} />
      )}
      {isHuman && (
        <>
          <label className="field-label">
            Human Skillful
            <select value={humanSkillId} onChange={(event) => onHumanSkillChange(event.target.value)}>
              <option value="">Choose one skill</option>
              {content.skills.map((skill) => (
                <option key={skill.id} value={skill.id} disabled={backgroundGrantedSkills.has(skill.id)}>
                  {skill.name} ({skill.ability.toUpperCase()}){backgroundGrantedSkills.has(skill.id) ? ' (already granted)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Human Versatile
            <select value={humanOriginFeatId} onChange={(event) => onHumanFeatChange(event.target.value)}>
              <option value="">Choose one Origin feat</option>
              {originFeats.map((feat) => (
                <option key={feat.id} value={feat.id} disabled={backgroundOriginFeat?.id === feat.id && !feat.repeatable}>
                  {feat.name}{backgroundOriginFeat?.id === feat.id && !feat.repeatable ? ' (already granted)' : ''}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {originFeatEntries.map((entry) => (
        <FeatChoicePanel
          key={entry.source}
          entry={entry}
          content={content}
          selectedSkills={featSkillChoices[entry.source] || []}
          unavailableSkillIds={new Set([
            ...backgroundGrantedSkills,
            ...(humanSkillId ? [humanSkillId] : []),
            ...Object.entries(featSkillChoices || {})
              .filter(([source]) => source !== entry.source)
              .flatMap(([, skills]) => skills || []),
          ])}
          onSkillChoice={(skillId) => onFeatSkillChoice(entry.source, skillId)}
          magicChoice={magicInitiateChoices[entry.source] || { cantrips: [], spell: '' }}
          onMagicChange={(field, value) => onMagicInitiateChange(entry.source, field, value)}
        />
      ))}
    </div>
  );
}

function FeatChoicePanel({ entry, content, selectedSkills, unavailableSkillIds, onSkillChoice, magicChoice, onMagicChange }) {
  const feat = entry.feat;
  const magicList = feat.magic_list;
  const cantrips = magicList ? content.spells.filter((spell) => spell.level === 0 && spell.classes.includes(magicList)) : [];
  const spells = magicList ? content.spells.filter((spell) => spell.level === 1 && spell.classes.includes(magicList)) : [];
  return (
    <div className="impact-box">
      <h3>{feat.name}</h3>
      <p>{feat.description}</p>
      {feat.choice?.type === 'skills' && (
        <>
          <p className="helper-text">Choose {feat.choice.count} skills. Selected: {selectedSkills.length}.</p>
          <div className="option-list">
            {content.skills.map((skill) => {
              const selected = selectedSkills.includes(skill.id);
              const unavailable = unavailableSkillIds.has(skill.id) && !selected;
              return (
              <label key={skill.id} className={`check-card ${selected ? 'selected' : ''} ${unavailable ? 'locked' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={unavailable || (!selected && selectedSkills.length >= feat.choice.count)}
                  onChange={() => onSkillChoice(skill.id)}
                />
                <span><strong>{skill.name}</strong> ({skill.ability.toUpperCase()})</span>
                <small>{unavailable ? 'Already granted by another origin choice.' : skill.description}</small>
              </label>
              );
            })}
          </div>
        </>
      )}
      {magicList && (
        <>
          <p className="helper-text">Choose 2 {magicList} cantrips and 1 level 1 {magicList} spell.</p>
          <SpellPicker title="Magic Initiate Cantrips" spells={cantrips} selected={magicChoice.cantrips || []} limit={2} onToggle={(id) => onMagicChange('cantrips', id)} />
          <label className="field-label">
            Level 1 spell
            <select value={magicChoice.spell || ''} onChange={(event) => onMagicChange('spell', event.target.value)}>
              <option value="">Choose spell</option>
              {spells.map((spell) => (
                <option key={spell.id} value={spell.id}>{spell.name}</option>
              ))}
            </select>
          </label>
        </>
      )}
      {!feat.choice && !magicList && (
        <p className="helper-text">No additional setup is needed for this feat right now. The sheet records it and applies any static math.</p>
      )}
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

function ReviewPanel({ draft, content, finalScores, abilityMods, backgroundBonus, acPreview, hpPreview, guidanceNotes, selectedClass, selectedSpecies, selectedBackground, originFeatEntries, equipmentItems, allSkillIds }) {
  const skillMap = Object.fromEntries(content.skills.map((skill) => [skill.id, skill]));
  const languageMap = Object.fromEntries((content.languages || []).map((language) => [language.id, language]));
  const originFeatBody = originFeatEntries.map((entry) => entry.feat.name).join(', ');
  return (
    <div className="review-grid">
      <InfoRow title={draft.name} meta={`${selectedSpecies?.name} ${selectedClass?.name}`} body={selectedBackground?.name} />
      <InfoRow title="Hit Points" meta={hpPreview} body={`d${selectedClass?.hit_die} + CON ${fmtMod(abilityMods.con)}`} />
      <InfoRow title="Armor Class" meta={acPreview.total} body={acPreview.parts.map((part) => `${part.label} ${fmtMod(part.value)}`).join(', ')} />
      {originFeatEntries.length > 0 && <InfoRow title="Origin Feats" meta={`${originFeatEntries.length} granted`} body={originFeatBody} />}
      {guidanceNotes.filter((note) => note.review).map((note) => (
        <InfoRow key={note.id} title={note.title} meta={note.tone === 'warning' ? 'Check' : 'Tip'} body={note.message} />
      ))}
      <InfoRow title="Ability Scores" meta="Final" body={ABILITIES.map((ability) => `${ability.toUpperCase()} ${finalScores[ability]} (${fmtMod(abilityMods[ability])}; base ${draft.abilityScores[ability]} + ${backgroundBonus[ability] || 0})`).join('; ')} />
      <InfoRow title="Skills" meta={`${allSkillIds.size} proficient`} body={[...allSkillIds].map((id) => skillMap[id]?.name).filter(Boolean).join(', ')} />
      <InfoRow title="Languages" meta={`${(draft.languages || []).length + 1} known`} body={['common', ...(draft.languages || [])].map((id) => languageMap[id]?.name).filter(Boolean).join(', ')} />
      <InfoRow title="Details" meta={draft.characterDetails?.alignment || 'Unaligned'} body={[draft.characterDetails?.appearance, draft.characterDetails?.personality, draft.characterDetails?.backstory].filter(Boolean).join(' ')} />
      <InfoRow title="Equipment" meta={`${draft.equipmentChoice} / ${draft.backgroundEquipmentChoice}`} body={[
        draft.equipmentChoice === 'pack' ? equipmentItems.map((item) => item.name).join(', ') : 'Class starting gold',
        draft.backgroundEquipmentChoice === 'equipment' ? `${selectedBackground?.name} background package` : '50 GP background alternative',
      ].filter(Boolean).join('; ')} />
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
  originFeatEntries,
  skillMap,
  languageMap,
  backgroundBonus,
  finalScores,
  abilityMods,
  allSkillIds,
  equipmentItems,
  acPreview,
  hpPreview,
  guidanceNotes,
}) {
  const showSpecies = Boolean(selectedSpecies);
  const showClass = step >= 2 && Boolean(selectedClass);
  const showBackground = step >= 3 && Boolean(selectedBackground);
  const showOrigin = step >= 4 && originFeatEntries.length > 0;
  const showAbilities = step >= 5 && ABILITIES.every((ability) => isFilledInteger(draft.abilityScores[ability]));
  const showSkills = step >= 6 && allSkillIds.size > 0;
  const showEquipment = step >= 7 && Boolean(draft.equipmentChoice);

  return (
    <>
      {!showSpecies && !showClass && !showBackground && (
        <p className="helper-text">Selections will appear here as you make them.</p>
      )}
      {showSpecies && (
        <DetailBlock
          title={selectedSpecies.name}
          body={selectedSpecies.description}
          items={[
            ...(selectedSpecies.traits?.map((trait) => `${trait.name}: ${trait.description}`) || []),
            ...formatSpeciesChoiceSummary(selectedSpecies, draft.speciesChoices, skillMap),
            `Languages: ${['common', ...(draft.languages || [])].map((id) => languageMap[id]?.name).filter(Boolean).join(', ') || 'Choose two more'}`,
          ]}
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
            `Origin feat: ${originFeatEntries.find((entry) => entry.source === 'background_feat')?.feat.name || 'None'}`,
            `Tool: ${selectedBackground.tool}`,
          ]}
        />
      )}
      {showOrigin && (
        <DetailBlock
          title="Origin Feats"
          body={originFeatEntries.map((entry) => `${entry.feat.name}: ${entry.feat.description}`).join(' ')}
          items={[
            draft.humanSkillId ? `Human Skillful: ${skillMap[draft.humanSkillId]?.name || draft.humanSkillId}` : null,
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
          body={[
            draft.equipmentChoice === 'pack' ? equipmentItems.map((item) => item.name).join(', ') : 'Class starting gold',
            draft.backgroundEquipmentChoice === 'equipment' ? `${selectedBackground?.name} background package` : '50 GP background alternative',
          ].filter(Boolean).join('; ')}
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
      {guidanceNotes.length > 0 && (
        <div className="guidance-box">
          <h3>Build Guidance</h3>
          {guidanceNotes.map((note) => (
            <div key={note.id} className={`guidance-note ${note.tone === 'warning' ? 'warning' : ''}`}>
              <strong>{note.title}</strong>
              <p>{note.message}</p>
            </div>
          ))}
        </div>
      )}
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

function formatSpeciesChoiceSummary(species, choices = {}, skillMap = {}) {
  return (species?.choices || []).map((choice) => {
    const value = choices[choice.id];
    if (!value) return null;
    if (choice.type === 'skill') return `${choice.label}: ${skillMap[value]?.name || value}`;
    if (choice.type === 'ability') return `${choice.label}: ${ABILITY_LABELS[value] || value.toUpperCase()}`;
    const option = (choice.options || []).find((item) => item.id === value);
    return `${choice.label}: ${option?.name || value}`;
  }).filter(Boolean);
}

function validBackgroundBonus(bonus, background) {
  const values = (background?.asi_options || []).map((ability) => Number(bonus[ability] || 0)).sort((a, b) => b - a);
  return JSON.stringify(values) === JSON.stringify([2, 1, 0]) || JSON.stringify(values) === JSON.stringify([1, 1, 1]);
}

function validSpeciesChoices(draft, species, content) {
  if (!species) return false;
  const allSkillIds = new Set(content.skills.map((skill) => skill.id));
  for (const choice of species.choices || []) {
    const value = draft.speciesChoices?.[choice.id] || '';
    if (choice.required && !value) return false;
    if (choice.type === 'skill' && (!(choice.options || []).includes(value) || !allSkillIds.has(value))) return false;
    if (choice.type === 'ability' && (!(choice.options || []).includes(value) || !ABILITIES.includes(value))) return false;
    if (choice.type === 'option' && !(choice.options || []).some((option) => option.id === value)) return false;
  }
  return true;
}

function validCharacterDetails(details = {}) {
  return String(details.alignment || '').length <= 40
    && String(details.appearance || '').length <= 500
    && String(details.personality || '').length <= 500
    && String(details.backstory || '').length <= 800;
}

function validLanguages(draft, content) {
  const standardLanguages = new Set((content.languages || [])
    .filter((language) => language.category === 'standard' && language.id !== 'common')
    .map((language) => language.id));
  const selected = draft.languages || [];
  return new Set(selected).size === 2 && selected.every((languageId) => standardLanguages.has(languageId));
}

function getSpeciesSkillIds(draft, species) {
  if (!species) return [];
  return (species.choices || [])
    .filter((choice) => choice.type === 'skill')
    .map((choice) => draft.speciesChoices?.[choice.id])
    .filter(Boolean);
}

function getSpeciesEffects(species, choices = {}) {
  if (!species) return [];
  const traitEffects = (species.traits || []).flatMap((trait) => trait.effects || []);
  const choiceEffects = (species.choices || []).flatMap((choice) => {
    const option = (choice.options || []).find((item) => item.id === choices[choice.id]);
    return option?.effects || [];
  });
  return [...traitEffects, ...choiceEffects];
}

function validOriginChoices(draft, selectedSpecies, selectedBackground, originFeatEntries, content, speciesSkillIds = new Set()) {
  const isHuman = selectedSpecies?.id === 'human';
  const allSkillIds = new Set(content.skills.map((skill) => skill.id));
  const originFeats = (content.feats || []).filter((feat) => feat.category === 'origin');
  const grantedSkillIds = new Set([...(selectedBackground?.skills || []), ...speciesSkillIds]);
  if (isHuman) {
    if (!allSkillIds.has(draft.humanSkillId)) return false;
    if (grantedSkillIds.has(draft.humanSkillId)) return false;
    if (!originFeats.some((feat) => feat.id === draft.humanOriginFeatId)) return false;
    grantedSkillIds.add(draft.humanSkillId);
  }
  const backgroundFeat = originFeatEntries.find((entry) => entry.source === 'background_feat')?.feat;
  const humanFeat = originFeatEntries.find((entry) => entry.source === 'human_feat')?.feat;
  if (backgroundFeat && humanFeat && backgroundFeat.id === humanFeat.id && !humanFeat.repeatable) return false;

  for (const entry of originFeatEntries) {
    const feat = entry.feat;
    if (feat.choice?.type === 'skills') {
      const selected = draft.featSkillChoices?.[entry.source] || [];
      if (new Set(selected).size !== feat.choice.count) return false;
      if (selected.some((skillId) => !allSkillIds.has(skillId))) return false;
      if (selected.some((skillId) => grantedSkillIds.has(skillId))) return false;
      selected.forEach((skillId) => grantedSkillIds.add(skillId));
    }
    if (feat.magic_list) {
      const choice = draft.magicInitiateChoices?.[entry.source] || {};
      const cantrips = choice.cantrips || [];
      const cantripOptions = content.spells.filter((spell) => spell.level === 0 && spell.classes.includes(feat.magic_list));
      const spellOptions = content.spells.filter((spell) => spell.level === 1 && spell.classes.includes(feat.magic_list));
      if (new Set(cantrips).size !== 2) return false;
      if (cantrips.some((id) => !cantripOptions.some((spell) => spell.id === id))) return false;
      if (!spellOptions.some((spell) => spell.id === choice.spell)) return false;
    }
  }
  return true;
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
      ...(unarmoredAbility ? [{ label: `${unarmoredDefense.label} ${unarmoredAbility.toUpperCase()}`, value: unarmoredBonus }] : []),
      ...(shieldBonus ? [{ label: 'Shield', value: shieldBonus }] : []),
    ],
  };
}

function getAcGuidance(acPreview, selectedClass, abilityMods, armor) {
  const defense = selectedClass?.unarmored_defense;
  if (!acPreview || !defense || armor) return null;
  const ability = defense.ability;
  const abilityLabel = ABILITY_LABELS[ability] || ability.toUpperCase();
  const abilityMod = abilityMods[ability] || 0;
  const dexMod = abilityMods.dex || 0;
  const shieldText = defense.allows_shield ? ' A shield can help later if one is equipped.' : '';
  const formula = `Unarmored Defense uses 10 + DEX ${fmtMod(dexMod)} + ${abilityLabel} ${fmtMod(abilityMod)}.`;
  if (abilityMod <= 0 || acPreview.total <= 12) {
    return {
      id: 'ac',
      title: 'Armor Class',
      tone: 'warning',
      message: `${formula} That makes AC ${acPreview.total}, so this build is betting on courage, hit points, and the enemy politely missing.${shieldText}`,
      review: true,
    };
  }
  return {
    id: 'ac',
    title: 'Armor Class',
    tone: 'info',
    message: `${formula}${shieldText}`,
    review: true,
  };
}

function getGuidanceNotes({
  selectedClass,
  selectedBackground,
  abilityMods,
  showAbilityMath,
  hpPreview,
  acGuidance,
  equipmentItems,
  allSkillIds,
  skillMap,
  originFeatEntries,
}) {
  const notes = [];
  if (!selectedClass) return notes;

  const primary = selectedClass.primary_ability;
  const primaryMod = abilityMods[primary];
  if (showAbilityMath && primary && primaryMod !== null && primaryMod !== undefined) {
    notes.push({
      id: 'primary',
      title: 'Primary Ability',
      tone: primaryMod < 2 ? 'warning' : 'info',
      message: `${selectedClass.name} leans on ${ABILITY_LABELS[primary]} for its main plan. Current modifier: ${fmtMod(primaryMod)}${primaryMod < 2 ? '. It will work, but the class may feel like it is arguing with its own character sheet.' : '.'}`,
      review: primaryMod < 2,
    });
  }

  if (showAbilityMath && hpPreview !== null && hpPreview !== undefined) {
    const conMod = abilityMods.con || 0;
    notes.push({
      id: 'hp',
      title: 'Hit Points',
      tone: conMod < 0 ? 'warning' : 'info',
      message: `Level 1 HP is hit die d${selectedClass.hit_die} + Constitution ${fmtMod(conMod)} = ${hpPreview}. Constitution is the quiet accountant of survival.`,
      review: conMod < 0,
    });
  }

  if (acGuidance) notes.push(acGuidance);

  const spellcasting = selectedClass.spellcasting;
  if (spellcasting) {
    const spellAbility = spellcasting.ability;
    const spellMod = abilityMods[spellAbility];
    const spellAbilityName = ABILITY_LABELS[spellAbility] || spellAbility.toUpperCase();
    const countText = spellcasting.prepared_formula
      ? `Prepared spells scale from ${spellAbilityName}${showAbilityMath ? ` ${fmtMod(spellMod || 0)}` : ''}.`
      : spellcasting.spells_known
        ? `You choose ${spellcasting.spells_known} known level 1 spells.`
        : 'Your spell choices are tied to class rules.';
    notes.push({
      id: 'spellcasting',
      title: 'Spellcasting',
      tone: showAbilityMath && spellMod < 2 ? 'warning' : 'info',
      message: `${selectedClass.name} casts with ${spellAbilityName}. ${countText}${showAbilityMath && spellMod < 2 ? ' Low casting ability means spell attacks, save DCs, and magical confidence all take the scenic route.' : ''}`,
      review: showAbilityMath && spellMod < 2,
    });
  }

  if (selectedBackground) {
    const backgroundSkillNames = (selectedBackground.skills || [])
      .map((id) => skillMap[id]?.name)
      .filter(Boolean)
      .join(', ');
    notes.push({
      id: 'background',
      title: 'Background',
      tone: 'info',
      message: `${selectedBackground.name} locks in ${backgroundSkillNames || 'background'} skills and controls which abilities can receive +2/+1 bonuses.`,
      review: false,
    });
  }

  if (originFeatEntries?.length > 0) {
    const featNames = originFeatEntries.map((entry) => entry.feat.name).join(', ');
    notes.push({
      id: 'origin-feats',
      title: 'Origin Feats',
      tone: 'info',
      message: `Origin feats are active from level 1: ${featNames}. Static math is applied now; choices that need table judgment are recorded on the sheet for play.`,
      review: false,
    });
  }

  if (allSkillIds?.size > 0) {
    const skillSummary = [...allSkillIds]
      .map((id) => skillMap[id])
      .filter(Boolean)
      .map((skill) => `${skill.name} (${skill.ability.toUpperCase()})`)
      .join(', ');
    notes.push({
      id: 'skills',
      title: 'Skill Coverage',
      tone: 'info',
      message: `Proficient skills add your proficiency bonus to checks: ${skillSummary}. This is where non-combat competence sneaks in wearing sensible shoes.`,
      review: false,
    });
  }

  if (equipmentItems?.length > 0) {
    const armor = equipmentItems.find((item) => item.type === 'armor');
    const shield = equipmentItems.find((item) => item.type === 'shield');
    const weapon = equipmentItems.find((item) => item.type === 'weapon');
    const equipmentBits = [
      armor ? `${armor.name} sets base AC ${armor.ac_base}${armor.dex_cap !== null && armor.dex_cap !== undefined ? ` with DEX cap ${armor.dex_cap}` : ''}` : null,
      shield ? `${shield.name} adds +2 AC while equipped` : null,
      weapon ? `${weapon.name} attacks with ${weapon.ability?.toUpperCase() || 'its listed ability'} for ${weapon.damage || 'listed'} damage` : null,
    ].filter(Boolean);
    notes.push({
      id: 'equipment',
      title: 'Equipment Math',
      tone: 'info',
      message: equipmentBits.length ? equipmentBits.join('. ') + '.' : 'Starting equipment is tracked now; only equipped or active items change your math.',
      review: false,
    });
  }

  return notes;
}

function stepsForClass(isCaster) {
  const steps = ['Name and Species', 'Details', 'Class', 'Background', 'Origin Feats', 'Ability Scores', 'Skills', 'Equipment'];
  if (isCaster) steps.push('Spells');
  steps.push('Review');
  return steps;
}
