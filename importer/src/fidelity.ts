import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID, type Conversion, type WargearFates } from "./conversion.ts";
import type { Catalogue } from "./model.ts";
import { TRANSPORT_PROFILE, UNIT_PROFILE, WEAPON_PROFILE } from "./profiles.ts";
import type { SourceDocument } from "./registry.ts";
import { emptyCounts, type CatalogueCounts, type Finding, type Report } from "./report.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

function walk(element: Element, visit: (element: Element) => void): void {
   visit(element);
   for (const child of element.children) walk(child, visit);
}

function withoutGameSystem(names: Set<string>, gameSystemAbilities: Set<string>): Set<string> {
   return new Set([...names].filter((name) => !gameSystemAbilities.has(name)));
}

/** Counts in a source file. Units are its root entries less detachment choices, plus a library's shared entries that are units. */
export function countBefore(document: SourceDocument, conversion: Conversion, gameSystemAbilities: Set<string>): CatalogueCounts {
   const counts = emptyCounts();
   const abilities = new Set<string>();
   walk(document.root, (element) => {
      if (element.tag === "profile") {
         const typeName = attribute(element, "typeName");
         const name = attribute(element, "name").trim();
         if (typeName === WEAPON_PROFILE) counts.weapons.add(name);
         else if (typeName !== UNIT_PROFILE && typeName !== TRANSPORT_PROFILE) abilities.add(name);
      }
      if (element.tag === "rule") abilities.add(attribute(element, "name").trim());
   });
   counts.abilities = withoutGameSystem(abilities, gameSystemAbilities);
   const hasPrimaryRole = (entry: Element) =>
      childrenOf(entry, "categoryLinks", "categoryLink").some((link) => link.attributes.primary === "true" && conversion.registry.category(attribute(link, "targetId"))?.kind === "Role");
   const roots = conversion.rootEntries(document).filter((entry) => !conversion.choiceRoots.has(entry));
   const shared = document.isLibrary ? childrenOf(document.root, "sharedSelectionEntries", "selectionEntry") : [];
   counts.units = roots.length + shared.filter((entry) => entry.attributes.type === "unit" || hasPrimaryRole(entry)).length;
   return counts;
}

export function countAfter(catalogue: Catalogue, gameSystemAbilities: Set<string>): CatalogueCounts {
   const datasheets = Object.values(catalogue.datasheets ?? {});
   return {
      units: datasheets.length + Object.keys(catalogue.datasheetLinks ?? {}).length,
      weapons: new Set(Object.values(catalogue.weapons ?? {}).map((weapon) => weapon.name)),
      abilities: withoutGameSystem(new Set(Object.values(catalogue.abilities ?? {}).map((ability) => ability.name)), gameSystemAbilities),
      options: datasheets.reduce((total, datasheet) => total + (datasheet.wargear ?? []).reduce((sum, group) => sum + group.options.length, 0), 0),
   };
}

/** The source wargear entries of one catalogue's datasheets, with what became of them. */
interface WargearTally extends WargearFates {
   sourceEntries: number;
   withDroppedDatasheets: number;
}

function wargearTallies(conversion: Conversion, converted: Catalogue[]): Map<string, WargearTally> {
   const tallies = new Map<string, WargearTally>();
   const byId = new Map(converted.map((catalogue) => [catalogue.id, catalogue]));
   for (const [key, slugs] of conversion.optionSlugs) {
      const [catalogueSlug, datasheetSlug] = key.split("/");
      const tally = tallies.get(catalogueSlug) ?? { sourceEntries: 0, options: 0, fixedWargear: 0, carriedUntilDropped: 0, dropped: 0, withDroppedDatasheets: 0 };
      tallies.set(catalogueSlug, tally);
      tally.sourceEntries += slugs.sourceEntries;
      if (byId.get(catalogueSlug)?.datasheets?.[datasheetSlug] === undefined) {
         tally.withDroppedDatasheets += slugs.sourceEntries;
         continue;
      }
      tally.options += slugs.fates.options;
      tally.fixedWargear += slugs.fates.fixedWargear;
      tally.carriedUntilDropped += slugs.fates.carriedUntilDropped;
      tally.dropped += slugs.fates.dropped;
   }
   return tallies;
}

/** The finding that accounts for a name present on one side only: one dropping it, or one renaming to it. */
function explanationOf(name: string, findings: Finding[]): string | undefined {
   const finding = findings.find((candidate) => candidate.where.endsWith(`> ${name}`) || candidate.message.includes(`"${name}"`));
   return finding === undefined ? undefined : `${finding.where}: ${finding.message}`;
}

