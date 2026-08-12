-- Backend V1 PostgreSQL target schema.
-- The running V1 API still uses seeded memory until the PostgreSQL adapter is enabled.

CREATE TABLE users (
  id text PRIMARY KEY,
  auth_provider_id text UNIQUE,
  name varchar(80) NOT NULL,
  email varchar(320) NOT NULL UNIQUE,
  role varchar(120) NOT NULL,
  plan varchar(20) NOT NULL CHECK (plan IN ('Free', 'Premium')),
  level integer NOT NULL DEFAULT 1 CHECK (level >= 1),
  timezone varchar(80) NOT NULL DEFAULT 'UTC',
  streak_days integer NOT NULL DEFAULT 0 CHECK (streak_days >= 0),
  skills_mastered integer NOT NULL DEFAULT 0 CHECK (skills_mastered >= 0),
  tasks_completed integer NOT NULL DEFAULT 0 CHECK (tasks_completed >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courses (
  id text PRIMARY KEY,
  title varchar(160) NOT NULL,
  category varchar(80) NOT NULL,
  description text NOT NULL,
  level varchar(20) NOT NULL CHECK (level IN ('Beginner', 'Intermediate', 'Advanced')),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  lesson_count integer NOT NULL CHECK (lesson_count > 0),
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE enrollments (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT false,
  progress_percent integer NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  current_module varchar(200) NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);

CREATE UNIQUE INDEX one_active_enrollment_per_user
  ON enrollments (user_id)
  WHERE active = true;

CREATE TABLE practice_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text REFERENCES courses(id) ON DELETE SET NULL,
  minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 480),
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX practice_sessions_user_started_idx
  ON practice_sessions (user_id, started_at DESC);

CREATE TABLE notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX notifications_user_created_idx
  ON notifications (user_id, created_at DESC);

CREATE TABLE activities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title varchar(160) NOT NULL,
  detail text NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('lesson', 'practice', 'achievement')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activities_user_occurred_idx
  ON activities (user_id, occurred_at DESC);

CREATE TABLE chat_threads (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text REFERENCES courses(id) ON DELETE SET NULL,
  title varchar(160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL CHECK (role IN ('student', 'tutor')),
  text text NOT NULL,
  provider varchar(40),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_thread_created_idx
  ON chat_messages (thread_id, created_at);
