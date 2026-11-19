import { allOf, combine, conditionKey, not, type ConditionContext } from "./conditions.ts";
import { COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID, type Conversion, type OptionSlugs } from "./conversion.ts";
import { describeSource, GROUP_BOUND_CORRECTIONS, OPTION_MAXIMUM_CORRECTIONS } from "./corrections.ts";
import { constraintsByScope, constraintValue, POWER_LEVEL_TYPE_ID, powerLevel, type EntryView } from "./entries.ts";
import type { Condition, ConditionalChange, Limit, Option, OptionGroup } from "./model.ts";
import { availabilityOf, flatModifiers, limitFrom, type FlatModifier } from "./modifiers.ts";
import { OptionBounds } from "./optionBounds.ts";
import { WEAPON_PROFILE } from "./profiles.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

/** Where a category link sits: on the unit itself, on an entry inside it, or on a whole unit nested inside it as an option. */
export type CategoryHolder = "Unit" | "NestedEntry" | "NestedUnit";

/** A unit's detachment or army maximum, and when modifiers on it leave the unit available at all. */
export interface UnitLimit {
   readonly maximum?: number;
   readonly availableWhen?: Condition;
}

/** An info target: a profile or rule, with the info link that reached it, if any. */
export interface InfoTarget {
   readonly link: Element | undefined;
   readonly target: Element | undefined;
}

/** What building a unit's wargear needs from the datasheet converter around it. */
export interface WargearHost {
   readonly conversion: Conversion;
   readonly slugs: OptionSlugs;
   readonly context: ConditionContext;
   readonly weapons: string[];
   readonly keywords: Set<string>;
   readonly factionKeywords: Set<string>;
   addCategories(links: Element[], keywords: Set<string>, factionKeywords: Set<string>, holder: CategoryHolder): void;
   addProfiles(view: EntryView, option: Option | undefined): void;
   infoTargets(profiles: Element[], rules: Element[], infoLinks: Element[], infoGroups: Element[]): InfoTarget[];
   conditionalChange(when: Condition): ConditionalChange;
   requires(parent: Option | undefined): Condition | undefined;
   unitLimit(constraint: Element | undefined, modifiers: FlatModifier[], label: string): UnitLimit;
   optionTaken(condition: Condition | null | undefined): string | undefined;
   defer(apply: () => void): void;
   unhandled(element: Element, message: string): void;
   fail(): void;
   dropConditionalRename(modifier: FlatModifier): void;
}

/** Exactly one, always shown and free: part of what holds it rather than an option. */
export function isMandatory(view: EntryView): boolean {
   const constraints = constraintsByScope(view);
   const exactlyOne = constraintValue(constraints.get("parent min")) === 1 && constraintValue(constraints.get("parent max")) === 1;
   const plain = view.modifiers.length === 0 && view.modifierGroups.length === 0 && !view.hidden;
   return exactlyOne && plain && powerLevel(view) === 0;
}

function isPassThrough(childId: string): boolean {
   return childId === COMMANDER_ENTRY_ID || childId === WARMASTER_TRAITS_GROUP_ID;
}

function nestedHolder(view: EntryView): CategoryHolder {
   return attribute(view.target, "type") === "unit" ? "NestedUnit" : "NestedEntry";
}

/** A unit's wargear: its option groups, the options outside any group, and the entries it always carries. */
export class Wargear {
   readonly groups: OptionGroup[] = [];
   readonly loose: Option[] = [];
   readonly optionsBySlug = new Map<string, Option>();
   readonly bounds: OptionBounds;
   private readonly host: WargearHost;

   constructor(host: WargearHost) {
      this.host = host;
      this.bounds = new OptionBounds({
         groups: this.groups,
         slugs: host.slugs,
         optionTaken: (condition) => host.optionTaken(condition),
         unhandled: (element, message) => host.unhandled(element, message),
         fail: () => host.fail(),
      });
   }

