import { OutputBuilder } from "./builder.ts";
import { allOf, not, type ConditionContext } from "./conditions.ts";
import { constraintsByScope, constraintValue, viewOf } from "./entries.ts";
import type { BattlefieldRole, CountScope, CountTarget, Detachment, DetachmentKind, GameSystem, KeywordLimit, LimitTerm, Option, SlotLimit } from "./model.ts";
import { flatModifiersOf, limitFrom, type RepeatTargets } from "./modifiers.ts";
import type { Registry } from "./registry.ts";
import type { Report } from "./report.ts";
import { slugify } from "./slug.ts";
import { abilityFromProfile, abilityFromRule } from "./profiles.ts";
import { attribute, childrenOf, isHidden, type Element } from "./xml.ts";

const DETACHMENT_SUFFIX = / Detachment$/;
const WARMASTER_TRAIT_PROFILE = "Warmaster Trait";

/** Game-system lookups every catalogue needs: detachments, Core detachments and categories. */
export class GameSystemIndex {
   readonly detachmentByForceId = new Map<string, string>();
   readonly coreDetachments = new Set<string>();

   private readonly registry: Registry;

   constructor(registry: Registry) {
      this.registry = registry;
      for (const force of registry.forceEntries()) {
         const slug = slugify(attribute(force, "name").replace(DETACHMENT_SUFFIX, ""));
         this.detachmentByForceId.set(attribute(force, "id"), slug);
         for (const child of childrenOf(force, "forceEntries", "forceEntry")) this.detachmentByForceId.set(attribute(child, "id"), slug);
      }
      for (const force of registry.forceEntries()) {
         for (const modifier of childrenOf(force, "modifiers", "modifier")) {
            if (attribute(modifier, "type") !== "increment") continue;
            for (const repeat of childrenOf(modifier, "repeats", "repeat")) {
               const counted = this.detachmentByForceId.get(attribute(repeat, "childId"));
               if (attribute(repeat, "field") === "forces" && counted !== undefined) this.coreDetachments.add(counted);
            }
         }
      }
   }

   kindOf(slug: string): DetachmentKind {
      return this.coreDetachments.has(slug) ? "Core" : "Special";
   }

   /** Counts of each Core detachment collapse into one count of the Core kind. */
   simplify(terms: LimitTerm[]): LimitTerm[] {
      const simplified: LimitTerm[] = [];
      const coreTerms = terms.filter((term) => term.per.kind === "Detachment" && this.coreDetachments.has(term.per.detachment));
      const coversCore = coreTerms.length === this.coreDetachments.size && new Set(coreTerms.map((term) => `${term.scope} ${term.amount}`)).size === 1;
      if (coversCore) simplified.push({ per: { kind: "DetachmentKind", detachmentKind: "Core" }, scope: coreTerms[0].scope, amount: coreTerms[0].amount });
      for (const term of terms) if (!coversCore || !coreTerms.includes(term)) simplified.push(term);
      return simplified;
   }

   countTarget(childId: string): CountTarget | undefined {
      const detachment = this.detachmentByForceId.get(childId);
      if (detachment !== undefined) return { kind: "Detachment", detachment };
      const category = this.registry.category(childId);
      if (category?.kind === "Role") return { kind: "Role", battlefieldRole: category.role };
      if (category?.kind === "Keyword" || category?.kind === "FactionKeyword") return { kind: "Keyword", keyword: category.keyword };
      return undefined;
   }
}

export class GameSystemConversion {
   readonly builder: OutputBuilder;
   private readonly detachments: Record<string, Detachment> = {};
   private readonly universalOptions: Record<string, Option> = {};
   /** Universal option slugs by the BattleScribe id of their entry. */
   readonly universalOptionIds = new Map<string, string>();
   private readonly armyKeywordLimits: Record<string, KeywordLimit> = {};
   readonly context: ConditionContext;

   private readonly registry: Registry;
   private readonly index: GameSystemIndex;
   private readonly report: Report;

