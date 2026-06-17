-- =============================================================================
-- OpsFloa — full schema
-- Run with: psql $DATABASE_URL -f schema.sql
-- All statements use IF NOT EXISTS / IF EXISTS so they are safe to re-run.
-- For an existing database, use the ALTER TABLE blocks at the bottom to add
-- any columns that were introduced after the initial deploy.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 VARCHAR(255) NOT NULL,
  slug                 VARCHAR(100) UNIQUE NOT NULL,
  subscription_status  VARCHAR(20)  NOT NULL DEFAULT 'trial',  -- trial | active | past_due | canceled
  trial_ends_at        TIMESTAMP,
  plan                 VARCHAR(20),                             -- e.g. 'starter', 'pro'
  active               BOOLEAN   NOT NULL DEFAULT true,
  created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                          SERIAL PRIMARY KEY,
  company_id                  UUID REFERENCES companies(id),
  username                    VARCHAR(100) UNIQUE NOT NULL,
  password_hash               VARCHAR(255) NOT NULL,
  role                        VARCHAR(20)  NOT NULL DEFAULT 'worker',  -- worker | admin | super_admin
  full_name                   VARCHAR(100) NOT NULL,
  first_name                  VARCHAR(100),
  middle_name                 VARCHAR(100),
  last_name                   VARCHAR(100),
  email                       VARCHAR(255) UNIQUE,
  email_confirmed             BOOLEAN      NOT NULL DEFAULT false,
  email_confirm_token         VARCHAR(64),
  email_confirm_token_expires TIMESTAMP,
  reset_token                 VARCHAR(64),
  reset_token_expires         TIMESTAMP,
  invite_token                VARCHAR(64),
  invite_token_expires        TIMESTAMP,
  invite_pending              BOOLEAN      NOT NULL DEFAULT false,
  hourly_rate                 DECIMAL(10,2),
  rate_type                   VARCHAR(20)  NOT NULL DEFAULT 'hourly',
  overtime_rule               VARCHAR(10)  NOT NULL DEFAULT 'daily', -- 'daily' | 'weekly' | 'none'
  language                    VARCHAR(20)  NOT NULL DEFAULT 'English',
  active                      BOOLEAN      NOT NULL DEFAULT true,
  created_at                  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id            SERIAL PRIMARY KEY,
  company_id    UUID         REFERENCES companies(id),
  name          VARCHAR(255) NOT NULL,
  wage_type     VARCHAR(20)  NOT NULL DEFAULT 'regular' CHECK (wage_type IN ('regular', 'prevailing')),
  geo_lat       DECIMAL(10,7),
  geo_lng       DECIMAL(10,7),
  geo_radius_ft INTEGER,
  budget_hours   NUMERIC(10,2),
  budget_dollars NUMERIC(10,2),
  active        BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- settings  (key/value store per company; value is TEXT to support strings)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  company_id UUID         NOT NULL REFERENCES companies(id),
  key        VARCHAR(50)  NOT NULL,
  value      TEXT         NOT NULL,
  PRIMARY KEY (company_id, key)
);

