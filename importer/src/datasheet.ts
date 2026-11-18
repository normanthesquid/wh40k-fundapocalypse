import type { OutputBuilder } from "./builder.ts";
import { allOf, combine, not, type ConditionContext } from "./conditions.ts";
import { COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID, type Conversion, type OptionSlugs } from "./conversion.ts";
import { constraintsByScope, constraintValue, POWER_LEVEL_TYPE_ID, powerLevel, viewOf, type EntryView } from "./entries.ts";
import type { BattlefieldRole, Condition, ConditionalChange, CostChange, CountTarget, Datasheet, LimitTerm, Option, OptionGroup } from "./model.ts";
import { flatModifiers, flatModifiersOf, limitFrom, type FlatModifier } from "./modifiers.ts";
import { describeSource, MISSING_ROLES } from "./corrections.ts";
import { UnitProfiles } from "./unitProfiles.ts";
import { addWeaponVariants, carriedWeapon, type VariantContext } from "./weaponVariants.ts";
import { characteristicNamesById, isDroppedProfile, TRANSPORT_PROFILE, transportFromProfile, UNIT_PROFILE, WEAPON_PROFILE } from "./profiles.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

/** Visibility from `hidden` and its modifiers: a condition, "Always", "Never", or undefined when a condition failed. */
export type Availability = Condition | "Always" | "Never" | undefined;

export function availabilityOf(hidden: boolean, modifiers: FlatModifier[]): Availability {
   const toggles = modifiers.filter((modifier) => modifier.field === "hidden");
   if (toggles.some((modifier) => modifier.condition === undefined)) return undefined;
   const showing = toggles.filter((modifier) => modifier.value === "false");
   const hiding = toggles.filter((modifier) => modifier.value === "true");
   if (hiding.some((modifier) => modifier.condition === null)) return "Never";
   const hideWhen = combine("Any", hiding.map((modifier) => modifier.condition as Condition));
   if (hidden) {
      if (showing.some((modifier) => modifier.condition === null)) return hideWhen === undefined ? "Always" : not(hideWhen);
      const showWhen = combine("Any", showing.map((modifier) => modifier.condition as Condition));
      if (showWhen === undefined) return "Never";
      return allOf(showWhen, hideWhen === undefined ? undefined : not(hideWhen))!;
   }
   return hideWhen === undefined ? "Always" : not(hideWhen);
}

/** Where a category link sits: on the unit itself, on an entry inside it, or on a whole unit nested inside it as an option. */
type CategoryHolder = "Unit" | "NestedEntry" | "NestedUnit";

interface SecondaryRole {
   readonly link: Element;
   readonly role: BattlefieldRole;
   readonly holder: CategoryHolder;
}

function nestedHolder(view: EntryView): CategoryHolder {
   return attribute(view.target, "type") === "unit" ? "NestedUnit" : "NestedEntry";
}

export class DatasheetConverter {
   readonly context: ConditionContext;
   private readonly weapons: string[] = [];
   private readonly abilities = new Set<string>();
   private readonly keywords = new Set<string>();
   private readonly factionKeywords = new Set<string>();
   private readonly groups: OptionGroup[] = [];
   private readonly loose: Option[] = [];
   private readonly optionsBySlug = new Map<string, Option>();
   private readonly deferred: (() => void)[] = [];
   private readonly groupOf = new Map<OptionGroup, EntryView>();
   private readonly conditionalChanges = new Map<string, ConditionalChange>();
   private readonly unitProfiles: UnitProfiles;
   private readonly costChanges: CostChange[] = [];
   private readonly secondaryRoles: SecondaryRole[] = [];
   private role: BattlefieldRole | undefined;
   private transport: string | undefined;
   private cost: number;
   private failed = false;

   private readonly conversion: Conversion;
   private readonly builder: OutputBuilder;
   private readonly view: EntryView;
   private readonly slugs: OptionSlugs;
   private readonly catalogueTarget: (childId: string) => CountTarget | undefined;

   constructor(conversion: Conversion, builder: OutputBuilder, view: EntryView, slugs: OptionSlugs, catalogueTarget: (childId: string) => CountTarget | undefined) {
      this.conversion = conversion;
      this.builder = builder;
      this.view = view;
      this.slugs = slugs;
      this.catalogueTarget = catalogueTarget;
      this.cost = powerLevel(view);
      this.context = {
         countTarget: (childId) => this.countTarget(childId),
         choiceGroupTargets: (childId) => conversion.choiceGroupTargets(builder, childId),
         isUnitScope: (scopeId) => slugs.allIds.has(scopeId),
         isThisUnit: conversion.thisUnit(view.ids),
         unitHasCategory: conversion.unitCategory(view, slugs),
         detachmentSlug: (forceId) => conversion.gameSystemIndex.detachmentByForceId.get(forceId),
         factionSlug: (catalogueId) => conversion.factionSlug(catalogueId),
         unhandled: (element, message) => this.unhandled(element, message),
         recordCorrection: (element, message) => conversion.report.recordCorrection(element, message),
      };
      this.unitProfiles = new UnitProfiles({
         conversion,
         view,
         groups: this.groups,
         optionsBySlug: this.optionsBySlug,
         defer: (apply) => this.deferred.push(apply),
         optionTaken: (condition) => this.optionTaken(condition),
         requires: (option) => this.requires(option),
         conditionalChange: (when) => this.conditionalChange(when),
         modelOption: () => this.modelOption(),
         unhandled: (element, message) => this.unhandled(element, message),
         fail: () => {
            this.failed = true;
         },
         dropConditionalRename: (modifier) => this.dropConditionalRename(modifier),
      });
   }

