# Saturation auto feed

A remote, traversable session-state recommender prototype with a 2010s archive/social corpus.

## Live product behavior

- Infinite remote feed backed by one million candidate instances.
- Exact base-corpus split: 500,000 archive-journalism candidates and 500,000 social-native candidates.
- Automatic saturation phase transition; no visible good-path/bad-path choice.
- Real hash routes for feed, article, archive article, source, and saved views.
- Deep links survive refresh; saved state persists locally; share uses the native share sheet or copies a direct URL.

Live: `https://pokitomas.github.io/theawesomehexapp/`

Debug: `https://pokitomas.github.io/theawesomehexapp/?debug=1`

## Corpus

The build combines:

- English Wikinews articles published from 2010 through 2019, weighted toward technology, music, film, games, fashion, youth economics, labor, internet culture, urban life, and consumer systems;
- public Hacker News story-level records from 2010 through 2019, including original-poster labels, archived points/comments, dates, and outbound links where available;
- a small explicitly labeled prototype bridge layer connecting archived 2010s artifacts to present-day revival motives. Generated bridge records are never attributed to real users.

Every resurfaced record keeps its original publication date and a separate resurfacing date. The candidate count is not presented as one million unique records. Wikinews text remains CC BY 2.5; Hacker News metadata is public, while linked content retains its original rights.

```bash
python scripts/fetch_wikinews.py --min-date 2010-01-01 --cutoff 2019-12-31 --output corpus/wikinews-2019.jsonl.gz
python social/fetch_social.py --output corpus/hn-2010s.jsonl.gz
python social/merge.py --articles corpus/wikinews-2019.jsonl.gz --social corpus/hn-2010s.jsonl.gz --output corpus/mixed-2010s.jsonl.gz
POST_COUNT=1000000 CHUNK_SIZE=1024 CORPUS_FILE=corpus/mixed-2010s.jsonl.gz node scripts/build.mjs
```

The 50/50 split describes the generated candidate repository. Served slates may depart from it as the automatic saturation policy changes retrieval geometry.

## Diagnostics

Append `?debug=1` to expose raw session measurements, decayed loads, thresholds, posterior state, automatic gate, event history count, and ranking components.

## Capability boundary

The archive text and source attribution are real. Viewpoint, graphic intensity, valence, arousal, predicted engagement, context, mechanism, and latent retrieval-family fields are deterministic prototype metadata. The site does not claim to infer psychological state, read a production platform candidate pool, or prove wellbeing outcomes.
