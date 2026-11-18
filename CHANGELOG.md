# Changelog

Each release is a git tag `v<version>` matching `release` in `data/game-system.json`, with an entry here. See [docs/data-format.md](docs/data-format.md#releases).

## Unreleased (2.0.0)

* The data moves from BattleScribe catalogues to the JSON format in [docs/data-format.md](docs/data-format.md).
* CI validates the data against the schema and the integrity rules, with the Go validator in `validator/`.

## 1.10.0

The last BattleScribe release, kept as the rollback point.
