# Thanos-snap corpus mix

Target served corpus:

- 50% archive journalism
- 50% social-native records

The split applies to candidate generation, not unique-source count. The ranker may depart from 50/50 per slate after saturation-state adaptation.

## Temporal fit

Archive journalism is filtered toward 2009–2019 and weighted toward technology, music, film, games, fashion, youth economics, labor, internet culture, urban life, and consumer systems. Hard-news records outside that window remain available only when they are strongly connected to a current 2010s-revival motive.

Every resurfaced record carries both `publishedAt` and `resurfacedAt`. The UI must never imply an archival story is newly reported.

## Social records

Social records have post text, community, pseudonymous author label, score/comment metadata, created date, reply depth, outbound link where available, and prototype embeddings/classifier fields. Any synthetic bridge post is labeled as generated prototype content and never attributed to a real user.
