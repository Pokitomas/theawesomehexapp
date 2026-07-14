BEGIN;

UPDATE social_mutation_receipts
SET operation = 'legacy-unbound:' || operation
WHERE request_digest = repeat('0', 64)
  AND operation NOT LIKE 'legacy-unbound:%';

COMMIT;
