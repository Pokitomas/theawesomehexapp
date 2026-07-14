BEGIN;

ALTER TABLE social_mutation_receipts
  ADD COLUMN IF NOT EXISTS request_digest text;

ALTER TABLE social_mutation_receipts
  DROP CONSTRAINT IF EXISTS social_mutation_receipts_request_digest_shape;
ALTER TABLE social_mutation_receipts
  ADD CONSTRAINT social_mutation_receipts_request_digest_shape
  CHECK (request_digest IS NULL OR request_digest ~ '^[a-f0-9]{64}$');

COMMIT;
