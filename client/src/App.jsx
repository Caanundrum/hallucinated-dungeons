import { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { socket } from './socket';
import CharacterWizard from './CharacterWizard';
import CharacterSelect from './CharacterSelect';
import './App.css';

// ── ROLL sentinel parser ──────────────────────────────────────────────────
// Parses [ROLL: id=abc XdY+Z] from DM1 response text.
// Returns { id, diceCount, dieSides, modifier, raw } or null if not found.
function parseRollTag(text) {
  const match = text.match(/\[ROLL:\s*(?:id=([a-zA-Z0-9_-]+)\s+)?(\d+)d(\d+)([+-]\d+)?\]/i);
  if (!match) return null;
  return {
    id:         match[1] || null,
    diceCount: parseInt(match[2], 10),
    dieSides:  parseInt(match[3], 10),
    modifier:  match[4] ? parseInt(match[4], 10) : 0,
    raw:       match[0],
  };
}

function inferBasicRollLabel(text) {
  const value = String(text || '');
  if (/initiative/i.test(value)) return 'Initiative';
  if (/death save|death saving throw/i.test(value)) return 'Death Save';
  if (/saving throw|save/i.test(value)) return 'Saving Throw';
  if (/attack/i.test(value)) return 'Attack Roll';
  if (/check/i.test(value)) return 'Check';
  return 'Roll';
}

function parseStructuredRollTag(text) {
  const match = String(text || '').match(/\[(CHECK|SAVE):\s*([^\]]+)\]/i);
  if (!match) return null;
  const attrs = {};
  const attrText = match[2];
  for (const attr of attrText.matchAll(/([a-z_]+)=("[^"]*"|'[^']*'|[^\s]+)/gi)) {
    attrs[attr[1].toLowerCase()] = attr[2].replace(/^["']|["']$/g, '');
  }
  return { kind: match[1].toLowerCase(), attrs, raw: match[0] };
}

// Strip [ROLL: ...] tags from text shown to the player
function stripRollTag(text) {
  return stripRollResultPrefix(text)
    .replace(/^\s*\[ROLL REQUEST:\s*[a-zA-Z0-9_-]+\]\s*/gi, 'Roll requested.')
    .replace(/\s*\[ROLL:\s*(?:id=[a-zA-Z0-9_-]+\s+)?\d+d\d+[+-]?\d*\]/gi, '')
    .replace(/\s*\[(?:CHECK|SAVE):\s*[^\]]+\]/gi, '')
    .trim();
}

function stripRollResultPrefix(text) {
  return String(text || '').replace(/^\[ROLL RESULT:\s*-?\d+\]\s*/, '');
}

function fmtMod(value) {
  const number = Number(value || 0);
  return number >= 0 ? `+${number}` : String(number);
}

function titleCase(value) {
  return String(value || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getStructuredRoll(character, tag) {
  if (!character || !tag) return null;
  const attrs = tag.attrs || {};
  const derived = character.derived_stats || {};
  const modifiers = character.abilities?.modifiers || {};
  const ability = String(attrs.ability || '').toLowerCase();
  const taggedModifier = attrs.modifier !== undefined ? Number(attrs.modifier) : null;
  const taggedBreakdown = attrs.breakdown ? String(attrs.breakdown) : null;
  const bonusDice = parseBonusDice(attrs.bonus_die, attrs.bonus_source);

  if (tag.kind === 'save') {
    const save = derived.saving_throw_modifiers?.[ability];
    if (!save && taggedModifier === null) return null;
    const total = taggedModifier !== null ? taggedModifier : Number(save.total || 0);
    return {
      id: attrs.id || null,
      diceCount: 1,
      dieSides: 20,
      modifier: total,
      label: `${ability.toUpperCase()} Save`,
      breakdown: taggedBreakdown || `${ability.toUpperCase()} ${save?.proficient ? '+ proficiency' : 'only'} = ${fmtMod(total)}`,
      bonusDice,
    };
  }

  const skill = String(attrs.skill || '').toLowerCase();
  if (skill) {
    const skillData = derived.skill_modifiers?.[skill];
    if (skillData || taggedModifier !== null) {
      const total = taggedModifier !== null ? taggedModifier : Number(skillData.total || 0);
      return {
        id: attrs.id || null,
        diceCount: 1,
        dieSides: 20,
        modifier: total,
        label: `${titleCase(skill)} Check`,
        breakdown: taggedBreakdown || `${skillData?.ability?.toUpperCase() || ability.toUpperCase()} ${skillData?.proficient ? '+ proficiency' : 'only'} = ${fmtMod(total)}`,
        bonusDice,
      };
    }
  }

  if (ability && (Number.isFinite(Number(modifiers[ability])) || taggedModifier !== null)) {
    const total = taggedModifier !== null ? taggedModifier : Number(modifiers[ability] || 0);
    return {
      id: attrs.id || null,
      diceCount: 1,
      dieSides: 20,
      modifier: total,
      label: `${ability.toUpperCase()} Check`,
      breakdown: taggedBreakdown || `${ability.toUpperCase()} modifier ${fmtMod(total)}`,
      bonusDice,
    };
  }

  return null;
}

function parseBonusDice(value, source) {
  const match = String(value || '').match(/^(\d+)d(\d+)$/i);
  if (!match) return null;
  return {
    diceCount: Number(match[1]),
    dieSides: Number(match[2]),
    source: source ? String(source).replaceAll('_', ' ') : 'bonus',
  };
}

function summarizeCharacterOption(characterId, character) {
  const identity = character?.identity || {};
  const derived = character?.derived_stats || {};
  const progression = character?.progression || {};
  return {
    id: characterId,
    name: identity.name || 'Unnamed Character',
    isActiveForSession: true,
    identity,
    summary: {
      species: identity.species_name || identity.species || '',
      className: identity.class_name || identity.class || '',
      subclassName: identity.subclass_name || '',
      level: identity.level || derived.level || 1,
      hp: derived.hp ?? null,
      maxHp: derived.max_hp ?? null,
      armorClass: derived.armor_class ?? null,
      experiencePoints: identity.experience_points ?? progression.experience_points ?? 0,
      nextLevelXp: identity.next_level_xp ?? progression.next_level_xp ?? null,
      levelUpAvailable: Boolean(identity.level_up_available || progression.level_up_available?.ready),
    },
    character,
  };
}

function App() {
  const [sessionId, setSessionId] = useState(null);
  const [sessionToken, setSessionToken] = useState(null);
  const [connected, setConnected] = useState(false);
  const [characterStatus, setCharacterStatus] = useState('loading'); // loading | select | required | ready
  const [characterContent, setCharacterContent] = useState(null);
  const [currentCharacter, setCurrentCharacter] = useState(null);
  const [availableCharacters, setAvailableCharacters] = useState([]);
  const [activeCharacterId, setActiveCharacterId] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [levelUpPreview, setLevelUpPreview] = useState(null);
  const [levelUpError, setLevelUpError] = useState(null);
  const [levelUpBusy, setLevelUpBusy] = useState(false);
  const [characterError, setCharacterError] = useState(null);
  const [characterSaving, setCharacterSaving] = useState(false);
  const [characterJoining, setCharacterJoining] = useState(false);
  const [creatingCharacter, setCreatingCharacter] = useState(false);

  // Narrative feed (DM1)
  const [narrative, setNarrative] = useState([]);
  const [storyInput, setStoryInput] = useState('');
  const [dm1Typing, setDm1Typing] = useState(false);

  // Rules panel (DM2)
  const [rulesLog, setRulesLog] = useState([]);
  const [rulesInput, setRulesInput] = useState('');
  const [dm2Typing, setDm2Typing] = useState(false);

  // Dice roller state
  const [pendingRoll, setPendingRoll] = useState(null);     // { diceCount, dieSides, modifier } | null

  const narrativeEndRef = useRef(null);
  const rulesEndRef = useRef(null);
  const currentCharacterRef = useRef(null);
  const creatingCharacterRef = useRef(false);
  const levelUpPreviewRequestRef = useRef(0);

  useEffect(() => {
    currentCharacterRef.current = currentCharacter;
  }, [currentCharacter]);

  useEffect(() => {
    creatingCharacterRef.current = creatingCharacter;
  }, [creatingCharacter]);

  // ── Socket lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    // Remove any stale listeners before re-registering (spec §9.1 — prevents
    // React 18 StrictMode double-mount from creating duplicate handlers)
    socket.off('connect');
    socket.off('disconnect');
    socket.off('session_joined');
    socket.off('session_resumed');
    socket.off('dm1_typing');
    socket.off('dm2_typing');
    socket.off('dm1_response');
    socket.off('dm2_response');
    socket.off('error');
    socket.off('dm2_error');
    socket.off('character_data');
    socket.off('character_ready');
    socket.off('character_error');
    socket.off('character_required');
    socket.off('character_roll');
    socket.off('character_left');
    socket.off('level_up_available');
    socket.off('level_up_preview');
    socket.off('level_up_error');
    socket.off('level_up_result');

    socket.connect();

    socket.on('connect', () => {
      setConnected(true);
      const savedSession = localStorage.getItem('hd_session_id');
      const savedToken = localStorage.getItem('hd_session_token');
      socket.emit('join_session', { sessionId: savedSession || null, sessionToken: savedToken || null });
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('session_joined', ({ sessionId: id, sessionToken }) => {
      setSessionId(id);
      setSessionToken(sessionToken || null);
      localStorage.setItem('hd_session_id', id);
      if (sessionToken) localStorage.setItem('hd_session_token', sessionToken);
      // Phase 4A: character creation gates DM1 session_start.
      setNarrative([]);
      setRulesLog([]);
      setCurrentCharacter(null);
      setLevelUpPreview(null);
      setLevelUpError(null);
      setLevelUpBusy(false);
      setCreatingCharacter(false);
      setCharacterStatus('loading');
      socket.emit('get_character_data', { sessionId: id, sessionToken });
    });

    socket.on('session_resumed', ({ sessionId: id, sessionToken, history }) => {
      setSessionId(id);
      setSessionToken(sessionToken || null);
      localStorage.setItem('hd_session_id', id);
      if (sessionToken) localStorage.setItem('hd_session_token', sessionToken);

      // Rebuild narrative feed from DM1-track history
      const narrativeHistory = history
        .filter((m) => m.role === 'player_dm1' || m.role === 'dm1')
        .map((m) => ({
          type: m.role === 'dm1' ? 'dm1' : 'player',
          text: stripRollTag(m.content),
          id:   m.id,
        }));

      // Rebuild rules feed from DM2-track history
      const rulesHistory = history
        .filter((m) => m.role === 'player_dm2' || m.role === 'dm2')
        .map((m) => ({
          type: m.role === 'dm2' ? 'dm2' : 'player',
          text: m.content,
          id:   m.id,
        }));

      // If no history exists, treat as new session.
      if (narrativeHistory.length === 0 && rulesHistory.length === 0) {
        setRulesLog([]);
      }

      // Add a divider after restored history to mark the resumed session boundary
      const divider = { type: 'divider', text: '-- Session resumed --', id: 'divider-resume' };
      setNarrative([...narrativeHistory, divider]);
      setRulesLog(rulesHistory);
      setLevelUpPreview(null);
      setLevelUpError(null);
      setLevelUpBusy(false);
      socket.emit('get_character_data', { sessionId: id, sessionToken });
    });

    socket.on('character_data', ({ content, character, characters = [], activeCharacterId }) => {
      setCharacterContent(content);
      setAvailableCharacters(characters);
      setActiveCharacterId(activeCharacterId || null);
      setCharacterError(null);
      setCurrentCharacter(character || null);
      if (creatingCharacterRef.current) {
        setCharacterStatus('required');
      } else if (character) {
        setCharacterStatus('ready');
      } else if (characters.length > 0) {
        setCharacterStatus('select');
      } else {
        setCharacterStatus('required');
      }
    });

    socket.on('character_ready', ({ character, characterId, shouldStartSession } = {}) => {
      setCharacterSaving(false);
      setCharacterJoining(false);
      setCreatingCharacter(false);
      setLevelUpBusy(false);
      setCharacterError(null);
      if (character) setCurrentCharacter(character);
      if (characterId) setActiveCharacterId(characterId);
      if (character && characterId) {
        const option = summarizeCharacterOption(characterId, character);
        setAvailableCharacters((prev) => [option, ...prev.filter((item) => item.id !== characterId)]);
      }
      setCharacterStatus('ready');
      if (character && shouldStartSession !== false) {
        socket.emit('session_start');
      }
    });

    socket.on('character_error', (err) => {
      setCharacterSaving(false);
      setCharacterJoining(false);
      setCharacterError(err);
      setCharacterStatus((current) => current === 'loading' ? 'required' : current);
    });

    socket.on('character_required', ({ message }) => {
      setCharacterStatus('required');
      setCharacterError({ message });
    });

    socket.on('character_left', () => {
      setCurrentCharacter(null);
      setCharacterStatus('select');
    });

    socket.on('level_up_available', ({ character, characterId } = {}) => {
      if (character) {
        setCurrentCharacter(character);
        if (characterId) {
          const option = summarizeCharacterOption(characterId, character);
          setAvailableCharacters((prev) => [option, ...prev.filter((item) => item.id !== characterId)]);
        }
      }
    });

    socket.on('level_up_preview', ({ preview, requestId } = {}) => {
      if (requestId && requestId !== levelUpPreviewRequestRef.current) return;
      setLevelUpBusy(false);
      setLevelUpError(null);
      setLevelUpPreview(preview || null);
    });

    socket.on('level_up_error', ({ message, preview, requestId } = {}) => {
      if (requestId && requestId !== levelUpPreviewRequestRef.current) return;
      setLevelUpBusy(false);
      setLevelUpError(message || 'Level up is not available yet.');
      if (preview) setLevelUpPreview(preview);
    });

    socket.on('level_up_result', ({ character, characterId } = {}) => {
      setLevelUpBusy(false);
      setLevelUpPreview(null);
      setLevelUpError(null);
      if (character) setCurrentCharacter(character);
      if (character && characterId) {
        const option = summarizeCharacterOption(characterId, character);
        setAvailableCharacters((prev) => [option, ...prev.filter((item) => item.id !== characterId)]);
      }
    });

    socket.on('dm1_typing', (val) => setDm1Typing(val));
    socket.on('dm2_typing', (val) => setDm2Typing(val));

    socket.on('dm1_response', ({ message }) => {
      // Parse any [ROLL: ...] sentinel tag before displaying
      const rollTag = parseRollTag(message);
      const structuredRollTag = parseStructuredRollTag(message);
      const displayText = stripRollTag(message);

      setNarrative((prev) => [...prev, { type: 'dm1', text: displayText, id: Date.now() }]);

      const structuredRoll = getStructuredRoll(currentCharacterRef.current, structuredRollTag);
      if (structuredRoll) {
        setPendingRoll(structuredRoll);
      } else if (rollTag?.id) {
        // Primary path: sentinel tag parsed successfully — activate the dice roller
        setPendingRoll({
          id:        rollTag.id,
          diceCount: rollTag.diceCount,
          dieSides:  rollTag.dieSides,
          modifier:  rollTag.modifier,
          label: inferBasicRollLabel(message),
        });
      }
    });

    socket.on('dm2_response', ({ message }) => {
      setRulesLog((prev) => [...prev, { type: 'dm2', text: message, id: Date.now() }]);
    });

    // DM1-track errors → narrative feed
    socket.on('error', ({ message, code }) => {
      setNarrative((prev) => {
        const base = code === 'moderation_blocked' && prev.at(-1)?.type === 'player'
          ? prev.slice(0, -1)
          : prev;
        return [...base, { type: 'error', text: message, id: Date.now() }];
      });
    });

    // Route DM2-track errors into the rules feed.
    socket.on('dm2_error', ({ message, code }) => {
      setRulesLog((prev) => {
        const base = code === 'moderation_blocked' && prev.at(-1)?.type === 'player'
          ? prev.slice(0, -1)
          : prev;
        return [...base, { type: 'error', text: message, id: Date.now() }];
      });
    });

    // Spec §9.1 cleanup — remove all listeners and disconnect on unmount
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('session_joined');
      socket.off('session_resumed');
      socket.off('dm1_typing');
      socket.off('dm2_typing');
      socket.off('dm1_response');
      socket.off('dm2_response');
      socket.off('error');
      socket.off('dm2_error');
      socket.off('character_data');
      socket.off('character_ready');
      socket.off('character_error');
      socket.off('character_required');
      socket.off('character_roll');
      socket.off('character_left');
      socket.off('level_up_available');
      socket.off('level_up_preview');
      socket.off('level_up_error');
      socket.off('level_up_result');
      socket.disconnect();
    };
  }, []);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    narrativeEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [narrative, dm1Typing, pendingRoll]);

  useEffect(() => {
    rulesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [rulesLog, dm2Typing]);

  // ── Input handlers ───────────────────────────────────────────────────────
  const handleStorySubmit = (e) => {
    e.preventDefault();
    const msg = storyInput.trim();
    if (!msg || dm1Typing || !connected) return;
    setNarrative((prev) => [...prev, { type: 'player', text: msg, id: Date.now() }]);
    socket.emit('story_input', { message: msg });
    setStoryInput('');
  };

  const handleRulesSubmit = (e) => {
    e.preventDefault();
    const msg = rulesInput.trim();
    if (!msg || dm2Typing || !connected) return;
    setRulesLog((prev) => [...prev, { type: 'player', text: msg, id: Date.now() }]);
    socket.emit('rules_input', { message: msg });
    setRulesInput('');
  };

  // ── Dice roller handlers ─────────────────────────────────────────────────
  const handleRoll = useCallback(() => {
    if (!pendingRoll) return;
    const { id, diceCount, dieSides, modifier, label, bonusDice } = pendingRoll;
    if (!id) {
      setNarrative((prev) => [...prev, { type: 'error', text: 'This roll was missing its server roll id. Ask the Game Master to request the roll again.', id: Date.now() }]);
      setPendingRoll(null);
      return;
    }
    const bonusText = bonusDice ? ` + ${bonusDice.diceCount}d${bonusDice.dieSides}` : '';
    const displayRollMsg = `${label || 'Roll'} requested (${diceCount}d${dieSides}${fmtMod(modifier)}${bonusText}).`;
    const rollMsg = `[ROLL REQUEST: ${id}]`;
    setNarrative((prev) => [...prev, { type: 'player', text: displayRollMsg, id: Date.now() }]);
    socket.emit('story_input', { message: rollMsg });
    setPendingRoll(null);
  }, [pendingRoll]);

  const handleSaveCharacter = useCallback((characterDraft) => {
    if (!sessionId || !sessionToken) {
      setCharacterError({ message: 'No active session. Please refresh.' });
      return;
    }
    setCharacterSaving(true);
    setCharacterError(null);
    socket.emit('save_character', { sessionId, sessionToken, characterDraft });
  }, [sessionId, sessionToken]);

  const handleJoinCharacter = useCallback((characterId) => {
    if (!sessionId || !sessionToken) {
      setCharacterError({ message: 'No active session. Please refresh.' });
      return;
    }
    setCreatingCharacter(false);
    setLevelUpPreview(null);
    setLevelUpError(null);
    if (characterId === activeCharacterId && currentCharacter) {
      setCharacterJoining(false);
      setCharacterError(null);
      setCharacterStatus('ready');
      return;
    }
    setCharacterJoining(true);
    setCharacterError(null);
    socket.emit('join_character', { sessionId, sessionToken, characterId });
  }, [activeCharacterId, currentCharacter, sessionId, sessionToken]);

  const handleCreateNewCharacter = useCallback(() => {
    setCreatingCharacter(true);
    setCurrentCharacter(null);
    setActiveCharacterId(null);
    setCharacterError(null);
    setLevelUpPreview(null);
    setLevelUpError(null);
    setCharacterStatus('required');
  }, []);

  const handleSwitchCharacter = useCallback(() => {
    setCreatingCharacter(false);
    setCharacterError(null);
    setLevelUpPreview(null);
    setLevelUpError(null);
    setCharacterStatus('select');
  }, []);

  const handleOpenLevelUp = useCallback(() => {
    if (!sessionId || !sessionToken) {
      setLevelUpError('No active session. Please refresh.');
      return;
    }
    setLevelUpBusy(true);
    setLevelUpError(null);
    const requestId = ++levelUpPreviewRequestRef.current;
    socket.emit('get_level_up_preview', { sessionId, sessionToken, requestId });
  }, [sessionId, sessionToken]);

  const handleRefreshLevelUpPreview = useCallback((choices = {}) => {
    if (!sessionId || !sessionToken) return;
    setLevelUpBusy(true);
    setLevelUpError(null);
    const requestId = ++levelUpPreviewRequestRef.current;
    socket.emit('get_level_up_preview', {
      sessionId,
      sessionToken,
      requestId,
      payload: { choices },
    });
  }, [sessionId, sessionToken]);

  const handleConfirmLevelUp = useCallback((payload = {}) => {
    if (!sessionId || !sessionToken || !levelUpPreview?.canLevelUp) return;
    setLevelUpBusy(true);
    setLevelUpError(null);
    socket.emit('level_up_character', { sessionId, sessionToken, payload: { hpMethod: 'fixed', ...payload } });
  }, [levelUpPreview, sessionId, sessionToken]);

  const handleCloseLevelUp = useCallback(() => {
    setLevelUpPreview(null);
    setLevelUpError(null);
    setLevelUpBusy(false);
  }, []);

  const handleRollCharacterStats = useCallback(() => new Promise((resolve) => {
    if (!sessionId || !sessionToken) {
      setCharacterError({ message: 'No active session. Please refresh.' });
      resolve(null);
      return;
    }

    setCharacterSaving(true);
    setCharacterError(null);
    const cleanup = () => {
      window.clearTimeout(timeout);
      socket.off('character_roll', onRoll);
      socket.off('character_error', onError);
      setCharacterSaving(false);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      setCharacterError({ message: 'The dice vanished under the table. Try rolling again.' });
      resolve(null);
    }, 10000);

    function onRoll(roll) {
      cleanup();
      setCharacterError(null);
      resolve(roll);
    }

    function onError(err) {
      cleanup();
      setCharacterError(err);
      resolve(null);
    }

    socket.once('character_roll', onRoll);
    socket.once('character_error', onError);
    socket.emit('roll_character_stats', { sessionId, sessionToken });
  }), [sessionId, sessionToken]);

  // Textarea stays active during Game Master loading; only the submit button locks.
  const storyTextareaDisabled = !connected || !sessionId;
  // During a pending roll, the story input is locked - the dice roller takes over.
  const storyDisabled = dm1Typing || !connected || !sessionId || !!pendingRoll;
  // Rules textarea stays active during DM2 typing; only the Ask button locks.
  const rulesTextareaDisabled = !connected || !sessionId;
  const rulesDisabled = dm2Typing || !connected || !sessionId;

  if (creatingCharacter || characterStatus !== 'ready') {
    return (
      <div className="app">
        <header className="app-header">
          <div className="brand-block">
            <h1>Hallucinated Dungeons</h1>
            <p className="ai-disclosure">AI-generated adventure and rules responses</p>
            <p className="legal-disclosure">Rules reference: SRD 5.2.1 (CC BY 4.0)</p>
          </div>
          <span className={`connection-status ${connected ? 'online' : 'offline'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </header>
        {characterStatus === 'loading' || !characterContent ? (
          <main className="creation-loading">
            <h2>Preparing character creation...</h2>
            <p>The quills are sharpening themselves. Probably fine.</p>
          </main>
        ) : characterStatus === 'select' && !creatingCharacter ? (
          <CharacterSelect
            characters={availableCharacters}
            activeCharacterId={activeCharacterId}
            error={characterError}
            joining={characterJoining}
            onJoin={handleJoinCharacter}
            onCreateNew={handleCreateNewCharacter}
          />
        ) : (
          <CharacterWizard
            content={characterContent}
            error={characterError}
            saving={characterSaving}
            rollingStats={characterSaving}
            onRollStats={handleRollCharacterStats}
            onClearError={() => setCharacterError(null)}
            onSave={handleSaveCharacter}
          />
        )}
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="app-header">
        <div className="brand-block">
          <h1>Hallucinated Dungeons</h1>
          <p className="ai-disclosure">AI-generated adventure and rules responses</p>
          <p className="legal-disclosure">Rules reference: SRD 5.2.1 (CC BY 4.0)</p>
        </div>
        <span className={`connection-status ${connected ? 'online' : 'offline'}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </header>

      <main className="app-main">

        {/* ── Narrative panel (DM1) ─────────────────────────────────── */}
        <section className="panel narrative-panel">
          <div className="panel-header">
            <span className="panel-label dm1-label">The Game Master</span>
            <div className="panel-actions">
              <button type="button" className="sheet-toggle" onClick={() => setSheetOpen(true)} disabled={!currentCharacter}>
                Character Sheet
              </button>
              <button type="button" className="sheet-toggle" onClick={handleSwitchCharacter} disabled={!availableCharacters.length}>
                Switch
              </button>
            </div>
          </div>

          <div className="message-feed" id="narrative-feed">
            {narrative.map((msg) => (
              msg.type === 'divider'
                ? <div key={msg.id} className="session-divider"><span>{msg.text}</span></div>
                : <div key={msg.id} className={`message message--${msg.type}`}>
                    {msg.type === 'dm1' && <span className="msg-tag">GM</span>}
                    {msg.type === 'player' && <span className="msg-tag player-tag">You</span>}
                    {msg.type === 'error' && <span className="msg-tag error-tag">!</span>}
                    {msg.type === 'dm1'
                      ? <div className="markdown-body"><ReactMarkdown>{msg.text}</ReactMarkdown></div>
                      : <p>{msg.text}</p>}
                  </div>
            ))}
            {dm1Typing && (
              <div className="message message--dm1 typing-indicator">
                <span className="msg-tag">GM</span>
                <p><span className="dot" /><span className="dot" /><span className="dot" /></p>
              </div>
            )}

            {/* ── Dice roller ──────────────────────────────────────────── */}
            {pendingRoll && !dm1Typing && (
              <div className="dice-roller" id="dice-roller">
                <div className="dice-roller-header">
                  <span className="dice-roller-label">Roll Required</span>
                  <span className="dice-roller-spec">
                    {pendingRoll.diceCount}d{pendingRoll.dieSides}
                    {pendingRoll.modifier > 0 && ` + ${pendingRoll.modifier}`}
                    {pendingRoll.modifier < 0 && ` - ${Math.abs(pendingRoll.modifier)}`}
                    {pendingRoll.bonusDice && ` + ${pendingRoll.bonusDice.diceCount}d${pendingRoll.bonusDice.dieSides}`}
                  </span>
                </div>

                {pendingRoll.breakdown && (
                  <p className="dice-roller-breakdown">{pendingRoll.breakdown}</p>
                )}

                <button className="roll-btn" onClick={handleRoll}>
                  Roll {pendingRoll.diceCount}d{pendingRoll.dieSides}
                  {pendingRoll.modifier !== 0 && (
                    <span className="roll-btn-mod">
                      {pendingRoll.modifier > 0 ? ` +${pendingRoll.modifier}` : ` ${pendingRoll.modifier}`}
                    </span>
                  )}
                  {pendingRoll.bonusDice && (
                    <span className="roll-btn-mod">
                      {` +${pendingRoll.bonusDice.diceCount}d${pendingRoll.bonusDice.dieSides}`}
                    </span>
                  )}
                </button>
              </div>
            )}

            <div ref={narrativeEndRef} />
          </div>

          <form className="input-form" onSubmit={handleStorySubmit}>
            <label className="input-label">What do you do?</label>
            <div className="input-row">
              <textarea
                className="story-textarea"
                value={storyInput}
                onChange={(e) => setStoryInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleStorySubmit(e); }
                }}
                placeholder={pendingRoll ? 'Use the dice roller above to roll...' : 'Describe your action...'}
                disabled={storyTextareaDisabled || !!pendingRoll}
                spellCheck="true"
                autoCorrect="on"
                autoCapitalize="sentences"
                rows={3}
              />
              <button
                type="submit"
                className="submit-btn dm1-btn"
                disabled={storyDisabled || !storyInput.trim()}
              >
                Act
              </button>
            </div>
          </form>
        </section>

        {/* ── Rules panel (DM2) ─────────────────────────────────────── */}
        <section className="panel rules-panel">
          <div className="panel-header">
            <span className="panel-label dm2-label">Rules Arbiter</span>
          </div>

          <div className="message-feed" id="rules-feed">
            {rulesLog.length === 0 && (
              <p className="empty-rules">Ask about rules, abilities, or anything out-of-character.</p>
            )}
            {rulesLog.map((msg) => (
              <div key={msg.id} className={`message message--${msg.type}`}>
                {msg.type === 'dm2'    && <span className="msg-tag dm2-tag">Rules</span>}
                {msg.type === 'player' && <span className="msg-tag player-tag">You</span>}
                {msg.type === 'error'  && <span className="msg-tag error-tag">!</span>}
                {msg.type === 'dm2'
                  ? <div className="markdown-body"><ReactMarkdown>{msg.text}</ReactMarkdown></div>
                  : <p>{msg.text}</p>}
              </div>
            ))}
            {dm2Typing && (
              <div className="message message--dm2 typing-indicator">
                <span className="msg-tag dm2-tag">Rules</span>
                <p><span className="dot" /><span className="dot" /><span className="dot" /></p>
              </div>
            )}
            <div ref={rulesEndRef} />
          </div>

          <form className="input-form" onSubmit={handleRulesSubmit}>
            <label className="input-label">Ask a rules question</label>
            <div className="input-row">
              <textarea
                className="rules-textarea"
                value={rulesInput}
                onChange={(e) => setRulesInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRulesSubmit(e); }
                }}
                placeholder="How does... / Can I... / What is..."
                disabled={rulesTextareaDisabled}
                spellCheck="true"
                autoCorrect="on"
                autoCapitalize="sentences"
                rows={3}
              />
              <button
                type="submit"
                className="submit-btn dm2-btn"
                disabled={rulesDisabled || !rulesInput.trim()}
              >
                Ask
              </button>
            </div>
          </form>
        </section>

      </main>
      {sheetOpen && currentCharacter && (
        <CharacterSheetModal
          character={currentCharacter}
          content={characterContent}
          levelUpBusy={levelUpBusy}
          onClose={() => setSheetOpen(false)}
          onLevelUp={handleOpenLevelUp}
        />
      )}
      {(levelUpPreview || levelUpError) && (
        <LevelUpModal
          key={`${levelUpPreview?.classId || 'error'}-${levelUpPreview?.currentLevel || 0}-${levelUpPreview?.nextLevel || 0}`}
          preview={levelUpPreview}
          error={levelUpError}
          busy={levelUpBusy}
          onClose={handleCloseLevelUp}
          onConfirm={handleConfirmLevelUp}
          onChoicesChange={handleRefreshLevelUpPreview}
        />
      )}
    </div>
  );
}

