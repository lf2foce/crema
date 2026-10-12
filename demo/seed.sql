-- Lumen: a realistic B2B SaaS (project management) database.
-- Deliberately contains the ambiguities real schemas have:
--   amounts in cents, tax on invoices, annual plans, trials, past-due subscriptions,
--   internal accounts, soft-deleted rows, voided invoices, refunds, plan upgrades.
-- Data is generated relative to now(), deterministic via setseed.

SET client_min_messages = warning;
SELECT setseed(0.42);

CREATE TABLE plans (
  id               serial PRIMARY KEY,
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  price_cents      integer NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  is_public        boolean NOT NULL DEFAULT true
);

CREATE TABLE accounts (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  domain      text,
  industry    text,
  country     char(2),
  is_internal boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL,
  deleted_at  timestamptz
);

CREATE TABLE users (
  id           serial PRIMARY KEY,
  account_id   integer NOT NULL REFERENCES accounts(id),
  email        text NOT NULL UNIQUE,
  full_name    text,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  deleted_at   timestamptz
);

CREATE TABLE subscriptions (
  id                 serial PRIMARY KEY,
  account_id         integer NOT NULL REFERENCES accounts(id),
  plan_id            integer NOT NULL REFERENCES plans(id),
  status             text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  seats              integer NOT NULL DEFAULT 1,
  started_at         timestamptz NOT NULL,
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  canceled_at        timestamptz,
  cancel_reason      text
);

CREATE TABLE invoices (
  id              serial PRIMARY KEY,
  account_id      integer NOT NULL REFERENCES accounts(id),
  subscription_id integer REFERENCES subscriptions(id),
  status          text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency        char(3) NOT NULL DEFAULT 'usd',
  subtotal_cents  integer NOT NULL,
  tax_cents       integer NOT NULL DEFAULT 0,
  total_cents     integer NOT NULL,
  issued_at       timestamptz,
  due_at          timestamptz,
  paid_at         timestamptz
);
COMMENT ON TABLE invoices IS 'One row per billing document sent to a customer. Amounts are in cents.';

CREATE TABLE refunds (
  id           serial PRIMARY KEY,
  invoice_id   integer NOT NULL REFERENCES invoices(id),
  amount_cents integer NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL
);

CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  account_id  integer NOT NULL REFERENCES accounts(id),
  user_id     integer NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  occurred_at timestamptz NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE support_tickets (
  id          serial PRIMARY KEY,
  account_id  integer NOT NULL REFERENCES accounts(id),
  priority    text NOT NULL,
  status      text NOT NULL,
  subject     text,
  opened_at   timestamptz NOT NULL,
  resolved_at timestamptz
);

INSERT INTO plans (code, name, price_cents, billing_interval, is_public) VALUES
  ('starter',         'Starter',            2900,    'month', true),
  ('team',            'Team',               9900,    'month', true),
  ('business',        'Business',           29900,   'month', true),
  ('team_annual',     'Team (annual)',      99000,   'year',  true),
  ('business_annual', 'Business (annual)',  299000,  'year',  true),
  ('enterprise',      'Enterprise',         1200000, 'year',  false);

