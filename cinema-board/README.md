# Cinematography Wall — runtime contract

This board is deliberately built as a fail-visible document first and an interactive canvas second.

## Non-negotiable invariants

1. **First paint contains the collage.** Cards and notes are static HTML. They are never created by JavaScript.
2. **No runtime library can erase the board.** Pan / pinch / drag use local vanilla JS. A dead CDN must not matter.
3. **Remote image failure is local, never global.** Every image card has a visible semantic fallback underneath the image.
4. **The camera has a CSS fallback.** Before JS runs, the 2100×3200 board is already translated and scaled into a phone-sized viewport.
5. **JS is progressive enhancement.** Its jobs are only home/zoom/pan/pinch/card-drag/status.
6. **Home is derived from viewport width.** It cannot inherit a stale transform from a previous screen size.
7. **A boot watchdog verifies intersection.** Two animation frames after boot, if the board does not intersect the viewport, `home()` is applied again.
8. **Touch owns the surface.** The viewport uses `touch-action:none`; cards share the same pointer system rather than fighting a second gesture library.
9. **No persistence until interaction is trustworthy.** The v1 rebuild intentionally removed saved layouts/re-scatter complexity.
10. **A broken image host may make one card ugly; no failure mode may produce an empty black page.**

## Self-test target

Minimum mobile acceptance surface: 390×844 CSS px.

The interaction core was headlessly exercised at 390×844 and 844×390 for:
- script boot without page errors;
- board visibly intersecting viewport;
- visible first card;
- zoom + home round-trip;
- blank-canvas pan;
- card drag;
- two-finger pinch zoom via synthetic touch input.

The visual source hosts remain external by design for this first board, but their availability is not required for the board UI to render because every card fails visibly to its labeled fallback.