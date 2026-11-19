/** Corrections from the official datasheets that apply to the converted catalogues, each recorded in the report. */

import {
   ABILITY_TEXT_CORRECTIONS,
   describeSource,
   MISSING_KEYWORDS,
   MISSING_WEAPONS,
   NAME_CORRECTIONS,
   OPTION_ABILITY_CORRECTIONS,
   OPTION_COST_CORRECTIONS,
   type RenamedKind,
   type Source,
} from "./corrections.ts";
import type { Ability, Catalogue, Datasheet, Option, Weapon } from "./model.ts";
import type { Report } from "./report.ts";
import { slugify } from "./slug.ts";

type Named = Datasheet | Weapon | Ability;

export function applyOutputCorrections(catalogues: readonly Catalogue[], report: Report): void {
   const corrections = new OutputCorrections(catalogues, report);
   corrections.addKeywords();
   corrections.rename();
   corrections.correctAbilityTexts();
   corrections.correctOptionCosts();
   corrections.addWeapons();
   corrections.correctOptionAbilities();
}

class OutputCorrections {
   private readonly catalogues: readonly Catalogue[];
   private readonly report: Report;
   private readonly byId: Map<string, Catalogue>;

   constructor(catalogues: readonly Catalogue[], report: Report) {
      this.catalogues = catalogues;
      this.report = report;
      this.byId = new Map(catalogues.map((catalogue) => [catalogue.id, catalogue]));
   }

   addKeywords(): void {
      for (const missing of MISSING_KEYWORDS) {
         const datasheet = this.datasheet(missing.catalogue, missing.datasheet);
         const keywords = missing.kind === "Keyword" ? datasheet.keywords : (datasheet.factionKeywords ??= []);
         keywords.push(missing.keyword);
         this.record(missing.catalogue, datasheet.name, `keyword ${missing.keyword} added`, missing.source);
      }
   }

   rename(): void {
      for (const correction of NAME_CORRECTIONS) {
         const message = `renamed from "${correction.from}" to "${correction.to}"`;
         if (correction.kind === "Keyword") {
            const replaced = this.replaceEverywhere(new Map([[correction.from, correction.to]]));
            if (replaced === 0) throw new Error(`keyword ${correction.from} not found`);
            this.record(correction.catalogue, correction.from, message, correction.source);
            continue;
         }
         const entries = this.entriesOf(this.catalogue(correction.catalogue), correction.kind);
         const matches = Object.entries(entries).filter(([, entry]) => entry.name === correction.from);
         if (matches.length !== 1) throw new Error(`${matches.length} ${correction.kind} entries named ${correction.from} in ${correction.catalogue}`);
         const [slug, entry] = matches[0];
         entry.name = correction.to;
         if (correction.kind === "Weapon") this.renameOptions(correction.from, correction.to);
         this.moveSlug(correction.catalogue, entries, slug, slugify(correction.to));
         this.record(correction.catalogue, correction.from, message, correction.source);
      }
   }

   correctAbilityTexts(): void {
      for (const correction of ABILITY_TEXT_CORRECTIONS) {
         const ability = this.catalogue(correction.catalogue).abilities?.[correction.ability];
         if (ability === undefined) throw new Error(`no ability ${correction.ability} in ${correction.catalogue}`);
         ability.text = correction.text;
         this.record(correction.catalogue, ability.name, "text corrected", correction.source);
      }
   }

   correctOptionCosts(): void {
      for (const correction of OPTION_COST_CORRECTIONS) {
         const datasheet = this.datasheet(correction.catalogue, correction.datasheet);
         const option = datasheet.wargear?.flatMap((group) => group.options).find((candidate) => candidate.id === correction.option);
         if (option === undefined) throw new Error(`no option ${correction.option} on ${correction.datasheet}`);
         option.cost = correction.cost;
         this.record(correction.catalogue, `${datasheet.name} > ${option.name}`, `cost set to ${correction.cost}`, correction.source);
      }
   }

   addWeapons(): void {
      for (const missing of MISSING_WEAPONS) {
         const weapons = (this.catalogue(missing.catalogue).weapons ??= {});
         const slug = freeSlug(weapons, missing.weapon);
         weapons[slug] = missing.weapon;
         for (const target of missing.datasheets) {
            const datasheet = this.datasheet(target.catalogue, target.datasheet);
            const reference = target.catalogue === missing.catalogue ? slug : `${missing.catalogue}/${slug}`;
            (datasheet.weapons ??= []).push(reference);
            this.record(target.catalogue, datasheet.name, `weapon ${missing.weapon.name} added`, missing.source);
         }
      }
   }

