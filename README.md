# Saturation auto feed

A fully traversable synthetic product built around a session-state recommender.

## Live product behavior

- Infinite remote feed backed by one million candidate instances.
- Automatic saturation phase transition; no visible good-path/bad-path choice.
- Real hash routes for feed, article, archive article, source, and saved views.
- Deep links survive refresh.
- Save state persists locally.
- Share uses the native share sheet or copies a direct candidate URL.
- Article pages contain archived text, attribution, cited-source records, categories, related archive stories, and the prototype ranking metadata attached to the candidate.

## Corpus

The build mirrors the official English Wikinews XML dump and extracts articles published from September 25, 2005 through December 31, 2017. That range is licensed CC BY 2.5 and attributed to Wikinews.

The build deliberately distinguishes:

- **archive articles** — unique historical Wikinews records with body text and metadata;
- **candidate instances** — one million deterministic recommender candidates derived from those records with simulated ranking/classifier features.

The candidate count is not presented as one million unique articles.

```bash
python scripts/fetch_wikinews.py
POST_COUNT=1000000 CHUNK_SIZE=1024 CORPUS_FILE=corpus/wikinews-2017.jsonl.gz node scripts/build.mjs
```

The site fetches only the post and article chunks needed for the current route.

## Diagnostics

Append `?debug=1` to expose raw session measurements, decayed loads, thresholds, posterior state, automatic gate, event history count, and ranking components.

## Capability boundary

The article corpus and attribution are real. Viewpoint, graphic intensity, valence, arousal, predicted engagement, context, mechanism, and latent retrieval-family fields are deterministic prototype metadata. The site does not claim to infer psychological state, read a production platform candidate pool, or prove wellbeing outcomes.