-- ---------------------------------------------------------------------------
-- time_entries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_entries (
  id              SERIAL PRIMARY KEY,
  company_id      UUID          REFERENCES companies(id),
  user_id         INTEGER       REFERENCES users(id) ON DELETE CASCADE,
  project_id      INTEGER       REFERENCES projects(id) ON DELETE SET NULL,
  work_date       DATE          NOT NULL,
  start_time      TIME          NOT NULL,
  end_time        TIME          NOT NULL,
  wage_type       VARCHAR(20)   NOT NULL CHECK (wage_type IN ('regular', 'prevailing')),
  notes           TEXT,
  break_minutes   INTEGER       NOT NULL DEFAULT 0,
  mileage         DECIMAL(7,2),
  status          VARCHAR(20)   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approval_note   TEXT,
  approved_by     INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMP,
  worker_signed_at TIMESTAMP,
  locked          BOOLEAN       NOT NULL DEFAULT false,
  clock_in_lat    DECIMAL(10,7),
  clock_in_lng    DECIMAL(10,7),
  clock_out_lat   DECIMAL(10,7),
  clock_out_lng   DECIMAL(10,7),
  timezone        VARCHAR(50),
  client_id       VARCHAR(36),
  created_at      TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- active_clock  (one row per currently-clocked-in worker; unique on user_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS active_clock (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER       UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id     UUID          NOT NULL REFERENCES companies(id),
  project_id     INTEGER       REFERENCES projects(id) ON DELETE SET NULL,
  clock_in_time  TIMESTAMP     NOT NULL DEFAULT NOW(),
  clock_in_lat   DECIMAL(10,7),
  clock_in_lng   DECIMAL(10,7),
  work_date      DATE          NOT NULL,
  notes          TEXT,
  timezone       VARCHAR(50),
  created_at     TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- shifts  (scheduled shifts assigned to workers by admins)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  id          SERIAL PRIMARY KEY,
  company_id  UUID         NOT NULL REFERENCES companies(id),
  user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  INTEGER      REFERENCES projects(id) ON DELETE SET NULL,
  shift_date  DATE         NOT NULL,
  start_time  TIME         NOT NULL,
  end_time    TIME         NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- pay_periods  (locking ranges that prevent editing time entries)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pay_periods (
  id           SERIAL PRIMARY KEY,
  company_id   UUID         NOT NULL REFERENCES companies(id),
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,
  label        VARCHAR(100),
  locked_by    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, period_start, period_end)
);

-- ---------------------------------------------------------------------------
-- entry_messages  (threaded comments on time entries for admin/worker dialog)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entry_messages (
  id            SERIAL PRIMARY KEY,
  time_entry_id INTEGER   NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  company_id    UUID      NOT NULL REFERENCES companies(id),
  sender_id     INTEGER   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT      NOT NULL,
  read_at       TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- push_subscriptions  (Web Push API subscriptions per user device)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID         NOT NULL REFERENCES companies(id),
  endpoint   TEXT         NOT NULL,
  p256dh     TEXT         NOT NULL,
  auth       TEXT         NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, endpoint)
);

-- ---------------------------------------------------------------------------
-- audit_log  (immutable record of admin actions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  company_id  UUID         NOT NULL REFERENCES companies(id),
  actor_id    INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  actor_name  VARCHAR(100),
  action      VARCHAR(100) NOT NULL,   -- e.g. 'entry.approved', 'worker.invited'
  entity_type VARCHAR(50),             -- e.g. 'time_entry', 'user'
  entity_id   INTEGER,
  entity_name VARCHAR(255),
  details     JSONB,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- field_reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_reports (
  id          SERIAL PRIMARY KEY,
  company_id  UUID         NOT NULL REFERENCES companies(id),
  project_id  INTEGER      REFERENCES projects(id) ON DELETE SET NULL,
  user_id     INTEGER      NOT NULL REFERENCES users(id),
  title       VARCHAR(255),
  notes       TEXT,
  lat         DECIMAL(10,7),
  lng         DECIMAL(10,7),
  status      VARCHAR(20)  NOT NULL DEFAULT 'submitted',
  reported_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS field_report_photos (
  id         SERIAL PRIMARY KEY,
  report_id  INTEGER NOT NULL REFERENCES field_reports(id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  caption    VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- daily_reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_reports (
  id                SERIAL PRIMARY KEY,
  company_id        UUID         NOT NULL REFERENCES companies(id),
  project_id        INTEGER      REFERENCES projects(id) ON DELETE SET NULL,
  report_date       DATE         NOT NULL,
  superintendent    VARCHAR(255),
  weather_condition VARCHAR(50),
  weather_temp      INTEGER,
  work_performed    TEXT,
  delays_issues     TEXT,
  visitor_log       TEXT,
  status            VARCHAR(20)  NOT NULL DEFAULT 'draft',
  created_by        INTEGER      REFERENCES users(id),
  created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, project_id, report_date)
);

CREATE TABLE IF NOT EXISTS daily_report_manpower (
  id           SERIAL PRIMARY KEY,
  report_id    INTEGER      NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  trade        VARCHAR(255),
  worker_count INTEGER      NOT NULL DEFAULT 1,
  hours        DECIMAL(5,2),
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS daily_report_equipment (
  id        SERIAL PRIMARY KEY,
  report_id INTEGER      NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  name      VARCHAR(255) NOT NULL,
  quantity  INTEGER      NOT NULL DEFAULT 1,
  hours     DECIMAL(5,2)
);

CREATE TABLE IF NOT EXISTS daily_report_materials (
  id          SERIAL PRIMARY KEY,
  report_id   INTEGER      NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  description VARCHAR(500) NOT NULL,
  quantity    VARCHAR(100)
);

-- ---------------------------------------------------------------------------
-- punchlist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS punchlist_items (
  id          SERIAL PRIMARY KEY,
  company_id  UUID         NOT NULL REFERENCES companies(id),
  project_id  INTEGER      REFERENCES projects(id) ON DELETE SET NULL,
  title       VARCHAR(500) NOT NULL,
  description TEXT,
  location    VARCHAR(255),
  status      VARCHAR(20)  NOT NULL DEFAULT 'open',
  priority    VARCHAR(10)  NOT NULL DEFAULT 'normal',
  assigned_to INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_by  INTEGER      NOT NULL REFERENCES users(id),
  resolved_at TIMESTAMP,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- safety_talks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS safety_talks (
  id         SERIAL PRIMARY KEY,
  company_id UUID         NOT NULL REFERENCES companies(id),
  project_id INTEGER      REFERENCES projects(id) ON DELETE SET NULL,
  title      VARCHAR(255) NOT NULL,
  content    TEXT,
  given_by   VARCHAR(255),
  talk_date  DATE         NOT NULL,
  created_by INTEGER      NOT NULL REFERENCES users(id),
  created_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS safety_talk_signoffs (
  id          SERIAL PRIMARY KEY,
  talk_id     INTEGER      NOT NULL REFERENCES safety_talks(id) ON DELETE CASCADE,
  worker_id   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  worker_name VARCHAR(255),
  signed_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Compatibility for databases created before field reports used user_id.
ALTER TABLE field_reports ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'field_reports' AND column_name = 'worker_id'
  ) THEN
    EXECUTE 'UPDATE field_reports SET user_id = worker_id WHERE user_id IS NULL';
  END IF;
END $$;

-- =============================================================================
-- Indexes
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_users_company_id             ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_projects_company_id          ON projects(company_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_company_id      ON time_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_id         ON time_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_work_date       ON time_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_date       ON time_entries(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_status          ON time_entries(status);
-- Composite index for approval queue sort (company + status + sort columns)
CREATE INDEX IF NOT EXISTS idx_time_entries_pending_sort     ON time_entries(company_id, status, worker_signed_at DESC NULLS LAST, work_date DESC);
-- Partial index for pending entries (avoids scanning approved/rejected rows)
CREATE INDEX IF NOT EXISTS idx_time_entries_pending          ON time_entries(company_id, work_date) WHERE status = 'pending';
-- Compound index for worker metrics CTE (company + wage_type + user)
CREATE INDEX IF NOT EXISTS idx_time_entries_company_wage     ON time_entries(company_id, wage_type, user_id);
CREATE INDEX IF NOT EXISTS idx_active_clock_company_id      ON active_clock(company_id);
CREATE INDEX IF NOT EXISTS idx_shifts_company_id            ON shifts(company_id);
CREATE INDEX IF NOT EXISTS idx_shifts_user_id               ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_shift_date            ON shifts(shift_date);
CREATE INDEX IF NOT EXISTS idx_pay_periods_company_id       ON pay_periods(company_id);
CREATE INDEX IF NOT EXISTS idx_entry_messages_entry_id      ON entry_messages(time_entry_id);
-- Index for unread message count query (filters by company + sender + read_at)
CREATE INDEX IF NOT EXISTS idx_entry_messages_company_id    ON entry_messages(company_id);
CREATE INDEX IF NOT EXISTS idx_entry_messages_unread        ON entry_messages(company_id, sender_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id   ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_company_id         ON audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at         ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_field_reports_company_id     ON field_reports(company_id);
CREATE INDEX IF NOT EXISTS idx_field_reports_user_id        ON field_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_company_id     ON daily_reports(company_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_report_date    ON daily_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_daily_report_manpower_report ON daily_report_manpower(report_id);
CREATE INDEX IF NOT EXISTS idx_safety_talks_company_id      ON safety_talks(company_id);
CREATE INDEX IF NOT EXISTS idx_safety_talk_signoffs_talk_id ON safety_talk_signoffs(talk_id);
CREATE INDEX IF NOT EXISTS idx_punchlist_items_company_id   ON punchlist_items(company_id);

-- ---------------------------------------------------------------------------
-- inbox  (in-app notification bell items per user)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbox (
  id          SERIAL PRIMARY KEY,
  company_id  UUID         NOT NULL REFERENCES companies(id),
  user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(50)  NOT NULL,   -- 'approval', 'rejection', 'comment', 'announcement', etc.
  title       VARCHAR(255) NOT NULL,
  body        TEXT,
  link        VARCHAR(255),
  read_at     TIMESTAMP,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbox_user_id    ON inbox(user_id);
CREATE INDEX IF NOT EXISTS idx_inbox_company_id ON inbox(company_id);

-- =============================================================================
-- ALTER TABLE migrations (safe to re-run on existing databases)
-- =============================================================================
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id     VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pro_addon              BOOLEAN NOT NULL DEFAULT false; -- legacy, replaced by addon_qbo
ALTER TABLE companies ADD COLUMN IF NOT EXISTS addon_qbo             BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_cycle          VARCHAR(10) NOT NULL DEFAULT 'monthly';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS annual_worker_count    INTEGER;
-- QBO OAuth tokens (per company)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qbo_access_token      TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qbo_refresh_token     TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qbo_realm_id          VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qbo_token_expires_at  TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qbo_connected_at      TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qbo_oauth_nonce       VARCHAR(64);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS qbo_disconnected      BOOLEAN NOT NULL DEFAULT false;
-- QBO mappings on workers and projects
ALTER TABLE users     ADD COLUMN IF NOT EXISTS qbo_employee_id       VARCHAR(50);
ALTER TABLE projects  ADD COLUMN IF NOT EXISTS qbo_customer_id       VARCHAR(50);
-- Login lockout
ALTER TABLE users     ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS locked_until           TIMESTAMP;
-- MFA (TOTP)
ALTER TABLE users     ADD COLUMN IF NOT EXISTS mfa_enabled           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS mfa_secret            TEXT;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS mfa_secret_pending    TEXT;
-- Timezone tracking on time entries and active clock
ALTER TABLE time_entries  ADD COLUMN IF NOT EXISTS timezone VARCHAR(50);
ALTER TABLE active_clock  ADD COLUMN IF NOT EXISTS timezone VARCHAR(50);
-- Fix QBO encrypted token column sizes
ALTER TABLE companies ALTER COLUMN qbo_realm_id TYPE TEXT;
-- First-login welcome tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcomed_at TIMESTAMP;
-- Per-admin feature permissions (null = full access, JSONB object = restricted)
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_permissions JSONB;
-- Per-admin worker access restriction (null = all workers, array of IDs = restricted group)
ALTER TABLE users ADD COLUMN IF NOT EXISTS worker_access_ids INTEGER[];
-- Offline deduplication for time entries
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS client_id VARCHAR(36);
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_user_client_id ON time_entries(user_id, client_id) WHERE client_id IS NOT NULL;
-- plan values: free | starter | business  (trial companies default to full access until plan is set)
-- Per-worker overtime rule: daily | weekly | none
ALTER TABLE users ADD COLUMN IF NOT EXISTS overtime_rule VARCHAR(10) NOT NULL DEFAULT 'daily';
-- Per-project prevailing wage rate (overrides company setting when set)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS prevailing_wage_rate DECIMAL(10,2);
-- Company contact info for invoices
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_email VARCHAR(200);
-- Performance indexes (safe to add on existing databases)
CREATE INDEX IF NOT EXISTS idx_time_entries_pending_sort  ON time_entries(company_id, status, worker_signed_at DESC NULLS LAST, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_time_entries_pending       ON time_entries(company_id, work_date) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_time_entries_company_wage  ON time_entries(company_id, wage_type, user_id);
CREATE INDEX IF NOT EXISTS idx_entry_messages_company_id  ON entry_messages(company_id);
CREATE INDEX IF NOT EXISTS idx_entry_messages_unread      ON entry_messages(company_id, sender_id, read_at) WHERE read_at IS NULL;
-- QBO sync tracking on time entries (duplicate prevention)
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS qbo_activity_id VARCHAR(50);
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS qbo_synced_at   TIMESTAMP;

