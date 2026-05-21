-- ============================================================
-- Hallucinated Dungeons - Supabase Security Lockdown
-- Applied to production Supabase on 2026-05-21.
--
-- Access model:
-- - Browser clients talk to the Railway Node backend only.
-- - The backend uses SUPABASE_SERVICE_ROLE_KEY.
-- - No public anon/authenticated table access is needed yet.
-- ============================================================

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.world_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapter_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dm_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_presence ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.sessions,
  public.messages,
  public.world_state,
  public.campaign_log,
  public.chapter_summaries,
  public.dm_logs,
  public.campaigns,
  public.characters,
  public.campaign_characters,
  public.character_presence
FROM anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE
  public.sessions,
  public.messages,
  public.world_state,
  public.campaign_log,
  public.chapter_summaries,
  public.dm_logs,
  public.campaigns,
  public.characters,
  public.campaign_characters,
  public.character_presence
TO service_role;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
