BEGIN;

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY,
  coaching_id INTEGER NOT NULL REFERENCES coaching_classes(id) ON DELETE CASCADE,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(180) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (coaching_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS branches_id_coaching_unique_idx
  ON branches (id, coaching_id);

INSERT INTO branches (coaching_id, code, name)
SELECT id, 'satpur', 'SCC - Satpur Branch'
FROM coaching_classes
WHERE slug = 'scc'
ON CONFLICT (coaching_id, code) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE;

INSERT INTO branches (coaching_id, code, name)
SELECT id, 'meri', 'SCC - Meri Branch'
FROM coaching_classes
WHERE slug = 'scc'
ON CONFLICT (coaching_id, code) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE;

INSERT INTO branches (coaching_id, code, name)
SELECT id, 'main', COALESCE(NULLIF(name, ''), 'Main') || ' - Main Branch'
FROM coaching_classes
WHERE slug <> 'scc'
ON CONFLICT (coaching_id, code) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE batches ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE fees ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE test_papers ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE batch_notes ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE answer_upload_requests ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE whatsapp_parent_sessions ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE student_fee_structure ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);

UPDATE users record
SET branch_id = branch.id
FROM branches branch
WHERE record.branch_id IS NULL
  AND record.coaching_id = branch.coaching_id
  AND branch.code = CASE
    WHEN EXISTS (
      SELECT 1 FROM coaching_classes coaching
      WHERE coaching.id = record.coaching_id AND coaching.slug = 'scc'
    ) THEN 'satpur'
    ELSE 'main'
  END
  AND record.is_owner = 0;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'batches',
    'attendance',
    'fees',
    'test_papers',
    'batch_notes',
    'answer_upload_requests',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_settings',
    'whatsapp_parent_sessions',
    'student_fee_structure',
    'audit_logs'
  ]
  LOOP
    EXECUTE format(
      'UPDATE %I record
       SET branch_id = branch.id
       FROM branches branch
       WHERE record.branch_id IS NULL
         AND record.coaching_id = branch.coaching_id
         AND branch.code = CASE
           WHEN EXISTS (
             SELECT 1 FROM coaching_classes coaching
             WHERE coaching.id = record.coaching_id AND coaching.slug = ''scc''
           ) THEN ''satpur''
           ELSE ''main''
         END',
      table_name
    );
  END LOOP;
END $$;

ALTER TABLE batches ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE attendance ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE fees ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE test_papers ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE batch_notes ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE answer_upload_requests ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE notification_logs ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE whatsapp_logs ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE whatsapp_settings ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE whatsapp_parent_sessions ALTER COLUMN branch_id SET NOT NULL;
ALTER TABLE student_fee_structure ALTER COLUMN branch_id SET NOT NULL;
-- Owner audit entries are platform-wide and intentionally have no branch.

CREATE OR REPLACE FUNCTION app_current_branch_id()
RETURNS INTEGER
LANGUAGE SQL
STABLE
AS $$
  SELECT NULLIF(current_setting('app.branch_id', TRUE), '')::INTEGER
$$;

CREATE OR REPLACE FUNCTION app_is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_super_admin', TRUE), '')::BOOLEAN, FALSE)
$$;

ALTER TABLE users ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE batches ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE attendance ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE fees ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE test_papers ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE batch_notes ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE answer_upload_requests ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE notification_logs ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE whatsapp_logs ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE whatsapp_settings ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE whatsapp_parent_sessions ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE student_fee_structure ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();
ALTER TABLE audit_logs ALTER COLUMN branch_id SET DEFAULT app_current_branch_id();

