# Fundapocalypse data format

BSData, the upstream of these catalogues, has been taken down. That frees Fundapocalypse from BattleScribe's format and tools, so from `v2.0.0` onwards the rules are plain JSON validated by JSON Schema (draft 2020-12). This document describes that format and how each BattleScribe construct maps onto it. The plan is tracked in fundamalleus's Pragmatik project, under initiative `006 - Fundapocalypse rules data format` (stage 1 is FUN-70).

`v1.10.0` is the last BattleScribe release and stays tagged as the rollback point.

## Layout

```
schema/
  common.schema.json       shared types: ids, profiles, weapons, conditions
  game-system.schema.json  detachments, universal abilities, release version
  catalogue.schema.json    a faction or a shared library
  fixtures/valid/          hand-converted examples that must validate
  fixtures/invalid/        examples that must be rejected
data/                      (from v2.0.0, written by the one-time importer in stage 3)
  game-system.json
  catalogues/<catalogue-id>.json
```

## Ids and references

Every datasheet, weapon, ability, warmaster trait, detachment and wargear option has a **slug** (`lascannon`, `ordo-hereticus`). It is unique within its kind in one catalogue, and **it never changes**, even when the name does, because army lists and rules proposals in fundamalleus store it. Retiring an entry removes the slug; it is never reused for something else.

A **reference** is a bare slug when the target is in the same catalogue or in the game system, and `catalogue-id/slug` when it's in another catalogue. That other catalogue must be listed in `imports`. The global id of an entry, as stored by fundamalleus, is always `catalogue-id/slug`.

Keyed objects (`"datasheets": { "inquisitor": { ... } }`) make duplicate ids impossible by construction.

## Typed values

The printed characteristics become typed values, so tools never parse text:

| Printed | Stored |
|---|---|
| `6"` | `{ "kind": "Inches", "inches": 6 }` |
| `20"-60"` (aircraft) | `{ "kind": "Range", "minimum": 20, "maximum": 60 }` |
| `-` for M | `{ "kind": "Immobile" }` |
| `3+` for WS or BS | `3` (a D6 roll, 2–6) |
| `8+` for Sv, SAP or SAT | `8` (a 2D6 roll, 2–12) |
| `-` for a skill, Leadership, SAP or SAT | the field is left out, never a placeholder |
| Weapon `A`: `2`, `User`, `x2`, `2D6` | `Fixed`, `User`, `UserMultiplied`, `Dice` |
| Weapon `Type` | `SmallArms`, `Heavy` or `Melee` |
| Weapon `Range` | inches; left out for melee weapons |
| Battlefield role | `HQ`, `Troops`, `Elites`, `FastAttack`, `HeavySupport`, `Flyer`, `DedicatedTransport`, `LordOfWar`, `Fortification`, `NoForceOrgSlot` |

Typos in the current data (`Mele`, `Smaill Arms`, a WS of `26`) are fixed by the importer and listed in its fidelity report.

## Conditions

BattleScribe hides and shows entries with modifiers and nested conditions. Here, availability is a small typed `condition`:

* `Count`: how many of an entry, a keyword or a wargear option the unit, detachment or army contains, between an optional `minimum` and `maximum`. "Not taken" is `maximum: 0`.
* `PrimaryFaction`: the army's primary faction.
* `All`, `Any` and `Not` combine conditions.

`availableWhen` on a datasheet or a wargear option uses it. For example, Terminator Armour is only available when the unit hasn't taken Ordo Hereticus.

## Revisions are computed, not stored

fundamalleus flags saved army lists whose units changed in a new release (007 Stage 5). It does this with a hash of each datasheet section, computed by tooling from the canonical JSON (keys sorted, references resolved):

* **profile:** profiles, keywords, faction keywords, abilities, and the resolved default weapons;
* **wargear:** the option groups, with their resolved weapons and abilities;
* **cost:** the base cost and every option cost.

