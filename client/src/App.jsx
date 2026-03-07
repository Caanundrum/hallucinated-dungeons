import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { socket } from './socket';
import './App.css';

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

  const narrativeEndRef = useRef(null);
  const rulesEndRef = useRef(null);

  // ── Socket lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    socket.connect();

    socket.on('connect', () => {
      setConnected(true);
      const savedSession = localStorage.getItem('hd_session_id');
      socket.emit('join_session', { sessionId: savedSession || null });
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('session_joined', ({ sessionId }) => {
      setSessionId(sessionId);
      localStorage.setItem('hd_session_id', sessionId);
      setNarrative([{
        type: 'dm1',
        text: 'The candle flickers. Shadows press close. Your adventure is about to begin...\n\nDescribe your character or type what you do to start your journey.',
        id: 'intro',
      }]);
    });

    socket.on('session_resumed', ({ sessionId, history }) => {
      setSessionId(sessionId);
      localStorage.setItem('hd_session_id', sessionId);

      // Rebuild narrative feed from DM1-track history
      const narrativeHistory = history
        .filter((m) => m.role === 'player_dm1' || m.role === 'dm1')
        .map((m) => ({
          type: m.role === 'dm1' ? 'dm1' : 'player',
          text: m.content,
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

      // Add a divider before restored history, then show it
      const divider = { type: 'divider', text: '— Session resumed —', id: 'divider-resume' };
      setNarrative([...narrativeHistory, divider]);
      setRulesLog(rulesHistory);
    });

    socket.on('dm1_typing', (val) => setDm1Typing(val));
    socket.on('dm2_typing', (val) => setDm2Typing(val));

    socket.on('dm1_response', ({ message }) => {
      setNarrative((prev) => [...prev, { type: 'dm1', text: message, id: Date.now() }]);
    });

    socket.on('dm2_response', ({ message }) => {
      setRulesLog((prev) => [...prev, { type: 'dm2', text: message, id: Date.now() }]);
    });

    socket.on('error', ({ message }) => {
      setNarrative((prev) => [...prev, { type: 'error', text: message, id: Date.now() }]);
    });

    return () => socket.disconnect();
  }, []);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    narrativeEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [narrative, dm1Typing]);

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

  const storyDisabled = dm1Typing || !connected || !sessionId;
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
                placeholder="Describe your action..."
                disabled={storyDisabled}
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
                {msg.type === 'dm2' && <span className="msg-tag dm2-tag">Rules</span>}
                {msg.type === 'player' && <span className="msg-tag player-tag">You</span>}
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
                disabled={rulesDisabled}
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
