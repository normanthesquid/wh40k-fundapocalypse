import type { OutputBuilder } from "./builder.ts";
import type { ConditionContext } from "./conditions.ts";
import type { Conversion, Located, OptionSlugs } from "./conversion.ts";
import { availabilityOf, DatasheetConverter } from "./datasheet.ts";
import { constraintsByScope, constraintValue, POWER_LEVEL_TYPE_ID, powerLevel, type EntryView } from "./entries.ts";
import type { Catalogue, CountTarget, Datasheet, DatasheetLink, DetachmentAbility, DetachmentChoice } from "./model.ts";
import { flatModifiers, flatModifiersOf } from "./modifiers.ts";
import type { SourceDocument } from "./registry.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

interface PlannedDatasheet {
   readonly view: EntryView;
   readonly located: Located;
   readonly slugs: OptionSlugs;
}

interface PlannedLink {
   readonly view: EntryView;
   readonly slug: string;
}

const LINK_ONLY_CHILDREN = new Set(["categoryLinks", "infoLinks", "constraints", "costs", "modifiers"]);

export class CatalogueConversion {
   private readonly builder: OutputBuilder;
   private readonly datasheets: PlannedDatasheet[] = [];
   private readonly links: PlannedLink[] = [];
   private readonly choices = new Map<string, { view: EntryView; options: [string, EntryView][] }>();
   /** Ids that mean one of this catalogue's own units, including the library entries its links field. */
   private readonly localUnits = new Map<string, string>();

   private readonly conversion: Conversion;
   private readonly document: SourceDocument;

   constructor(conversion: Conversion, document: SourceDocument) {
      this.conversion = conversion;
      this.document = document;
      this.builder = conversion.builders.get(document)!;
   }

   private registry() {
      return this.conversion.registry;
   }

   private isListConfiguration(view: EntryView): boolean {
      return view.categoryLinks.some((link) => link.attributes.primary === "true" && this.registry().category(attribute(link, "targetId"))?.kind === "ListConfiguration");
   }

   private hasPrimaryRole(view: EntryView): boolean {
      return view.categoryLinks.some((link) => link.attributes.primary === "true" && this.registry().category(attribute(link, "targetId"))?.kind === "Role");
   }

   /** Phase one: give every datasheet, link, option and choice its slug, before any condition is converted. */
   allocate(): void {
      const roots = this.conversion.rootEntries(this.document);
      const shared = this.document.isLibrary ? childrenOf(this.document.root, "sharedSelectionEntries", "selectionEntry") : [];
      for (const element of [...roots, ...shared]) {
         const view = this.conversion.view(element);
         if (view === undefined) continue;
         if (this.isListConfiguration(view)) this.planChoice(view);
         else if (view.kind === "upgrade" && view.categoryLinks.length === 0 && !shared.includes(element)) {
            this.conversion.report.recordCorrection(element, "root upgrade entry with no categories read as a detachment choice");
            this.planChoice(view);
         }
         else if (view.kind !== "unit" && !this.hasPrimaryRole(view)) {
            if (shared.includes(element)) continue;
            this.conversion.report.failUnhandled(element, `root entry of type ${view.kind}`);
         } else this.planUnit(view);
      }
   }

   private planChoice(view: EntryView): void {
      const slug = this.builder.slugFor(view.ids[0], view.name);
      const options: [string, EntryView][] = [];
      const entries = (parent: EntryView): EntryView[] =>
         [...parent.childEntries, ...parent.childGroups].flatMap((child) => {
            const childView = this.conversion.view(child);
            if (childView === undefined) return [];
            if (childView.kind !== "group") return [childView];
            const inGroup = entries(childView);
            for (const id of childView.ids) this.conversion.choiceGroups.set(id, inGroup.map((option) => option.ids[0]));
            return inGroup;
         });
      for (const childView of entries(view)) {
         const optionSlug = this.builder.slugFor(childView.ids[0], childView.name);
         for (const id of childView.ids) this.conversion.choiceOptions.set(id, { builder: this.builder, slug: optionSlug });
         options.push([optionSlug, childView]);
      }
      this.choices.set(slug, { view, options });
   }

