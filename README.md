# Saturation auto feed

A remotely chunked session-state recommender built on one general content model: **article, forum, and social**.

Live: `https://pokitomas.github.io/theawesomehexapp/`

Debug: `https://pokitomas.github.io/theawesomehexapp/?debug=1`

## Product behavior

- One million deterministic candidate instances, distributed article 333,334 / forum 333,333 / social 333,333.
- Automatic saturation phase transition with no visible good-path/bad-path choice.
- Type filters replace topic categories: ALL, SOCIAL, FORUM, ARTICLE.
- Working deep routes for candidates, source records, saved items, content details, author profiles, the local account profile, and collections.
- Article pages render full bodies and source citations.
- Forum pages render the linked submission, discussion record, and retrieved reply excerpts.
- Social pages render original text, author identity, engagement metadata, and media.
- Images use compressed card and full-display WebP variants while preserving the original media URL and provenance.

## Profile system

The profile layer is an owned product surface rather than a decorative card.

- editable display name, handle, pronouns, biography, location, website, status, and up to three profile badges
- deterministic avatar and cover generation using monogram, grid, orbit, signal, cutout, ledger, wave, and stamp motifs
- image uploads compressed client-side to WebP and stored as blobs in IndexedDB
- themes, profile layouts, feed-density controls, and visibility controls for engagement, activity, following, and saved records
- persistent follows, saved records, pinned records, collections, and local activity history
- author profiles generated from retrieved source ownership, including record/type/source statistics, original profile links, and unique record lists
- portable JSON profile packages that include preferences, collections, follows, and uploaded visual assets
- downloadable SVG profile cards, a generated application mark, a maskable icon, and a web-app manifest

The local state schema is versioned. Default state is persisted immediately, imports are validated before replacement, and uploaded assets are separated from structured settings so larger blobs do not inflate every localStorage write.

## General content model

Every record shares the same outer schema:

- `type`: article, forum, or social
- source and canonical URL
- author identity and profile URL
- original publication time
- title, summary, text, or article body
- engagement tuple appropriate to the source type
- media records with original, card, and full-display locations
- all retrieved canonical, citation, outbound, profile, comment, and media source links
- forum replies where available

There are no topic-category fields in the corpus or interface. Organization happens through source metadata, content type, author, date, format, media geometry, and the recommender's synthetic retrieval features.

## Actual sources

The reproducible deployment retrieves:

- English Wikinews article records from 2010 through the current build date, including article bodies, canonical pages, MediaWiki page images, and up to sixty parsed citations per article;
- Hacker News submission/discussion records, outbound links, authors, archived engagement, and retrieved comment excerpts;
- public Mastodon statuses from multiple instances, including original post/profile links, linked pages, engagement, content warnings, and original media URLs.

Displayed source text, authors, links, replies, and media provenance come from those records. Original creators retain their applicable rights. Recommendation features such as viewpoint, arousal, graphic intensity, context value, and latent retrieval family remain deterministic prototype metadata.

## Media pipeline

Remote images are validated, orientation-corrected, and encoded as:

- card display: maximum 1280×900 WebP
- full display: maximum 2200×1800 WebP

Records without a mirrored image retain the original remote URL. The frontend uses stored width, height, and aspect ratio to reserve space and fit media without UI overflow.

## Diagnostics

Append `?debug=1` to expose raw session measurements, decayed loads, thresholds, posterior state, automatic gate, event-history count, and ranking components.

## Capability boundary

This is a production-shaped local-first interface, not a completed production social platform. It has no account service, server database, authentication, moderation backend, multi-device synchronization, upload CDN, or transactional guarantees. Profile ownership and customization are real within the browser: they persist locally, survive reloads, can be exported with their assets, and operate across the app's real routes and records.