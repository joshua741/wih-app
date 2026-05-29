-- WIH App Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Pipeline stages (seeded below)
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL UNIQUE,
  pipeline    TEXT NOT NULL CHECK (pipeline IN ('agent_outreach', 'seller_inbound', 'active_deals')),
  position    INTEGER NOT NULL,
  color       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Contacts: sellers, agents, buyers
CREATE TABLE IF NOT EXISTS contacts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone           TEXT NOT NULL UNIQUE,
  name            TEXT,
  email           TEXT,
  address         TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  contact_type    TEXT NOT NULL DEFAULT 'seller'
                    CHECK (contact_type IN ('seller', 'agent', 'buyer')),
  source          TEXT,                        -- 'agent_outreach' | 'seller_inbound' | 'manual'
  pipeline        TEXT NOT NULL DEFAULT 'seller_inbound'
                    CHECK (pipeline IN ('agent_outreach', 'seller_inbound', 'active_deals')),
  stage_id        UUID REFERENCES pipeline_stages(id),
  is_dnc          BOOLEAN NOT NULL DEFAULT FALSE,
  dnc_reason      TEXT,
  human_takeover  BOOLEAN NOT NULL DEFAULT FALSE,
  takeover_by     TEXT,                        -- 'josh' | 'angel'
  ai_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations: one per contact (main thread)
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id      UUID NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  twilio_number   TEXT NOT NULL,               -- which AI number they're on
  last_message_at TIMESTAMPTZ,
  ai_summary      TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'closed', 'human_takeover')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Messages: all SMS messages in/out
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  twilio_sid      TEXT UNIQUE,
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body            TEXT NOT NULL,
  from_number     TEXT NOT NULL,
  to_number       TEXT NOT NULL,
  sender          TEXT NOT NULL DEFAULT 'ai'
                    CHECK (sender IN ('ai', 'human', 'contact')),
  status          TEXT DEFAULT 'sent',         -- sent | delivered | failed | received
  error_code      TEXT,
  ai_model        TEXT,
  prompt_tokens   INTEGER,
  completion_tokens INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Deals: qualified leads that become actual deals
CREATE TABLE IF NOT EXISTS deals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  stage_id        UUID REFERENCES pipeline_stages(id),
  assigned_to     TEXT CHECK (assigned_to IN ('josh', 'angel')),
  deal_type       TEXT CHECK (deal_type IN ('cash', 'creative_finance', 'wholetail', 'unknown')),
  property_address TEXT,
  asking_price    NUMERIC(12, 2),
  arv             NUMERIC(12, 2),              -- after repair value
  repair_estimate NUMERIC(12, 2),
  offer_price     NUMERIC(12, 2),
  motivation_score INTEGER CHECK (motivation_score BETWEEN 1 AND 10),
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Call logs: all Twilio voice calls
CREATE TABLE IF NOT EXISTS call_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id      UUID REFERENCES contacts(id),
  twilio_call_sid TEXT UNIQUE,
  direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number     TEXT NOT NULL,
  to_number       TEXT NOT NULL,
  forwarded_to    TEXT,                        -- josh or angel's number
  duration_seconds INTEGER,
  status          TEXT,                        -- initiated | ringing | in-progress | completed | failed
  recording_url   TEXT,
  initiated_by    TEXT,                        -- 'click_to_call' | 'inbound'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Tags
CREATE TABLE IF NOT EXISTS tags (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#6366f1',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contact tags (many-to-many)
CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

-- Contact properties: property details linked to a seller contact
CREATE TABLE IF NOT EXISTS contact_properties (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  address          TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,
  property_type    TEXT,
  beds             INTEGER,
  baths            NUMERIC(3,1),
  sqft             INTEGER,
  year_built       INTEGER,
  condition        TEXT,
  arv              NUMERIC(12,2),
  repair_estimate  NUMERIC(12,2),
  asking_price     NUMERIC(12,2),
  offer_price      NUMERIC(12,2),
  mortgage_balance NUMERIC(12,2),
  equity           NUMERIC(12,2),
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Note folders: per-contact folders for organizing notes
CREATE TABLE IF NOT EXISTS note_folders (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Contact notes: multiple stacked notes per contact, optionally filed in a folder
CREATE TABLE IF NOT EXISTS contact_notes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  folder_id   UUID REFERENCES note_folders(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Agent profiles: extra fields for contacts with contact_type = 'agent'
CREATE TABLE IF NOT EXISTS agent_profiles (
  contact_id         UUID PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  license_number     TEXT,
  brokerage          TEXT,
  specialties        TEXT[],
  market_areas       TEXT[],
  deals_submitted    INTEGER NOT NULL DEFAULT 0,
  relationship_score INTEGER NOT NULL DEFAULT 0 CHECK (relationship_score BETWEEN 0 AND 100),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Buyer profiles: extra fields for contacts with contact_type = 'buyer'
CREATE TABLE IF NOT EXISTS buyer_profiles (
  contact_id     UUID PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  buy_box_min    NUMERIC(12,2),
  buy_box_max    NUMERIC(12,2),
  preferred_areas TEXT[],
  property_types  TEXT[],
  cash_buyer     BOOLEAN NOT NULL DEFAULT FALSE,
  proof_of_funds BOOLEAN NOT NULL DEFAULT FALSE,
  deals_closed   INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage_id);
CREATE INDEX IF NOT EXISTS idx_contacts_pipeline ON contacts(pipeline);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage_id);
CREATE INDEX IF NOT EXISTS idx_contact_properties_contact ON contact_properties(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_tags_contact ON contact_tags(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_notes_folder ON contact_notes(folder_id);
CREATE INDEX IF NOT EXISTS idx_note_folders_contact ON note_folders(contact_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER deals_updated_at
  BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER contact_notes_updated_at
  BEFORE UPDATE ON contact_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- One-time migration: move each contact's legacy notes blob into a first note,
-- then clear it. Idempotent — after the first run contacts.notes is NULL so this is a no-op.
INSERT INTO contact_notes (contact_id, body, created_at, updated_at)
  SELECT id, notes, updated_at, updated_at
  FROM contacts
  WHERE notes IS NOT NULL AND btrim(notes) <> '';
UPDATE contacts SET notes = NULL WHERE notes IS NOT NULL;

-- Seed pipeline stages
INSERT INTO pipeline_stages (name, pipeline, position, color) VALUES
  -- Agent Outreach pipeline
  ('New Agent Lead',      'agent_outreach',  1, '#6366f1'),
  ('Contacted',           'agent_outreach',  2, '#8b5cf6'),
  ('Appointment Set',     'agent_outreach',  3, '#a855f7'),
  ('Deal Submitted',      'agent_outreach',  4, '#d946ef'),
  -- Seller Inbound (ISP) pipeline
  ('New Lead',            'seller_inbound',  1, '#f59e0b'),
  ('Engaged',             'seller_inbound',  2, '#f97316'),
  ('Qualified',           'seller_inbound',  3, '#ef4444'),
  ('Offer Made',          'seller_inbound',  4, '#dc2626'),
  ('Under Contract',      'seller_inbound',  5, '#b91c1c'),
  -- Active Deals pipeline
  ('Due Diligence',       'active_deals',    1, '#10b981'),
  ('Title/Escrow',        'active_deals',    2, '#059669'),
  ('Closed',              'active_deals',    3, '#047857')
ON CONFLICT (name) DO NOTHING;
