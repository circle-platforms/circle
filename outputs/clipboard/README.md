# Actual macOS system clipboard verification

`apps/desktop/test/system-clipboard.mjs` is an independent local fixture harness. It uses only synthetic 16×16 PNGs, temporary Circle homes/workspaces, a loopback model gateway and ScriptedModel. It never prints or saves the original clipboard content.

A separate Swift/AppKit helper snapshots every original pasteboard item and every available type's Data in its own memory before changing anything. An incomplete snapshot is refused. The helper owns the synthetic pasteboard changes and restores and compares the original items, type sets and Data in `finally`/EOF cleanup. A newer external clipboard change is preserved and causes the test to fail rather than be overwritten.

The desktop check uses actual `Meta+v`: paste red, paste green, remove the first image through the native renderer's attachment control, then send. The TUI check uses the unmodified macOS `osascript` clipboard reader through `SessionApp`'s `ctrl+v` handler twice, then the actual composer `home`/`delete` keys to remove the first token and send. Terminal drawing is stubbed; this is not a claim of an interactive terminal emulator run.

Both resulting model requests must contain exactly one image with the green fixture's decoded pixels. After the original clipboard is restored, the harness reopens each application's `CheckpointStore` and requires the persisted attachment's encoded bytes to equal the actual model request bytes. Receipts contain synthetic PNG byte lengths, encoded and decoded hashes, fixture dimensions/color and restoration flags only.

Actual development verification: **6 checks passed**, `packaged:false`, original clipboard restored. The desktop and TUI each sent a 106-byte PNG, all 256 decoded pixels matched RGBA `[20,210,60,255]`, and both reopened checkpoints matched the encoded bytes exactly. See `development/receipt.json` for the independent execution receipt.

The final macOS `Circle.app` also passed **6 checks**, `packaged:true`, with the same encoded-byte and decoded-pixel assertions and verified original clipboard restoration. See `packaged/receipt.json`; the development receipt remains intact. Windows and Linux system clipboard behavior is not verified by this macOS harness.
