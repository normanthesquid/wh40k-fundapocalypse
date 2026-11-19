# Repo rules

- This repo is public. Nothing in it (files, commit messages, PR titles or bodies, branch names, issue comments) names or links the private tracker or its ticket keys. Plans for this repo are kept with the fundamalleus repo.
- House style comes from `cephalotech-ab/shared-infra`, with recorded exceptions: this repo stays on the personal `normanthesquid` account, and its CI runs on GitHub-hosted `ubuntu-latest`. The comment and file length checks come from shared-infra through a read-only deploy key (secret `SHARED_INFRA_DEPLOY_KEY`), so they skip on fork PRs.
- The format is defined by `schema/` and [docs/data-format.md](docs/data-format.md). Run the validator from `validator/` before pushing: `go test ./...` and `go run .` (or `go run . -data ../schema/fixtures/valid` until `data/` exists).
- `.gitignore` ignores everything by default, so a new top-level file or directory needs a `!` entry there.
- A new tooling ecosystem gets a `.github/dependabot.yml` entry in the same change.
- Releases: add a `CHANGELOG.md` entry, set `release` in `data/game-system.json`, and push the tag `v<release>`; CI checks the two match. Once it's green, fast-forward the `release` branch, which fundamalleus pins as a submodule: `git push origin v<release>^{commit}:refs/heads/release`. That push is manual because Actions' token may not push commits that change workflows.
- Before treating a data discrepancy as a mistake in the source, check `git log`/`git blame` and the wiki's Datasheet Changes pages for a deliberate change, and confirm a real mistake with the owner before changing a unit.
