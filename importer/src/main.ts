import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { CatalogueConversion } from "./catalogue.ts";
import { Conversion } from "./conversion.ts";
import { countAfter, countBefore, writeReport } from "./fidelity.ts";
import { applyOutputCorrections } from "./outputCorrections.ts";
import { Registry } from "./registry.ts";
import { Report } from "./report.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: flags } = parseArgs({
   options: {
      source: { type: "string", default: repositoryRoot },
      output: { type: "string", default: join(repositoryRoot, "data") },
      report: { type: "string", default: join(repositoryRoot, "importer", "fidelity-report.md") },
      release: { type: "string", default: "2.0.0" },
   },
});

function writeJson(path: string, value: unknown): void {
   mkdirSync(dirname(path), { recursive: true });
   writeFileSync(path, `${JSON.stringify(value, null, 3)}\n`);
}

const registry = new Registry(flags.source);
const report = new Report();
const conversion = new Conversion(registry, report);
const catalogues = registry.catalogues.map((document) => new CatalogueConversion(conversion, document));
for (const catalogue of catalogues) catalogue.allocate();
const gameSystem = conversion.gameSystem.convert(flags.release);
const converted = catalogues.map((catalogue) => catalogue.convert());
applyOutputCorrections(converted, report);

rmSync(flags.output, { recursive: true, force: true });
writeJson(join(flags.output, "game-system.json"), gameSystem);
for (const catalogue of converted) writeJson(join(flags.output, "catalogues", `${catalogue.id}.json`), catalogue);
const gameSystemAbilities = new Set([...conversion.gameSystem.builder.abilities.values()].map((ability) => ability.name));
for (const document of registry.catalogues) report.before.set(document.slug, countBefore(document, conversion, gameSystemAbilities));
for (const catalogue of converted) report.after.set(catalogue.id, countAfter(catalogue, gameSystemAbilities));
const fidelity = writeReport(flags.report, report, conversion, converted);

console.log(`${converted.length} catalogues written to ${flags.output}`);
console.log(`${report.corrections.length} corrections, ${report.dropped.length} dropped, ${report.renames.length} renamed, ${report.unhandled.length} unhandled`);
console.log(`fidelity: ${fidelity.unexplainedCounts} unit counts differ, ${fidelity.unexplainedNames} unexplained names, ${fidelity.unaccountedWargear} unaccounted wargear entries`);
const fidelityProblems = fidelity.unexplainedCounts + fidelity.unexplainedNames + fidelity.unaccountedWargear;
if (fidelityProblems > 0) process.exitCode = 1;
if (report.unhandled.length > 0) {
   const byMessage = new Map<string, number>();
   for (const finding of report.unhandled) {
      const pattern = finding.message.replace(/[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/g, "<id>");
      byMessage.set(pattern, (byMessage.get(pattern) ?? 0) + 1);
   }
   for (const [message, count] of [...byMessage].sort((left, right) => right[1] - left[1])) console.log(`${String(count).padStart(5)}  ${message}`);
   process.exitCode = 1;
}