   private unhandled(element: Element, message: string): void {
      this.failed = true;
      this.conversion.report.failUnhandled(element, message);
   }

   private countTarget(childId: string): CountTarget | undefined {
      const local = this.slugs.byId.get(childId);
      if (local !== undefined && this.slugs.groups.has(local)) return { kind: "OptionGroup", group: local };
      if (local !== undefined) return { kind: "Option", option: local };
      if (childId === MODEL_COUNT_ID) return this.modelOption();
      return this.catalogueTarget(childId) ?? this.conversion.globalCountTarget(this.builder, childId);
   }

   /** Counting the unit's models counts its one model option; undefined when it has several, or none. */
   private modelOption(): CountTarget | undefined {
      const models = new Set<string>();
      const walk = (view: EntryView) => {
         for (const child of [...view.childEntries, ...view.childGroups]) {
            const childView = viewOf(this.conversion.registry, child);
            if (childView === undefined) continue;
            if (childView.kind === "model") models.add(this.slugs.byId.get(childView.ids[0])!);
            walk(childView);
         }
      };
      walk(this.view);
      return models.size === 1 ? { kind: "Option", option: [...models][0] } : undefined;
   }

   /** The local option a condition requires to be taken, if that is all it says. */
   private optionTaken(condition: Condition | null | undefined): string | undefined {
      if (condition?.kind !== "Count" || condition.scope !== "Unit" || condition.of.kind !== "Option" || condition.of.datasheet !== undefined) return undefined;
      if ((condition.minimum ?? 0) < 1) return undefined;
      return condition.of.option;
   }

   convert(): Datasheet | undefined {
      const view = this.view;
      const modifiers = flatModifiers(view.modifiers, view.modifierGroups, this.context);
      this.addCategories(view.categoryLinks, this.keywords, this.factionKeywords, "Unit");
      this.addProfiles(view, undefined);
      this.addChildren(view, undefined);
      this.unitProfiles.resolve();
      this.applyUnitModifiers(modifiers);
      for (const apply of this.deferred) apply();
      this.unitProfiles.addSizedProfiles();
      if (this.role === undefined) this.role = this.roleFromLinks();
      if (this.role === undefined) this.role = this.roleFromCorrections();
      if (this.role === undefined) this.unhandled(view.element, "no primary battlefield role");
      this.resolveSecondaryRoles();
      const profiles = this.unitProfiles.profiles;
      if (profiles.length === 0) this.unitProfiles.checkProfileless();
      if (this.failed || this.role === undefined) return undefined;
      const renamed = modifiers.find((modifier) => modifier.field === "name" && modifier.type === "set" && modifier.condition === null);
      const datasheet: Datasheet = { name: renamed?.value ?? view.name, battlefieldRole: this.role, cost: this.cost, keywords: [...this.keywords] };
      if (profiles.length > 0) datasheet.profiles = profiles;
      if (this.factionKeywords.size > 0) datasheet.factionKeywords = [...this.factionKeywords];
      if (this.weapons.length > 0) datasheet.weapons = this.weapons;
      if (this.abilities.size > 0) datasheet.abilities = [...this.abilities];
      if (this.transport !== undefined) datasheet.transport = this.transport;
      if (this.conditionalChanges.size > 0) datasheet.conditionalChanges = [...this.conditionalChanges.values()];
      if (this.costChanges.length > 0) datasheet.costChanges = this.costChanges;
      const wargear = [...this.groups];
      if (this.loose.length > 0) wargear.push({ id: this.slugs.optionsGroup, name: "Upgrades", options: this.loose });
      if (wargear.length > 0) datasheet.wargear = wargear;
      const availability = availabilityOf(view.hidden, modifiers);
      if (availability === "Never") {
         this.conversion.report.recordDropped(view.element, "unit hidden with no condition that shows it");
         return undefined;
      }
      if (availability !== undefined && availability !== "Always") datasheet.availableWhen = availability;
      const constraints = constraintsByScope(view);
      const perArmy = constraintValue(constraints.get("roster max"));
      const perDetachment = constraintValue(constraints.get("force max"));
      if (perDetachment !== undefined) datasheet.maximumPerDetachment = perDetachment;
      if (perArmy !== undefined) datasheet.maximumPerArmy = perArmy;
      for (const key of constraints.keys()) if (!["roster max", "force max"].includes(key)) this.unhandled(constraints.get(key)!, `unit constraint ${key}`);
      return datasheet;
   }

