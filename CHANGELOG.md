# Changelog

Each release is a git tag `v<version>` matching `release` in `data/game-system.json`, with an entry here. See [docs/data-format.md](docs/data-format.md#releases).

## 2.0.0

* The data moves from BattleScribe catalogues to the JSON format in [docs/data-format.md](docs/data-format.md). All 38 catalogues of `1.10.0` were converted.
* CI validates the data against the schema and the integrity rules, with the Go validator in `validator/`.
* BattleScribe support is deprecated. The `.gst` and `.cat` files stay in this repository, frozen at `1.10.0`, and the BattleScribe data URL keeps serving them. None of the changes below reach BattleScribe.
* Names now match the official datasheets where BattleScribe gave a unit its own name for a shared ability or weapon, e.g. Reaver Void Shields, Warrant of Trade, Artillery Battery.
* Corrections to `1.10.0`, checked against the official Apocalypse datasheets:
  * Stat lines that were missing for 28 datasheets were added, and blank or mistyped characteristics were fixed, e.g. Azrael, Hector Rex, Trajann Valoris, Cyberwolves and the Elysian squads.
  * Allarus Weapons (Ranged) has a range of 24". The Avenger Gatling Cannon has SAT 8+. Rubric Marines have Sv 5+ and Close Combat Weapons. A 12-model Harlequin Troupe has A 3.
  * Keywords were added: INFANTRY on the Shield Captain, TERMINATOR on Allarus Custodians, and IMPERIUM on the Interrogator-Chaplain.
  * Names were corrected: Elysian Veteran Squad, Stormspear Rocket Pod, The Vox-Shamblers, Legacy of the Rubricae, Warden of Yvraine.
  * The Banner of the Apostate affects Imperial units, and a Death Korps Combat Engineer Squad's Heavy Weapons Team costs PL +1.
  * The Reaver Melta Cannon has Destroyer, not Apocalyptic Destroyer.
  * Six units that had no battlefield role were given one from their datasheet, and a few option limits and conditions that pointed at the wrong unit were fixed.
* Patrol and Air Wing are Special Detachments, as the rulebook calls them.

## 1.10.0

The last BattleScribe release, kept as the rollback point.
