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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage_id);
CREATE INDEX IF NOT EXISTS idx_contacts_pipeline ON contacts(pipeline);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage_id);

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
