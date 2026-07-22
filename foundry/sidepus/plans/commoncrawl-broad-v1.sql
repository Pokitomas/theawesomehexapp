-- Broad deterministic archive intake for CC-MAIN-2026-25.
-- Collection diversity is not a training ratio. Selected records remain subject to
-- exact ranged-WARC retrieval, extraction, rights gating, deduplication, and the
-- separate developmental scheduler. The caller supplies the hard record ceiling.
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
    content_languages,
    coalesce(content_mime_detected, content_mime_type, '') AS effective_mime
  FROM cc_url_index
  WHERE fetch_status = 200
    AND warc_record_length BETWEEN 256 AND 67108864
    AND regexp_matches(url, '^https?://')
    AND NOT regexp_matches(
      lower(url),
      '(logout|signin|login|session=|token=|password=|access[_-]?key=|auth=)'
    )
    AND coalesce(content_mime_detected, content_mime_type, '') IN (
      'text/html',
      'application/xhtml+xml',
      'text/plain',
      'application/pdf',
      'application/json',
      'application/ld+json',
      'application/xml',
      'text/xml',
      'text/css',
      'application/javascript',
      'text/javascript',
      'image/svg+xml',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'audio/mpeg',
      'audio/ogg',
      'audio/wav',
      'audio/x-wav',
      'video/mp4',
      'video/webm',
      'video/ogg'
    )
), deterministic_broad_sample AS (
  SELECT *
  FROM eligible
  WHERE
    CASE
      WHEN effective_mime IN ('video/mp4','video/webm','video/ogg')
        THEN hash(url) % 100000 < 350
      WHEN effective_mime IN ('audio/mpeg','audio/ogg','audio/wav','audio/x-wav')
        THEN hash(url) % 100000 < 650
      WHEN effective_mime IN ('image/jpeg','image/png','image/webp','image/gif')
        THEN hash(url) % 100000 < 900
      WHEN effective_mime = 'application/pdf'
        THEN hash(url) % 100000 < 9000
      WHEN effective_mime IN
        ('application/json','application/ld+json','application/xml','text/xml',
         'text/css','application/javascript','text/javascript','image/svg+xml')
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
