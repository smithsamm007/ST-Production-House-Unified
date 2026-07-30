BEGIN;

CREATE TABLE used_totp_codes (
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  totp_code text NOT NULL,
  time_step text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, totp_code, time_step)
);

-- Index to clean up old codes later if needed, though they remain permanently logged for audit
CREATE INDEX used_totp_codes_lookup_idx ON used_totp_codes (owner_id, totp_code, time_step);

COMMIT;
