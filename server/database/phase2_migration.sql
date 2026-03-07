-- ============================================================
-- Hallucinated Dungeons — Phase 2 Migration
-- Run this in the Supabase SQL Editor before deploying Phase 2.
-- ============================================================

-- ── sessions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT        NOT NULL DEFAULT 'active'
  -- status is reserved for future use; expiry not enforced in Phase 2
);
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;

-- ── messages ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID        NOT NULL REFERENCES sessions(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  turn_number    INTEGER     NULL,
  -- Populated for player_dm1 and dm1 rows (same value for both messages
  -- of the same exchange — the pre-increment session_turn).
  -- NULL for player_dm2 and dm2 rows.
  role           TEXT        NOT NULL,
  -- Values: player_dm1, dm1, player_dm2, dm2
  content        TEXT        NOT NULL,
  token_estimate INTEGER     NULL
);
CREATE INDEX IF NOT EXISTS messages_session_role ON messages(session_id, role);
CREATE INDEX IF NOT EXISTS messages_session_turn ON messages(session_id, turn_number);
ALTER TABLE messages DISABLE ROW LEVEL SECURITY;

-- ── world_state ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS world_state (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL UNIQUE REFERENCES sessions(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  state       JSONB       NOT NULL DEFAULT '{}'
);
ALTER TABLE world_state DISABLE ROW LEVEL SECURITY;

-- ── campaign_log ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL REFERENCES sessions(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  turn_number INTEGER     NOT NULL,
  summary     TEXT        NOT NULL,
  type        TEXT        NOT NULL DEFAULT 'entry',
  -- Values: entry (raw extracted event) or archive (compressed summary).
  -- Compression never targets archive rows.
  tags        TEXT[]      NULL
);
CREATE INDEX IF NOT EXISTS campaign_log_session ON campaign_log(session_id, created_at);
ALTER TABLE campaign_log DISABLE ROW LEVEL SECURITY;

-- ── chapter_summaries ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chapter_summaries (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL REFERENCES sessions(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  turn_start  INTEGER     NOT NULL,
  turn_end    INTEGER     NOT NULL,
  summary     TEXT        NOT NULL
);
CREATE INDEX IF NOT EXISTS chapter_summaries_session ON chapter_summaries(session_id, turn_start);
ALTER TABLE chapter_summaries DISABLE ROW LEVEL SECURITY;

-- ── dm_logs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dm_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES sessions(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dm            TEXT        NOT NULL,
  -- Values: dm1, dm2, world_state, campaign_log, chapter_summary
  model         TEXT        NOT NULL,
  player_input  TEXT        NULL,
  full_prompt   TEXT        NOT NULL,
  dm_response   TEXT        NULL,
  -- NULL for failed API calls (distinguishes failure from empty response)
  input_tokens  INTEGER     NULL,
  output_tokens INTEGER     NULL
);
CREATE INDEX IF NOT EXISTS dm_logs_session ON dm_logs(session_id, created_at);
ALTER TABLE dm_logs DISABLE ROW LEVEL SECURITY;