DO $$
DECLARE
  horizon   timestamptz := date_trunc('hour', now());
  origin    timestamptz := date_trunc('day', now()) - interval '24 months';
  prefixes  text[] := ARRAY['Northwind','Bluebird','Atlas','Cobalt','Juniper','Harbor','Kestrel','Meridian','Orchid','Pioneer','Quartz','Redwood','Summit','Tidal','Umber','Vantage','Willow','Yonder','Zephyr','Aurora','Beacon','Cedar','Driftwood','Ember','Fjord','Granite','Helix','Iris','Lattice','Monarch'];
  suffixes  text[] := ARRAY['Labs','Studio','Group','Health','Logistics','Capital','Media','Systems','Foods','Robotics','Legal','Design','Partners','Energy','Analytics'];
  industries text[] := ARRAY['software','healthcare','logistics','finance','media','retail','manufacturing','education','legal','energy'];
  countries text[] := ARRAY['US','US','US','US','GB','DE','FR','CA','AU','NL','VN','SG'];
  firsts    text[] := ARRAY['Ava','Ben','Chloe','Dan','Elif','Farah','Gus','Hana','Ivan','Jade','Kai','Lena','Milo','Nora','Omar','Pia','Quinn','Rosa','Sam','Tara','Uma','Vik','Wes','Yara','Zoe','Minh','Linh','Anh'];
  lasts     text[] := ARRAY['Nguyen','Smith','Garcia','Müller','Rossi','Kim','Patel','Brown','Tran','Johnson','Silva','Lee','Martin','Novak','Cohen','Okafor'];
  reasons   text[] := ARRAY['too_expensive','missing_features','switched_competitor','no_longer_needed','company_closed'];

  i int; j int; acc_id int; sub_id int; inv_id int; n_users int;
  internal bool; a_created timestamptz; a_name text; a_domain text; a_country text;
  plan_id int; p record; r float8;
  trial_end timestamptz; period_start timestamptz; period_end timestamptz; step interval;
  churned bool; past_due bool; upgraded bool; sub_started timestamptz;
  subtotal int; tax int; issued timestamptz; inv_status text; paid timestamptz;
  last_cancel timestamptz;
