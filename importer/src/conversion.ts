import { OutputBuilder, referenceFrom } from "./builder.ts";
import { viewOf, type EntryView } from "./entries.ts";
import { GameSystemConversion, GameSystemIndex } from "./gameSystem.ts";
import type { BattlefieldRole, CountTarget } from "./model.ts";
import { ABILITY_TEXTS, describeSource } from "./corrections.ts";
import { abilityFromProfile, abilityFromRule, profileTexts, UNIT_PROFILE, TRANSPORT_PROFILE, WEAPON_PROFILE, weaponFromProfile } from "./profiles.ts";
import type { Registry, SourceDocument } from "./registry.ts";
import type { Report } from "./report.ts";
import { SlugAllocator } from "./slug.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

export const COMMANDER_ENTRY_ID = "7347-5716-355f-9165";
export const WARMASTER_TRAITS_GROUP_ID = "acd4-8bbf-d48d-1a62";
export const OPTIONS_GROUP_NAME = "Upgrades";

export interface Located {
   readonly builder: OutputBuilder;
   readonly slug: string;
}

export interface LocatedOption {
   readonly datasheet: Located;
   readonly option: string;
}

/** What the conversion made of each wargear entry in one datasheet's source tree, for the fidelity report. */
export interface WargearFates {
   options: number;
   fixedWargear: number;
   carriedUntilDropped: number;
   dropped: number;
}

/** The slugs of one datasheet's option groups and options, keyed by every BattleScribe id that names them. */
export class OptionSlugs {
   readonly byId = new Map<string, string>();
   /** The wargear entries (every entry but groups) below the unit in the source. */
   sourceEntries = 0;
   readonly fates: WargearFates = { options: 0, fixedWargear: 0, carriedUntilDropped: 0, dropped: 0 };
   readonly allIds = new Set<string>();
   /** Categories some entry below the unit adds, so the unit only has them when that entry is taken. */
   readonly optionalCategories = new Set<string>();
   /** The slugs that name option groups rather than options. */
   readonly groups = new Set<string>();
   readonly allocator = new SlugAllocator();
   readonly optionsGroup: string;

   constructor() {
      this.optionsGroup = this.allocator.allocate(OPTIONS_GROUP_NAME);
   }
}

export class Conversion {
   readonly gameSystemIndex: GameSystemIndex;
   readonly gameSystem: GameSystemConversion;
   readonly builders = new Map<SourceDocument, OutputBuilder>();
   readonly datasheets = new Map<string, Located>();
   readonly options = new Map<string, LocatedOption>();
   readonly optionSlugs = new Map<string, OptionSlugs>();
   readonly choiceOptions = new Map<string, Located>();
   /** Groups inside a detachment choice, by every id naming them, with the ids of the options they hold. */
   readonly choiceGroups = new Map<string, string[]>();
   /** The root entries read as detachment choices rather than units. */
   readonly choiceRoots = new Set<Element>();
   readonly profiles = new Map<string, Located>();
   /** The roles faction links give each library unit, by the unit's id. */
   readonly linkRoles = new Map<string, BattlefieldRole[]>();

   readonly registry: Registry;
   readonly report: Report;

   constructor(registry: Registry, report: Report) {
      this.registry = registry;
      this.report = report;
      this.gameSystemIndex = new GameSystemIndex(registry);
      this.gameSystem = new GameSystemConversion(registry, this.gameSystemIndex, report);
      this.builders.set(registry.gameSystem, this.gameSystem.builder);
      this.gameSystem.convertAbilities();
      const reserved = [...this.gameSystem.builder.abilities.keys()];
      for (const document of registry.catalogues) this.builders.set(document, new OutputBuilder(document, reserved));
      for (const document of registry.documents) this.indexProfiles(document);
   }

   builderOf(element: Element): OutputBuilder {
      return this.builders.get(this.registry.documentContaining(element))!;
   }

