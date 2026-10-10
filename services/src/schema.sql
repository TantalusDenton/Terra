CREATE TABLE IF NOT EXISTS community_state (
  community_key text PRIMARY KEY,
  community_id text NOT NULL,
  source_block numeric(78,0), source_hash text, source_timestamp numeric(78,0),
  finality text, head_block numeric(78,0), members numeric(78,0) NOT NULL DEFAULT 0,
  proposal_count numeric(78,0) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(), last_error text
);
CREATE TABLE IF NOT EXISTS checkpoints (
  community_key text NOT NULL, block_number numeric(78,0) NOT NULL,
  block_hash text NOT NULL, block_timestamp numeric(78,0) NOT NULL,
  archive_hash text NOT NULL, members numeric(78,0) NOT NULL, proposal_count numeric(78,0) NOT NULL,
  PRIMARY KEY (community_key, block_number)
);
CREATE TABLE IF NOT EXISTS proposals (
  community_key text NOT NULL, proposal_id numeric(78,0) NOT NULL,
  title text NOT NULL, summary text NOT NULL, proposer text NOT NULL,
  starts_at numeric(78,0) NOT NULL, ends_at numeric(78,0) NOT NULL,
  electorate numeric(78,0) NOT NULL, yes numeric(78,0) NOT NULL DEFAULT 0,
  no numeric(78,0) NOT NULL DEFAULT 0, abstain numeric(78,0) NOT NULL DEFAULT 0,
  executed boolean NOT NULL DEFAULT false, policy_hash text NOT NULL, actions_hash text NOT NULL,
  action_count integer NOT NULL, content_hash text NOT NULL,
  creation_tx text NOT NULL, creation_block numeric(78,0) NOT NULL,
  PRIMARY KEY (community_key, proposal_id)
) PARTITION BY HASH (community_key);
CREATE INDEX IF NOT EXISTS proposals_page ON proposals (community_key, proposal_id DESC);
CREATE INDEX IF NOT EXISTS proposals_deadline ON proposals (community_key, ends_at, proposal_id DESC);
CREATE TABLE IF NOT EXISTS canonical_events (
  community_key text NOT NULL, block_number numeric(78,0) NOT NULL, block_hash text NOT NULL,
  transaction_hash text NOT NULL, log_index integer NOT NULL, event_type text NOT NULL,
  proposal_id numeric(78,0) NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (community_key, transaction_hash, log_index)
) PARTITION BY HASH (community_key);
CREATE INDEX IF NOT EXISTS events_rewind ON canonical_events (community_key, block_number);
CREATE INDEX IF NOT EXISTS events_tallies ON canonical_events (community_key, proposal_id, event_type);
DO $$ BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS proposals_%s PARTITION OF proposals FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
    EXECUTE format('CREATE TABLE IF NOT EXISTS canonical_events_%s PARTITION OF canonical_events FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i);
  END LOOP;
END $$;