BEGIN
  FOR i IN 1..1800 LOOP
    internal := i <= 18;
    IF internal THEN
      a_created := origin + (i * interval '3 days');
      a_name    := 'Lumen Internal ' || i;
      a_domain  := 'lumen.dev';
      a_country := 'US';
    ELSE
      -- growth curve: more recent signups than old ones
      a_created := origin + sqrt(random()) * (horizon - origin - interval '1 day');
      a_name    := prefixes[1 + floor(random() * array_length(prefixes, 1))::int] || ' ' ||
                   suffixes[1 + floor(random() * array_length(suffixes, 1))::int];
      a_domain  := lower(replace(a_name, ' ', '')) || i || '.com';
      a_country := countries[1 + floor(random() * array_length(countries, 1))::int];
    END IF;

    INSERT INTO accounts (name, domain, industry, country, is_internal, created_at)
    VALUES (a_name, a_domain, industries[1 + floor(random() * array_length(industries, 1))::int],
            a_country, internal, a_created)
    RETURNING id INTO acc_id;

    -- plan mix
    r := random();
    plan_id := CASE
      WHEN internal THEN 6
      WHEN r < 0.30 THEN 1 WHEN r < 0.60 THEN 2 WHEN r < 0.72 THEN 3
      WHEN r < 0.86 THEN 4 WHEN r < 0.96 THEN 5 ELSE 6 END;

    trial_end := a_created + interval '14 days';
    churned := false; past_due := false; upgraded := false; last_cancel := NULL;

    IF trial_end > horizon THEN
      INSERT INTO subscriptions (account_id, plan_id, status, seats, started_at, trial_ends_at, current_period_end)
      VALUES (acc_id, plan_id, 'trialing', 1 + floor(random() * 5)::int, a_created, trial_end, trial_end);
    ELSIF NOT internal AND random() > 0.68 THEN
      INSERT INTO subscriptions (account_id, plan_id, status, seats, started_at, trial_ends_at, current_period_end, canceled_at, cancel_reason)
      VALUES (acc_id, plan_id, 'canceled', 1 + floor(random() * 5)::int, a_created, trial_end, trial_end, trial_end, 'trial_expired');
      last_cancel := trial_end;
      churned := true;
    ELSE
      sub_started := a_created;
      INSERT INTO subscriptions (account_id, plan_id, status, seats, started_at, trial_ends_at)
      VALUES (acc_id, plan_id, 'active', 1 + floor(random() * 25)::int, sub_started, trial_end)
      RETURNING id INTO sub_id;

      period_start := trial_end;
      LOOP
        SELECT * INTO p FROM plans WHERE id = plan_id;
        step := CASE WHEN p.billing_interval = 'month' THEN interval '1 month' ELSE interval '1 year' END;
        period_end := period_start + step;

        subtotal := p.price_cents;
        tax := CASE WHEN a_country IN ('GB','DE','FR','NL') THEN round(subtotal * 0.20)
                    WHEN a_country = 'US' THEN round(subtotal * 0.07) ELSE 0 END;
        IF internal THEN subtotal := 0; tax := 0; END IF;   -- 100% discount for our own workspaces
        issued := period_start;
        r := random();

        IF period_end > horizon AND NOT internal AND r < 0.06 THEN
          inv_status := 'open'; paid := NULL; past_due := true;
        ELSIF NOT internal AND r < 0.015 THEN
          inv_status := 'uncollectible'; paid := NULL;
        ELSE
          IF NOT internal AND r < 0.04 THEN
            -- a voided duplicate, then the real one
            INSERT INTO invoices (account_id, subscription_id, status, subtotal_cents, tax_cents, total_cents, issued_at, due_at)
            VALUES (acc_id, sub_id, 'void', subtotal, tax, subtotal + tax, issued, issued + interval '14 days');
          END IF;
          inv_status := 'paid';
          paid := least(issued + random() * interval '6 days', horizon);
        END IF;

        INSERT INTO invoices (account_id, subscription_id, status, subtotal_cents, tax_cents, total_cents, issued_at, due_at, paid_at)
        VALUES (acc_id, sub_id, inv_status, subtotal, tax, subtotal + tax, issued, issued + interval '14 days', paid)
        RETURNING id INTO inv_id;

        IF inv_status = 'paid' AND subtotal > 0 AND random() < 0.025 THEN
          INSERT INTO refunds (invoice_id, amount_cents, reason, created_at)
          VALUES (inv_id, CASE WHEN random() < 0.6 THEN subtotal + tax ELSE (subtotal + tax) / 2 END,
                  (ARRAY['requested_by_customer','duplicate','service_issue'])[1 + floor(random() * 3)::int],
                  least(paid + random() * interval '20 days', horizon));
        END IF;

        EXIT WHEN period_end > horizon;

        IF inv_status = 'uncollectible' THEN
          UPDATE subscriptions SET status = 'canceled', canceled_at = period_end, cancel_reason = 'payment_failed',
                 current_period_end = period_end WHERE id = sub_id;
          last_cancel := period_end; churned := true; EXIT;
        END IF;

        IF NOT internal AND (
             (p.billing_interval = 'month' AND random() < 0.028) OR
             (p.billing_interval = 'year'  AND random() < 0.18)) THEN
          UPDATE subscriptions SET status = 'canceled', canceled_at = period_end, current_period_end = period_end,
                 cancel_reason = reasons[1 + floor(random() * array_length(reasons, 1))::int] WHERE id = sub_id;
          last_cancel := period_end; churned := true; EXIT;
        END IF;

        IF NOT internal AND NOT upgraded AND plan_id IN (1, 2) AND random() < 0.03 THEN
          -- upgrade: the old subscription ends, a new one starts. Same customer, two subscriptions.
          UPDATE subscriptions SET status = 'canceled', canceled_at = period_end, current_period_end = period_end,
                 cancel_reason = 'upgraded' WHERE id = sub_id;
          plan_id := plan_id + 1; upgraded := true;
          INSERT INTO subscriptions (account_id, plan_id, status, seats, started_at)
          VALUES (acc_id, plan_id, 'active', 1 + floor(random() * 25)::int, period_end)
          RETURNING id INTO sub_id;
        END IF;

        period_start := period_end;
      END LOOP;

      IF NOT churned THEN
        UPDATE subscriptions SET status = CASE WHEN past_due THEN 'past_due' ELSE 'active' END,
               current_period_end = period_end WHERE id = sub_id;
        IF NOT past_due AND random() < 0.10 THEN
          INSERT INTO invoices (account_id, subscription_id, status, subtotal_cents, tax_cents, total_cents)
          VALUES (acc_id, sub_id, 'draft', subtotal, tax, subtotal + tax);
        END IF;
      END IF;
    END IF;

    -- some churned accounts get soft-deleted a month later
    IF churned AND last_cancel + interval '30 days' < horizon AND random() < 0.25 THEN
      UPDATE accounts SET deleted_at = last_cancel + interval '30 days' WHERE id = acc_id;
    END IF;

    -- people
    n_users := CASE WHEN internal THEN 8 WHEN plan_id = 1 THEN 1 + floor(random() * 3)::int
                    ELSE 1 + floor(random() * random() * 16)::int END;
    FOR j IN 1..n_users LOOP
      INSERT INTO users (account_id, email, full_name, role, created_at)
      VALUES (acc_id, 'u' || acc_id || '_' || j || '@' || a_domain,
              firsts[1 + floor(random() * array_length(firsts, 1))::int] || ' ' || lasts[1 + floor(random() * array_length(lasts, 1))::int],
              CASE WHEN j = 1 THEN 'owner' WHEN j <= 2 THEN 'admin' ELSE 'member' END,
              least(a_created + (j - 1) * random() * interval '40 days', horizon));
    END LOOP;
  END LOOP;