   /** A library unit with no role of its own takes the one most of its faction links give it; the others override it. */
   private roleFromLinks(): BattlefieldRole | undefined {
      const roles = this.conversion.linkRoles.get(this.view.ids[this.view.ids.length - 1]) ?? [];
      const tally = new Map<BattlefieldRole, number>();
      for (const role of roles) tally.set(role, (tally.get(role) ?? 0) + 1);
      const [mostCommon] = [...tally].sort((left, right) => right[1] - left[1]);
      if (mostCommon !== undefined) this.conversion.report.recordCorrection(this.view.element, `no role of its own: takes ${mostCommon[0]} from its faction links`);
      return mostCommon?.[0];
   }

   /** The correction table's role for a unit neither it nor its links give one. */
   private roleFromCorrections(): BattlefieldRole | undefined {
      const missing = MISSING_ROLES.find((entry) => this.view.ids.includes(entry.unitId));
      if (missing !== undefined) this.conversion.report.recordCorrection(this.view.element, `battlefield role ${missing.role} added (${describeSource(missing.source)})`);
      return missing?.role;
   }

   /** A role that repeats the unit's own, or belongs to a whole unit offered as an option, says nothing about this unit's role. */
   private resolveSecondaryRoles(): void {
      for (const { link, role, holder } of this.secondaryRoles) {
         if (role === this.role) this.conversion.report.recordDropped(link, `battlefield role ${role} repeating the unit's own`);
         else if (holder === "NestedUnit") this.conversion.report.recordDropped(link, `battlefield role ${role} of a unit offered as an option`);
         else this.unhandled(link, "battlefield role that is not the unit's primary category");
      }
   }

   private addCategories(links: Element[], keywords: Set<string>, factionKeywords: Set<string>, holder: CategoryHolder): void {
      for (const link of links) {
         if (link.children.length > 0) this.unhandled(link, "category link with modifiers or constraints");
         const category = this.conversion.registry.category(attribute(link, "targetId"));
         if (category === undefined) this.unhandled(link, "category link to a missing category");
         else if (category.kind === "Role" && holder === "Unit" && link.attributes.primary === "true") this.role = category.role;
         else if (category.kind === "Role") this.secondaryRoles.push({ link, role: category.role, holder });
         else if (category.kind === "FactionKeyword") factionKeywords.add(category.keyword);
         else if (category.kind === "Keyword") keywords.add(category.keyword);
         else this.unhandled(link, "List Configuration category on a unit");
      }
   }

   /** Adds the unit profiles, weapons and abilities of an entry; `option` is set when they come with taking an option. */
   private addProfiles(view: EntryView, option: Option | undefined): void {
      for (const { link, target } of this.infoTargets(view.profiles, view.rules, view.infoLinks, view.infoGroups)) {
         if (target === undefined) {
            this.unhandled(link!, "info link to a missing id");
            continue;
         }
         const modifiers = [...(link === undefined ? [] : flatModifiersOf(link, this.context)), ...flatModifiersOf(target, this.context)];
         if (link !== undefined) for (const dropped of modifiers.filter((modifier) => modifier.field === "page")) this.conversion.report.recordDropped(dropped.element, "page reference");
         const kept = modifiers.filter((modifier) => modifier.field !== "page");
         if (target.tag === "rule") this.addAbility(target, kept, option);
         else if (target.tag === "profile" && attribute(target, "typeName") === UNIT_PROFILE) this.unitProfiles.add(target, kept, option);
         else if (target.tag === "profile" && attribute(target, "typeName") === TRANSPORT_PROFILE) this.transport = transportFromProfile(target);
         else if (target.tag === "profile") this.addAbility(target, kept, option);
         else this.unhandled(link ?? target, `info link to a ${target.tag}`);
      }
   }