   private planUnit(view: EntryView): void {
      const slug = this.builder.slugFor(view.ids[0], view.name);
      const located: Located = { builder: this.builder, slug };
      const targetDocument = this.registry().documentContaining(view.target);
      const isLibraryLink = view.element.tag === "entryLink" && targetDocument !== this.document;
      for (const id of view.ids) this.localUnits.set(id, slug);
      if (isLibraryLink) this.recordLinkRole(view);
      this.conversion.datasheets.set(view.ids[0], located);
      if (isLibraryLink && this.isPlainLink(view.element)) {
         this.links.push({ view, slug });
         return;
      }
      if (!isLibraryLink) for (const id of view.ids) this.conversion.datasheets.set(id, located);
      this.datasheets.push({ view, located, slugs: this.conversion.allocateOptions(`${this.document.slug}/${slug}`, located, view) });
   }

   /** The role a faction's link gives a library unit, which a library unit without its own role takes from its links. */
   private recordLinkRole(view: EntryView): void {
      const primary = view.element.children.flatMap((child) => (child.tag === "categoryLinks" ? child.children : [])).find((link) => link.attributes.primary === "true");
      const category = primary === undefined ? undefined : this.registry().category(attribute(primary, "targetId"));
      if (category?.kind !== "Role") return;
      const targetId = view.ids[view.ids.length - 1];
      this.conversion.linkRoles.set(targetId, [...(this.conversion.linkRoles.get(targetId) ?? []), category.role]);
   }

   private isPlainLink(link: Element): boolean {
      if (!link.children.every((child) => LINK_ONLY_CHILDREN.has(child.tag))) return false;
      return childrenOf(link, "modifiers", "modifier").every((modifier) => {
         const field = attribute(modifier, "field");
         const type = attribute(modifier, "type");
         const conditional = modifier.children.length > 0;
         return field === "hidden" || (field === POWER_LEVEL_TYPE_ID && type === "set" && !conditional) || (field === "category" && type === "add");
      });
   }

   /** Phase two: convert, once every catalogue has allocated its slugs. */
   convert(): Catalogue {
      const catalogue: Catalogue = {
         $schema: "../../schema/catalogue.schema.json",
         id: this.document.slug,
         name: this.document.name,
         kind: this.document.isLibrary ? "Library" : "Faction",
      };
      const datasheets: Record<string, Datasheet> = {};
      for (const planned of this.datasheets) {
         const converted = new DatasheetConverter(this.conversion, this.builder, planned.view, planned.slugs, (id) => this.localTarget(id)).convert();
         if (converted !== undefined) datasheets[planned.located.slug] = converted;
      }
      const links: Record<string, DatasheetLink> = {};
      for (const planned of this.links) {
         const converted = this.convertLink(planned.view);
         if (converted !== undefined) links[planned.slug] = converted;
      }
      const choices = this.convertChoices();
      const detachmentAbilities = this.convertDetachmentAbilities();
      if (Object.keys(datasheets).length > 0) catalogue.datasheets = datasheets;
      if (Object.keys(links).length > 0) catalogue.datasheetLinks = links;
      if (Object.keys(choices).length > 0) catalogue.detachmentChoices = choices;
      if (Object.keys(detachmentAbilities).length > 0) catalogue.detachmentAbilities = detachmentAbilities;
      if (this.builder.weapons.size > 0) catalogue.weapons = Object.fromEntries(this.builder.weapons);
      if (this.builder.abilities.size > 0) catalogue.abilities = Object.fromEntries(this.builder.abilities);
      if (this.builder.imports.size > 0) catalogue.imports = [...this.builder.imports].sort();
      return catalogue;
   }

   private localTarget(id: string): CountTarget | undefined {
      const slug = this.localUnits.get(id);
      return slug === undefined ? undefined : { kind: "Datasheet", datasheet: slug };
   }