function nameDifferences(report: Report): { lines: string[]; unexplained: number } {
   const findings = [...report.dropped, ...report.corrections];
   const lines: string[] = [];
   let unexplained = 0;
   for (const [slug, before] of report.before) {
      const after = report.after.get(slug) ?? emptyCounts();
      const kinds: [string, Set<string>, Set<string>][] = [["Weapon", before.weapons, after.weapons], ["Ability", before.abilities, after.abilities]];
      for (const [kind, source, converted] of kinds) {
         const differing = [...[...source].filter((name) => !converted.has(name)).map((name) => [name, "removed"]), ...[...converted].filter((name) => !source.has(name)).map((name) => [name, "added"])];
         for (const [name, change] of differing) {
            const explanation = explanationOf(name, findings);
            if (explanation === undefined) unexplained += 1;
            lines.push(`| ${slug} | ${kind} | ${name} | ${change} | ${(explanation ?? "**unexplained**").replace(/\|/g, "\\|")} |`);
         }
      }
   }
   return { lines, unexplained };
}

function findingRows(findings: Finding[]): string {
   if (findings.length === 0) return "None.\n";
   const rows = findings.map((finding) => `| ${finding.file} | ${finding.where.replace(/\|/g, "\\|")} | ${finding.message.replace(/\|/g, "\\|")} |`);
   return ["| File | Where | What |", "|---|---|---|", ...rows].join("\n") + "\n";
}

export interface FidelitySummary {
   readonly unexplainedCounts: number;
   readonly unexplainedNames: number;
   readonly unaccountedWargear: number;
}

export function writeReport(path: string, report: Report, conversion: Conversion, converted: Catalogue[]): FidelitySummary {
   const mark = (left: number, right: number) => (left === right ? `${right}` : `**${right}**`);
   const lines = ["# BattleScribe import fidelity report", "", "## Counts per catalogue", ""];
   lines.push("Weapons and abilities are counted by distinct name; game-system abilities are left out of both sides.", "");
   lines.push("| Catalogue | Units before | after | Weapons before | after | Abilities before | after |", "|---|---|---|---|---|---|---|");
   let unexplainedCounts = 0;
   for (const [slug, before] of report.before) {
      const after = report.after.get(slug) ?? emptyCounts();
      if (before.units !== after.units) unexplainedCounts += 1;
      lines.push(`| ${slug} | ${before.units} | ${mark(before.units, after.units)} | ${before.weapons.size} | ${mark(before.weapons.size, after.weapons.size)} | ${before.abilities.size} | ${mark(before.abilities.size, after.abilities.size)} |`);
   }
   const names = nameDifferences(report);
   lines.push("", `A bold unit count differs from the source and has no explanation. A bold weapon or ability count is explained name by name below (${names.unexplained} unexplained).`, "");
   lines.push("## Weapon and ability names on one side only", "");
   if (names.lines.length === 0) lines.push("None.");
   else lines.push("| Catalogue | Kind | Name | Change | Explained by |", "|---|---|---|---|---|", ...names.lines);
   lines.push("", "## Wargear entries", "");
   lines.push("Every entry below a unit in the source, except groups and the Commander and Warmaster links, against what the conversion made of it.", "");
   lines.push("| Catalogue | Source entries | Options | Fixed wargear | Carried until dropped | Dropped | With dropped datasheets | Unaccounted |", "|---|---|---|---|---|---|---|---|");
   let unaccountedWargear = 0;
   for (const [slug, tally] of wargearTallies(conversion, converted)) {
      const accounted = tally.options + tally.fixedWargear + tally.carriedUntilDropped + tally.dropped + tally.withDroppedDatasheets;
      const unaccounted = tally.sourceEntries - accounted;
      const optionsAfter = report.after.get(slug)?.options ?? 0;
      unaccountedWargear += Math.abs(unaccounted) + Math.abs(optionsAfter - tally.options);
      lines.push(`| ${slug} | ${tally.sourceEntries} | ${mark(tally.options, optionsAfter)} | ${tally.fixedWargear} | ${tally.carriedUntilDropped} | ${tally.dropped} | ${tally.withDroppedDatasheets} | ${unaccounted === 0 ? "0" : `**${unaccounted}**`} |`);
   }
   lines.push("", "A bold option count differs from the options in the converted catalogue.", "");
   lines.push(`## Corrections (${report.corrections.length})`, "", findingRows(report.corrections));
   lines.push(`## Dropped (${report.dropped.length})`, "", findingRows(report.dropped));
   lines.push(`## Unhandled (${report.unhandled.length})`, "", findingRows(report.unhandled));
   mkdirSync(dirname(path), { recursive: true });
   writeFileSync(path, lines.join("\n"));
   const mapping: Record<string, string> = {};
   for (const [id, located] of conversion.datasheets) mapping[id] = located.builder.document.slug === "" ? located.slug : `${located.builder.document.slug}/${located.slug}`;
   for (const [id, located] of conversion.options) mapping[id] = `${located.datasheet.builder.document.slug}/${located.datasheet.slug}#${located.option}`;
   for (const [id, located] of conversion.choiceOptions) mapping[id] = `${located.builder.document.slug}/${located.slug}`;
   writeFileSync(path.replace(/\.md$/, "-id-mapping.json"), `${JSON.stringify(mapping, null, 3)}\n`);
   return { unexplainedCounts, unexplainedNames: names.unexplained, unaccountedWargear };
}

export const PASS_THROUGH_IDS = [COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID];