   /** Profiles, rules and info links, with each info group (linked or held directly) opened into its contents, which BattleScribe only groups for display. */
   private infoTargets(profiles: Element[], rules: Element[], infoLinks: Element[], infoGroups: Element[]): { link: Element | undefined; target: Element | undefined }[] {
      const targets: { link: Element | undefined; target: Element | undefined }[] = [...profiles.filter((profile) => !isDroppedProfile(profile)), ...rules].map((target) => ({ link: undefined, target }));
      const open = (group: Element, link: Element | undefined) => {
         if (group.attributes.hidden === "true" || childrenOf(group, "modifiers", "modifier").length > 0 || (link !== undefined && childrenOf(link, "modifiers", "modifier").length > 0)) {
            this.unhandled(link ?? group, "info group that is hidden or has modifiers");
            return;
         }
         targets.push(...this.infoTargets(childrenOf(group, "profiles", "profile"), childrenOf(group, "rules", "rule"), childrenOf(group, "infoLinks", "infoLink"), childrenOf(group, "infoGroups", "infoGroup")));
      };
      for (const group of infoGroups) open(group, undefined);
      for (const link of infoLinks) {
         const target = this.conversion.registry.lookup(attribute(link, "targetId"));
         if (target?.tag === "infoGroup") open(target, link);
         else if (target === undefined || !isDroppedProfile(target)) targets.push({ link, target });
      }
      return targets;
   }

   private addAbility(target: Element, modifiers: FlatModifier[], option: Option | undefined): void {
      const located = this.conversion.profiles.get(attribute(target, "id"));
      if (located === undefined) {
         this.unhandled(target, "profile that was not converted");
         return;
      }
      const original = this.conversion.reference(this.builder, located);
      const isWeapon = target.tag === "profile" && attribute(target, "typeName") === WEAPON_PROFILE;
      for (const renamed of modifiers.filter((modifier) => modifier.field === "name")) this.conversion.report.recordDropped(renamed.element, `display rename to "${renamed.value}"`);
      const rest = modifiers.filter((modifier) => modifier.field !== "name" && modifier.field !== "hidden");
      const characteristicNames = characteristicNamesById(target);
      const characteristicChanges = isWeapon ? rest.filter((modifier) => modifier.type === "set" && modifier.repeats.length === 0 && characteristicNames.has(modifier.field)) : [];
      const renames = modifiers.filter((modifier) => modifier.field === "name");
      const reference = characteristicChanges.length === 0 ? original : carriedWeapon(this.variantContext, target, original, characteristicChanges, renames);
      const addVariants = (required: Condition | undefined) => {
         if (characteristicChanges.length > 0) addWeaponVariants(this.variantContext, target, reference, characteristicChanges, renames, required);
      };
      for (const modifier of rest.filter((candidate) => !characteristicChanges.includes(candidate))) this.unhandled(modifier.element, `${isWeapon ? "weapon" : "ability"} modifier ${modifier.type} ${modifier.field}`);
      const availability = availabilityOf(target.attributes.hidden === "true", modifiers);
      const add = (to: Option | undefined) => {
         if (to === undefined && isWeapon) this.weapons.push(reference);
         else if (to === undefined) this.abilities.add(reference);
         else if (isWeapon) (to.addsWeapons ??= []).push(reference);
         else if (!(to.addsAbilities ??= []).includes(reference)) to.addsAbilities.push(reference);
      };
      if (availability === "Always") {
         add(option);
         addVariants(this.requires(option));
      } else if (availability === "Never") this.conversion.report.recordDropped(target, "hidden with no condition that shows it");
      else if (availability !== undefined) {
         const taken = option === undefined ? this.optionTaken(availability) : undefined;
         if (taken !== undefined) {
            this.deferred.push(() => {
               const takenOption = this.optionsBySlug.get(taken);
               add(takenOption);
               addVariants(this.requires(takenOption));
            });
         } else {
            const required = allOf(this.requires(option), availability)!;
            addVariants(required);
            const change = this.conditionalChange(required);
            if (isWeapon) (change.addsWeapons ??= []).push(reference);
            else if (!(change.addsAbilities ??= []).includes(reference)) change.addsAbilities.push(reference);
         }
      }
   }

   private get variantContext(): VariantContext {
      return {
         conversion: this.conversion,
         builder: this.builder,
         conditionalChange: (when) => this.conditionalChange(when),
         unhandled: (element, message) => this.unhandled(element, message),
      };
   }

   /** The datasheet's change for one condition, shared by everything that applies under it. */
   private conditionalChange(when: Condition): ConditionalChange {
      const key = JSON.stringify(when);
      let change = this.conditionalChanges.get(key);
      if (change === undefined) {
         change = { when };
         this.conditionalChanges.set(key, change);
      }
      return change;
   }

   private isPassThrough(childId: string): boolean {
      return childId === COMMANDER_ENTRY_ID || childId === WARMASTER_TRAITS_GROUP_ID;
   }

   /** A condition that `parent` is taken, for wargear nested under it, which is flattened into the datasheet's own groups. */
   private requires(parent: Option | undefined): Condition | undefined {
      if (parent === undefined) return undefined;
      return { kind: "Count", scope: "Unit", of: { kind: "Option", option: parent.id! }, minimum: 1 };
   }