   private convertLink(view: EntryView): DatasheetLink | undefined {
      const targetId = view.ids[view.ids.length - 1];
      const target = this.conversion.datasheets.get(targetId);
      const targetSlugs = target === undefined ? undefined : this.conversion.optionSlugs.get(`${target.builder.document.slug}/${target.slug}`);
      if (target === undefined || targetSlugs === undefined) {
         this.conversion.report.failUnhandled(view.element, "link to a library entry that is not a datasheet");
         return undefined;
      }
      const context: ConditionContext = {
         choiceGroupTargets: (childId) => this.conversion.choiceGroupTargets(this.builder, childId),
         countTarget: (childId) => {
            const option = targetSlugs.byId.get(childId);
            if (option !== undefined) return { kind: "Option", option };
            return this.localTarget(childId) ?? this.conversion.globalCountTarget(this.builder, childId);
         },
         isUnitScope: (scopeId) => scopeId === view.ids[0] || targetSlugs.allIds.has(scopeId),
         isThisUnit: this.conversion.thisUnit(view.ids),
         unitHasCategory: () => undefined,
         detachmentSlug: (forceId) => this.conversion.gameSystemIndex.detachmentByForceId.get(forceId),
         factionSlug: (catalogueId) => this.conversion.factionSlug(catalogueId),
         unhandled: (element, message) => this.conversion.report.failUnhandled(element, message),
      };
      const link: DatasheetLink = { datasheet: this.conversion.reference(this.builder, target) };
      const own = view.element;
      for (const categoryLink of childrenOf(own, "categoryLinks", "categoryLink")) {
         const category = this.registry().category(attribute(categoryLink, "targetId"));
         if (category?.kind === "FactionKeyword") (link.addsFactionKeywords ??= []).push(category.keyword);
         else if (category?.kind === "Keyword") (link.addsKeywords ??= []).push(category.keyword);
         else if (category?.kind === "Role" && categoryLink.attributes.primary === "true") link.battlefieldRole = category.role;
         else this.conversion.report.failUnhandled(categoryLink, "link category that is not a keyword");
      }
      for (const infoLink of childrenOf(own, "infoLinks", "infoLink")) {
         const located = this.conversion.profiles.get(attribute(infoLink, "targetId"));
         if (located === undefined || infoLink.children.length > 0) this.conversion.report.failUnhandled(infoLink, "link info link that is not a plain ability");
         else (link.addsAbilities ??= []).push(this.conversion.reference(this.builder, located));
      }
      const linkCost = childrenOf(own, "costs", "cost").find((cost) => attribute(cost, "typeId") === POWER_LEVEL_TYPE_ID);
      const modifiers = flatModifiersOf(own, context);
      const costSet = modifiers.find((modifier) => modifier.field === POWER_LEVEL_TYPE_ID);
      const cost = costSet !== undefined ? Number(costSet.value) : linkCost !== undefined ? powerLevel(view) : undefined;
      if (cost !== undefined) link.cost = cost;
      for (const added of modifiers.filter((modifier) => modifier.field === "category")) {
         const category = this.registry().category(added.value);
         if (added.condition === undefined) continue;
         if (added.condition === null || (category?.kind !== "Keyword" && category?.kind !== "FactionKeyword")) {
            this.conversion.report.failUnhandled(added.element, "unconditional or non-keyword category added by a link");
            continue;
         }
         const entry = category.kind === "Keyword" ? { when: added.condition, addsKeywords: [category.keyword] } : { when: added.condition, addsFactionKeywords: [category.keyword] };
         (link.conditionalKeywords ??= []).push(entry);
      }
      const availability = availabilityOf(own.attributes.hidden === "true", modifiers);
      if (availability === "Never") {
         this.conversion.report.recordDropped(own, "link hidden with no condition that shows it");
         return undefined;
      }
      if (availability !== undefined && availability !== "Always") link.availableWhen = availability;
      const constraints = constraintsByScope({ ...view, constraints: childrenOf(own, "constraints", "constraint") });
      const perArmy = constraintValue(constraints.get("roster max"));
      const perDetachment = constraintValue(constraints.get("force max"));
      if (perDetachment !== undefined) link.maximumPerDetachment = perDetachment;
      if (perArmy !== undefined) link.maximumPerArmy = perArmy;
      for (const key of constraints.keys()) if (!["roster max", "force max"].includes(key)) this.conversion.report.failUnhandled(constraints.get(key)!, `link constraint ${key}`);
      return link;
   }

