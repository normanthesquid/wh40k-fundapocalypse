# Changelog

Each release is a git tag `v<version>` matching `release` in `data/game-system.json`, with an entry here. See [docs/data-format.md](docs/data-format.md#releases).

## 2.9.1

* 30 datasheets get their printed keywords, which were missing: 16 Renegades and Heretics vehicle and artillery units, the Carnifex, Screamer-Killer, Thornback and Stone Crusher broods, the Armiger Helverin, Moirax and Warglaive, the Bane Wolf and Devil Dog, the War Dog and War Dog Moirax, the Greater Possessed (now a CHARACTER), the Drone Sentry Turrets, and the Space Marines' Tarantula Battery and Tarantula Air Defence Battery.

## 2.9.0

* Each detachment has an `order`, where it comes in the rulebook's list of detachments, from Battalion (1) to Ad Hoc (11). New integrity rule 11 rejects two detachments with the same order.
* TYRANIDS is a Faction keyword of every Hive Fleets and Genestealer Cults datasheet, as printed, not a plain keyword. A detachment can now pick TYRANIDS and mix units from both.
* 21 datasheets get their printed Faction keywords, which were missing: the Carnifex, Screamer-Killer, Thornback and Stone Crusher broods, 16 Renegades and Heretics vehicle and artillery units (Hellhound to Valkyrie squadrons), and the T'au Empire Drone Sentry Turrets.

## 2.8.0

* Each Faction catalogue has a `factionKeyword`, its own Faction keyword, such as BLOOD ANGELS for Blood Angels, IMPERIUM for Agents of the Imperium and TYRANID HIVE FLEETS for Hive Fleets.
* `unitsShareFaction` now means every unit in the detachment has the one Faction keyword the list picks for it, rather than the units sharing any keyword at all.

## 2.7.0

* A detachment's `slots` list the roles it allows: a role left out allows no units, and `{}` allows any number. The Ad Hoc detachment lists every role that way. The `NoForceOrgSlot` role is removed.
* A datasheet's `takesNoSlotWhen` keeps a unit out of its role's minimum and maximum while a condition holds. It replaces the second copies BattleScribe needed for this: Adeptus Ministorum Crusaders, Death Cult Assassins and Arco-flagellants (with a Ministorum Priest), Geminae Superia (with Celestine) and Repentia Superior (with Sisters Repentia); Astra Militarum Crusaders (with a Ministorum Priest); Heretic Astartes Chaos Beastmen and Rogue Psyker (with Obsidius Mallex in the detachment, as printed); and Gellerpox Mutoid Vermin (with Vulgrar Thrice-Cursed). Lists naming a removed copy (`-2`, or `mutoid-vermin-3`) need that unit added again.
* `takesNoSlotWhen` also gives the printed rule to units that lacked it: Drukhari Lhamaean, Medusae, Sslyth and Ur-Ghul (with an Archon), Clawed Fiends, Khymerae and Razorwing Flocks (with a Beastmaster), and the Aegis Defense Line Gun Emplacement.
* A detachment's `commanderCannotBeWarlord`: the Ad Hoc detachment's Commander never gains WARLORD.
* Sisters Repentia and Repentia Superior carry their printed keywords, SISTERS REPENTIA and REPENTIA SUPERIOR, in place of REPENTIA SQUAD and MISTRESS OF REPENTANCE.

## 2.6.0

* Each unit names its own subfaction, as the printed rules say, rather than its detachment choosing one for all its units. A detachment may mix subfactions, a Venom names one of a Kabal, Wych Cult or Coven, and a unit printed with a subfaction's keyword, such as Marneus Calgar, may join any detachment its other rules allow. See [the data format](docs/data-format.md#subfactions).
* Heretic Astartes' Marks of Chaos and the Black Templars' Librarians test the unit's Legion or Chapter keyword, not the detachment's choice. Captain Corien Sumatris no longer has a Chapter condition: his wargear gives his keyword.
* Integrity rule 10 also rejects a condition that counts a subfaction choice's option.

## 2.5.1

* Eight datasheets get their printed Faction keywords, which were missing: Bane Wolf and Devil Dog (`<REGIMENT>`), the Armiger Moirax, Helverin and Warglaive (`<QUESTOR ALLEGIANCE>`, `<HOUSEHOLD>`), the War Dog and War Dog Moirax (`<QUESTOR TRAITORIS>`) and the Greater Possessed (`<LEGION>`).

## 2.5.0

* Subfactions. A detachment choice's `fillsPlaceholder` makes it a faction's subfaction choice, and each option names the `keyword` that replaces the placeholder. Every placeholder faction keyword now has one: Adeptus Ministorum, Astra Militarum (Militarum Tempestus included), Asuryani, Chaos Knights, Drukhari, Genestealer Cults, Harlequins, Hive Fleets, Imperial Knights, Necrons, Orks, T'au Empire and Titan Legions get theirs, and Adeptus Astartes' and Heretic Astartes' filters become their Chapter and Legion. Chaos Knights choose an Infernal or Iconoclast Household, and an Imperial Knights Household may be Freeblade. Those two allegiances are `closed`: no "your own". A list builder also offers "your own", named by the player; Titan Legions and Asuryani Conclaves and Coteries offer only that. Drukhari's three choices share an `alternativeGroup`, since a Venom or Raider is from one of a Kabal, Wych Cult or Coven.
* Kaptin Badrukk and Flash Gitz carry FREEBOOTERZ, as printed, not FREEBOOTAS.
* A unit carrying a subfaction's keyword (Marneus Calgar's ULTRAMARINES, Ghazghkull's GOFF) may join only a detachment of that subfaction, as [the data format](docs/data-format.md#subfactions) explains. The conditions that encoded this for Adeptus Astartes and Heretic Astartes units are removed. Captain Corien Sumatris, who carries no Chapter keyword, needs Astral Claws or Tiger Claws.
* Heretic Astartes units without a fixed Legion carry `<LEGION>`, replacing the Legion filter's added keyword, and the Renegade Chapter option is gone: "your own" names one.
* New integrity rule 10 checks each placeholder has exactly one subfaction choice, whose options each name a keyword.

## 2.4.0

* New markers for list builders that record Commanders and the Warmaster: a datasheet's `cannotBeWarlord` (the three C'tan Shards), a datasheet's `beginsAsCommander` (the Tomb Ziggurat) and a detachment ability's `makesCharacter` (Knight Lances and Fallen Courts).