   private addChildren(view: EntryView, parent: Option | undefined): void {
      for (const child of view.childEntries) {
         if (child.tag === "entryLink" && this.isPassThrough(attribute(child, "targetId"))) continue;
         const childView = this.conversion.view(child);
         if (childView === undefined) continue;
         if (this.isMandatory(childView)) this.absorb(childView, parent);
         else if (!this.absorbUnlessDropped(childView, parent)) {
            const option = this.optionFrom(childView, this.requires(parent));
            if (option !== undefined) this.loose.push(option);
         }
      }
      for (const group of view.childGroups) {
         if (group.tag === "entryLink" && this.isPassThrough(attribute(group, "targetId"))) continue;
         const groupView = this.conversion.view(group);
         if (groupView !== undefined) this.addGroup(groupView, parent);
      }
   }

   private isMandatory(view: EntryView): boolean {
      const constraints = constraintsByScope(view);
      const exactlyOne = constraintValue(constraints.get("parent min")) === 1 && constraintValue(constraints.get("parent max")) === 1;
      const plain = view.modifiers.length === 0 && view.modifierGroups.length === 0 && !view.hidden;
      return exactlyOne && plain && powerLevel(view) === 0;
   }

   /** An entry carried until a condition zeroes both its bounds: its weapons, removed while that condition holds, and its rules while it does not. */
   private absorbUnlessDropped(view: EntryView, parent: Option | undefined): boolean {
      if (!this.isDroppableWeapons(view)) return false;
      const [first, second] = flatModifiers(view.modifiers, [], this.context);
      if (first.condition === undefined || second.condition === undefined) {
         this.failed = true;
         return true;
      }
      if (first.condition === null || JSON.stringify(first.condition) !== JSON.stringify(second.condition)) {
         this.unhandled(view.element, "mandatory entry whose bounds are zeroed under different conditions");
         return true;
      }
      const holder: Option = { name: view.name };
      this.addProfiles(view, holder);
      const weapons = holder.addsWeapons ?? [];
      if (parent === undefined) this.weapons.push(...weapons);
      else (parent.addsWeapons ??= []).push(...weapons);
      const change = this.conditionalChange(allOf(this.requires(parent), first.condition)!);
      (change.removesWeapons ??= []).push(...weapons);
      if (holder.addsAbilities !== undefined) {
         const carried = this.conditionalChange(allOf(this.requires(parent), not(first.condition))!);
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
      return this.infoTargets(view.profiles, view.rules, view.infoLinks, view.infoGroups).every(
         ({ link, target }) => target !== undefined && isWeaponOrRule(target) && target.attributes.hidden !== "true" && isPlain(link) && isPlain(target),
      );
   }

   /** A mandatory entry is part of what holds it (the datasheet, or the option `parent`), with its own children. */
   private absorb(view: EntryView, parent: Option | undefined): void {
      if (parent === undefined) this.addCategories(view.categoryLinks, this.keywords, this.factionKeywords, nestedHolder(view));
      else this.addOptionCategories(view, parent);
      this.addProfiles(view, parent);
      this.addChildren(view, parent);
   }

   private addOptionCategories(view: EntryView, option: Option): void {
      const keywords = new Set<string>(option.addsKeywords);
      const factionKeywords = new Set<string>(option.addsFactionKeywords);
      this.addCategories(view.categoryLinks, keywords, factionKeywords, nestedHolder(view));
      if (keywords.size > 0) option.addsKeywords = [...keywords];
      if (factionKeywords.size > 0) option.addsFactionKeywords = [...factionKeywords];
   }

   private optionFrom(view: EntryView, inherited: Condition | undefined): Option | undefined {
      const id = this.slugs.byId.get(view.ids[0])!;
      const option: Option = { id, name: view.name };
      this.optionsBySlug.set(id, option);
      const cost = powerLevel(view);
      const modifiers = flatModifiers(view.modifiers, view.modifierGroups, this.context);
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
      if (maximumModifiers.some((modifier) => modifier.condition === undefined)) this.failed = true;
      else if (!isSimple && maximumBase > 0 && maximumModifiers.every(isZeroedWhen)) {
         option.maximum = maximumBase;
         availableWhen = allOf(availableWhen, not(combine("Any", maximumModifiers.map((modifier) => modifier.condition as Condition))!));
      } else if (!isSimple && maximumModifiers.length === 1 && isUnconditionalSet(maximumModifiers[0]) && Number(maximumModifiers[0].value) > 0) {
         option.maximum = Number(maximumModifiers[0].value);
      } else if (!isSimple) {
         option.maximum = maximumBase;
         this.deferred.push(() => this.setBound(option, "maximum", maximumConstraint!, modifiers, "option"));
      } else if (maximumConstraint !== undefined) {
         const converted = limitFrom(maximumConstraint, modifiers, { target: () => undefined, simplify: (terms) => terms }, this.context);
         if (converted === undefined) this.failed = true;
         else if (converted.limit.terms !== undefined) this.unhandled(maximumConstraint, "option maximum that grows");
         else if (converted.limit.base === 0 && converted.availableWhen === undefined) {
            this.conversion.report.recordDropped(view.element, "option with a maximum of 0");
            return undefined;
         } else {
            option.maximum = converted.limit.base;
            availableWhen = allOf(availableWhen, converted.availableWhen);
         }
      }
      const minimumConstraint = constraints.get("parent min");
      const minimumModifiers = minimumConstraint === undefined ? [] : modifiers.filter((modifier) => modifier.field === attribute(minimumConstraint, "id"));
      const isDroppedWithMaximum = (modifier: FlatModifier) => modifier.type === "set" && Number(modifier.value) === 0 && maximumModifiers.some((maximumModifier) => JSON.stringify(maximumModifier.condition) === JSON.stringify(modifier.condition));
      let minimumValue = minimum ?? 0;
      const requiredWhen: Condition[] = [];
      for (const modifier of minimumModifiers.filter((candidate) => !isDroppedWithMaximum(candidate))) {
         if (modifier.condition === undefined) this.failed = true;
         else if (modifier.repeats.length > 0 || modifier.type !== "set") this.unhandled(modifier.element, `option minimum ${modifier.type}`);
         else if (modifier.condition === null) minimumValue = Number(modifier.value);
         else if (Number(modifier.value) === 1 && minimumValue <= 0) requiredWhen.push(modifier.condition);
         else this.unhandled(modifier.element, "option minimum set with conditions to more than 1");
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
            for (const modifier of constraintModifiers) this.conversion.report.recordDropped(modifier.element, "army minimum the detachment's own keyword minimum already sets");
            continue;
         }
         if (field === undefined || value === undefined || value < 1 || modified) this.unhandled(constraint, `option constraint ${key}${modified ? " with modifiers" : ""}`);
         else option[field] = value;
      }
      for (const modifier of modifiers) {
         if (modifier.field === "hidden" || constraintIds.has(modifier.field)) continue;
         if (modifier.field === POWER_LEVEL_TYPE_ID && modifier.type === "set" && modifier.condition === null) option.cost = Number(modifier.value);
         else if (modifier.field === POWER_LEVEL_TYPE_ID && modifier.condition !== null && modifier.condition !== undefined && modifier.repeats.length === 0) {
            const amount = Number(modifier.value);
            const change = modifier.type === "set" ? { when: modifier.condition, set: amount } : { when: modifier.condition, increment: modifier.type === "decrement" ? -amount : amount };
            (option.costChanges ??= []).push(change);
         } else if (modifier.field === "name" && modifier.condition === null) option.name = modifier.value;
         else if (modifier.field === "name") this.dropConditionalRename(modifier);
         else this.unhandled(modifier.element, `option modifier ${modifier.type} ${modifier.field}${modifier.condition ? " with conditions" : ""}`);
      }
      if (option.cost === undefined && cost !== 0) option.cost = cost;
      const availability = availabilityOf(view.hidden, modifiers);
      if (availability === "Never") {
         this.conversion.report.recordDropped(view.element, "option hidden with no condition that shows it");
         return undefined;
      }
      if (availability !== undefined && availability !== "Always") availableWhen = allOf(availableWhen, availability);
      if (availableWhen !== undefined) option.availableWhen = availableWhen;
      this.addOptionCategories(view, option);
      this.addProfiles(view, option);
      this.addChildren(view, option);
      return option;
   }

