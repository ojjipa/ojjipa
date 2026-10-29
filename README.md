# OJJIPA

> The infrastructure around your agents.

OJJIPA is a local-first control layer for coordinating autonomous AI agents around human attention.

## Structure

- `apps/` — applications
- `core/` — OJJIPA core components
- `engine/` — runtime/backend
- `docs/` — documentation
- `tests/` — tests

## Core

- **Grandpa** — judgment/control layer
- **MiniPa** — agent
- **Hermes** — execution/tooling
- **Protocol** — shared contracts

> Grandpa decides. MiniPa acts.

## Status

🚧 Early development

## macOS installer

On an Apple Silicon Mac, install Xcode Command Line Tools and Homebrew, then
run `./setup-mac.sh` from the repository root. The script prepares the Python
engine and builds an OJJIPA DMG in `outputs/`. Open the DMG and drag OJJIPA to
Applications.

The generated DMG is not signed or notarized. Public distribution requires an
Apple Developer ID certificate and notarization.

## License

Apache 2.0
