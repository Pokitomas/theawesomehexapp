-- Broad deterministic archive intake for CC-MAIN-2026-25.
-- This is intentionally not a training curriculum. It selects provenance-rich
-- records for later extraction, classification, rights gating, and developmental
-- scheduling. The caller must provide an explicit max-records bound.
WITH eligible AS (
  SELECT
    url,
    warc_filename,
    warc_record_offset,
    warc_record_length,
    fetch_time,
    fetch_status,
    content_digest,
    content_mime_type,
    content_mime_detected,
    content_languages
  FROM cc_url_index
  WHERE fetch_status = 200
    AND warc_record_length BETWEEN 256 AND 8388608
    AND regexp_matches(url, '^https?://')
    AND NOT regexp_matches(lower(url), '(logout|signin|login|session=|token=|password=)')
    AND coalesce(content_mime_detected, content_mime_type, '') IN (
      'text/html',
      'application/xhtml+xml',
      'text/plain',
      'application/pdf',
      'application/json',
      'application/xml',
      'text/xml',
      'text/css',
      'application/javascript',
      'text/javascript',
      'image/svg+xml'
    )
), deterministic_broad_sample AS (
  SELECT *
  FROM eligible
  WHERE
    CASE
      WHEN coalesce(content_mime_detected, content_mime_type) = 'application/pdf'
        THEN hash(url) % 100000 < 9000
      WHEN coalesce(content_mime_detected, content_mime_type) IN
        ('application/json','application/xml','text/xml','text/css',
         'application/javascript','text/javascript','image/svg+xml')
        THEN hash(url) % 100000 < 12000
      WHEN coalesce(content_languages, '') NOT LIKE 'eng%'
        THEN hash(url) % 100000 < 4500
      ELSE hash(url) % 100000 < 1800
    END
)
SELECT
  url,
  warc_filename,
  warc_record_offset,
  warc_record_length,
  fetch_time,
  fetch_status,
  content_digest,
  content_mime_type,
  content_mime_detected,
  content_languages
FROM deterministic_broad_sample
ORDER BY hash(url), url
