-- ============================================================
-- Hallucinated Dungeons — Phase 4A Migration
-- Campaign and Character Foundation
-- Run in Supabase SQL Editor before deploying Phase 4A server.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS campaigns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  story_state JSONB NOT NULL DEFAULT '{}'
);
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

INSERT INTO campaigns (id, slug, title, status)
VALUES ('00000000-0000-4000-8000-000000000001', 'main', 'Hallucinated Dungeons', 'active')
ON CONFLICT (slug) DO UPDATE
SET title = EXCLUDED.title,
    status = EXCLUDED.status,
    updated_at = now();

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id);

UPDATE sessions
SET campaign_id = '00000000-0000-4000-8000-000000000001'
WHERE campaign_id IS NULL;

CREATE TABLE IF NOT EXISTS characters (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  session_id       UUID UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  owner_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  future_account_id UUID NULL,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  character_sheet  JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS characters_campaign_idx ON characters(campaign_id);
CREATE INDEX IF NOT EXISTS characters_owner_session_idx ON characters(owner_session_id);
ALTER TABLE characters ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS campaign_characters (
  campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'available',
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, character_id)
);
ALTER TABLE campaign_characters ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS character_presence (
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  character_id  UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES sessions(id) ON DELETE SET NULL,
  presence      TEXT NOT NULL DEFAULT 'away',
  in_combat     BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, character_id)
);
ALTER TABLE character_presence ENABLE ROW LEVEL SECURITY;

-- The Node backend uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
-- No public anon/authenticated policies are created in Phase 4A.
