# ArchiePhone native runtime

This is the first native iOS application target for Archie. It is deliberately fail-closed:

- no model is bundled or represented as admitted;
- activation verifies exact artifact size and SHA-256, stages a versioned model, and atomically changes the active revision pointer;
- local model files use iOS data protection;
- Core ML generation works only for an explicitly compatible byte-token autoregressive model and manifest;
- MLX and GGUF remain unavailable until their exact Xcode-built runtimes and physical-device evidence are admitted;
- memory warnings, critical thermal state, cancellation, and Low Power Mode change runtime behavior;
- the UI does not open GitHub or rewrite Maker tasks.

`project.yml` is the source-controlled XcodeGen specification. CI generates `ArchiePhone.xcodeproj` and compiles/tests it with Xcode. A physical A15/4 GB campaign, an enrolled independent measurement authority, and intelligence-quality admission are still required before any model can be selected or promoted.
