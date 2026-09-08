# Mach live bus

Transport-only orphan branch. No Actions workflows live in this tree.

`inbox.json` is a monotonic command register. `outbox.json` is Mach's ack/result/heartbeat register. Writers increment `seq`; the resident q0907 watcher executes each unseen sequence once and advances `ack`.