   private addGroup(view: EntryView, parent: Option | undefined): void {
      const id = this.slugs.byId.get(view.ids[0])!;
      const modifiers = flatModifiers(view.modifiers, view.modifierGroups, this.context);
      const availability = availabilityOf(view.hidden, modifiers);
      if (availability === "Never") {
         this.conversion.report.recordDropped(view.element, "option group hidden with no condition that shows it");
         return;
      }
      const shownWhen = allOf(availability === "Always" || availability === undefined ? undefined : availability, this.requires(parent));
      const group: OptionGroup = { id, name: view.name, options: [] };
      const constraints = constraintsByScope(view);
      const minimum = constraintValue(constraints.get("parent min"));
      const maximum = constraintValue(constraints.get("parent max"));
      const minimumConstraint = constraints.get("parent min");
      const maximumConstraint = constraints.get("parent max");
      const boundIds = new Set([minimumConstraint, maximumConstraint].filter((constraint) => constraint !== undefined).map((constraint) => attribute(constraint, "id")));
      const minimumModified = minimumConstraint !== undefined && modifiers.some((modifier) => modifier.field === attribute(minimumConstraint, "id"));
      if (minimum !== undefined && minimum > 0 && parent === undefined && !minimumModified) group.minimum = minimum;
      if (minimum !== undefined && minimum > 0 && parent !== undefined) {
         this.conversion.report.recordCorrection(view.element, `minimum ${minimum} dropped: the group is only offered once ${parent.name} is taken`);
      }
      if (maximum !== undefined) group.maximum = maximum;
      if (minimumModified && parent === undefined) this.deferred.push(() => this.setBound(group, "minimum", minimumConstraint, modifiers, "option group"));
      if (maximumConstraint !== undefined && modifiers.some((modifier) => modifier.field === attribute(maximumConstraint, "id"))) {
         this.deferred.push(() => this.setBound(group, "maximum", maximumConstraint, modifiers, "option group"));
      }
      for (const key of constraints.keys()) if (!["parent min", "parent max"].includes(key)) this.unhandled(constraints.get(key)!, `option group constraint ${key}`);
      for (const modifier of modifiers) if (modifier.field !== "hidden" && !boundIds.has(modifier.field)) this.unhandled(modifier.element, `option group modifier ${modifier.type} ${modifier.field}`);
      this.groupOf.set(group, view);
      for (const child of view.childEntries) {
         if (child.tag === "entryLink" && this.isPassThrough(attribute(child, "targetId"))) continue;
         const childView = this.conversion.view(child);
         if (childView === undefined) continue;
         const option = this.optionFrom(childView, shownWhen);
         if (option !== undefined) group.options.push(option);
      }
      for (const nested of view.childGroups) {
         const nestedView = this.conversion.view(nested);
         if (nestedView !== undefined) this.addGroup(nestedView, parent);
      }
      if (view.defaultSelectionEntryId !== undefined) {
         const fallback = this.slugs.byId.get(view.defaultSelectionEntryId);
         if (fallback !== undefined && group.options.some((option) => option.id === fallback)) group.default = fallback;
         else this.unhandled(view.element, "default selection that is not one of the group's options");
      }
      if (group.options.length === 0) {
         if (view.childGroups.length === 0) this.conversion.report.recordDropped(view.element, "option group with no options left");
         return;
      }
      this.groups.push(group);
   }