CREATE INDEX IF NOT EXISTS users_branch_role_idx ON users (branch_id, role);
CREATE INDEX IF NOT EXISTS batches_branch_status_idx ON batches (branch_id, status);
CREATE INDEX IF NOT EXISTS attendance_branch_date_idx ON attendance (branch_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS fees_branch_status_idx ON fees (branch_id, status, due_date);
CREATE INDEX IF NOT EXISTS test_papers_branch_upload_idx ON test_papers (branch_id, upload_date DESC);
CREATE INDEX IF NOT EXISTS batch_notes_branch_created_idx ON batch_notes (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS answer_requests_branch_created_idx ON answer_upload_requests (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_logs_branch_created_idx ON notification_logs (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_logs_branch_created_idx ON whatsapp_logs (branch_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_settings_branch_unique_idx ON whatsapp_settings (branch_id);
CREATE UNIQUE INDEX IF NOT EXISTS student_fee_structure_branch_student_unique_idx
  ON student_fee_structure (branch_id, student_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_branch_roll_unique_idx
  ON users (branch_id, roll_no) WHERE role = 'student' AND roll_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_branch_admin_username_unique_idx
  ON users (branch_id, username) WHERE role = 'admin' AND username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS batches_branch_name_unique_idx
  ON batches (branch_id, normalized_name);

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT
      namespace.nspname AS schema_name,
      relation.relname AS table_name,
      constraint_row.conname AS constraint_name,
      ARRAY_AGG(attribute.attname ORDER BY key_column.ordinality) AS columns
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON TRUE
    JOIN pg_attribute attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum = key_column.attnum
    WHERE constraint_row.contype = 'u'
      AND namespace.nspname = current_schema()
      AND relation.relname IN ('users', 'batches', 'whatsapp_settings', 'student_fee_structure', 'whatsapp_parent_sessions')
    GROUP BY namespace.nspname, relation.relname, constraint_row.conname
  LOOP
    IF (constraint_record.table_name = 'users' AND constraint_record.columns IN (
          ARRAY['coaching_id', 'roll_no']::name[],
          ARRAY['coaching_id', 'username']::name[]
        ))
       OR (constraint_record.table_name = 'batches' AND constraint_record.columns = ARRAY['coaching_id', 'normalized_name']::name[])
       OR (constraint_record.table_name = 'whatsapp_settings' AND constraint_record.columns = ARRAY['coaching_id']::name[])
       OR (constraint_record.table_name = 'student_fee_structure' AND constraint_record.columns = ARRAY['coaching_id', 'student_id']::name[])
       OR (constraint_record.table_name = 'whatsapp_parent_sessions' AND constraint_record.columns = ARRAY['coaching_id', 'phone_number']::name[])
    THEN
      EXECUTE format(
        'ALTER TABLE %I.%I DROP CONSTRAINT %I',
        constraint_record.schema_name,
        constraint_record.table_name,
        constraint_record.constraint_name
      );
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_parent_sessions_branch_phone_unique_idx
  ON whatsapp_parent_sessions (branch_id, phone_number);

DO $$
DECLARE
  table_name TEXT;
  constraint_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'batches',
    'attendance',
    'fees',
    'test_papers',
    'batch_notes',
    'answer_upload_requests',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_settings',
    'whatsapp_parent_sessions',
    'student_fee_structure',
    'audit_logs'
  ]
  LOOP
    constraint_name := table_name || '_branch_coaching_fk';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = constraint_name
        AND conrelid = table_name::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I
         ADD CONSTRAINT %I
         FOREIGN KEY (branch_id, coaching_id)
         REFERENCES branches (id, coaching_id)
         NOT VALID',
        table_name,
        constraint_name
      );
      EXECUTE format(
        'ALTER TABLE %I VALIDATE CONSTRAINT %I',
        table_name,
        constraint_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'branches',
    'users',
    'batches',
    'attendance',
    'fees',
    'test_papers',
    'batch_notes',
    'answer_upload_requests',
    'notification_logs',
    'whatsapp_logs',
    'whatsapp_settings',
    'whatsapp_parent_sessions',
    'student_fee_structure',
    'audit_logs'
  ]
  LOOP
    policy_name := table_name || '_branch_isolation';
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, table_name);

    IF table_name = 'branches' THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I
         USING (app_is_super_admin() OR id = app_current_branch_id())
         WITH CHECK (app_is_super_admin() OR id = app_current_branch_id())',
        policy_name,
        table_name
      );
    ELSIF table_name = 'users' THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I
         USING (app_is_super_admin() OR branch_id = app_current_branch_id())
         WITH CHECK (
           app_is_super_admin()
           OR (branch_id = app_current_branch_id() AND is_owner = 0)
         )',
        policy_name,
        table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON %I
         USING (app_is_super_admin() OR branch_id = app_current_branch_id())
         WITH CHECK (app_is_super_admin() OR branch_id = app_current_branch_id())',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
