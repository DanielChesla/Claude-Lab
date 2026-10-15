-- Lookup audit log. The function creates this automatically on first run;
-- this file is the reference copy.
CREATE TABLE IF NOT EXISTS lookups (
  id            bigserial PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ip            text NOT NULL,
  email         text,
  query         text,
  query_type    text,                 -- 'key' | 'case' | 'invalid' | 'n/a'
  result        text NOT NULL,        -- 'found' | 'not_found' | 'rejected_domain' | 'invalid' | 'rate_limited' | 'error'
  matched_keys  text[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS lookups_ip_created_idx ON lookups (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS lookups_created_idx    ON lookups (created_at DESC);

-- One row per file sent to /api/attach. query_type 'upload' rows in lookups summarise the request;
-- this table has the per-file detail and drives the per-email hourly limit.
CREATE TABLE IF NOT EXISTS uploads (
  id             bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ip             text NOT NULL,
  email          text NOT NULL,
  issue_key      text NOT NULL,
  filename       text NOT NULL,
  size_bytes     bigint NOT NULL,
  attachment_id  text,                 -- Jira attachment id when result = 'uploaded'
  result         text NOT NULL         -- 'uploaded' | 'error'
);

CREATE INDEX IF NOT EXISTS uploads_email_created_idx ON uploads (email, created_at DESC);

-- One row per comment attempt via /api/comment; drives the per-email hourly comment limit.
CREATE TABLE IF NOT EXISTS comments (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip          text NOT NULL,
  email       text NOT NULL,
  issue_key   text NOT NULL,
  chars       int NOT NULL,
  comment_id  text,                  -- Jira comment id when result = 'posted'
  result      text NOT NULL          -- 'posted' | 'error'
);

CREATE INDEX IF NOT EXISTS comments_email_created_idx ON comments (email, created_at DESC);

-- One row per reopen request via /api/reopen; drives the per-email hourly reopen limit.
CREATE TABLE IF NOT EXISTS reopen_requests (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ip           text NOT NULL,
  email        text NOT NULL,
  issue_key    text NOT NULL,
  status       text,                 -- ticket status at the time of the request
  chars        int NOT NULL,
  comment_id   text,                 -- Jira comment id when result = 'requested'
  label_added  boolean NOT NULL DEFAULT false,
  result       text NOT NULL         -- 'requested' | 'error'
);

CREATE INDEX IF NOT EXISTS reopen_email_created_idx ON reopen_requests (email, created_at DESC);

-- Handy queries
-- Lookups per day:        SELECT date_trunc('day', created_at) d, count(*) FROM lookups GROUP BY d ORDER BY d DESC;
-- Top users this month:   SELECT email, count(*) FROM lookups WHERE created_at > date_trunc('month', now()) GROUP BY email ORDER BY 2 DESC;
-- Not-found queries:      SELECT query, count(*) FROM lookups WHERE result = 'not_found' GROUP BY query ORDER BY 2 DESC;
