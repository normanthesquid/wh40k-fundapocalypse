# Repo rules

- This repo's plans and tickets live in **fundamalleus's Pragmatik project `FUN`**, not here and not in GitHub issues; the data-format work is Initiative `006 - Fundapocalypse rules data format`. Cite tickets as links, e.g. [FUN-71](https://pragmatik.withaplan.com/projects/FUN/issues/71).
- House style comes from `cephalotech-ab/shared-infra`, as in fundamalleus's CLAUDE.md, with recorded exceptions: this repo stays on the personal `normanthesquid` account and its CI runs on GitHub-hosted `ubuntu-latest` (FUN-71).
- The format is defined by `schema/` and [docs/data-format.md](docs/data-format.md). Run the validator from `validator/` before pushing: `go test ./...` and `go run .` (or `go run . -data ../schema/fixtures/valid` until `data/` exists).
- `.gitignore` ignores everything by default, so a new top-level file or directory needs a `!` entry there.
- A new tooling ecosystem gets a `.github/dependabot.yml` entry in the same change.
- Releases: add a `CHANGELOG.md` entry, set `release` in `data/game-system.json`, and push the tag `v<release>`. CI checks the two match and fast-forwards the `release` branch, which fundamalleus pins as a submodule.