   /** Weapons and abilities are converted wherever they are defined, so unreferenced ones still survive. */
   private indexProfiles(document: SourceDocument): void {
      const builder = this.builders.get(document)!;
      const gameSystem = this.gameSystem.builder;
      const visit = (element: Element) => {
         if (element.tag === "profile") {
            const typeName = attribute(element, "typeName");
            if (typeName === WEAPON_PROFILE) {
               const weapon = weaponFromProfile(element, this.report);
               if (weapon !== undefined) this.profiles.set(attribute(element, "id"), { builder, slug: builder.addWeapon(weapon) });
            } else if (typeName !== UNIT_PROFILE && typeName !== TRANSPORT_PROFILE && !document.isGameSystem) {
               const textless = profileTexts(element).length === 0 ? this.textlessAbility(builder, element) : undefined;
               const ability = textless === undefined ? abilityFromProfile(element, this.report) : undefined;
               if (textless !== undefined) this.profiles.set(attribute(element, "id"), textless);
               if (ability !== undefined) this.profiles.set(attribute(element, "id"), this.placeAbility(builder, ability));
            } else if (document.isGameSystem && typeName !== UNIT_PROFILE && typeName !== TRANSPORT_PROFILE) {
               const ability = abilityFromProfile(element, this.report);
               const slug = ability === undefined ? undefined : gameSystem.findAbility(ability);
               if (slug !== undefined) this.profiles.set(attribute(element, "id"), { builder: gameSystem, slug });
            }
         } else if (element.tag === "rule") {
            this.profiles.set(attribute(element, "id"), this.placeAbility(builder, abilityFromRule(element)));
         }
         for (const child of element.children) visit(child);
      };
      visit(document.root);
   }

   /** An empty ability profile: its printed text from the correction table, or the game-system ability it names, as Ignore Damage (5+). */
   private textlessAbility(builder: OutputBuilder, profile: Element): Located | undefined {
      const name = attribute(profile, "name").trim();
      const corrected = ABILITY_TEXTS.find((entry) => entry.profileId === attribute(profile, "id"));
      if (corrected !== undefined) {
         this.report.recordCorrection(profile, `text added (${describeSource(corrected.source)})`);
         return this.placeAbility(builder, { name, text: corrected.text });
      }
      const slug = this.gameSystem.builder.abilityNamed(name);
      if (slug !== undefined) this.report.recordCorrection(profile, `empty profile read as the game-system ability ${name}`);
      return slug === undefined ? undefined : { builder: this.gameSystem.builder, slug };
   }

   private placeAbility(builder: OutputBuilder, ability: { name: string; text: string }): Located {
      const shared = this.gameSystem.builder.findAbility(ability);
      if (shared !== undefined) return { builder: this.gameSystem.builder, slug: shared };
      return { builder, slug: builder.addAbility(ability) };
   }

   reference(from: OutputBuilder, located: Located): string {
      return referenceFrom(from, located.builder, located.slug);
   }

   view(element: Element): EntryView | undefined {
      const view = viewOf(this.registry, element);
      if (view === undefined) this.report.failUnhandled(element, `link to missing id ${element.attributes.targetId}`);
      return view;
   }

   /** Allocates option slugs for one datasheet's tree, so conditions anywhere can name its options. */
   allocateOptions(datasheetKey: string, datasheet: Located, view: EntryView): OptionSlugs {
      const slugs = new OptionSlugs();
      const targetUses = new Map<string, number>();
      const walk = (current: EntryView) => {
         for (const id of current.ids) slugs.allIds.add(id);
         for (const child of [...current.childEntries, ...current.childGroups]) {
            if (child.tag === "entryLink" && [COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID].includes(attribute(child, "targetId"))) continue;
            const childView = viewOf(this.registry, child);
            if (childView === undefined) continue;
            for (const link of childView.categoryLinks) slugs.optionalCategories.add(attribute(link, "targetId"));
            const slug = slugs.allocator.allocate(childView.name);
            slugs.byId.set(childView.ids[0], slug);
            if (childView.kind === "group") slugs.groups.add(slug);
            const target = childView.ids[childView.ids.length - 1];
            targetUses.set(target, (targetUses.get(target) ?? 0) + 1);
            if (!slugs.byId.has(target)) slugs.byId.set(target, slug);
            walk(childView);
         }
      };
      walk(view);
      slugs.sourceEntries = this.wargearEntriesUnder(view);
      for (const [target, uses] of targetUses) if (uses > 1 && !view.ids.includes(target)) slugs.byId.delete(target);
      for (const [id, option] of slugs.byId) if (!this.options.has(id)) this.options.set(id, { datasheet, option });
      this.optionSlugs.set(datasheetKey, slugs);
      return slugs;
   }