   /** The options a condition requires, when it is one option taken or any of several. */
   private optionsTaken(condition: Condition | null | undefined): string[] | undefined {
      const single = this.optionTaken(condition);
      if (single !== undefined) return [single];
      if (condition?.kind !== "Any") return undefined;
      const each = condition.conditions.map((part) => this.optionTaken(part));
      return each.every((option) => option !== undefined) ? (each as string[]) : undefined;
   }

   /** The group holding an option, when that group lets the unit take only one of its options. */
   private exclusiveGroupOf(optionSlug: string): OptionGroup | undefined {
      const group = this.groups.find((candidate) => candidate.options.some((option) => option.id === optionSlug));
      return group?.maximum === 1 ? group : undefined;
   }

   /** Whether the unit must take exactly one of the group's options and each is one of these, so a set always replaces the base. */
   private alwaysTakesOneOf(group: OptionGroup, options: string[]): boolean {
      const isRequired = typeof group.minimum === "number" && group.minimum >= 1;
      return isRequired && group.options.every((option) => options.includes(option.id!));
   }

   /** A group's or option's bound set or incremented by other options, as a limit counting them; a set needs options that exclude each other. */
   private setBound(holder: OptionGroup | Option, bound: "minimum" | "maximum", constraint: Element, modifiers: FlatModifier[], label: string): void {
      const owner = "options" in holder ? holder : this.groups.find((candidate) => candidate.options.includes(holder));
      const constraintId = attribute(constraint, "id");
      let base = Number(attribute(constraint, "value"));
      const amounts = new Map<string, { set?: number; increment: number }>();
      for (const modifier of modifiers.filter((candidate) => candidate.field === constraintId)) {
         if (modifier.condition === undefined) {
            this.failed = true;
            return;
         }
         const signed = Number(modifier.value) * (modifier.type === "decrement" ? -1 : 1);
         if (modifier.condition === null && modifier.type === "set" && modifier.repeats.length === 0 && amounts.size === 0) {
            base = signed;
            continue;
         }
         const counted = modifier.condition === null ? this.repeatedOptions(modifier) : modifier.repeats.length === 0 ? this.optionsTaken(modifier.condition) : undefined;
         if (counted === undefined || (modifier.type === "set" && modifier.condition === null)) {
            this.unhandled(modifier.element, `${label} ${bound} ${modifier.type} that does not count the unit's options`);
            return;
         }
         for (const option of counted) {
            const amount = amounts.get(option) ?? { increment: 0 };
            if (modifier.type === "set") {
               if (amount.increment !== 0) {
                  this.unhandled(modifier.element, `${label} ${bound} set after an increment for the same option`);
                  return;
               }
               amount.set = signed;
            } else amount.increment += signed;
            amounts.set(option, amount);
         }
      }
      const setOptions = [...amounts].filter(([, amount]) => amount.set !== undefined).map(([option]) => option);
      const exclusive = new Set(setOptions.map((option) => this.exclusiveGroupOf(option)));
      if (setOptions.length > 0 && (exclusive.size !== 1 || exclusive.has(undefined) || (owner !== undefined && exclusive.has(owner)))) {
         this.unhandled(constraint, `${label} ${bound} set by options that do not exclude each other`);
         return;
      }
      const [setGroup] = exclusive;
      if (setGroup !== undefined && this.alwaysTakesOneOf(setGroup, setOptions)) base = 0;
      if (base < 0) {
         this.unhandled(constraint, `${label} ${bound} with a negative base`);
         return;
      }
      const terms: LimitTerm[] = [];
      for (const [option, amount] of amounts) {
         const total = (amount.set === undefined ? 0 : amount.set - base) + amount.increment;
         if (total !== 0) terms.push({ per: { kind: "Option", option }, scope: "Unit", amount: total });
      }
      if (terms.length > 0) holder[bound] = { base, terms };
      else if (bound === "minimum" && base > 0) holder.minimum = base;
      else if (bound === "maximum") holder.maximum = base;
   }