## 2.3.0

* Commander, Warmaster and Character are no longer datasheet upgrades. The rules nominate them after deployment, and Knight Lances and Fallen Courts are Faction abilities. Removed: the game-wide `commander` and `warmaster` options and with them universal options; the Knights', C'tan and Sanctus upgrades; and every COMMANDER and WARMASTER keyword limit, and with them `keywordLimits` and `armyKeywordLimits`. An option's `maximumPerDetachment` is removed too, since nothing used it any more.
* The Renegade Commander has its printed Chaos Covenant ability, replacing 50 conditional covenant abilities on other Renegades and Heretics datasheets.
* The Primaris Redoubt and the Dark Angels Master, Primaris Master and Lazarus no longer have a COMMANDER keyword, matching their datasheets.

## 2.2.0

* An option's `maximumPerArmy` is removed from the format. No option used it; per-army limits are on whole units.

## 2.1.0

* Detachments carry `unitsShareFaction`: all units must be from the same Faction, sharing at least one Faction keyword. It is set on every detachment except Super-heavy Auxiliary, Fortification Network and Ad Hoc.
* The Doomsday Ark has its keywords (HEAVY, VEHICLE, FLY, DOOMSDAY ARK) and Faction keywords (NECRONS, `<DYNASTY>`), which were missing.
* An option's `minimumPerArmy` is removed from the format. No option used it.

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
  * The Centurion Assault and Devastator Squads that Blood Angels, Dark Angels, Space Wolves and Deathwatch field have the Power Ratings, 6-model stat line and keywords of their datasheets.
  * Six units that had no battlefield role were given one from their datasheet, and a few option limits and conditions that pointed at the wrong unit were fixed.
* Detachments that aren't Core (Patrol, Air Wing, Super-heavy Auxiliary, Fortification Network, Supreme Command and Ad Hoc) are Special Detachments, as the rulebook calls them.

## 1.10.0

The last BattleScribe release, kept as the rollback point.