Because the hashes are derived, nobody maintains them by hand, and a change to a shared library weapon changes the hash of every datasheet that uses it.

## Releases

`game-system.json` carries `release`, which must match the git tag `v<release>`. Each release also fast-forwards the `release` branch. fundamalleus pins this repo as a git submodule on that branch, so Dependabot's `gitsubmodule` updates (which follow a branch, not tags) propose each release exactly once.

## BattleScribe constructs

From a survey of the `.gst` and all 38 `.cat` files at `v1.10.0`.

| BattleScribe construct | Count (— where the survey grouped it differently) | In this format |
|---|---|---|
| `gameSystem` | 1 | `game-system.json` |
| `catalogue` | 38 | one file each under `data/catalogues/`; the 5 `Library - *` files become `kind: Library` |
| `catalogueLink` | 35 | `imports` |
| `costType` (PL only) | 1 | `cost` (an integer Power Level) |
| `profileType` Unit | — | `profiles` (`modelProfile`) |
| `profileType` Weapons | — | `weapons` map, referenced by slug |
| `profileType` Abilities | — | `abilities` map, referenced by slug |
| `profileType` Transport | — | `transport` (the printed rule as text) |
| `profileType` Warmaster Trait | — | `warmasterTraits` |
| `characteristic` | 25,806 | typed fields (see "Typed values") |
| `forceEntry` | 21 | `detachments`, with `slots` per battlefield role |
| `categoryEntry` / `categoryLink` | 1,583 / 12,191 | battlefield-role categories become `battlefieldRole`; `Faction: *` become `factionKeywords`; the rest become `keywords` |
| `selectionEntry` type `unit` or `model` | 1,459 | `datasheets` |
| `selectionEntry` type `upgrade` | 3,241 | wargear `option`s |
| `selectionEntryGroup` | 917 | wargear `optionGroup`s |
| `entryLink` | 5,591 | references; links to shared entries become references to the library slug |
| `constraint` min/max, scope parent | 7,382 | `minimum`/`maximum` on option groups and options |
| `constraint` max, scope roster | 203 | `maximumPerArmy` |
| `constraint` max, scope force | 20 | `maximumPerDetachment` |
| `modifier` set PL, unconditional (on a link) | 407 | resolved into that context's `cost` |
| `modifier` set PL by unit size, or increment PL per model | 98 | a "unit size" option group whose options carry the cost |
| `modifier` set M/A/W/Sv when an option is taken | — | `profileChanges` on that option |
| `modifier` set M/A/W/Sv/name, unconditional (on a link) | — | a catalogue-local entry with its own slug, in place of a link with overrides |
| `modifier` set hidden, with conditions | — | `availableWhen` |
| `condition`, `conditionGroup` (and/or) | 1,290 / 265 | `Count`, `All`, `Any`, `Not`, `PrimaryFaction` |
| `repeat` | 78 | per-model costs, as a repeatable option with `maximum` |
| `infoLink` to a profile or rule | 1,993 | `abilities` references |
| `rule` / `sharedRules` | 44 | game-system or catalogue `abilities` |

### Dropped, deliberately

| BattleScribe construct | Why |
|---|---|
| `publication`, `page` modifiers | source references for BattleScribe's UI; Fundapocalypse is its own source now |
| `List Configuration` category | a BattleScribe roster-setup device, not a rule |
| `readme`, `comment` | authoring notes; anything still useful moves to this document or the wiki |
| `infoGroup` | grouping for BattleScribe's display only |
| `modifier` set name on an `infoLink` | display renames of a linked rule; the referenced ability carries the right name |
| BattleScribe `id`s (`8438-2d0c-...`) | replaced by slugs; the importer keeps a one-time mapping in its report |
| `hidden="true"` with no condition | dead entries; the importer lists them for a decision rather than converting them |

Anything the importer meets that this table doesn't cover fails the import, so nothing is silently lost.