   constructor(registry: Registry, index: GameSystemIndex, report: Report) {
      this.registry = registry;
      this.index = index;
      this.report = report;
      this.builder = new OutputBuilder(registry.gameSystem, []);
      this.context = {
         countTarget: (childId) => index.countTarget(childId),
         choiceGroupTargets: () => undefined,
         isUnitScope: () => false,
         isThisUnit: () => undefined,
         unitHasCategory: () => undefined,
         detachmentSlug: (forceId) => index.detachmentByForceId.get(forceId),
         factionSlug: (catalogueId) => registry.catalogues.find((document) => document.battleScribeId === catalogueId)?.slug,
         unhandled: (element, message) => report.failUnhandled(element, message),
         recordCorrection: (element, message) => report.recordCorrection(element, message),
      };
   }

   /** Abilities first, so catalogues can reuse them by content before the rest is converted. */
   convertAbilities(): void {
      const root = this.registry.gameSystem.root;
      for (const rule of childrenOf(root, "sharedRules", "rule")) this.builder.addAbility(abilityFromRule(rule));
      for (const profile of childrenOf(root, "sharedProfiles", "profile")) {
         const ability = abilityFromProfile(profile, this.report);
         if (ability !== undefined) this.builder.addAbility(ability);
      }
      for (const force of this.registry.forceEntries()) for (const rule of childrenOf(force, "rules", "rule")) this.builder.addAbility(abilityFromRule(rule));
   }

   convert(release: string): GameSystem {
      const targets: RepeatTargets = {
         target: (childId) => this.index.countTarget(childId),
         simplify: (terms) => this.index.simplify(terms),
      };
      const keywordCaps = this.categoryKeywordLimits();
      for (const force of this.registry.forceEntries()) this.convertDetachment(force, targets, keywordCaps);
      this.convertUniversalOptions();
      const gameSystem: GameSystem = { $schema: "../schema/game-system.schema.json", release, detachments: this.detachments };
      if (Object.keys(this.universalOptions).length > 0) gameSystem.universalOptions = this.universalOptions;
      if (Object.keys(this.armyKeywordLimits).length > 0) gameSystem.armyKeywordLimits = this.armyKeywordLimits;
      if (this.builder.abilities.size > 0) gameSystem.abilities = Object.fromEntries(this.builder.abilities);
      if (this.builder.warmasterTraits.size > 0) gameSystem.warmasterTraits = Object.fromEntries(this.builder.warmasterTraits);
      return gameSystem;
   }

   /** Category-wide caps: `force` ones apply in every detachment, `roster` ones to the army. */
   private categoryKeywordLimits(): Record<string, KeywordLimit> {
      const perDetachment: Record<string, KeywordLimit> = {};
      for (const category of childrenOf(this.registry.gameSystem.root, "categoryEntries", "categoryEntry")) {
         for (const constraint of childrenOf(category, "constraints", "constraint")) {
            const keyword = this.index.countTarget(attribute(category, "id"));
            const scope = attribute(constraint, "scope");
            if (keyword?.kind !== "Keyword" || attribute(constraint, "type") !== "max" || (scope !== "force" && scope !== "roster")) {
               this.report.failUnhandled(constraint, `category constraint ${constraint.attributes.type} scope=${scope}`);
               continue;
            }
            const limit: KeywordLimit = { maximum: { base: Number(attribute(constraint, "value")) } };
            if (scope === "force") perDetachment[keyword.keyword] = limit;
            else this.armyKeywordLimits[keyword.keyword] = limit;
         }
      }
      return perDetachment;
   }