   /** Turns the entries below `view` into options and option groups; `parent` is set when they come with taking an option. */
   addChildren(view: EntryView, parent: Option | undefined): void {
      for (const child of view.childEntries) {
         if (child.tag === "entryLink" && isPassThrough(attribute(child, "targetId"))) continue;
         const childView = this.host.conversion.view(child);
         if (childView === undefined) continue;
         if (isMandatory(childView)) {
            this.host.slugs.fates.fixedWargear += 1;
            this.absorb(childView, parent);
         } else if (this.absorbUnlessDropped(childView, parent)) this.host.slugs.fates.carriedUntilDropped += 1;
         else {
            const option = this.optionFrom(childView, this.host.requires(parent));
            if (option !== undefined) this.loose.push(option);
         }
      }
      for (const group of view.childGroups) {
         if (group.tag === "entryLink" && isPassThrough(attribute(group, "targetId"))) continue;
         const groupView = this.host.conversion.view(group);
         if (groupView !== undefined) this.addGroup(groupView, parent);
      }
   }

   /** An entry carried until a condition zeroes both its bounds: its weapons, removed while that condition holds, and its rules while it does not. */
   private absorbUnlessDropped(view: EntryView, parent: Option | undefined): boolean {
      if (!this.isDroppableWeapons(view)) return false;
      const [first, second] = flatModifiers(view.modifiers, [], this.host.context);
      if (first.condition === undefined || second.condition === undefined) {
         this.host.fail();
         return true;
      }
      if (!first.condition || !second.condition || conditionKey(first.condition) !== conditionKey(second.condition)) {
         this.host.unhandled(view.element, "mandatory entry whose bounds are zeroed under different conditions");
         return true;
      }
      const holder: Option = { name: view.name };
      this.host.addProfiles(view, holder);
      const weapons = holder.addsWeapons ?? [];
      if (parent === undefined) this.host.weapons.push(...weapons);
      else (parent.addsWeapons ??= []).push(...weapons);
      const change = this.host.conditionalChange(allOf(this.host.requires(parent), first.condition)!);
      (change.removesWeapons ??= []).push(...weapons);
      if (holder.addsAbilities !== undefined) {
         const carried = this.host.conditionalChange(allOf(this.host.requires(parent), not(first.condition))!);
         for (const ability of holder.addsAbilities) if (!(carried.addsAbilities ??= []).includes(ability)) carried.addsAbilities.push(ability);
      }
      return true;
   }

   /** Exactly one, always shown, free, holding only plain weapon profiles and rules, with both bounds set to 0 by one modifier each. */
   private isDroppableWeapons(view: EntryView): boolean {
      const constraints = constraintsByScope(view);
      const minimum = constraints.get("parent min");
      const maximum = constraints.get("parent max");
      if (minimum === undefined || maximum === undefined || constraints.size !== 2) return false;
      if (constraintValue(minimum) !== 1 || constraintValue(maximum) !== 1 || view.hidden || powerLevel(view) !== 0) return false;
      if (view.childEntries.length > 0 || view.childGroups.length > 0 || view.categoryLinks.length > 0 || view.modifierGroups.length > 0) return false;
      const bounds = new Set([attribute(minimum, "id"), attribute(maximum, "id")]);
      const zeroesBound = (modifier: Element) =>
         attribute(modifier, "type") === "set" && Number(attribute(modifier, "value")) === 0 && bounds.delete(attribute(modifier, "field")) && childrenOf(modifier, "repeats", "repeat").length === 0;
      if (view.modifiers.length !== 2 || !view.modifiers.every(zeroesBound)) return false;
      const isWeaponOrRule = (target: Element) => target.tag === "rule" || (target.tag === "profile" && attribute(target, "typeName") === WEAPON_PROFILE);
      const isPlain = (element: Element | undefined) => element === undefined || childrenOf(element, "modifiers", "modifier").length === 0;
      return this.host.infoTargets(view.profiles, view.rules, view.infoLinks, view.infoGroups).every(
         ({ link, target }) => target !== undefined && isWeaponOrRule(target) && target.attributes.hidden !== "true" && isPlain(link) && isPlain(target),
      );
   }

