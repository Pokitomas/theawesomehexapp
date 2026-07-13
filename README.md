# Saturation auto feed

A remotely chunked session-state recommender built on one general content model: **article, forum, and social**.

Live: `https://pokitomas.github.io/theawesomehexapp/`

Manual empty edition: `https://pokitomas.github.io/theawesomehexapp/manual/`

Root debug: `https://pokitomas.github.io/theawesomehexapp/?debug=1`

Manual debug: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1`

Phone gate proof: `https://pokitomas.github.io/theawesomehexapp/manual/?debug=1&test=1&autorun=1`

## Parallel manual corpus edition

`/manual/` is a separate empty product surface. The normal one-million-candidate feed remains intact at the root URL.

The manual edition ships with zero records, zero candidate chunks, and zero mirrored corpus media. The browser becomes the ingestion system:

- FILES accepts individual uploads
- FOLDER accepts directory trees
- PASTE creates a record from words
- LINK creates a source-linked record
- OPEN PACK restores a portable corpus package
- SAVE PACK exports records and local assets together
- drag and drop stages files before PUT IN commits them

Supported ingestion includes plain text and code, Markdown, HTML, CSS, JavaScript, TypeScript, Python, SQL, YAML, XML, JSON, JSONL, CSV, TSV, images, audio, video, PDF, ZIP, DOCX, PPTX, and XLSX. ZIP and Office documents are unpacked in the browser. Images and other binary assets are stored as blobs in IndexedDB. SHA-256 hashes prevent duplicate file ingestion.

The manual corpus, saved records, source index, author index, collections, and portable packs are all built from what the user adds. No external corpus is silently mixed in. Every primary control uses short action language such as ADD, FILES, FOLDER, PASTE, LINK, PUT IN, KEEP, BOX, SEND, FIX, DONE, and THROW OUT.

## One kernel

The manual feed does not contain a second approximation of the recommender. During every build, `manual-app/kernel.js` is generated directly from the root `src/app.js` declarations for the axes, thresholds, raw-load calculation, exponential load updates, transition state machine, Thompson gate, scoring terms, and diversified lateral ranking.

Records the user PUTS IN are converted to the root candidate shape, then ranked by that extracted kernel. Optional upload metadata may provide topic vectors or axis values; ordinary uploads receive deterministic features from their own text, source, type, and file metadata. The manual `?debug=1` panel displays the same fast/slow/raw/z axis values, phase state, gate target, Thompson samples, posteriors, and ranking components.

The build includes a twenty-record concentrated-corpus test. At a phone-sized 390×844 viewport, `?debug=1&test=1&autorun=1` must load exactly twenty records, enter saturation, fire the boundary, and visibly move the gate above zero before deployment is allowed.

## Product behavior

- One million deterministic candidate instances in the root product, distributed article 333,334 / forum 333,333 / social 333,333.
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

## Actual root sources

The reproducible root deployment retrieves:

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

Append `?debug=1` to either edition to expose raw session measurements, decayed loads, thresholds, posterior state, automatic gate, event-history count, and ranking components.

## Capability boundary

The root and manual editions are production-shaped local-first interfaces, not completed production social platforms. They have no account service, server database, authentication, moderation backend, multi-device synchronization, upload CDN, or transactional guarantees. Manual-edition files remain in that browser unless the user exports a pack. Profile ownership and customization persist locally, survive reloads, and operate across the real routes and records.
