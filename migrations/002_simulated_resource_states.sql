ALTER TABLE scenarios
ADD COLUMN IF NOT EXISTS simulated_resource_states jsonb NOT NULL DEFAULT '{}'::jsonb;
