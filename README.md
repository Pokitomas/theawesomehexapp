# Saturation auto feed

A remote, scrollable session-state recommender prototype.

The deployment build materializes **1,000,000 deterministic sample posts** into chunked JSON. The browser fetches repository segments only as needed, keeps a bounded chunk cache, virtualizes the DOM, measures exposure, crosses a hysteretic phase boundary, and automatically changes the ranking mixture. There is no user-facing “healthy path / slop path” choice.

## Deployment status

The full build is verified in GitHub Actions: source extraction, generation of exactly 1,000,000 posts, and corpus-count checks all pass. The repository is currently private, and GitHub rejected automatic Pages configuration. Make the repository public or enable GitHub Pages for private repositories; the next push to `main` will deploy automatically.

Planned URL:

`https://pokitomas.github.io/theawesomehexapp/`

Diagnostics after deployment:

`https://pokitomas.github.io/theawesomehexapp/?debug=1`

## Corpus

The repository stores a compressed deterministic source package rather than committing hundreds of megabytes of generated JSON. GitHub Actions extracts it and runs:

```bash
POST_COUNT=1000000 CHUNK_SIZE=1024 node scripts/build.mjs
```

The generated site contains a manifest plus 977 remotely served data chunks. Every sample has a stable ID, headline, dek, source/ownership cluster, topic vector, stance coordinate, graphic/valence/arousal scores, duplicate family, informational-axis tags, predicted engagement, relevance, context, and mechanism scores.

## Automatic policy

The phase boundary does not expose two buttons. A continuous gate mixes ordinary exploitation with same-motive/different-axis retrieval. The gate is driven by normalized session load and Thompson-sampled posterior reward. Ordinary scrolling, opens, saves, shares, dwell, and rapid skips update that posterior.

Append `?debug=1` to expose raw measurements, decayed loads, high/low thresholds, the posterior, gate value, and ranking components.

## Capability boundary

This demonstrates remote chunk retrieval, million-item corpus mechanics, state measurement, time decay, hysteresis, and ranking-mixture adaptation. It does not read a real platform candidate pool, infer reliable ideology, detect regret, or establish causal wellbeing effects.
