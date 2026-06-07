function CharacterSelect({
  characters,
  activeCharacterId,
  error,
  joining,
  onJoin,
  onCreateNew,
}) {
  const activeCharacter = characters.find((character) => character.id === activeCharacterId);
  const orderedCharacters = [
    ...(activeCharacter ? [activeCharacter] : []),
    ...characters.filter((character) => character.id !== activeCharacterId),
  ];

  return (
    <main className="character-select-shell">
      <section className="character-select-main">
        <p className="eyebrow">Phase 4B Party Presence</p>
        <div className="wizard-header">
          <h2>Choose Your Character</h2>
          <span className="step-pill">Single Campaign</span>
        </div>

        {error?.message && <div className="wizard-error">{error.message}</div>}

        <p className="helper-text">
          Pick who steps into the ongoing story. A browser session is only a temporary key until accounts arrive later.
        </p>

        <div className="character-select-grid">
          {orderedCharacters.map((character) => (
            <button
              key={character.id}
              type="button"
              className={`character-select-card ${character.id === activeCharacterId ? 'selected' : ''}`}
              onClick={() => onJoin(character.id)}
              disabled={joining}
            >
              <span className="character-select-card-top">
                <strong>{character.name}</strong>
                {character.id === activeCharacterId && <em>Current</em>}
              </span>
              <span>
                Level {character.summary?.level || 1} {character.summary?.species || ''} {character.summary?.className || ''}
              </span>
              <small>
                HP {character.summary?.hp ?? '--'}/{character.summary?.maxHp ?? '--'} / AC {character.summary?.armorClass ?? '--'}
              </small>
              <small>
                XP {character.summary?.experiencePoints ?? 0}
                {character.summary?.nextLevelXp ? `/${character.summary.nextLevelXp}` : ''}
                {character.summary?.levelUpAvailable ? ' - level up ready' : ''}
              </small>
            </button>
          ))}
        </div>

        <div className="wizard-actions">
          <button type="button" className="secondary-btn" onClick={onCreateNew} disabled={joining}>
            Create New Character
          </button>
        </div>
      </section>
    </main>
  );
}

export default CharacterSelect;