   /** The wargear entries in a view's tree, the view itself included unless it is a group. */
   wargearEntryCount(view: EntryView): number {
      const own = view.kind === "group" ? 0 : 1;
      return own + this.wargearEntriesUnder(view);
   }

   /** The wargear entries below a view, leaving out the Commander and Warmaster links every unit passes through. */
   wargearEntriesUnder(view: EntryView): number {
      let count = 0;
      for (const child of [...view.childEntries, ...view.childGroups]) {
         if (child.tag === "entryLink" && [COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID].includes(attribute(child, "targetId"))) continue;
         const childView = viewOf(this.registry, child);
         if (childView !== undefined) count += this.wargearEntryCount(childView);
      }
      return count;
   }

   /** The count targets for a detachment choice's group, which counts as any of its options. */
   choiceGroupTargets(from: OutputBuilder, childId: string): CountTarget[] | undefined {
      return this.choiceGroups.get(childId)?.map((optionId) => ({ kind: "DetachmentChoice", option: this.reference(from, this.choiceOptions.get(optionId)!) }));
   }

   /** The universal option an id names, directly or through a link inside one unit, which narrows the count to that unit. */
   private universalOptionTarget(from: OutputBuilder, childId: string): CountTarget | undefined {
      const direct = this.gameSystem.universalOptionIds.get(childId);
      if (direct !== undefined) return { kind: "UniversalOption", option: direct };
      const link = this.registry.lookup(childId);
      const option = link?.tag === "entryLink" ? this.gameSystem.universalOptionIds.get(attribute(link, "targetId")) : undefined;
      if (option === undefined) return undefined;
      let holder = link!.parent;
      while (holder !== undefined && !(holder.tag === "selectionEntry" || holder.tag === "entryLink")) holder = holder.parent;
      const unit = holder === undefined ? undefined : this.datasheets.get(attribute(holder, "id"));
      return unit === undefined ? undefined : { kind: "UniversalOption", option, datasheet: this.reference(from, unit) };
   }

   /** A count target for an id that isn't local to the datasheet being converted. */
   globalCountTarget(from: OutputBuilder, childId: string): CountTarget | undefined {
      const fromIndex = this.gameSystemIndex.countTarget(childId) ?? this.universalOptionTarget(from, childId);
      if (fromIndex !== undefined) return fromIndex;
      const choice = this.choiceOptions.get(childId);
      if (choice !== undefined) return { kind: "DetachmentChoice", option: this.reference(from, choice) };
      const datasheet = this.datasheets.get(childId);
      if (datasheet !== undefined) return { kind: "Datasheet", datasheet: this.reference(from, datasheet) };
      const option = this.options.get(childId);
      if (option !== undefined) return { kind: "Option", option: option.option, datasheet: this.reference(from, option.datasheet) };
      return undefined;
   }

   /** True when the id names a unit entry, or a link to one; conditions asking "is this that unit" fold on it. */
   isUnitEntry(id: string): boolean {
      const element = this.registry.lookup(id);
      if (element === undefined) return false;
      const target = element.tag === "entryLink" ? this.registry.lookup(attribute(element, "targetId")) : element;
      return target?.tag === "selectionEntry" && (target.attributes.type === "unit" || this.datasheets.has(id));
   }

   unitCategory(view: EntryView, slugs: OptionSlugs | undefined): (categoryId: string) => boolean | undefined {
      const own = new Set(view.categoryLinks.map((link) => attribute(link, "targetId")));
      return (categoryId) => {
         if (own.has(categoryId)) return true;
         if (slugs?.optionalCategories.has(categoryId)) return undefined;
         return this.registry.category(categoryId)?.kind === "Keyword" ? false : undefined;
      };
   }

   thisUnit(ids: readonly string[]): (id: string) => boolean | undefined {
      return (id) => (ids.includes(id) ? true : this.isUnitEntry(id) ? false : undefined);
   }

   factionSlug(catalogueId: string): string | undefined {
      return this.registry.catalogues.find((document) => document.battleScribeId === catalogueId && !document.isLibrary)?.slug;
   }

   rootEntries(document: SourceDocument): Element[] {
      return [...childrenOf(document.root, "selectionEntries", "selectionEntry"), ...childrenOf(document.root, "entryLinks", "entryLink")];
   }
}
