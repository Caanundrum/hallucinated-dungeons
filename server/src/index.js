require('dotenv').config({ override: true });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Setup ──────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
  },
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Load prompts ───────────────────────────────────────────────────────────
const DM1_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/dm1.txt'), 'utf8'
);
const DM2_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/dm2.txt'), 'utf8'
);

// ── In-memory session store (Phase 1) ─────────────────────────────────────
// Phase 2 will replace this with Supabase persistence
const sessions = {};

function getOrCreateSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      id: sessionId,
      dm1History: [],
      dm2History: [],
      createdAt: new Date().toISOString(),
    };
  }
  return sessions[sessionId];
}

// ── Claude API calls ───────────────────────────────────────────────────────
async function callDM1(session, playerMessage) {
  session.dm1History.push({ role: 'user', content: playerMessage });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: DM1_PROMPT,
    messages: session.dm1History,
  });

  const reply = response.content[0].text;
  session.dm1History.push({ role: 'assistant', content: reply });
  return reply;
}

async function callDM2(session, playerMessage) {
  session.dm2History.push({ role: 'user', content: playerMessage });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: DM2_PROMPT,
    messages: session.dm2History,
  });

  const reply = response.content[0].text;
  session.dm2History.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Socket.io events ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Player joins or creates a session
  socket.on('join_session', ({ sessionId }) => {
    const id = sessionId || uuidv4();
    const session = getOrCreateSession(id);
    socket.join(id);
    socket.sessionId = id;
    console.log(`Socket ${socket.id} joined session ${id}`);
    socket.emit('session_joined', { sessionId: id });
  });

  // Player sends a story action (routes to DM1)
  socket.on('story_input', async ({ message }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('error', { message: 'No active session. Please refresh.' });
      return;
    }

    try {
      const session = getOrCreateSession(sessionId);
      socket.emit('dm1_typing', true);
      const reply = await callDM1(session, message);
      socket.emit('dm1_typing', false);
      socket.emit('dm1_response', { message: reply });
    } catch (err) {
      console.error('DM1 error:', err);
      socket.emit('dm1_typing', false);
      socket.emit('error', { message: 'The Dungeon Master encountered an error. Please try again.' });
    }
  });

  // Player sends a rules question (routes to DM2)
  socket.on('rules_input', async ({ message }) => {
    const sessionId = socket.sessionId;
    if (!sessionId) {
      socket.emit('error', { message: 'No active session. Please refresh.' });
      return;
    }

    try {
      const session = getOrCreateSession(sessionId);
      socket.emit('dm2_typing', true);
      const reply = await callDM2(session, message);
      socket.emit('dm2_typing', false);
      socket.emit('dm2_response', { message: reply });
    } catch (err) {
      console.error('DM2 error:', err);
      socket.emit('dm2_typing', false);
      socket.emit('error', { message: 'The Rules Arbiter encountered an error. Please try again.' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Hallucinated Dungeons server running on port ${PORT}`);
});
