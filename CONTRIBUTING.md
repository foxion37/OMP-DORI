# Contributing

## Build and test

You need the Rust toolchain from `rust-toolchain.toml` and [Bun](https://bun.sh) for the OMP
extension.

```sh
cargo build
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --no-fail-fast
cargo test --locked --no-fail-fast --workspace --features voice   # the voice build
cd extension && bun install --frozen-lockfile && bun run typecheck && bun test
```

`cargo deny check licenses` checks dependency licences against `deny.toml`. Every new dependency
is recorded in `docs/third-party.md` with its licence and source. Read `docs/cleanroom.md` and
`docs/principles.md` before you write code.

## Licence and CLA

Cataly is licensed under AGPL-3.0-only (see `LICENSE` and `NOTICE`); vntrevx also offers it
under commercial licences. So that this stays possible, every contribution needs the
[Contributor Licence Agreement](CLA.md). Accept it by writing in your pull request:

> I have read CLA.md and agree to its terms for this and my future contributions to Cataly.

Pull requests without it are not merged.