   private convertChoices(): Record<string, DetachmentChoice> {
      const choices: Record<string, DetachmentChoice> = {};
      for (const [slug, { view, options }] of this.choices) {
         const choice: DetachmentChoice = { name: view.name, options: {} };
         const constraints = constraintsByScope(view);
         const minimum = constraintValue(constraints.get("force min") ?? constraints.get("parent min"));
         const maximum = constraintValue(constraints.get("force max") ?? constraints.get("parent max"));
         if (minimum !== undefined) choice.minimum = minimum;
         if (maximum !== undefined) choice.maximum = maximum;
         for (const [optionSlug, optionView] of options) {
            const option: DetachmentChoice["options"][string] = { name: optionView.name };
            for (const link of optionView.categoryLinks) {
               const category = this.registry().category(attribute(link, "targetId"));
               if (category?.kind === "FactionKeyword") (option.addsFactionKeywords ??= []).push(category.keyword);
               else if (category?.kind === "Keyword") (option.addsKeywords ??= []).push(category.keyword);
               else this.conversion.report.failUnhandled(link, "detachment choice category that is not a keyword");
            }
            const extra = [...optionView.profiles, ...optionView.infoLinks, ...optionView.childEntries, ...optionView.childGroups, ...optionView.modifiers];
            for (const element of extra) this.conversion.report.failUnhandled(element, `detachment choice option with a ${element.tag}`);
            choice.options[optionSlug] = option;
         }
         const ownExtras = [...view.modifiers, ...view.profiles, ...view.infoLinks];
         for (const element of ownExtras) this.conversion.report.failUnhandled(element, `detachment choice with a ${element.tag}`);
         choices[slug] = choice;
      }
      return choices;
   }

   private convertDetachmentAbilities(): Record<string, DetachmentAbility> {
      const abilities: Record<string, DetachmentAbility> = {};
      if (this.document.isLibrary) return abilities;
      for (const rule of childrenOf(this.document.root, "rules", "rule")) {
         const located = this.conversion.profiles.get(attribute(rule, "id"))!;
         const context: ConditionContext = {
            countTarget: (childId) => this.localTarget(childId) ?? this.conversion.globalCountTarget(this.builder, childId),
            choiceGroupTargets: (childId) => this.conversion.choiceGroupTargets(this.builder, childId),
            isUnitScope: () => false,
            isThisUnit: this.conversion.thisUnit([]),
            unitHasCategory: () => undefined,
            detachmentSlug: (forceId) => this.conversion.gameSystemIndex.detachmentByForceId.get(forceId),
            factionSlug: (catalogueId) => this.conversion.factionSlug(catalogueId),
            unhandled: (element, message) => this.conversion.report.failUnhandled(element, message),
         };
         const availability = availabilityOf(rule.attributes.hidden === "true", flatModifiers(childrenOf(rule, "modifiers", "modifier"), [], context));
         if (availability === "Never" || availability === undefined) {
            if (availability === "Never") this.conversion.report.recordDropped(rule, "rule hidden with no condition that shows it");
            continue;
         }
         const entry: DetachmentAbility = { ability: this.conversion.reference(this.builder, located) };
         if (availability !== "Always") entry.availableWhen = availability;
         abilities[this.builder.slugFor(`${attribute(rule, "id")}#detachment`, attribute(rule, "name"))] = entry;
      }
      return abilities;
   }
}
