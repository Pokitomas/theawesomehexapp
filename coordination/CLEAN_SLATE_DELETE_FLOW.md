# Clean-slate delete flow

The destructive phone journey now creates three authored posts across text, image, and place variants; cancels one deletion; deletes every authored post; verifies image blobs are removed; verifies the saved place reports zero items; reloads; and proves imported library material survives.

A cancelled destructive action now emits the `cancelled` lifecycle phase rather than a false `success`.
