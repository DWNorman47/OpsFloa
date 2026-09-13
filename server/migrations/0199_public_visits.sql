-- Anonymous, tab-scoped welcome-page visits. No IP, raw URL, or user agent.
CREATE TABLE IF NOT EXISTS public_visits (
  session_id UUID PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  landing_path VARCHAR(12) NOT NULL,
  referrer_host VARCHAR(120),
  utm_source VARCHAR(80),
  utm_medium VARCHAR(80),
  utm_campaign VARCHAR(80),
  device VARCHAR(10),
  viewed_pricing BOOLEAN NOT NULL DEFAULT false,
  clicked_register BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_public_visits_first_seen ON public_visits(first_seen DESC);
