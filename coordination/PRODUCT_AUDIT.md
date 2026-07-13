# Product audit — social/actions layer, against "single-user local app"

Read the actual code before writing this, not guessing from feature names.
No compliments below on purpose; things that are fine aren't mentioned.

## Kill: self-reactions (😂 🔥 REAL ???)

`react()` increments a bare counter on your own post with zero concept of
who's reacting — there is no second user, no network, no way for the number
to mean anything except "I tapped this." A rising reaction count is a
multi-user validation signal; showing one to yourself is either meaningless
theater or, worse, actively trains the exact fake-engagement-number-watching
this whole project's kernel work was built to steer people *away* from. This
is the one finding that isn't just "unnecessary," it's in tension with the
app's own stated purpose.

**Replacement, if the tap still has value:** a private, non-numeric mood
tag on your own post ("past-me felt: 🔥") with no count, or delete the
control entirely. Do not ship a number that only one person will ever move.

## Half-built: remix attribution

`remixOf` (the source post's real id) is captured and stored on every
remix, but never read again — only `remixText` (a duplicated text snippet)
gets rendered. There's no link back to the original, so on a device where
you're remixing your own year-old posts, the "chain" is a copy-paste with
no way to actually walk it. Either wire `remixOf` into a real "jump to
original" affordance in the new PLACES-based feed, or stop storing it and
be honest that this is text duplication, not remixing.

## Cosmetic-only: mood / style tags

`post.mood` and `post.style` are read in exactly one place each — CSS class
selection in `social.js` — and nowhere else in the codebase (checked: not
in the kernel, not in ranking, not in any other product file). That's a
legitimate feature (visual variety in the composer), but it's currently
presented alongside real structural fields (`text`, `author`, `createdAt`)
as if it categorizes something. It doesn't. Fine to keep, not fine to let
the new workspace/PLACES UI imply mood/style drive placement or ranking —
they don't and, on current wiring, can't.

## Naming honesty: LATER is SAVED, generalized

The new default place LATER is structurally identical to the old top-level
SAVED tab this rebuild is deleting — same one-bit-per-entity membership,
same semantics, same migration source (`post.saved`). That's not a
criticism of the design (one flexible places system beats one hardcoded
flag, and the workspace backend treats LATER as just the first custom-style
place rather than special-casing a boolean) — it's a note that "delete
SAVED as a tab" and "SAVED becomes a place" are the same sentence said two
different ways, and product copy should say that plainly rather than
implying LATER is a new concept.

## Structurally impossible for single-user, not currently pretended otherwise

Nothing else found claims a social graph, followers, or cross-device sync
that isn't real — worth stating since it means the three findings above
are the actual gap, not a symptom of a wider pattern of fake multi-user
theater. `sharePost()` correctly defers to the OS share sheet or clipboard
rather than pretending to share "to Sideways," which is the right call and
the reason it isn't listed as a problem here.
