-- Booking module — appointment scheduling that knows the company's
-- roster, shifts, and time-off. Uses the existing shifts table (gets
-- a shift_type_id column added here) so a "Phone Consult" can be
-- booked during "Office hours" shifts but not during "Field work"
-- shifts via the appointment_type_shift_types many-to-many.
--
-- See `c:/Users/v-normand/.claude/plans/company-calendar-booking.md`
-- for the full design.

-- users.bookable: opt-in flag. Foremen swinging hammers don't get
-- booked; PMs and estimators opt in. Default false keeps existing
-- users out of the bookable pool unless explicitly added.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS bookable             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bookable_role_label  VARCHAR(60),
  ADD COLUMN IF NOT EXISTS timezone             VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_users_bookable ON users (company_id) WHERE bookable;

-- Per-user weekly availability windows (the "I can be booked Mon-Fri
-- 9-5" config). Times stored as plain TIME, weekday 0=Sun..6=Sat.
CREATE TABLE IF NOT EXISTS bookable_windows (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TIME     NOT NULL,
  end_time    TIME     NOT NULL CHECK (end_time > start_time),
  active      BOOLEAN  NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_bw_user ON bookable_windows (user_id) WHERE active;

-- Shift typing. Existing shifts stay typed NULL ("untyped legacy")
-- and the booking_untyped_shifts_block setting governs them
-- conservatively (default: block).
CREATE TABLE IF NOT EXISTS shift_types (
  id          SERIAL PRIMARY KEY,
  company_id  UUID         NOT NULL,
  name        VARCHAR(120) NOT NULL,
  color       VARCHAR(7),
  description TEXT,
  active      BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_shift_types_name UNIQUE (company_id, name)
);
CREATE INDEX IF NOT EXISTS idx_st_company ON shift_types (company_id) WHERE active;

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS shift_type_id INTEGER REFERENCES shift_types(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_shifts_type ON shifts (shift_type_id);

-- Appointment types (company-level config: "Site Visit 1hr",
-- "Phone Consult 30min").
CREATE TABLE IF NOT EXISTS appointment_types (
  id                  SERIAL PRIMARY KEY,
  company_id          UUID         NOT NULL,
  slug                VARCHAR(60)  NOT NULL,
  name                VARCHAR(120) NOT NULL,
  description         TEXT,
  duration_minutes    INTEGER      NOT NULL CHECK (duration_minutes >= 15),
  buffer_before_min   INTEGER      NOT NULL DEFAULT 0 CHECK (buffer_before_min >= 0),
  buffer_after_min    INTEGER      NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),
  advance_notice_hrs  INTEGER      NOT NULL DEFAULT 24 CHECK (advance_notice_hrs >= 0),
  max_advance_days    INTEGER      NOT NULL DEFAULT 60 CHECK (max_advance_days >= 1),
  slot_interval_min   INTEGER      NOT NULL DEFAULT 30 CHECK (slot_interval_min >= 15),
  active              BOOLEAN      NOT NULL DEFAULT true,
  is_public           BOOLEAN      NOT NULL DEFAULT true,
  location_kind       VARCHAR(20)  NOT NULL DEFAULT 'phone'
    CONSTRAINT chk_appt_type_location_kind CHECK (location_kind IN
      ('phone', 'video', 'onsite', 'office', 'other')),
  location_detail     TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_appt_types_slug UNIQUE (company_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_at_company ON appointment_types (company_id) WHERE active;

-- M2M: which users are eligible for this appointment type. Empty list
-- = all bookable users on the company eligible.
CREATE TABLE IF NOT EXISTS appointment_type_users (
  appointment_type_id INTEGER NOT NULL REFERENCES appointment_types(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (appointment_type_id, user_id)
);

-- M2M: this appointment_type can be booked during shifts of these
-- types. Empty list = no shift-type compatibility configured, every
-- typed shift blocks; only un-shift'd time is bookable. Combined with
-- the booking_untyped_shifts_block setting that governs NULL-typed
-- legacy shifts.
CREATE TABLE IF NOT EXISTS appointment_type_shift_types (
  appointment_type_id INTEGER NOT NULL REFERENCES appointment_types(id) ON DELETE CASCADE,
  shift_type_id       INTEGER NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  PRIMARY KEY (appointment_type_id, shift_type_id)
);
CREATE INDEX IF NOT EXISTS idx_atst_st ON appointment_type_shift_types (shift_type_id);

CREATE TABLE IF NOT EXISTS appointments (
  id                  SERIAL PRIMARY KEY,
  company_id          UUID NOT NULL,
  appointment_type_id INTEGER NOT NULL REFERENCES appointment_types(id) ON DELETE RESTRICT,
  assigned_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_name         VARCHAR(255) NOT NULL,
  client_email        VARCHAR(255) NOT NULL,
  client_phone        VARCHAR(50),
  client_notes        TEXT,
  project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  scheduled_at        TIMESTAMPTZ NOT NULL,
  duration_minutes    INTEGER NOT NULL CHECK (duration_minutes >= 15),
  status              VARCHAR(20) NOT NULL DEFAULT 'booked'
    CONSTRAINT chk_appointments_status CHECK (status IN
      ('booked','confirmed','completed','cancelled','no_show','rescheduled')),
  manage_token_hash   VARCHAR(64) NOT NULL,
  cancelled_at        TIMESTAMPTZ,
  cancelled_by        VARCHAR(10)
    CONSTRAINT chk_appointments_cancelled_by CHECK (cancelled_by IS NULL OR cancelled_by IN
      ('client','admin','assignee')),
  cancel_reason       TEXT,
  completed_at        TIMESTAMPTZ,
  rescheduled_from_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_company_when
  ON appointments (company_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_user_when
  ON appointments (assigned_user_id, scheduled_at)
  WHERE status IN ('booked', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_appointments_manage_token
  ON appointments (manage_token_hash);

CREATE TABLE IF NOT EXISTS appointment_audit (
  id              SERIAL PRIMARY KEY,
  appointment_id  INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  action          VARCHAR(20) NOT NULL
    CONSTRAINT chk_appointment_audit_action CHECK (action IN
      ('booked','confirmed','cancelled','rescheduled','completed','no_show')),
  actor_kind      VARCHAR(10) NOT NULL
    CONSTRAINT chk_appointment_audit_actor_kind CHECK (actor_kind IN
      ('client','admin','assignee','system')),
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_ip        INET,
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appt_audit_appt
  ON appointment_audit (appointment_id, created_at);
