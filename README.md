# silvercode

The open source AI coding agent.

[![Discord](https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord)](https://github.com/mdev34-lab/alphacode)
[![Build status](https://img.shields.io/github/actions/workflow/status/mdev34-lab/alphacode/publish.yml?style=flat-square&branch=dev)](https://github.com/mdev34-lab/alphacode/actions/workflows/publish.yml)

## Installation

> [!NOTE]
> **This is the SilverCode fork.** It is distributed through this repository's GitHub Releases and the install script only; it is not published to npm or other package registries.

```bash
curl -fsSL https://github.com/mdev34-lab/alphacode/releases/latest/download/install | bash
```

To build from source:

```bash
git clone https://github.com/mdev34-lab/alphacode.git silvercode
cd silvercode
bun install
./packages/opencode/script/build.ts --single
# binary: ./packages/opencode/dist/silvercode-ai-<platform>/bin/silvercode (e.g. linux-x64, darwin-arm64)
```

> **Note:** the executable is now named `silvercode`. Config and data paths (`~/.opencode`) are unchanged.

## Documentation

- [Agent effort](specs/agent-effort.md) — the fast/medium/thorough/ultra dial: configuration, review passes, validation gates, and the `task()` override.