   /** A mandatory entry is part of what holds it (the datasheet, or the option `parent`), with its own children. */
   private absorb(view: EntryView, parent: Option | undefined): void {
      if (parent === undefined) this.host.addCategories(view.categoryLinks, this.host.keywords, this.host.factionKeywords, nestedHolder(view));
      else this.addOptionCategories(view, parent);
      this.host.addProfiles(view, parent);
      this.addChildren(view, parent);
   }

   private addOptionCategories(view: EntryView, option: Option): void {
      const keywords = new Set<string>(option.addsKeywords);
      const factionKeywords = new Set<string>(option.addsFactionKeywords);
      this.host.addCategories(view.categoryLinks, keywords, factionKeywords, nestedHolder(view));
      if (keywords.size > 0) option.addsKeywords = [...keywords];
      if (factionKeywords.size > 0) option.addsFactionKeywords = [...factionKeywords];
   }

   private optionFrom(view: EntryView, inherited: Condition | undefined): Option | undefined {
      const id = this.host.slugs.byId.get(view.ids[0])!;
      const option: Option = { id, name: view.name };
      this.optionsBySlug.set(id, option);
      const cost = powerLevel(view);
      const modifiers = flatModifiers(view.modifiers, view.modifierGroups, this.host.context);
      const constraints = constraintsByScope(view);
      const minimum = constraintValue(constraints.get("parent min"));
      const maximumConstraint = constraints.get("parent max");
      let availableWhen = inherited;
      const maximumModifiers = maximumConstraint === undefined ? [] : modifiers.filter((modifier) => modifier.field === attribute(maximumConstraint, "id"));
      const maximumBase = constraintValue(maximumConstraint) ?? 0;
      const isZeroedWhen = (modifier: FlatModifier) => modifier.type === "set" && Number(modifier.value) === 0 && modifier.condition !== null && modifier.repeats.length === 0;
      const isUnconditionalSet = (modifier: FlatModifier) => modifier.type === "set" && modifier.condition === null && modifier.repeats.length === 0;
      const isAvailabilitySet = maximumModifiers.length === 1 && maximumBase === 0 && maximumModifiers[0].type === "set" && maximumModifiers[0].condition !== null;
      const isSimple = maximumModifiers.length === 0 || isAvailabilitySet || maximumModifiers.some((modifier) => modifier.repeats.length > 0);
      if (maximumModifiers.some((modifier) => modifier.condition === undefined)) this.host.fail();
      else if (!isSimple && maximumBase > 0 && maximumModifiers.every(isZeroedWhen)) {
         option.maximum = maximumBase;
         availableWhen = allOf(availableWhen, not(combine("Any", maximumModifiers.map((modifier) => modifier.condition as Condition))!));
      } else if (!isSimple && maximumModifiers.length === 1 && isUnconditionalSet(maximumModifiers[0]) && Number(maximumModifiers[0].value) > 0) {
         option.maximum = Number(maximumModifiers[0].value);
      } else if (!isSimple) {
         option.maximum = maximumBase;
         this.host.defer(() => this.bounds.setBound(option, "maximum", maximumConstraint!, modifiers, "option"));
      } else if (maximumConstraint !== undefined) {
         const converted = limitFrom(maximumConstraint, modifiers, { target: () => undefined, simplify: (terms) => terms }, this.host.context);
         if (converted === undefined) this.host.fail();
         else if (converted.limit.terms !== undefined) this.host.unhandled(maximumConstraint, "option maximum that grows");
         else if (converted.limit.base === 0 && converted.availableWhen === undefined) {
            this.host.conversion.report.recordDropped(view.element, "option with a maximum of 0");
            this.host.slugs.fates.dropped += this.host.conversion.wargearEntryCount(view);
            return undefined;
         } else {
            option.maximum = converted.limit.base;
            availableWhen = allOf(availableWhen, converted.availableWhen);
         }
      }
      const maximumCorrection = OPTION_MAXIMUM_CORRECTIONS.find((entry) => maximumConstraint !== undefined && entry.constraintId === attribute(maximumConstraint, "id"));
      if (maximumCorrection !== undefined) {
         option.maximum = maximumCorrection.maximum;
         this.host.conversion.report.recordCorrection(view.element, `${maximumCorrection.name}: maximum ${maximumCorrection.maximum} as printed (${describeSource(maximumCorrection.source)})`);
      }
      const minimumConstraint = constraints.get("parent min");
      const minimumModifiers = minimumConstraint === undefined ? [] : modifiers.filter((modifier) => modifier.field === attribute(minimumConstraint, "id"));
      const isDroppedWithMaximum = (modifier: FlatModifier) => modifier.type === "set" && Number(modifier.value) === 0 && maximumModifiers.some((maximumModifier) => JSON.stringify(maximumModifier.condition) === JSON.stringify(modifier.condition));
      let minimumValue = minimum ?? 0;
      const requiredWhen: Condition[] = [];
      for (const modifier of minimumModifiers.filter((candidate) => !isDroppedWithMaximum(candidate))) {
         if (modifier.condition === undefined) this.host.fail();
         else if (modifier.repeats.length > 0 || modifier.type !== "set") this.host.unhandled(modifier.element, `option minimum ${modifier.type}`);
         else if (modifier.condition === null) minimumValue = Number(modifier.value);
         else if (Number(modifier.value) === 1 && minimumValue <= 0) requiredWhen.push(modifier.condition);
         else this.host.unhandled(modifier.element, "option minimum set with conditions to more than 1");
      }
      if (minimumValue > 0) option.minimum = minimumValue;
      if (requiredWhen.length > 0) option.requiredWhen = combine("Any", requiredWhen)!;
      const constraintIds = new Set(view.constraints.map((constraint) => attribute(constraint, "id")));
      const wider = { "force max": "maximumPerDetachment", "roster max": "maximumPerArmy", "roster min": "minimumPerArmy" } as const;
      for (const [key, constraint] of constraints) {
         if (key === "parent min" || key === "parent max") continue;
         const field = wider[key as keyof typeof wider];
         const value = constraintValue(constraint);
         const constraintModifiers = modifiers.filter((modifier) => modifier.field === attribute(constraint, "id"));
         const modified = constraintModifiers.length > 0;
         if (key === "roster min" && value === 0 && modified && this.isDetachmentKeywordMinimum(view, constraintModifiers)) {
            for (const modifier of constraintModifiers) this.host.conversion.report.recordDropped(modifier.element, "army minimum the detachment's own keyword minimum already sets");
            continue;
         }
         if ((key === "force max" || key === "roster max") && modified) {
            const limit = this.host.unitLimit(constraint, modifiers, "option");
            if (limit.maximum !== undefined) option[key === "force max" ? "maximumPerDetachment" : "maximumPerArmy"] = limit.maximum;
            availableWhen = allOf(availableWhen, limit.availableWhen);
            continue;
         }
         if (field === undefined || value === undefined || value < 1 || modified) this.host.unhandled(constraint, `option constraint ${key}${modified ? " with modifiers" : ""}`);
         else option[field] = value;
      }
      for (const modifier of modifiers) {
         if (modifier.field === "hidden" || constraintIds.has(modifier.field)) continue;
         if (modifier.field === POWER_LEVEL_TYPE_ID && modifier.type === "set" && modifier.condition === null) option.cost = Number(modifier.value);
         else if (modifier.field === POWER_LEVEL_TYPE_ID && modifier.condition === null && modifier.repeats.length === 0) {
            const signed = Number(modifier.value) * (modifier.type === "decrement" ? -1 : 1);
            option.cost = (option.cost ?? cost) + signed;
         }
         else if (modifier.field === POWER_LEVEL_TYPE_ID && modifier.condition !== null && modifier.condition !== undefined && modifier.repeats.length === 0) {
            const amount = Number(modifier.value);
            const change = modifier.type === "set" ? { when: modifier.condition, set: amount } : { when: modifier.condition, increment: modifier.type === "decrement" ? -amount : amount };
            (option.costChanges ??= []).push(change);
         } else if (modifier.field === "name" && modifier.condition === null) option.name = modifier.value;
         else if (modifier.field === "name") this.host.dropConditionalRename(modifier);
         else this.host.unhandled(modifier.element, `option modifier ${modifier.type} ${modifier.field}${modifier.condition ? " with conditions" : ""}`);
      }
      if (option.cost === undefined && cost !== 0) option.cost = cost;
      const availability = availabilityOf(view.hidden, modifiers);
      if (availability === "Never") {
         this.host.conversion.report.recordDropped(view.element, "option hidden with no condition that shows it");
         this.host.slugs.fates.dropped += this.host.conversion.wargearEntryCount(view);
         return undefined;
      }
      if (availability !== undefined && availability !== "Always") availableWhen = allOf(availableWhen, availability);
      if (availableWhen !== undefined) option.availableWhen = availableWhen;
      this.addOptionCategories(view, option);
      this.host.addProfiles(view, option);
      this.addChildren(view, option);
      this.host.slugs.fates.options += 1;
      return option;
   }

