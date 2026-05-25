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

// Roll dice client-side using Math.random()
function rollDiceResults(diceCount, dieSides) {
  const rolls = [];
  for (let i = 0; i < diceCount; i++) {
    rolls.push(Math.floor(Math.random() * dieSides) + 1);
  }
  return rolls;
}

function formatNaturalRollDetails(rolls, dieSides) {
  if (!Array.isArray(rolls) || rolls.length === 0) return '';
  if (dieSides === 20 && rolls.length === 1) return `natural ${rolls[0]}; `;
  return `dice ${rolls.join(', ')}; `;
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
  return {
    id: characterId,
    name: identity.name || 'Unnamed Character',
    isActiveForSession: true,
    identity,
    summary: {
      species: identity.species_name || identity.species || '',
      className: identity.class_name || identity.class || '',
      level: identity.level || derived.level || 1,
      hp: derived.hp ?? null,
      maxHp: derived.max_hp ?? null,
      armorClass: derived.armor_class ?? null,
    },
    character,
  };
}

// ── Fallback roll detector ────────────────────────────────────────────────
// When DM1 requests a roll in natural language but the [ROLL:] sentinel tag
// is absent or unparseable, detect the roll request and show a generic roller.
// Returns { dieSides } if a roll request is detected, or null otherwise.
function detectFallbackRoll(text) {
  // Match patterns like "roll a d20", "roll 1d20", "make a ... saving throw",
  // "roll a d8 for damage", "roll for initiative", etc.
  const dieMatch = text.match(/roll\s+(?:a\s+)?(?:\d+d(\d+)|d(\d+))/i);
  if (dieMatch) {
    const sides = parseInt(dieMatch[1] || dieMatch[2], 10);
    if (sides > 0) return { dieSides: sides };
  }
  // Catch "make a ... saving throw / check" — default to d20
  if (/make\s+a\s+\w+(?:\s+\w+)?\s+(?:saving\s+throw|ability\s+check|check|save)/i.test(text)) {
    return { dieSides: 20 };
  }
  // Catch "roll for initiative"
  if (/roll\s+(?:for\s+)?initiative/i.test(text)) {
    return { dieSides: 20 };
  }
  return null;
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
  const [characterError, setCharacterError] = useState(null);
  const [characterSaving, setCharacterSaving] = useState(false);
  const [characterJoining, setCharacterJoining] = useState(false);

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
  // Fallback roller state for natural-language roll detection without sentinel tag.
  const [fallbackRoll, setFallbackRoll] = useState(null);   // { dieSides, modifier } | null — modifier is user-entered
  const [fallbackModInput, setFallbackModInput] = useState('0'); // controlled input for modifier

  const narrativeEndRef = useRef(null);
  const rulesEndRef = useRef(null);
  const pendingSessionStartRef = useRef(false);
  const currentCharacterRef = useRef(null);

  useEffect(() => {
    currentCharacterRef.current = currentCharacter;
  }, [currentCharacter]);

  // ── Socket lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    // Remove any stale listeners before re-registering (spec §9.1 — prevents
    // React 18 StrictMode double-mount from creating duplicate handlers)
    socket.off('connect');
    socket.off('disconnect');
    socket.off('session_joined');
    socket.off('session_resumed');
    socket.off('session_start_ack');
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
      setCharacterStatus('loading');
      pendingSessionStartRef.current = true;
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
        pendingSessionStartRef.current = true;
        setRulesLog([]);
      } else {
        pendingSessionStartRef.current = false;
      }

      // Add a divider after restored history to mark the resumed session boundary
      const divider = { type: 'divider', text: '— Session resumed —', id: 'divider-resume' };
      setNarrative([...narrativeHistory, divider]);
      setRulesLog(rulesHistory);
      socket.emit('get_character_data', { sessionId: id, sessionToken });
    });

    socket.on('character_data', ({ content, character, characters = [], activeCharacterId }) => {
      setCharacterContent(content);
      setAvailableCharacters(characters);
      setActiveCharacterId(activeCharacterId || null);
      setCharacterError(null);
      setCurrentCharacter(character || null);
      if (character) {
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
      setCharacterError(null);
      if (character) setCurrentCharacter(character);
      if (characterId) setActiveCharacterId(characterId);
      if (character && characterId) {
        const option = summarizeCharacterOption(characterId, character);
        setAvailableCharacters((prev) => [option, ...prev.filter((item) => item.id !== characterId)]);
      }
      setCharacterStatus('ready');
      pendingSessionStartRef.current = false;
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
        setFallbackRoll(null);
        setFallbackModInput('0');
      } else if (rollTag?.id) {
        // Primary path: sentinel tag parsed successfully — activate the dice roller
        setPendingRoll({
          id:        rollTag.id,
          diceCount: rollTag.diceCount,
          dieSides:  rollTag.dieSides,
          modifier:  rollTag.modifier,
          label: inferBasicRollLabel(message),
        });
        // Clear any stale fallback state
        setFallbackRoll(null);
        setFallbackModInput('0');
      } else if (rollTag) {
        setPendingRoll(null);
        setFallbackRoll({ dieSides: rollTag.dieSides, modifier: rollTag.modifier });
        setFallbackModInput(String(rollTag.modifier || 0));
      } else {
        // No parseable sentinel, so scan natural language for a roll request.
        const fallback = detectFallbackRoll(message);
        if (fallback) {
          setFallbackRoll(fallback);
          setFallbackModInput('0');
        }
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
      socket.off('session_start_ack');
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
      socket.disconnect();
    };
  }, []);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    narrativeEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [narrative, dm1Typing, pendingRoll, fallbackRoll]);

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
      setNarrative((prev) => [...prev, { type: 'error', text: 'This roll was missing its server roll id. Ask the DM to request the roll again.', id: Date.now() }]);
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

  // ── Fallback roller handlers ─────────────────────────────────────────────
  const handleFallbackRoll = useCallback(() => {
    if (!fallbackRoll) return;
    const modifier = parseInt(fallbackModInput, 10) || 0;
    const rolls = rollDiceResults(1, fallbackRoll.dieSides);
    const rolled = rolls[0];
    const total  = rolled + modifier;
    const { dieSides } = fallbackRoll;
    const modStr = modifier > 0 ? ` + ${modifier}` : modifier < 0 ? ` - ${Math.abs(modifier)}` : '';
    const naturalDetails = formatNaturalRollDetails(rolls, dieSides);
    const rollMsg = `[ROLL RESULT: ${total}] I rolled a ${total} (${naturalDetails}1d${dieSides}${modStr} = ${total})`;
    const displayRollMsg = stripRollResultPrefix(rollMsg);
    setNarrative((prev) => [...prev, { type: 'player', text: displayRollMsg, id: Date.now() }]);
    socket.emit('story_input', { message: rollMsg });
    setFallbackRoll(null);
    setFallbackModInput('0');
  }, [fallbackRoll, fallbackModInput]);

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
    setCharacterJoining(true);
    setCharacterError(null);
    socket.emit('join_character', { sessionId, sessionToken, characterId });
  }, [sessionId, sessionToken]);

  const handleCreateNewCharacter = useCallback(() => {
    setCurrentCharacter(null);
    setActiveCharacterId(null);
    setCharacterError(null);
    setCharacterStatus('required');
  }, []);

  const handleSwitchCharacter = useCallback(() => {
    if (sessionId && sessionToken && currentCharacter) {
      socket.emit('leave_character', { sessionId, sessionToken });
    }
    setCharacterError(null);
    setCharacterStatus('select');
  }, [sessionId, sessionToken, currentCharacter]);

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

  // Textarea stays active during DM loading; only the submit button locks.
  const storyTextareaDisabled = !connected || !sessionId;
  // During a pending roll (primary or fallback), the story input is locked — the dice roller takes over
  const storyDisabled = dm1Typing || !connected || !sessionId || !!pendingRoll || !!fallbackRoll;
  // Rules textarea stays active during DM2 typing; only the Ask button locks.
  const rulesTextareaDisabled = !connected || !sessionId;
  const rulesDisabled = dm2Typing || !connected || !sessionId;

  if (characterStatus !== 'ready') {
    return (
      <div className="app">
        <header className="app-header">
          <div className="brand-block">
            <h1>Hallucinated Dungeons</h1>
            <p className="ai-disclosure">AI-generated adventure and rules responses</p>
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
        ) : characterStatus === 'select' ? (
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
        </div>
        <span className={`connection-status ${connected ? 'online' : 'offline'}`}>
          {connected ? '⚔ Connected' : '✖ Disconnected'}
        </span>
      </header>

      <main className="app-main">

        {/* ── Narrative panel (DM1) ─────────────────────────────────── */}
        <section className="panel narrative-panel">
          <div className="panel-header">
            <span className="panel-label dm1-label">The Dungeon Master</span>
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
                    {msg.type === 'dm1' && <span className="msg-tag">DM</span>}
                    {msg.type === 'player' && <span className="msg-tag player-tag">You</span>}
                    {msg.type === 'error' && <span className="msg-tag error-tag">!</span>}
                    {msg.type === 'dm1'
                      ? <div className="markdown-body"><ReactMarkdown>{msg.text}</ReactMarkdown></div>
                      : <p>{msg.text}</p>}
                  </div>
            ))}
            {dm1Typing && (
              <div className="message message--dm1 typing-indicator">
                <span className="msg-tag">DM</span>
                <p><span className="dot" /><span className="dot" /><span className="dot" /></p>
              </div>
            )}

            {/* ── Dice roller ──────────────────────────────────────────── */}
            {pendingRoll && !dm1Typing && (
              <div className="dice-roller" id="dice-roller">
                <div className="dice-roller-header">
                  <span className="dice-roller-label">🎲 Roll Required</span>
                  <span className="dice-roller-spec">
                    {pendingRoll.diceCount}d{pendingRoll.dieSides}
                    {pendingRoll.modifier > 0 && ` + ${pendingRoll.modifier}`}
                    {pendingRoll.modifier < 0 && ` − ${Math.abs(pendingRoll.modifier)}`}
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

            {/* ── Fallback generic dice roller ──────────────────────────── */}
            {fallbackRoll && !pendingRoll && !dm1Typing && (
              <div className="dice-roller dice-roller--fallback" id="dice-roller-fallback">
                <div className="dice-roller-header">
                  <span className="dice-roller-label">🎲 Roll Required</span>
                  <span className="dice-roller-spec">d{fallbackRoll.dieSides}</span>
                </div>
                <div className="fallback-modifier-row">
                  <label className="fallback-mod-label">Add your modifier:</label>
                  <input
                    className="fallback-mod-input"
                    type="number"
                    value={fallbackModInput}
                    onChange={(e) => setFallbackModInput(e.target.value)}
                    min="-10"
                    max="20"
                  />
                </div>
                <button className="roll-btn" onClick={handleFallbackRoll}>
                  Roll 1d{fallbackRoll.dieSides}
                  {parseInt(fallbackModInput, 10) !== 0 && (
                    <span className="roll-btn-mod">
                      {parseInt(fallbackModInput, 10) > 0
                        ? ` +${fallbackModInput}`
                        : ` ${fallbackModInput}`}
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
                placeholder={(pendingRoll || fallbackRoll) ? 'Use the dice roller above to roll...' : 'Describe your action...'}
                disabled={storyTextareaDisabled || !!pendingRoll || !!fallbackRoll}
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
        <CharacterSheetModal character={currentCharacter} content={characterContent} onClose={() => setSheetOpen(false)} />
      )}
    </div>
  );
}

function CharacterSheetModal({ character, content, onClose }) {
  const identity = character.identity || {};
  const abilities = character.abilities || {};
  const derived = character.derived_stats || {};
  const passiveBonuses = character.active_effects || [];
  const activeEffects = derived.active_spell_effects || [];
  const attacks = derived.attack_breakdowns || [];
  const skills = derived.skill_modifiers || {};
  const saves = derived.saving_throw_modifiers || {};
  const features = character.features || [];
  const inventory = character.inventory || [];
  const details = character.character_details || {};
  const languages = character.languages || character.proficiencies?.languages || [];
  const speciesSpells = character.species_spells || [];
  const resistances = character.resistances || [];
  const spellcasting = character.spellcasting || null;
  const magicInitiate = character.origin?.magic_initiate || {};
  const spellById = (spellId) => content?.spells?.find((spell) => spell.id === spellId);
  const spellName = (spellId) => spellById(spellId)?.name || String(spellId || '').replaceAll('_', ' ');
  const spellSummary = (spellId) => {
    const spell = spellById(spellId);
    if (!spell) return spellName(spellId);
    return `${spell.name}: ${spell.description} (${spell.casting_time}, ${spell.range}, ${spell.duration})`;
  };
  const magicInitiateRows = Object.entries(magicInitiate).map(([source, choice]) => ({
    source,
    label: source === 'background_feat' ? 'Background Magic Initiate' : 'Human Magic Initiate',
    cantrips: (choice.cantrips || []).map(spellName),
    spell: choice.spell ? spellName(choice.spell) : '',
  }));

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Character sheet">
      <div className="character-sheet-modal">
        <div className="sheet-header">
          <div>
            <p className="eyebrow">Character Sheet</p>
            <h2>{identity.name}</h2>
            <p>{identity.species_name} {identity.class_name} - Level {identity.level || derived.level || 1}</p>
          </div>
          <button type="button" className="secondary-btn" onClick={onClose}>Close</button>
        </div>

        <div className="sheet-stat-strip">
          <SheetStat label="HP" value={`${derived.hp ?? '--'}/${derived.max_hp ?? '--'}`} />
          <SheetStat label="AC" value={derived.armor_class ?? '--'} />
          <SheetStat label="Speed" value={`${derived.speed ?? '--'} ft`} />
          <SheetStat label="Init" value={fmtMod(derived.initiative)} />
          <SheetStat label="PB" value={fmtMod(derived.proficiency_bonus)} />
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

          {passiveBonuses.length > 0 && (
            <section className="sheet-section">
              <h3>Passive Bonuses</h3>
              {passiveBonuses.map((effect) => (
                <div key={`${effect.id || effect.name}-${effect.target || 'self'}`} className="sheet-line">
                  <strong>{effect.name || effect.id}</strong>
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
                <span key={skill}>{skill.replaceAll('_', ' ')} {fmtMod(data.total)}{data.proficient ? ' *' : ''}</span>
              ))}
            </div>
          </section>

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
            {resistances.length > 0 && (
              <div className="sheet-line">
                <strong>Resistances</strong>
                <span>{resistances.join(', ')}</span>
              </div>
            )}
            {speciesSpells.length > 0 && (
              <div className="sheet-line">
                <strong>Species Spells</strong>
                <span>{speciesSpells.map((spell) => spellSummary(spell.id || spell)).join(' | ')}</span>
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
                  {(spellcasting.spells_prepared || spellcasting.spells_known || []).length > 0 && (
                    <div className="sheet-line">
                      <strong>Level 1</strong>
                      <span>{(spellcasting.spells_prepared || spellcasting.spells_known || []).map(spellSummary).join(' | ')}</span>
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
                <strong>{item.name}</strong>
                <span>{item.description}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function SheetStat({ label, value }) {
  return (
    <div className="sheet-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatEffectSummary(effect) {
  const parts = [];
  if (effect.mechanical_effect) parts.push(effect.mechanical_effect);
  else if (effect.target && effect.value != null) parts.push(`${effect.target}: ${fmtMod(effect.value)}`);
  if (effect.duration) parts.push(`Duration ${effect.duration}`);
  if (effect.remaining_rounds != null) parts.push(`${effect.remaining_rounds} rounds left`);
  else if (effect.remaining_minutes != null) parts.push(`${effect.remaining_minutes} minutes left`);
  if (effect.concentration) parts.push('Concentration');
  return parts.join(' - ') || 'Effect active';
}

export default App;