   correctOptionAbilities(): void {
      for (const correction of OPTION_ABILITY_CORRECTIONS) {
         let corrected = 0;
         for (const option of this.options()) {
            const index = option.name === correction.option ? (option.addsAbilities ?? []).indexOf(correction.from) : -1;
            if (index < 0) continue;
            option.addsAbilities![index] = correction.to;
            corrected += 1;
         }
         if (corrected === 0) throw new Error(`no ${correction.option} option adds ${correction.from}`);
         this.record("*", correction.option, `${corrected} options add ${correction.to} instead of ${correction.from}`, correction.source);
      }
   }

   private catalogue(id: string): Catalogue {
      const catalogue = this.byId.get(id);
      if (catalogue === undefined) throw new Error(`no catalogue ${id}`);
      return catalogue;
   }

   private datasheet(catalogue: string, slug: string): Datasheet {
      const datasheet = this.catalogue(catalogue).datasheets?.[slug];
      if (datasheet === undefined) throw new Error(`no datasheet ${slug} in ${catalogue}`);
      return datasheet;
   }

   private entriesOf(catalogue: Catalogue, kind: Exclude<RenamedKind, "Keyword">): Record<string, Named> {
      if (kind === "Datasheet") return catalogue.datasheets ?? {};
      if (kind === "Weapon") return catalogue.weapons ?? {};
      return catalogue.abilities ?? {};
   }

   /** Options named after a renamed weapon take its new name, and an id made from the old name, with what refers to it on the datasheet, takes the new one. */
   private renameOptions(from: string, to: string): void {
      const idChange = new Map([[slugify(from), slugify(to)]]);
      for (const catalogue of this.catalogues) {
         for (const datasheet of Object.values(catalogue.datasheets ?? {})) {
            const options = (datasheet.wargear ?? []).flatMap((group) => group.options).filter((option) => option.name === from);
            for (const option of options) option.name = to;
            if (options.some((option) => option.id === slugify(from))) replaceStrings(datasheet, idChange);
         }
      }
   }

   private *options(): Generator<Option> {
      for (const catalogue of this.catalogues) for (const datasheet of Object.values(catalogue.datasheets ?? {})) for (const group of datasheet.wargear ?? []) yield* group.options;
   }

   /** Moves an entry to the slug of its new name, and every reference to it: bare within its catalogue, prefixed from others. */
   private moveSlug(catalogueId: string, entries: Record<string, Named>, slug: string, newSlug: string): void {
      if (slug === newSlug || newSlug in entries) return;
      entries[newSlug] = entries[slug];
      delete entries[slug];
      replaceStrings(this.catalogue(catalogueId), new Map([[slug, newSlug]]));
      this.replaceEverywhere(new Map([[`${catalogueId}/${slug}`, `${catalogueId}/${newSlug}`]]));
   }

   private replaceEverywhere(replacements: Map<string, string>): number {
      return this.catalogues.reduce((total, catalogue) => total + replaceStrings(catalogue, replacements), 0);
   }

   private record(catalogue: string, where: string, message: string, source: Source): void {
      this.report.recordOutputCorrection(catalogue, where, `${message} (${describeSource(source)})`);
   }
}

/** The weapon's slug in this catalogue: an identical weapon's, or its name's first free one. */
function freeSlug(weapons: Record<string, Weapon>, weapon: Weapon): string {
   const base = slugify(weapon.name);
   for (let suffix = 1; ; suffix += 1) {
      const slug = suffix === 1 ? base : `${base}-${suffix}`;
      const existing = weapons[slug];
      if (existing === undefined || JSON.stringify(existing) === JSON.stringify(weapon)) return slug;
   }
}

/** Replaces string values that equal a key of `replacements`, in place; returns how many it replaced. */
function replaceStrings(value: unknown, replacements: Map<string, string>): number {
   if (typeof value !== "object" || value === null) return 0;
   let replaced = 0;
   const container = value as Record<string, unknown>;
   for (const key of Object.keys(container)) {
      const item = container[key];
      const replacement = typeof item === "string" ? replacements.get(item) : undefined;
      if (replacement !== undefined) {
         container[key] = replacement;
         replaced += 1;
      } else replaced += replaceStrings(item, replacements);
   }
   return replaced;
}