   private addGroup(view: EntryView, parent: Option | undefined): void {
      const id = this.host.slugs.byId.get(view.ids[0])!;
      const modifiers = flatModifiers(view.modifiers, view.modifierGroups, this.host.context);
      const availability = availabilityOf(view.hidden, modifiers);
      if (availability === "Never") {
         this.host.conversion.report.recordDropped(view.element, "option group hidden with no condition that shows it");
         this.host.slugs.fates.dropped += this.host.conversion.wargearEntriesUnder(view);
         return;
      }
      const hiddenUnless = availability === "Always" || availability === undefined ? undefined : availability;
      const shownWhen = allOf(hiddenUnless, this.host.requires(parent));
      const perParent = (amount: number): number | Limit => (parent === undefined ? amount : { base: 0, terms: [{ per: { kind: "Option", option: parent.id! }, scope: "Unit", amount }] });
      const group: OptionGroup = { id, name: view.name, options: [] };
      const constraints = constraintsByScope(view);
      const minimum = constraintValue(constraints.get("parent min"));
      const maximum = constraintValue(constraints.get("parent max"));
      const minimumConstraint = constraints.get("parent min");
      const maximumConstraint = constraints.get("parent max");
      const boundIds = new Set([minimumConstraint, maximumConstraint].filter((constraint) => constraint !== undefined).map((constraint) => attribute(constraint, "id")));
      const minimumModified = minimumConstraint !== undefined && modifiers.some((modifier) => modifier.field === attribute(minimumConstraint, "id"));
      if (minimum !== undefined && minimum > 0 && !minimumModified) group.minimum = perParent(minimum);
      if (maximum !== undefined) group.maximum = perParent(maximum);
      const correction = GROUP_BOUND_CORRECTIONS.find((entry) => view.ids.includes(entry.groupId));
      const zeroedWhen = this.groupZeroedWhen(minimumConstraint, maximumConstraint, modifiers);
      const multipleOf = minimumModified && minimum === 0 ? this.bounds.multipleOf(id, minimumConstraint, modifiers) : undefined;
      if (correction !== undefined) {
         if (correction.minimum !== undefined) group.minimum = correction.minimum;
         if (correction.maximum !== undefined) group.maximum = correction.maximum;
         this.host.conversion.report.recordCorrection(view.element, `${correction.name} bounds set as printed (${describeSource(correction.source)})`);
      } else if (zeroedWhen !== undefined) {
         if (minimum !== undefined && minimum > 0) group.minimum = perParent(minimum);
         group.availableWhen = not(zeroedWhen);
      } else {
         if (multipleOf !== undefined) group.multipleOf = multipleOf;
         else if (minimumModified && parent === undefined) this.host.defer(() => this.bounds.setBound(group, "minimum", minimumConstraint, modifiers, "option group"));
         if (maximumConstraint !== undefined && modifiers.some((modifier) => modifier.field === attribute(maximumConstraint, "id"))) {
            this.host.defer(() => this.bounds.setBound(group, "maximum", maximumConstraint, modifiers, "option group"));
         }
      }
      for (const key of constraints.keys()) if (!["parent min", "parent max"].includes(key)) this.host.unhandled(constraints.get(key)!, `option group constraint ${key}`);
      for (const modifier of modifiers) if (modifier.field !== "hidden" && !boundIds.has(modifier.field)) this.host.unhandled(modifier.element, `option group modifier ${modifier.type} ${modifier.field}`);
      for (const child of view.childEntries) {
         if (child.tag === "entryLink" && isPassThrough(attribute(child, "targetId"))) continue;
         const childView = this.host.conversion.view(child);
         if (childView === undefined) continue;
         const option = this.optionFrom(childView, shownWhen);
         if (option !== undefined) group.options.push(option);
      }
      for (const nested of view.childGroups) {
         const nestedView = this.host.conversion.view(nested);
         if (nestedView !== undefined) this.addGroup(nestedView, parent);
      }
      if (view.defaultSelectionEntryId !== undefined) {
         const fallback = this.host.slugs.byId.get(view.defaultSelectionEntryId);
         if (fallback !== undefined && group.options.some((option) => option.id === fallback)) group.default = fallback;
         else this.host.unhandled(view.element, "default selection that is not one of the group's options");
      }
      if (hiddenUnless !== undefined && group.minimum !== undefined) group.availableWhen = allOf(group.availableWhen, hiddenUnless);
      if (group.options.length === 0) {
         if (view.childGroups.length === 0) this.host.conversion.report.recordDropped(view.element, "option group with no options left");
         return;
      }
      this.groups.push(group);
   }

