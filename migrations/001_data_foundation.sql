CREATE TABLE IF NOT EXISTS app_users (
  firebase_uid text PRIMARY KEY,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  owner_uid text NOT NULL REFERENCES app_users(firebase_uid),
  name text NOT NULL DEFAULT 'Personal workspace',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_uid)
);

CREATE TABLE IF NOT EXISTS user_entitlements (
  firebase_uid text NOT NULL REFERENCES app_users(firebase_uid),
  feature_key text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (firebase_uid, feature_key)
);

CREATE TABLE IF NOT EXISTS module_versions (
  module_id text NOT NULL,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  content_hash text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (module_id, version)
);

CREATE TABLE IF NOT EXISTS scenarios (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('guided', 'freeform')),
  region text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('created-in-sandbox', 'imported')),
  origin_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  workload_assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenarios_workspace_updated_idx ON scenarios(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS scenario_resources (
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  id text NOT NULL,
  service text NOT NULL,
  resource_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  name text NOT NULL,
  region text NOT NULL,
  config jsonb NOT NULL,
  PRIMARY KEY (scenario_id, id)
);
CREATE INDEX IF NOT EXISTS scenario_resources_type_idx ON scenario_resources(resource_type);
CREATE INDEX IF NOT EXISTS scenario_resources_config_idx ON scenario_resources USING gin(config);

CREATE TABLE IF NOT EXISTS scenario_relationships (
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  target_id text NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (scenario_id, source_id, target_id, kind),
  FOREIGN KEY (scenario_id, source_id) REFERENCES scenario_resources(scenario_id, id) ON DELETE CASCADE,
  FOREIGN KEY (scenario_id, target_id) REFERENCES scenario_resources(scenario_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scenario_revisions (
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, revision)
);

CREATE TABLE IF NOT EXISTS module_attempts (
  id uuid PRIMARY KEY,
  scenario_id uuid NOT NULL UNIQUE REFERENCES scenarios(id) ON DELETE CASCADE,
  module_id text NOT NULL,
  module_version integer NOT NULL,
  current_step integer NOT NULL DEFAULT 0,
  unlocked_through_step integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (module_id, module_version) REFERENCES module_versions(module_id, version)
);
CREATE INDEX IF NOT EXISTS module_attempts_module_idx ON module_attempts(module_id, module_version);

CREATE TABLE IF NOT EXISTS legacy_imports (
  source_path text PRIMARY KEY,
  scenario_id uuid NOT NULL UNIQUE REFERENCES scenarios(id) ON DELETE CASCADE,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_catalog_versions (
  id uuid PRIMARY KEY,
  source_kind text NOT NULL,
  source_url text NOT NULL,
  object_key text,
  region text,
  effective_at timestamptz,
  fetched_at timestamptz NOT NULL,
  coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id uuid PRIMARY KEY,
  scenario_id uuid NOT NULL,
  revision integer NOT NULL,
  evaluator_version text NOT NULL,
  source_catalog_ids uuid[] NOT NULL DEFAULT '{}',
  assumptions jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (scenario_id, revision) REFERENCES scenario_revisions(scenario_id, revision)
);