END $$;

UPDATE users SET deleted_at = created_at + interval '60 days'
WHERE random() < 0.04 AND created_at + interval '60 days' < now();

-- Product usage: each user is active on some days while their account is alive.
CREATE TEMP TABLE account_life AS
SELECT a.id AS account_id,
       a.is_internal,
       CASE WHEN bool_and(s.status = 'canceled') THEN max(s.canceled_at) ELSE date_trunc('hour', now()) END AS active_until
FROM accounts a JOIN subscriptions s ON s.account_id = a.id
GROUP BY a.id, a.is_internal;

INSERT INTO events (account_id, user_id, name, occurred_at)
SELECT account_id, user_id,
       CASE WHEN x < 0.50 THEN 'login' WHEN x < 0.80 THEN 'task_completed' WHEN x < 0.88 THEN 'project_created'
            WHEN x < 0.96 THEN 'comment_added' WHEN x < 0.98 THEN 'invite_sent' ELSE 'export_csv' END,
       d + jitter * interval '20 hours'
FROM (
  -- random() in the select list is evaluated per row (an uncorrelated LATERAL would run once)
  SELECT u.account_id, u.id AS user_id, d, random() AS x, random() AS keep, random() AS jitter,
         CASE WHEN al.is_internal THEN 0.6 ELSE 0.03 + 0.22 * ((u.id * 7919) % 100) / 100.0 END AS p
  FROM users u
  JOIN account_life al ON al.account_id = u.account_id
  CROSS JOIN LATERAL generate_series(date_trunc('day', u.created_at),
                                     least(al.active_until, coalesce(u.deleted_at, al.active_until)) - interval '20 hours',
                                     interval '1 day') d
) z
WHERE keep < p;

UPDATE users u SET last_seen_at = e.last_at
FROM (SELECT user_id, max(occurred_at) AS last_at FROM events GROUP BY user_id) e
WHERE e.user_id = u.id;

INSERT INTO support_tickets (account_id, priority, status, subject, opened_at, resolved_at)
SELECT a.id,
       (ARRAY['low','normal','normal','high','urgent'])[1 + floor(random() * 5)::int],
       st,
       (ARRAY['Billing question','Bug report','Feature request','Login issue','Data export'])[1 + floor(random() * 5)::int],
       op,
       CASE WHEN st IN ('solved','closed') THEN op + random() * interval '5 days' END
FROM accounts a
CROSS JOIN LATERAL generate_series(1, 1 + floor(random() * 3)::int) g
CROSS JOIN LATERAL (SELECT a.created_at + random() * (now() - a.created_at) AS op,
                           (ARRAY['open','pending','solved','solved','closed'])[1 + floor(random() * 5)::int] AS st) t
WHERE random() < 0.55;

CREATE INDEX ON invoices (account_id);
CREATE INDEX ON invoices (paid_at);
CREATE INDEX ON subscriptions (account_id);
CREATE INDEX ON events (occurred_at);
CREATE INDEX ON events (account_id, occurred_at);
CREATE INDEX ON refunds (invoice_id);
ANALYZE;