   /** The options a repeating increment counts in the unit, one per repeat. */
   private repeatedOptions(modifier: FlatModifier): string[] | undefined {
      if (modifier.repeats.length === 0) return undefined;
      const options = modifier.repeats.map((repeat) => {
         const scopeId = attribute(repeat, "scope");
         const isUnit = scopeId === "parent" || this.slugs.allIds.has(scopeId);
         return isUnit && attribute(repeat, "value") === "1.0" ? this.slugs.byId.get(attribute(repeat, "childId")) : undefined;
      });
      return options.every((option) => option !== undefined) ? (options as string[]) : undefined;
   }

   /** Whether every modifier raises the minimum only inside a detachment type whose keyword limits already require that many of a keyword the entry has. */
   private isDetachmentKeywordMinimum(view: EntryView, modifiers: FlatModifier[]): boolean {
      const keywords = view.categoryLinks.map((link) => this.conversion.registry.category(attribute(link, "targetId"))).flatMap((category) => (category?.kind === "Keyword" ? [category.keyword] : []));
      return modifiers.every((modifier) => {
         const condition = modifier.condition;
         if (modifier.type !== "set" || condition?.kind !== "Count" || condition.scope !== "Detachment" || condition.of.kind !== "Detachment") return false;
         const detachment = condition.of.detachment;
         const required = Number(modifier.value);
         return keywords.some((keyword) => (this.conversion.gameSystem.keywordMinimum(detachment, keyword) ?? 0) >= required);
      });
   }

   /** A name that changes under a condition only labels what the condition already shows, such as a mount or a model count. */
   private dropConditionalRename(modifier: FlatModifier): void {
      this.conversion.report.recordDropped(modifier.element, `display rename to "${modifier.value}" under a condition`);
   }

   private applyUnitModifiers(modifiers: FlatModifier[]): void {
      const baseCost = this.cost;
      for (const modifier of modifiers) {
         if (modifier.field === "hidden" || modifier.condition === undefined) continue;
         if (modifier.field === POWER_LEVEL_TYPE_ID && modifier.condition === null && modifier.type === "set") {
            this.cost = Number(modifier.value);
            continue;
         }
         const taken = this.optionTaken(modifier.condition);
         const option = taken === undefined ? undefined : this.optionsBySlug.get(taken);
         if (modifier.field === POWER_LEVEL_TYPE_ID && option !== undefined && modifier.repeats.length === 0) {
            const delta = modifier.type === "set" ? Number(modifier.value) - baseCost : Number(modifier.value) * (modifier.type === "decrement" ? -1 : 1);
            option.cost = (option.cost ?? 0) + delta;
            continue;
         }
         if (modifier.field === POWER_LEVEL_TYPE_ID && modifier.repeats.length === 0 && modifier.type !== "set") {
            const amount = Number(modifier.value) * (modifier.type === "decrement" ? -1 : 1);
            if (modifier.condition === null) this.cost += amount;
            else this.costChanges.push({ when: modifier.condition, increment: amount });
            continue;
         }
         if (modifier.field === POWER_LEVEL_TYPE_ID && modifier.repeats.length === 0 && modifier.condition !== null) {
            this.costChanges.push({ when: modifier.condition, set: Number(modifier.value) });
            continue;
         }
         if (modifier.field === "name" && modifier.condition === null) continue;
         if (modifier.field === "name") {
            this.dropConditionalRename(modifier);
            continue;
         }
         this.unhandled(modifier.element, `unit modifier ${modifier.type} ${modifier.field}${modifier.condition ? " with conditions" : ""}${modifier.repeats.length > 0 ? " with repeats" : ""}`);
      }
   }
}

/** The childId BattleScribe uses to count every model in a unit. */
const MODEL_COUNT_ID = "model";