function CharacterSheetModal({ character, content, levelUpBusy, onClose, onLevelUp }) {
  const identity = character.identity || {};
  const progression = character.progression || {};
  const abilities = character.abilities || {};
  const derived = character.derived_stats || {};
  const equippedDefenses = [
    ...(character.active_effects || []).filter(isEquipmentEffect),
    ...buildDerivedDefenseEffects(derived),
  ];
  const activeEffects = (derived.active_spell_effects || []).filter((effect) => !isEquipmentEffect(effect));
  const attacks = derived.attack_breakdowns || [];
  const skills = derived.skill_modifiers || {};
  const saves = derived.saving_throw_modifiers || {};
  const features = character.features || [];
  const inventory = character.inventory || [];
  const details = character.character_details || {};
  const languages = character.languages || character.proficiencies?.languages || [];
  const tools = character.proficiencies?.tools || [];
  const speciesSpells = character.species_spells || [];
  const resistances = character.resistances || [];
  const speciesChoices = character.species_choices || {};
  const senses = derived.senses || {};
  const classChoices = character.class_choices || {};
  const classChoiceDetails = character.class_choice_details || {};
  const classChoiceSpells = character.class_choice_spells || character.spellcasting?.class_choice_spells || [];
  const weaponMasteries = character.weapon_masteries || [];
  const expertiseSkills = character.expertise_skills || [];
  const resources = character.resources || {};
  const spellcasting = character.spellcasting || null;
  const magicInitiate = character.origin?.magic_initiate || {};
  const experiencePoints = Number(identity.experience_points ?? progression.experience_points ?? 0);
  const nextLevelXp = identity.next_level_xp ?? progression.next_level_xp ?? null;
  const levelUpReady = Boolean(identity.level_up_available || progression.level_up_available?.ready);
  const spellById = (spellId) => content?.spells?.find((spell) => spell.id === spellId);
  const spellName = (spellId) => spellById(spellId)?.name || String(spellId || '').replaceAll('_', ' ');
  const spellSummary = (spellId) => {
    const spell = spellById(spellId);
    if (!spell) return spellName(spellId);
    return `${spell.name}: ${spell.description} (${spell.casting_time}, ${spell.range}, ${spell.duration})`;
  };
  const speciesSpellSummary = (entry) => {
    const spellId = entry.id || entry;
    const summary = spellSummary(spellId);
    if (!entry.ability) return summary;
    const ability = String(entry.ability).toLowerCase();
    const modifier = Number(abilities.modifiers?.[ability] || 0);
    const proficiency = Number(derived.proficiency_bonus || 2);
    return `${summary} [${ability.toUpperCase()} - Attack ${fmtMod(modifier + proficiency)}, DC ${8 + modifier + proficiency}]`;
  };
  const magicInitiateRows = Object.entries(magicInitiate).map(([source, choice]) => ({
    source,
    label: source === 'background_feat' ? 'Background Magic Initiate' : 'Human Magic Initiate',
    cantrips: (choice.cantrips || []).map(spellName),
    spell: choice.spell ? spellName(choice.spell) : '',
  }));
  const resourceRows = Object.entries(resources)
    .filter(([key, value]) => (
      key !== 'spell_uses'
      && key !== 'hit_dice'
      && value
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.remaining !== undefined
      && value.max !== undefined
    ));

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Character sheet">
      <div className="character-sheet-modal">
        <div className="sheet-header">
          <div>
            <p className="eyebrow">Character Sheet</p>
            <h2>{identity.name}</h2>
            <p>
              {identity.species_name} {identity.class_name}
              {identity.subclass_name ? ` (${identity.subclass_name})` : ''} - Level {identity.level || derived.level || 1}
            </p>
            {levelUpReady && <span className="level-up-badge">Level Up Available</span>}
          </div>
          <div className="sheet-header-actions">
            {levelUpReady && (
              <button type="button" className="primary-btn" onClick={onLevelUp} disabled={levelUpBusy}>
                {levelUpBusy ? 'Checking...' : 'Level Up'}
              </button>
            )}
            <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="sheet-stat-strip">
          <SheetStat label="HP" value={`${derived.hp ?? '--'}/${derived.max_hp ?? '--'}`} />
          <SheetStat label="AC" value={derived.armor_class ?? '--'} />
          <SheetStat label="Speed" value={`${derived.speed ?? '--'} ft`} />
          <SheetStat label="Init" value={fmtMod(derived.initiative)} />
          <SheetStat label="PB" value={fmtMod(derived.proficiency_bonus)} />
          <SheetStat label="XP" value={nextLevelXp ? `${experiencePoints}/${nextLevelXp}` : experiencePoints} />
        </div>

        <div className="sheet-grid">
          <section className="sheet-section">
            <h3>Abilities</h3>
            <div className="mini-grid">
              {Object.entries(abilities.final_scores || {}).map(([ability, score]) => (
                <SheetStat key={ability} label={ability.toUpperCase()} value={`${score} (${fmtMod(abilities.modifiers?.[ability])})`} />
              ))}
            </div>
          </section>

          <section className="sheet-section">
            <h3>Active Effects</h3>
            {activeEffects.length ? activeEffects.map((effect) => (
              <div key={`${effect.id || effect.name}-${effect.target || 'self'}`} className="sheet-line">
                <strong>{effect.name || effect.id}</strong>
                <span>{formatEffectSummary(effect)}</span>
              </div>
            )) : <p className="muted-text">No active effects.</p>}
          </section>

          {equippedDefenses.length > 0 && (
            <section className="sheet-section">
              <h3>Equipped Defenses</h3>
              {equippedDefenses.map((effect) => (
                <div key={`${effect.id || effect.name}-${effect.target || 'self'}`} className="sheet-line">
                  <strong>{formatEffectName(effect)}</strong>
                  <span>{formatEffectSummary(effect)}</span>
                </div>
              ))}
            </section>
          )}

          <section className="sheet-section">
            <h3>Attacks</h3>
            {attacks.length ? attacks.map((attack) => (
              <div key={attack.weapon_id || attack.name} className="sheet-line">
                <strong>{attack.name}</strong>
                <span>Hit {fmtMod(attack.attack_total)} - {attack.damage_formula}</span>
              </div>
            )) : <p className="muted-text">No equipped weapon.</p>}
          </section>

          <section className="sheet-section">
            <h3>Saving Throws</h3>
            <div className="mini-grid">
              {Object.entries(saves).map(([ability, save]) => (
                <SheetStat key={ability} label={ability.toUpperCase()} value={`${fmtMod(save.total)}${save.proficient ? ' prof' : ''}`} />
              ))}
            </div>
          </section>

          <section className="sheet-section">
            <h3>Skills</h3>
            <div className="skill-list">
              {Object.entries(skills).map(([skill, data]) => (
                <span key={skill}>{skill.replaceAll('_', ' ')} {fmtMod(data.total)}{data.expertise ? ' expertise' : data.proficient ? ' *' : ''}</span>
              ))}
            </div>
          </section>

          {(Object.keys(classChoices).length > 0 || weaponMasteries.length > 0 || expertiseSkills.length > 0) && (
            <section className="sheet-section">
              <h3>Class Choices</h3>
              {Object.entries(classChoices).map(([choiceId, optionId]) => (
                <div key={choiceId} className="sheet-line">
                  <strong>{choiceId.replaceAll('_', ' ')}</strong>
                  <span>{[
                    formatClassChoiceValue(optionId),
                    ...Object.entries(classChoiceDetails[choiceId] || {}).map(([detailId, detailValue]) => `${detailId.replaceAll('_', ' ')}: ${formatClassChoiceDetailValue(detailValue, spellName)}`),
                  ].join(' | ')}</span>
                </div>
              ))}
              {Object.entries(classChoiceDetails)
                .filter(([choiceId]) => !Object.prototype.hasOwnProperty.call(classChoices, choiceId))
                .map(([choiceId, details]) => (
                  <div key={`detail-${choiceId}`} className="sheet-line">
                    <strong>{choiceId.replaceAll('_', ' ')}</strong>
                    <span>{Object.entries(details || {}).map(([detailId, value]) => `${detailId.replaceAll('_', ' ')}: ${formatClassChoiceDetailValue(value, spellName)}`).join(' | ')}</span>
                  </div>
                ))}
              {weaponMasteries.length > 0 && (
                <div className="sheet-line">
                  <strong>Weapon Mastery</strong>
                  <span>{weaponMasteries.map((entry) => `${entry.name} (${entry.mastery_name || entry.mastery})`).join(' | ')}</span>
                </div>
              )}
              {expertiseSkills.length > 0 && (
                <div className="sheet-line">
                  <strong>Expertise</strong>
                  <span>{expertiseSkills.map((skill) => String(skill).replaceAll('_', ' ')).join(', ')}</span>
                </div>
              )}
            </section>
          )}

          <section className="sheet-section">
            <h3>Origin</h3>
            {details.alignment && (
              <div className="sheet-line">
                <strong>Alignment</strong>
                <span>{details.alignment}</span>
              </div>
            )}
            {[details.appearance, details.personality, details.backstory].filter(Boolean).length > 0 && (
              <div className="sheet-line">
                <strong>Details</strong>
                <span>{[details.appearance, details.personality, details.backstory].filter(Boolean).join(' ')}</span>
              </div>
            )}
            <div className="sheet-line">
              <strong>Languages</strong>
              <span>{languages.length ? languages.join(', ') : 'None recorded'}</span>
            </div>
            {tools.length > 0 && (
              <div className="sheet-line">
                <strong>Tools</strong>
                <span>{tools.join(', ')}</span>
              </div>
            )}
            {resistances.length > 0 && (
              <div className="sheet-line">
                <strong>Resistances</strong>
                <span>{resistances.join(', ')}</span>
              </div>
            )}
            {speciesSpells.length > 0 && (
              <div className="sheet-line">
                <strong>Species Spells</strong>
                <span>{speciesSpells.map(speciesSpellSummary).join(' | ')}</span>
              </div>
            )}
            {Number(senses.darkvision || 0) > 0 && (
              <div className="sheet-line">
                <strong>Senses</strong>
                <span>Darkvision {senses.darkvision} ft</span>
              </div>
            )}
            {Object.keys(speciesChoices).length > 0 && (
              <div className="sheet-line">
                <strong>Species Choices</strong>
                <span>{Object.entries(speciesChoices).map(([choice, value]) => `${titleCase(choice)}: ${titleCase(value)}`).join(' | ')}</span>
              </div>
            )}
          </section>

          {(spellcasting || magicInitiateRows.length > 0) && (
            <section className="sheet-section">
              <h3>Spells</h3>
              {spellcasting && (
                <>
                  <div className="sheet-line">
                    <strong>Spellcasting</strong>
                    <span>{spellcasting.ability?.toUpperCase()} - Attack {fmtMod(derived.spell_attack_bonus)}, DC {derived.spell_save_dc ?? '--'}</span>
                  </div>
                  {(spellcasting.cantrips_known || []).length > 0 && (
                    <div className="sheet-line">
                      <strong>Cantrips</strong>
                      <span>{spellcasting.cantrips_known.map(spellSummary).join(' | ')}</span>
                    </div>
                  )}
                  {(spellcasting.spellbook_spells || []).length > 0 && (
                    <div className="sheet-line">
                      <strong>Spellbook</strong>
                      <span>{spellcasting.spellbook_spells.map(spellSummary).join(' | ')}</span>
                    </div>
                  )}
                  {(spellcasting.always_prepared_spells || []).length > 0 && (
                    <div className="sheet-line">
                      <strong>Always Prepared</strong>
                      <span>{spellcasting.always_prepared_spells.map(spellSummary).join(' | ')}</span>
                    </div>
                  )}
                  {(spellcasting.spells_prepared || []).length > 0 && (
                    <div className="sheet-line">
                      <strong>Prepared Level 1</strong>
                      <span>{(spellcasting.spells_prepared || []).map(spellSummary).join(' | ')}</span>
                    </div>
                  )}
                  {classChoiceSpells.length > 0 && (
                    <div className="sheet-line">
                      <strong>Class Choice Spells</strong>
                      <span>{classChoiceSpells.map((entry) => `${entry.source}: ${spellSummary(entry.id)}`).join(' | ')}</span>
                    </div>
                  )}
                </>
              )}
              {magicInitiateRows.map((row) => (
                <div key={row.source} className="sheet-line">
                  <strong>{row.label}</strong>
                  <span>{[
                    row.cantrips.length ? `Cantrips: ${(magicInitiate[row.source]?.cantrips || []).map(spellSummary).join(' | ')}` : null,
                    row.spell ? `Level 1: ${spellSummary(magicInitiate[row.source]?.spell)}` : null,
                  ].filter(Boolean).join('; ')}</span>
                </div>
              ))}
            </section>
          )}

          {resourceRows.length > 0 && (
            <section className="sheet-section">
              <h3>Resources</h3>
              {resourceRows.map(([key, resource]) => (
                <div key={key} className="sheet-line">
                  <strong>{resource.name || titleCase(key)}</strong>
                  <span>{resource.remaining}/{resource.max} until {String(resource.reset || 'rest').replaceAll('_', ' ')}</span>
                </div>
              ))}
            </section>
          )}

          {Object.keys(resources.spell_uses || {}).length > 0 && (
            <section className="sheet-section">
              <h3>Limited Uses</h3>
              {Object.entries(resources.spell_uses || {}).map(([key, use]) => (
                <div key={key} className="sheet-line">
                  <strong>{use.name}</strong>
                  <span>{use.remaining}/{use.max} until {String(use.reset || 'rest').replaceAll('_', ' ')}</span>
                </div>
              ))}
            </section>
          )}

          <section className="sheet-section">
            <h3>Features</h3>
            {features.map((feature) => (
              <div key={`${feature.source}-${feature.name}`} className="sheet-line">
                <strong>{feature.name}</strong>
                <span>{feature.description}</span>
              </div>
            ))}
          </section>

          <section className="sheet-section">
            <h3>Equipment</h3>
            {inventory.map((item) => (
              <div key={item.id} className="sheet-line">
                <strong>{Number(item.quantity || 0) > 1 ? `${item.name} x${item.quantity}` : item.name}</strong>
                <span>{item.description}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function buildInitialLevelUpChoices(preview) {
  const initialSelections = {};
  for (const choice of preview?.requiredChoices || []) {
    initialSelections[choice.id] = choice.selected || [];
  }
  return initialSelections;
}

function LevelUpModal({ preview, error, busy, onClose, onConfirm, onChoicesChange }) {
  const blockers = preview?.blockers || [];
  const canLevelUp = Boolean(preview?.canLevelUp);
  const requiredChoices = preview?.requiredChoices || [];
  const [choiceSelections, setChoiceSelections] = useState(() => buildInitialLevelUpChoices(preview));
  const activeRequiredChoices = requiredChoices.filter((choice) => isLevelUpChoiceActive(choice, choiceSelections));
  const choiceBlockerTypes = new Set(['required_choice', 'invalid_choice']);
  const hardBlockers = blockers.filter((entry) => !choiceBlockerTypes.has(entry.type));
  const choicesComplete = activeRequiredChoices.every((choice) => {
    const selected = choiceSelections[choice.id] || [];
    const optionById = new Map((choice.options || []).map((option) => [option.id, option]));
    return selected.length === Number(choice.count || 0)
      && selected.every((optionId) => isLevelUpOptionAvailable(optionById.get(optionId), choiceSelections));
  });
  const canApply = Boolean(preview?.canApply || (canLevelUp && hardBlockers.length === 0 && choicesComplete));

  const toggleChoice = (choice, optionId) => {
    const selected = choiceSelections[choice.id] || [];
    const exists = selected.includes(optionId);
    const count = Number(choice.count || 0);
    const nextSelected = exists
      ? selected.filter((id) => id !== optionId)
      : [...selected, optionId].slice(Math.max(0, selected.length + 1 - count));
    const nextSelections = {
      ...choiceSelections,
      [choice.id]: nextSelected,
    };
    setChoiceSelections(nextSelections);
    onChoicesChange?.(nextSelections);
  };

  const submitLevelUp = () => {
    onConfirm({ choices: choiceSelections });
  };

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Level up preview">
      <div className="level-up-modal">
        <div className="sheet-header">
          <div>
            <p className="eyebrow">Level Up</p>
            <h2>{preview ? `${preview.className} Level ${preview.nextLevel}` : 'Level Up'}</h2>
            {preview && (
              <p>
                XP {preview.currentXp}/{preview.threshold ?? '--'} - Level {preview.currentLevel} to {preview.nextLevel}
              </p>
            )}
          </div>
          <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
        </div>

        {error && <div className="level-up-alert">{error}</div>}

        {preview && (
          <div className="level-up-content">
            <div className="sheet-stat-strip">
              <SheetStat label="Status" value={canLevelUp ? 'Ready' : 'Not Yet'} />
              <SheetStat label="HP Gain" value={`+${preview.hp?.increase ?? 0}`} />
              <SheetStat label="PB" value={`${fmtMod(preview.proficiencyBonus?.current)} -> ${fmtMod(preview.proficiencyBonus?.next)}`} />
              <SheetStat label="Apply" value={canApply ? 'Unlocked' : 'Blocked'} />
            </div>

            <section className="sheet-section">
              <h3>Hit Points</h3>
              <p className="muted-text">
                Fixed increase: {preview.hp?.fixedBase ?? '--'} + CON {fmtMod(preview.hp?.constitutionModifier)}
                {preview.hp?.perLevelBonus ? ` + bonus ${fmtMod(preview.hp.perLevelBonus)}` : ''}.
              </p>
            </section>

            <section className="sheet-section">
              <h3>New Features</h3>
              {preview.features?.length ? preview.features.map((feature) => (
                <div key={feature.id || feature.name} className="sheet-line">
                  <strong>{feature.name}</strong>
                  <span>{feature.description}</span>
                </div>
              )) : <p className="muted-text">No new feature data for this level.</p>}
            </section>

            {preview.selectedSubclass && (
              <section className="sheet-section">
                <h3>Subclass</h3>
                <div className="sheet-line">
                  <strong>{preview.selectedSubclass.name}</strong>
                  <span>{preview.selectedSubclass.description}</span>
                </div>
              </section>
            )}

            {activeRequiredChoices.length > 0 && (
              <section className="sheet-section">
                <h3>Level Choices</h3>
                {activeRequiredChoices.map((choice) => (
                  <div key={choice.id} className="level-up-choice">
                    <div className="sheet-line">
                      <strong>{choice.label || titleCase(choice.id)}</strong>
                      <span>Choose {choice.count}</span>
                    </div>
                    <div className="level-up-choice-grid">
                      {(choice.options || []).filter((option) => isLevelUpOptionAvailable(option, choiceSelections)).map((option) => {
                        const selected = (choiceSelections[choice.id] || []).includes(option.id);
                        return (
                          <button
                            type="button"
                            key={option.id}
                            className={`choice-card level-up-option${selected ? ' selected' : ''}`}
                            onClick={() => toggleChoice(choice, option.id)}
                          >
                            <strong>{option.name || titleCase(option.id)}</strong>
                            {option.meta && <small>{option.meta}</small>}
                            {option.description && <span>{option.description}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {preview.spellcasting && (
              <section className="sheet-section">
                <h3>Spellcasting</h3>
                <p className="muted-text">{formatPreviewSpellcasting(preview.spellcasting)}</p>
              </section>
            )}

            <section className="sheet-section">
              <h3>Before Applying</h3>
              {blockers.length ? blockers.map((blocker) => (
                <div key={`${blocker.type}-${blocker.message}`} className="sheet-line">
                  <strong>{titleCase(blocker.type)}</strong>
                  <span>{blocker.message}</span>
                </div>
              )) : <p className="muted-text">No blockers. The rules table is calm, which is suspicious but welcome.</p>}
            </section>

            <div className="level-up-actions">
              <button type="button" className="secondary-btn" onClick={onClose}>Not Now</button>
              <button type="button" className="primary-btn" onClick={submitLevelUp} disabled={!canApply || busy}>
                {busy ? 'Applying...' : canApply ? 'Apply Level Up' : 'Rules Work Needed'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function isLevelUpChoiceActive(choice = {}, selections = {}) {
  const condition = choice.required_if;
  if (!condition) return true;
  const selected = selections[condition.choice_id] || [];
  const required = String(condition.includes || condition.equals || '').toLowerCase();
  return required ? selected.includes(required) : true;
}

function isLevelUpOptionAvailable(option, selections = {}) {
  if (!option) return false;
  const requirement = option.requires_choice;
  if (!requirement) return true;
  return (selections[requirement.choice_id] || []).includes(requirement.option_id);
}

function SheetStat({ label, value }) {
  return (
    <div className="sheet-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatPreviewSpellcasting(spellcasting = {}) {
  const parts = [];
  if (spellcasting.cantrips !== undefined) parts.push(`${spellcasting.cantrips} cantrips`);
  if (spellcasting.prepared_spells !== undefined) parts.push(`${spellcasting.prepared_spells} prepared spells`);
  if (spellcasting.spellbook_spells_add) parts.push(`${spellcasting.spellbook_spells_add} spellbook additions`);
  if (spellcasting.always_prepared_spells?.length) {
    parts.push(`always prepared: ${spellcasting.always_prepared_spells.map((spell) => spell.replaceAll('_', ' ')).join(', ')}`);
  }
  if (spellcasting.slots) {
    parts.push(`slots ${Object.entries(spellcasting.slots).map(([level, count]) => `L${level}:${count}`).join(', ')}`);
  }
  return parts.join(' - ') || 'No spellcasting changes.';
}

function formatEffectSummary(effect) {
  const parts = [];
  if (effect.mechanical_effect) parts.push(effect.mechanical_effect);
  parts.push(...getEffectRules(effect).map((rule) => formatEffectRuleSummary(rule, effect)).filter(Boolean));
  if (effect.duration) parts.push(`Duration ${effect.duration}`);
  if (effect.remaining_rounds != null) parts.push(`${effect.remaining_rounds} rounds left`);
  else if (effect.remaining_minutes != null) parts.push(`${effect.remaining_minutes} minutes left`);
  if (effect.concentration) parts.push('Concentration');
  return parts.join(' - ') || 'Effect active';
}

function getEffectRules(effect = {}) {
  return Array.isArray(effect.rules_effects) && effect.rules_effects.length
    ? effect.rules_effects
    : [effect];
}

function formatEffectRuleSummary(rule = {}, effect = {}) {
  const target = rule.target || effect.target;
  const value = rule.value ?? effect.value;
  if (target === 'armor_formula') {
    return `Base AC ${rule.base ?? effect.base ?? '--'}${(rule.dex_cap ?? effect.dex_cap) == null ? ' + full DEX modifier' : ` + DEX modifier cap ${rule.dex_cap ?? effect.dex_cap}`}`;
  }
  if (target === 'shield_bonus') {
    return `AC ${fmtMod(value)}`;
  }
  if (target === 'armor_class_bonus') {
    return `AC ${fmtMod(value)}`;
  }
  if (target === 'max_hp_per_level_bonus') {
    return `Max HP ${fmtMod(value)} per level`;
  }
  if (target && value != null) {
    return `${titleCase(String(target).replaceAll('_', ' '))}: ${fmtMod(value)}`;
  }
  return '';
}

function formatEffectName(effect) {
  if (effect.name) return effect.name;
  if (effect.source_item_name) return effect.source_item_name;
  if (effect.id) return titleCase(String(effect.id).replaceAll('_', ' '));
  if (effect.target) return titleCase(String(effect.target).replaceAll('_', ' '));
  return 'Passive Effect';
}

function formatClassChoiceValue(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => String(entry || '').replaceAll('_', ' ')).filter(Boolean).join(', ');
}

function formatClassChoiceDetailValue(value, nameFormatter = formatClassChoiceValue) {
  if (Array.isArray(value)) return value.map((entry) => formatClassChoiceDetailValue(entry, nameFormatter)).join(', ');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, nested]) => `${key.replaceAll('_', ' ')}: ${formatClassChoiceDetailValue(nested, nameFormatter)}`).join(', ');
  }
  return nameFormatter(value);
}

function isEquipmentEffect(effect = {}) {
  return effect.source_type === 'equipment'
    || String(effect.id || '').startsWith('equipment_')
    || Boolean(effect.source_item_id || effect.source_item_name);
}

function buildDerivedDefenseEffects(derived = {}) {
  return (derived.armor_class_breakdown || [])
    .filter((entry) => /fighting style/i.test(String(entry.label || '')))
    .map((entry) => ({
      id: `derived_defense_${String(entry.label || 'bonus').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      name: entry.label || 'Defense Bonus',
      mechanical_effect: `AC ${fmtMod(entry.value)}`,
      source_type: 'derived_defense',
    }));
}

export default App;