   private convertDetachment(force: Element, targets: RepeatTargets, keywordCaps: Record<string, KeywordLimit>): void {
      const slug = this.index.detachmentByForceId.get(attribute(force, "id"))!;
      const modifiers = flatModifiersOf(force, this.context);
      const detachment: Detachment = { name: attribute(force, "name"), kind: this.index.kindOf(slug), slots: {} };
      for (const constraint of childrenOf(force, "constraints", "constraint")) {
         const converted = attribute(constraint, "type") === "max" ? limitFrom(constraint, modifiers, targets, this.context) : undefined;
         if (converted === undefined) {
            this.report.failUnhandled(constraint, `detachment constraint ${constraint.attributes.type}`);
            continue;
         }
         detachment.maximumPerArmy = converted.limit;
         if (converted.availableWhen !== undefined) detachment.availableWhen = this.simplifyCoreCondition(converted.availableWhen);
      }
      for (const modifier of modifiers) {
         if (!childrenOf(force, "constraints", "constraint").some((constraint) => attribute(constraint, "id") === modifier.field)) {
            this.report.failUnhandled(modifier.element, `detachment modifier ${modifier.type} ${modifier.field}`);
         }
      }
      const slotLinks = [...childrenOf(force, "categoryLinks", "categoryLink")];
      for (const link of slotLinks) this.convertSlot(link, detachment, targets);
      if (Object.keys(keywordCaps).length > 0) detachment.keywordLimits = structuredClone(keywordCaps);
      const abilities = childrenOf(force, "rules", "rule").map((rule) => this.builder.findAbility(abilityFromRule(rule))!);
      if (abilities.length > 0) detachment.abilities = abilities;
      for (const child of childrenOf(force, "forceEntries", "forceEntry")) {
         if (isNeverAdded(child)) this.report.recordDropped(child, "child force entry with an army maximum of 0");
         else if (child.children.some((element) => !["categoryLinks"].includes(element.tag))) this.report.failUnhandled(child, "child force entry with more than category links");
      }
      this.detachments[slug] = detachment;
   }

   private convertSlot(link: Element, detachment: Detachment, targets: RepeatTargets): void {
      const category = this.registry.category(attribute(link, "targetId"));
      const constraints = childrenOf(link, "constraints", "constraint");
      if (category?.kind === "ListConfiguration") return;
      if (category?.kind !== "Role") {
         this.report.failUnhandled(link, "detachment category link that is not a battlefield role");
         return;
      }
      if (constraints.length === 0) return;
      const modifiers = flatModifiersOf(link, this.context);
      const slot: SlotLimit = {};
      for (const constraint of constraints) {
         if (attribute(constraint, "type") === "min") {
            slot.minimum = Number(attribute(constraint, "value"));
            continue;
         }
         const converted = limitFrom(constraint, modifiers, targets, this.context);
         if (converted === undefined || converted.availableWhen !== undefined) {
            this.report.failUnhandled(constraint, "slot maximum");
            continue;
         }
         slot.maximum = converted.limit;
      }
      detachment.slots[category.role as BattlefieldRole] = slot;
   }

   /** "Any Core detachment present" reads better as one DetachmentKind count than as a list of five. */
   private simplifyCoreCondition(condition: ReturnType<typeof allOf> & object): typeof condition {
      if (condition.kind !== "Any") return condition;
      const named = condition.conditions.map((part) =>
         part.kind === "Count" && part.of.kind === "Detachment" && part.minimum === 1 && part.maximum === undefined ? part : undefined,
      );
      const slugs = new Set(named.map((part) => (part?.of.kind === "Detachment" ? part.of.detachment : "")));
      const scopes = new Set(named.map((part) => part?.scope));
      const isCore = named.every((part) => part !== undefined) && slugs.size === this.index.coreDetachments.size && [...slugs].every((slug) => this.index.coreDetachments.has(slug));
      if (!isCore || scopes.size !== 1) return condition;
      return { kind: "Count", scope: [...scopes][0] as CountScope, of: { kind: "DetachmentKind", detachmentKind: "Core" }, minimum: 1 };
   }

   private convertUniversalOptions(): void {
      const root = this.registry.gameSystem.root;
      for (const group of childrenOf(root, "sharedSelectionEntryGroups", "selectionEntryGroup")) {
         for (const entry of childrenOf(group, "selectionEntries", "selectionEntry")) {
            for (const profile of childrenOf(entry, "profiles", "profile")) {
               const ability = abilityFromProfile(profile, this.report);
               if (attribute(profile, "typeName") !== WARMASTER_TRAIT_PROFILE || ability === undefined) {
                  this.report.failUnhandled(profile, "shared group entry that is not a warmaster trait");
                  continue;
               }
               this.builder.addWarmasterTrait(attribute(entry, "id"), ability);
            }
         }
      }
      for (const entry of childrenOf(root, "sharedSelectionEntries", "selectionEntry")) this.convertUniversalOption(entry, undefined);
   }

