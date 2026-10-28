-- 021_director_workspace.sql
--
-- Additive migration (CONVENTIONS.md Rule 9: never edit applied migrations).
--
-- Director Workspace (Master Blueprint sections 7-12):
--   - director_conversations: ONE persistent owner<->director communication
--     window per (owner, agent). Lazily created on first access, so Director
--     #50 receives its window exactly like Director #01.
--   - director_messages: append-only conversation history with explicit
--     execution semantics (conversation | proposal | instruction | decision).
--     Recording a message NEVER triggers production or publishing by itself —
--     conversation is not execution (Blueprint section 10).
--   - director_roadmap_items: per-director long-term roadmap in four buckets
--     (now | next | future | ideas) (Blueprint section 11).
--   - director_memory_entries: isolated per-director memory, one entry per
--     category (universe bible, characters, ... ) (Blueprint section 12).
--     No director automatically receives another director's memory: every
--     table carries (owner_id, agent_id) and every read is scoped to both.
--
-- All statements are idempotent (IF NOT EXISTS). New closed enums here are
-- introduced by this issue; existing status enums elsewhere are untouched.

CREATE TABLE IF NOT EXISTS director_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id)
);

CREATE TABLE IF NOT EXISTS director_messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES director_conversations(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id),
  sender text NOT NULL CHECK (sender IN ('owner', 'director')),
  kind text NOT NULL CHECK (kind IN ('conversation', 'proposal', 'instruction', 'decision')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS director_messages_conversation_idx
  ON director_messages (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS director_messages_agent_idx
  ON director_messages (agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS director_roadmap_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id),
  bucket text NOT NULL CHECK (bucket IN ('now', 'next', 'future', 'ideas')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  detail text CHECK (char_length(detail) <= 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'done', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS director_roadmap_agent_idx
  ON director_roadmap_items (owner_id, agent_id, bucket);

CREATE TABLE IF NOT EXISTS director_memory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id),
  category text NOT NULL CHECK (category IN (
    'universe_bible', 'characters', 'locations', 'story_rules',
    'visual_identity', 'voice_identity', 'music_identity',
    'audience_insights', 'owner_decisions', 'production_history'
  )),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, agent_id, category)
);
