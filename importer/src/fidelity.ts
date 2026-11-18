import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID, type Conversion } from "./conversion.ts";
import type { Catalogue } from "./model.ts";
import { characteristicsOf, TRANSPORT_PROFILE, UNIT_PROFILE, WEAPON_PROFILE } from "./profiles.ts";
import type { SourceDocument } from "./registry.ts";
import { emptyCounts, type CatalogueCounts, type Finding, type Report } from "./report.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

function contentOf(element: Element): string {
   return JSON.stringify([attribute(element, "name").trim(), [...characteristicsOf(element)].map(([name, text]) => [name, text.trim()])]);
}

function walk(element: Element, visit: (element: Element) => void): void {
   visit(element);
   for (const child of element.children) walk(child, visit);
}

/** Counts in a source file, by content, so duplicate profiles count once as they do after conversion. */
export function countBefore(document: SourceDocument, gameSystemAbilities: Set<string>): CatalogueCounts {
   const counts = emptyCounts();
   const weapons = new Set<string>();
   const abilities = new Set<string>();
   walk(document.root, (element) => {
      if (element.tag === "profile") {
         const typeName = attribute(element, "typeName");
         if (typeName === WEAPON_PROFILE) weapons.add(contentOf(element));
         else if (typeName !== UNIT_PROFILE && typeName !== TRANSPORT_PROFILE) abilities.add(contentOf(element));
      }
      if (element.tag === "rule") abilities.add(attribute(element, "id"));
   });
   for (const content of gameSystemAbilities) abilities.delete(content);
   counts.weapons = weapons.size;
   counts.abilities = abilities.size;
   const roots = [...childrenOf(document.root, "selectionEntries", "selectionEntry"), ...childrenOf(document.root, "entryLinks", "entryLink")];
   const shared = document.isLibrary ? childrenOf(document.root, "sharedSelectionEntries", "selectionEntry") : [];
   for (const entry of [...roots, ...shared]) {
      const type = entry.attributes.type;
      if (type === "unit" || (entry.tag === "entryLink" && type === "selectionEntry")) counts.units += 1;
   }
   return counts;
}

export function countAfter(catalogue: Catalogue): CatalogueCounts {
   const datasheets = Object.values(catalogue.datasheets ?? {});
   return {
      units: datasheets.length + Object.keys(catalogue.datasheetLinks ?? {}).length,
      weapons: Object.keys(catalogue.weapons ?? {}).length,
      abilities: Object.keys(catalogue.abilities ?? {}).length,
      options: datasheets.reduce((total, datasheet) => total + (datasheet.wargear ?? []).reduce((sum, group) => sum + group.options.length, 0), 0),
   };
}

function findingRows(findings: Finding[]): string {
   if (findings.length === 0) return "None.\n";
   const rows = findings.map((finding) => `| ${finding.file} | ${finding.where.replace(/\|/g, "\\|")} | ${finding.message.replace(/\|/g, "\\|")} |`);
   return ["| File | Where | What |", "|---|---|---|", ...rows].join("\n") + "\n";
}

export function writeReport(path: string, report: Report, conversion: Conversion): void {
   const lines = ["# BattleScribe import fidelity report", "", "## Counts per catalogue", ""];
   lines.push("| Catalogue | Units before | after | Weapons before | after | Abilities before | after | Options after |", "|---|---|---|---|---|---|---|---|");
   for (const [slug, before] of report.before) {
      const after = report.after.get(slug) ?? emptyCounts();
      const mark = (left: number, right: number) => (left === right ? `${right}` : `**${right}**`);
      lines.push(`| ${slug} | ${before.units} | ${mark(before.units, after.units)} | ${before.weapons} | ${mark(before.weapons, after.weapons)} | ${before.abilities} | ${mark(before.abilities, after.abilities)} | ${after.options} |`);
   }
   lines.push("", "A bold count differs from the source; each difference is explained under the sections below.", "");
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
}

export const PASS_THROUGH_IDS = [COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID];