   /** Whether every modifier raises the minimum only inside a detachment type whose keyword limits already require that many of a keyword the entry has. */
   private isDetachmentKeywordMinimum(view: EntryView, modifiers: FlatModifier[]): boolean {
      const keywords = view.categoryLinks.map((link) => this.host.conversion.registry.category(attribute(link, "targetId"))).flatMap((category) => (category?.kind === "Keyword" ? [category.keyword] : []));
      return modifiers.every((modifier) => {
         const condition = modifier.condition;
         if (modifier.type !== "set" || condition?.kind !== "Count" || condition.scope !== "Detachment" || condition.of.kind !== "Detachment") return false;
         const detachment = condition.of.detachment;
         const required = Number(modifier.value);
         return keywords.some((keyword) => (this.host.conversion.gameSystem.keywordMinimum(detachment, keyword) ?? 0) >= required);
      });
   }
   private groupZeroedWhen(minimumConstraint: Element | undefined, maximumConstraint: Element | undefined, modifiers: FlatModifier[]): Condition | undefined {
      if (minimumConstraint === undefined || maximumConstraint === undefined) return undefined;
      const on = (constraint: Element) => modifiers.filter((modifier) => modifier.field === attribute(constraint, "id"));
      const isZeroedWhen = (modifier: FlatModifier) => modifier.type === "set" && Number(modifier.value) === 0 && modifier.repeats.length === 0 && Boolean(modifier.condition);
      const minimumChanges = on(minimumConstraint);
      const maximumChanges = on(maximumConstraint);
      const changes = [...minimumChanges, ...maximumChanges];
      if (minimumChanges.length === 0 || maximumChanges.length === 0 || !changes.every(isZeroedWhen)) return undefined;
      const keys = (list: FlatModifier[]) => [...new Set(list.map((modifier) => conditionKey(modifier.condition as Condition)))].toSorted().join("|");
      if (keys(minimumChanges) !== keys(maximumChanges)) return undefined;
      return combine("Any", maximumChanges.map((modifier) => modifier.condition as Condition));
   }
}
