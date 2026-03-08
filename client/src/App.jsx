import { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { socket } from './socket';
import './App.css';

// ── ROLL sentinel parser ──────────────────────────────────────────────────
// Parses [ROLL: XdY+Z] or [ROLL: XdY-Z] from DM1 response text.
// Returns { diceCount, dieSides, modifier, raw } or null if not found.
function parseRollTag(text) {
  const match = text.match(/\[ROLL:\s*(\d+)d(\d+)([+-]\d+)?\]/i);
  if (!match) return null;
  return {
    diceCount: parseInt(match[1], 10),
    dieSides:  parseInt(match[2], 10),
    modifier:  match[3] ? parseInt(match[3], 10) : 0,
    raw:       match[0],
  };
}

// Strip [ROLL: ...] tags from text shown to the player
function stripRollTag(text) {
  return text.replace(/\s*\[ROLL:\s*\d+d\d+[+-]?\d*\]/gi, '').trim();
}

// Roll dice client-side using Math.random()
function rollDice(diceCount, dieSides) {
  let total = 0;
  for (let i = 0; i < diceCount; i++) {
    total += Math.floor(Math.random() * dieSides) + 1;
  }
  return total;
}

function App() {
  const [sessionId, setSessionId] = useState(null);
  const [connected, setConnected] = useState(false);

  // Narrative feed (DM1)
  const [narrative, setNarrative] = useState([]);
  const [storyInput, setStoryInput] = useState('');
  const [dm1Typing, setDm1Typing] = useState(false);

  // Rules panel (DM2)
  const [rulesLog, setRulesLog] = useState([]);
  const [rulesInput, setRulesInput] = useState('');
  const [dm2Typing, setDm2Typing] = useState(false);

  // Dice roller state
  const [pendingRoll, setPendingRoll] = useState(null); // { diceCount, dieSides, modifier } | null
  const [rollResult, setRollResult] = useState(null);   // { rolled, modifier, total } | null

  const narrativeEndRef = useRef(null);
  const rulesEndRef = useRef(null);

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

    socket.connect();

    socket.on('connect', () => {
      setConnected(true);
      const savedSession = localStorage.getItem('hd_session_id');
      socket.emit('join_session', { sessionId: savedSession || null });
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('session_joined', ({ sessionId: id }) => {
      setSessionId(id);
      localStorage.setItem('hd_session_id', id);
      // New session — emit session_start so DM1 generates the campaign opening.
      // Guard is enforced server-side too, but we only emit here on fresh join.
      socket.emit('session_start');
    });

    socket.on('session_resumed', ({ sessionId: id, history }) => {
      setSessionId(id);
      localStorage.setItem('hd_session_id', id);

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

      // BUG-012: if no history exists, treat as new session
      if (narrativeHistory.length === 0 && rulesHistory.length === 0) {
        socket.emit('session_start');
        setRulesLog([]);
        return;
      }

      // Add a divider after restored history to mark the resumed session boundary
      const divider = { type: 'divider', text: '— Session resumed —', id: 'divider-resume' };
      setNarrative([...narrativeHistory, divider]);
      setRulesLog(rulesHistory);
    });

    socket.on('dm1_typing', (val) => setDm1Typing(val));
    socket.on('dm2_typing', (val) => setDm2Typing(val));

    socket.on('dm1_response', ({ message }) => {
      // Parse any [ROLL: ...] sentinel tag before displaying
      const rollTag = parseRollTag(message);
      const displayText = stripRollTag(message);

      setNarrative((prev) => [...prev, { type: 'dm1', text: displayText, id: Date.now() }]);

      if (rollTag) {
        // Activate the dice roller
        setPendingRoll({
          diceCount: rollTag.diceCount,
          dieSides:  rollTag.dieSides,
          modifier:  rollTag.modifier,
        });
        setRollResult(null);
      }
    });

    socket.on('dm2_response', ({ message }) => {
      setRulesLog((prev) => [...prev, { type: 'dm2', text: message, id: Date.now() }]);
    });

    // DM1-track errors → narrative feed
    socket.on('error', ({ message }) => {
      setNarrative((prev) => [...prev, { type: 'error', text: message, id: Date.now() }]);
    });

    // DM2-track errors → rules feed (BUG-011)
    socket.on('dm2_error', ({ message }) => {
      setRulesLog((prev) => [...prev, { type: 'error', text: message, id: Date.now() }]);
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
    const { diceCount, dieSides, modifier } = pendingRoll;
    const rolled = rollDice(diceCount, dieSides);
    const total  = rolled + modifier;
    setRollResult({ rolled, modifier, total });
  }, [pendingRoll]);

  const handleSubmitRoll = useCallback(() => {
    if (!rollResult || !pendingRoll) return;
    const { diceCount, dieSides, modifier } = pendingRoll;
    const { total } = rollResult;

    // Format the roll result message
    const modStr = modifier > 0 ? ` + ${modifier}` : modifier < 0 ? ` - ${Math.abs(modifier)}` : '';
    const rollMsg = `I rolled a ${total} (${diceCount}d${dieSides}${modStr} = ${total})`;

    setNarrative((prev) => [...prev, { type: 'player', text: rollMsg, id: Date.now() }]);
    socket.emit('story_input', { message: rollMsg });

    // Clear the dice roller
    setPendingRoll(null);
    setRollResult(null);
  }, [rollResult, pendingRoll]);

  // BUG-009: textarea stays active during DM loading; only the submit button locks
  const storyTextareaDisabled = !connected || !sessionId;
  // During a pending roll, the story input is hidden — the dice roller takes over
  const storyDisabled = dm1Typing || !connected || !sessionId || !!pendingRoll;
  // BUG-017: rules textarea stays active during DM2 typing; only the ASK button locks
  const rulesTextareaDisabled = !connected || !sessionId;
  const rulesDisabled = dm2Typing || !connected || !sessionId;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="app-header">
        <h1>Hallucinated Dungeons</h1>
        <span className={`connection-status ${connected ? 'online' : 'offline'}`}>
          {connected ? '⚔ Connected' : '✖ Disconnected'}
        </span>
      </header>

      <main className="app-main">

        {/* ── Narrative panel (DM1) ─────────────────────────────────── */}
        <section className="panel narrative-panel">
          <div className="panel-header">
            <span className="panel-label dm1-label">The Dungeon Master</span>
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
                  </span>
                </div>

                {!rollResult ? (
                  <button className="roll-btn" onClick={handleRoll}>
                    Roll {pendingRoll.diceCount}d{pendingRoll.dieSides}
                    {pendingRoll.modifier !== 0 && (
                      <span className="roll-btn-mod">
                        {pendingRoll.modifier > 0 ? ` +${pendingRoll.modifier}` : ` ${pendingRoll.modifier}`}
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="roll-result-area">
                    <div className="roll-result">
                      <span className="roll-result-total">{rollResult.total}</span>
                      <span className="roll-result-breakdown">
                        (rolled {rollResult.rolled}
                        {rollResult.modifier > 0 && ` + ${rollResult.modifier}`}
                        {rollResult.modifier < 0 && ` − ${Math.abs(rollResult.modifier)}`}
                        )
                      </span>
                    </div>
                    <button className="submit-roll-btn" onClick={handleSubmitRoll}>
                      Submit Roll
                    </button>
                  </div>
                )}
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
    </div>
  );
}

export default App;
