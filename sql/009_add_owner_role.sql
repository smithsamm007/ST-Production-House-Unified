BEGIN;

-- Add role column to owners if it doesn't already exist
ALTER TABLE owners ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner';

COMMIT;
