# Fundapocalypse data format

BSData, the upstream of these catalogues, has been taken down. That frees Fundapocalypse from BattleScribe's format and tools, so from `v2.0.0` onwards the rules are plain JSON validated by JSON Schema (draft 2020-12). This document describes that format and how each BattleScribe construct maps onto it.

`v1.10.0` is the last BattleScribe release and stays tagged as the rollback point.

## Layout

```
schema/
  common.schema.json       shared types: ids, profiles, weapons, conditions, limits
  game-system.schema.json  detachments, release version
  catalogue.schema.json    a faction or a shared library
  fixtures/valid/          a small data set that must pass, laid out like data/
  fixtures/invalid/        catalogues the schema must reject, each for the reason in its name
data/                      (from v2.0.0; converted from the BattleScribe files by a one-time importer, in the v2.0.0 tag)
  game-system.json
  catalogues/<catalogue-id>.json
validator/                 the Go validator CI runs: the schema plus the integrity rules below
```

In `fixtures/valid/`, `catalogues/agents-of-the-imperium.json`, `catalogues/weapons.json` and `game-system.json` are converted by hand from `v1.10.0`, with the real values for the entries they include (Supreme Command's Dedicated Transport rule is left out for brevity). The Patrol, Vanguard, Super-heavy Auxiliary and Fortification Network detachments are stubs with no slots, there only so the references to them resolve. `catalogues/example-library.json` and `catalogues/example-faction.json` are illustrative and exist to exercise library links, alternative roles and detachment abilities.

## Ids and references

Every entry has a **slug** (`lascannon`, `ordo-malleus`):
* in a catalogue: datasheets, datasheet links, weapons, abilities, warmaster traits, detachment choices, the options of each detachment choice, and detachment abilities;
* in the game system: detachments, abilities and warmaster traits;
* within a datasheet: option groups and options, given as an `id` because they are ordered arrays.

**A slug never changes**, even when the name does, because army lists and rules proposals in fundamalleus store it. Retiring an entry removes its slug; it is never reused.

| What | Unique within | Global id stored by fundamalleus |
|---|---|---|
| Catalogue entries (all kinds together) | the catalogue | `catalogue-id/slug` |
| Game-system entries (all kinds together) | the game system | `slug` |
| Option groups and options (all groups together) | the datasheet | the datasheet's id plus the option slug |

A **reference** is a bare slug when the target is in the same catalogue or the game system, and `catalogue-id/slug` when it's in another catalogue, which must be listed in `imports`. A catalogue never prefixes its own entries. The game system has no `imports`, so its prefixed references may name any catalogue.

### Library datasheets

`imports` makes a library's entries referenceable but fields no units by itself. A faction lists each library datasheet it fields in `datasheetLinks`. The link can replace the battlefield role or cost and add faction keywords, keywords, abilities, alternative roles and an `availableWhen`. The link's own slug is the unit's id in that faction, so `dark-angels/tactical-squad` and `space-wolves/tactical-squad` stay distinct while sharing one library datasheet. A change to that library datasheet reaches every faction that links it. `conditionalKeywords` adds keywords only when a condition holds, e.g. when the unit takes one of the library datasheet's options.

## Keywords and order

Keywords are written in capitals (`INFANTRY`, `COMMANDER (T'AU)`) and match exactly; the schema rejects lower case, so `Infantry` can't silently become a second keyword.

Lists whose order is shown to players, such as option groups and the options in a group, are arrays in display order. Maps keyed by slug (datasheets, weapons, abilities) carry no meaningful order.

## Typed values

The printed characteristics become typed values, so tools never parse text:

| Printed | Stored |
|---|---|
| `6"` | `{ "kind": "Inches", "inches": 6 }` |
| `20"-60"` (aircraft) | `{ "kind": "Range", "minimum": 20, "maximum": 60 }` |
| `-` for M | `{ "kind": "Immobile" }` |
| `3+` for WS or BS | `3` (a D6 roll, 2–6) |
| `8+` for Sv, SAP or SAT | `8` (a 2D6 roll, 2–12) |
| Unit `A`: `3`, `D3`, `2D3` | `{ "kind": "Fixed", "value": 3 }`, `{ "kind": "Dice", "count": 1, "sides": 3 }`, ... |
| Weapon `A`: `2`, `User`, `x2` | `Fixed`, `User`, `UserMultiplied` (`Dice` is allowed; no weapon used it in `v1.10.0`) |
| Weapon `Range`: `48"`, `*`, `Melee` | `{ "kind": "Inches", "inches": 48 }`, `{ "kind": "Special" }` (see the weapon's text), left out for melee |
| `-` for a skill, Attacks, Leadership, SAP or SAT | the field is left out, never a placeholder value |
| Weapon `Type` | `SmallArms`, `Heavy` or `Melee` |
| Battlefield role | `HQ`, `Troops`, `Elites`, `FastAttack`, `HeavySupport`, `Flyer`, `DedicatedTransport`, `LordOfWar`, `Fortification`, `NoForceOrgSlot` |

Typos in the `v1.10.0` data (`Mele`, `Smaill Arms`, a WS of `26`) were fixed by the importer and listed in its fidelity report.

## Conditions and limits

BattleScribe hides and shows entries with modifiers and nested conditions. Here, a typed `condition` decides availability:

* **`Count`:** how many of something the unit, detachment or army contains (counting a `Detachment` type in `Detachment` scope asks whether this detachment is of that type), between an optional `minimum` and `maximum`. It can count a datasheet, a keyword, a battlefield role, a wargear option, everything taken from one of the unit's option groups (`OptionGroup`), a detachment choice (e.g. a faction filter), a detachment type, a detachment kind (`Core`, or `Special` for the rulebook's Special Detachments, such as Patrol and Air Wing, that Core ones unlock), or any unit. "Not taken" is `maximum: 0`.
* **`PrimaryFaction`:** the army's primary faction.
* **`All`, `Any` and `Not`** combine conditions.

It's used by `availableWhen` on datasheets, links, options, detachments and detachment abilities, and by `alternativeRoles` (e.g. Khorne Berserkers becoming Troops). Two more constructs apply only while a condition holds:

* **`conditionalChanges`** on a datasheet add weapons, abilities, keywords or profile changes, or remove weapons, e.g. an ability only one Ordo's Acolytes have. A weapon whose characteristics change becomes a second weapon, swapped in this way or by an option.
* **`costChanges`** on an option or a datasheet `set` or `increment` its cost, in order, e.g. a jump pack that costs more in a larger unit, or a unit whose power rating rises once it takes any drones.

A **`limit`** is a number that grows or shrinks with the army: a `base`, plus `amount` for each thing counted. For example, a Battalion's Dedicated Transport maximum is 0, plus 1 per HQ, Troops, Elites, Fast Attack and Heavy Support unit in it. An Air Wing's maximum per army is 3 per Core detachment, minus 1 per Supreme Command, Super-heavy Auxiliary, Patrol or Fortification Network detachment. Slot maximums and detachments per army are both limits. An option group's `minimum` or `maximum`, or an option's `maximum`, may be a limit too, counting the unit's own options, e.g. one heavy weapon, plus one if the unit takes its 10-model option. An option group's `availableWhen` makes the whole group, its minimum included, apply only while a condition holds, e.g. an Inquisitorial Retinue's weapon swap once no Acolytes are left to carry it. An option group's `multipleOf` makes the number of options taken a multiple of it, e.g. a Baneblade's two or four sponsons.

A datasheet's `requiredInDetachment` makes a detachment hold at least `minimum` of the unit while `when` holds, as the parts of a fortification that come together: once a detachment has any part of a Castellum Stronghold, it needs its 3 Bunker Annexes.

A detachment with `unitsShareFaction` requires all its units to be from the same Faction: every unit shares at least one Faction keyword, as the rulebook's Factions section explains. Super-heavy Auxiliary, Fortification Network and Ad Hoc leave it out, so their units may mix Factions.

An option with `requiredWhen` must be taken while that condition holds, e.g. the Mark of Khorne once the detachment has chosen Khorne. An option that adds a model with its own characteristics lists it in `addsProfiles`; `profileChanges` may name it. A datasheet with no stat line at all leaves `profiles` out; that is right only where the official datasheet prints none, as for terrain features such as the Aegis Defence Line.

## Integrity rules

JSON Schema checks each file's shape. These rules span entries or files, so `validator/` checks them after every file passes the schema. It also rejects a key repeated within one JSON object, which a JSON parser would otherwise silently merge:

1. Slugs are unique as listed under "Ids and references". Profile names are unique within a datasheet.
2. Every reference resolves. A `catalogue-id/` reference only points into an imported catalogue; `imports` only names `kind: Library` catalogues that exist; a catalogue's `id` matches its file name.
3. `datasheetLinks`, `detachmentChoices` and `detachmentAbilities` appear only in `kind: Faction` catalogues, and a `datasheetLinks` target is a library datasheet.
4. Count targets resolve: a `Detachment` names a game-system detachment; a `DetachmentChoice` names an option of some `detachmentChoices` entry; an `Option` names an option of its datasheet (or of `datasheet`, when given); an `OptionGroup` names an option group of its datasheet; `PrimaryFaction` names a `kind: Faction` catalogue.
5. Every keyword used in a count target is a keyword some datasheet, option, link or choice actually adds, which catches typos.
6. An option group's `default` is one of its options, and its `minimum` is no more than its options' `maximum`s add up to (any option without a fixed `maximum` lifts the cap). A group bound written as a limit always has terms, so it depends on the unit and is not compared.
7. `removesWeapons` only names weapons the datasheet carries, another of its options adds, or a conditional change adds, and `profileChange.profile` names one of the datasheet's profiles, including those its options add.
8. `minimum` ≤ `maximum` wherever both appear, including movement ranges. A slot limit is compared only when its `maximum` has no `terms`, since a growing maximum depends on the army.
9. `game-system.json`'s `release` matches the tag being released (`go run . -release 2.0.0`; CI passes it on a tag push).

## Revisions are computed, not stored

fundamalleus flags saved army lists whose units changed in a new release. It does this with a hash of each datasheet section. Tooling computes the hash from the canonical JSON: references are resolved to their full content (weapon profiles, ability text), library links are merged, object keys are sorted, and keyword and ability lists are sorted, so reordering them is not a change. Option groups and options keep their order, because display order is part of the datasheet.

* **cost:** the base cost, and every option's cost.
* **wargear:** the option groups and options, without their costs.
* **profile:** everything else: profiles, keywords, abilities, default weapons, transport, battlefield role, alternative roles, availability and limits.

Because the hashes are derived, nobody maintains them by hand, and a change to a shared library weapon or ability changes the hash of every datasheet that uses it.

## Releases

`game-system.json` carries `release`, which must match the git tag `v<release>`, and each release has a `CHANGELOG.md` entry. Pushing the tag runs CI, which checks the two match. The maintainer then fast-forwards the `release` branch to the tag (`git push origin v<release>^{commit}:refs/heads/release`); Actions' own token can't, since a release can change workflow files. fundamalleus pins this repo as a git submodule on that branch, so Dependabot's `gitsubmodule` updates (which follow a branch, not tags) propose each release exactly once.

## BattleScribe constructs

From a survey of the `.gst` and all 38 `.cat` files at `v1.10.0`.

| BattleScribe construct | Count | In this format |
|---|---|---|
| `gameSystem` | 1 | `game-system.json` |
| `catalogue` | 38 | one file each under `data/catalogues/`; the 5 `Library - *` files become `kind: Library` |
| `catalogueLink` (all `importRootEntries`) | 35 | `imports`, plus a `datasheetLinks` entry for each library datasheet the faction fields |
| `costType` (PL only) | 1 | `cost` (an integer Power Level) |
| `profileType` Unit / Weapons / Abilities | — | `profiles` / `weapons` / `abilities` |
| `profileType` Transport | — | `transport` (the printed rule as text) |
| `profileType` Warmaster Trait | — | `warmasterTraits` |
| `characteristic` | 25,806 | typed fields (see "Typed values") |
| `forceEntry` | 21 | 11 `detachments`; the other 10 are each detachment's nested child force of the same name, merged into it |
| Detachment `rule` (e.g. Objective Secured) | — | detachment `abilities` |
| `categoryEntry` / `categoryLink` | 1,583 / 12,191 | battlefield-role categories become `battlefieldRole`; `Faction: *` become `factionKeywords`; the rest become `keywords` |
| `categoryLink` changed by `add`/`remove`/`set-primary` modifiers | 10 | `alternativeRoles` or `addsKeywords` |
| `selectionEntry` type `unit` | 1,235 | `datasheets` |
| `selectionEntry` type `model` | 224 | per-model and unit-size options inside a datasheet (e.g. a `unit-size` option group), or a profile |
| `selectionEntry` type `upgrade` | 3,241 | wargear `option`s |
| `selectionEntryGroup` | 917 | wargear `optionGroup`s |
| "Chapter Filter", "Faction Filter" and similar `List Configuration` entries | — | `detachmentChoices` |
| `entryLink` | 5,591 | references to shared entries; root-level links to library units become `datasheetLinks` |
| `constraint` min/max, scope parent | 7,382 | `minimum`/`maximum` on option groups and options; no max constraint means `maximum` is left out |
| `constraint` max, scope roster | 203 | `maximumPerArmy` |
| `constraint` max, scope force | 20 | `maximumPerDetachment` |
| `modifier` on PL | 535 | unconditional ones become the cost in that context; conditional ones on the unit become option costs, and conditional ones on an option become its `costChanges` |
| `modifier` on an option group's min/max constraint, or an option's max | — | a `limit` counting the unit's options |
| `modifier` setting an option's max to 0, with conditions | — | `availableWhen`, or a weapon removed by `conditionalChanges` when the entry is otherwise mandatory |
| `modifier` setting an option's min to 1, with conditions | — | `requiredWhen` |
| `modifier` setting a unit's own detachment min, with conditions | — | `requiredInDetachment` |
| `modifier` setting both an option group's min and max to 0, with conditions | — | the group's `availableWhen` |
| `modifier` raising an option group's min to the next multiple once one more is taken | — | the group's `multipleOf` |
| `modifier` on a weapon's characteristics | — | a second weapon, swapped in by an option or a `conditionalChanges` entry |
| `modifier` set hidden on an ability or weapon, with conditions | — | the option's `addsAbilities`/`addsWeapons` when it depends on one, otherwise `conditionalChanges` |
| `selectionEntry` type `model` with its own Unit profile, optional | — | `addsProfiles` on that option |
| `modifier` on M/A/W/Sv, when an option is taken | — | `profileChanges` on that option |
| `modifier` on M/A/W/Sv/name, unconditional (on a link) | — | a catalogue-local entry with its own slug, in place of a link with overrides |
| `modifier` set hidden, with conditions | — | `availableWhen` |
| `modifier` on a detachment's slot constraint (`increment`/`decrement` with `repeat`) | 66 repeats | `limit` terms |
| `repeat` in catalogues | 12 | per-model costs, as an option with a `cost` and a `maximum` |
| `condition`, `conditionGroup` (and/or) | 1,290 / 265 | `Count`, `All`, `Any`, `Not`, `PrimaryFaction` |
| `infoLink` to a profile or rule | 1,993 | `abilities` references |
| `rule` / `sharedRules` | 44 | game-system or catalogue `abilities` |

### Dropped, deliberately

| BattleScribe construct | Why |
|---|---|
| `publication`, `page` modifiers | source references for BattleScribe's UI; Fundapocalypse is its own source now |
| `readme`, `comment` | authoring notes; anything still useful moves to this document or the wiki |
| `infoGroup` | grouping for BattleScribe's display only |
| BattleScribe `id`s (`8438-2d0c-...`) | replaced by slugs; the importer kept a one-time mapping in its report |
| Commander, Warmaster and Warlord upgrades (in the `.gst` and as catalogue options such as Character (Knight Lances)), their keyword limits, and the per-detachment caps on them | the rules nominate these during the game, after deployment, not when the list is built |
| `hidden="true"` with no condition | dead entries; the importer listed them for a decision rather than converting them |

Anything the importer met that this table doesn't cover failed the import, so nothing was silently lost.