   private convertUniversalOption(entry: Element, parentKeyword: string | undefined): void {
      const view = viewOf(this.registry, entry)!;
      const option: Option = { name: view.name };
      const keywords = view.categoryLinks.map((link) => this.index.countTarget(attribute(link, "targetId"))).filter((target) => target?.kind === "Keyword");
      if (keywords.length > 0) option.addsKeywords = keywords.map((target) => target.keyword);
      const constraints = constraintsByScope(view);
      const parentMaximum = constraintValue(constraints.get("parent max"));
      if (parentMaximum !== undefined) option.maximum = parentMaximum;
      const hiddenWhen = flatModifiersOf(entry, this.context).filter((modifier) => modifier.field === "hidden");
      const visible = hiddenWhen.map((modifier) => (modifier.condition ? not(modifier.condition) : undefined));
      const needsParent = parentKeyword === undefined ? undefined : { kind: "Count" as const, scope: "Unit" as const, of: { kind: "Keyword" as const, keyword: parentKeyword }, minimum: 1 };
      const availableWhen = allOf(needsParent, ...visible);
      if (availableWhen !== undefined) option.availableWhen = availableWhen;
      const slug = this.builder.slugFor(view.ids[0], view.name);
      this.universalOptions[slug] = option;
      for (const id of view.ids) this.universalOptionIds.set(id, slug);
      for (const modifier of flatModifiersOf(entry, this.context)) {
         if (modifier.field === "name") this.report.recordDropped(modifier.element, `conditional rename of ${view.name} to ${modifier.value}`);
         else if (modifier.field !== "hidden") this.recordForceMinimum(view.name, modifier, constraints, option);
      }
      for (const child of childrenOf(entry, "selectionEntries", "selectionEntry")) this.convertUniversalOption(child, option.addsKeywords?.[0]);
      if (isHidden(entry)) this.report.failUnhandled(entry, "hidden universal option");
   }

   /** The least number of units with `keyword` a detachment of this type must contain, if it sets one. */
   keywordMinimum(detachment: string, keyword: string): number | undefined {
      return this.detachments[detachment]?.keywordLimits?.[keyword]?.minimum;
   }

   /** A `force min` raised to N inside one detachment type becomes that detachment's keyword minimum. */
   private recordForceMinimum(name: string, modifier: ReturnType<typeof flatModifiersOf>[number], constraints: Map<string, Element>, option: Option): void {
      const forceMinimum = constraints.get("force min");
      const condition = modifier.condition;
      const keyword = option.addsKeywords?.[0];
      const inDetachment = condition?.kind === "Count" && condition.of.kind === "Detachment" ? condition.of.detachment : undefined;
      if (forceMinimum === undefined || modifier.field !== attribute(forceMinimum, "id") || inDetachment === undefined || keyword === undefined) {
         this.report.failUnhandled(modifier.element, `universal option ${name} modifier ${modifier.type} ${modifier.field}`);
         return;
      }
      const detachment = this.detachments[inDetachment];
      detachment.keywordLimits = { ...detachment.keywordLimits, [keyword]: { ...detachment.keywordLimits?.[keyword], minimum: Number(modifier.value) } };
   }
}

/** A force whose only constraint caps it at 0 per army, so it can never be added. */
function isNeverAdded(force: Element): boolean {
   const constraints = childrenOf(force, "constraints", "constraint");
   const isZeroCap = (constraint: Element) => attribute(constraint, "field") === "forces" && attribute(constraint, "type") === "max" && Number(attribute(constraint, "value")) === 0;
   return constraints.length === 1 && isZeroCap(constraints[0]) && force.children.every((element) => ["constraints", "categoryLinks"].includes(element.tag));
}
