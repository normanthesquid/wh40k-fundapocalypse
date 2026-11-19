import type { OutputBuilder } from "./builder.ts";
import { allOf, combine, not, type ConditionContext } from "./conditions.ts";
import type { Conversion, OptionSlugs } from "./conversion.ts";
import { constraintsByScope, constraintValue, POWER_LEVEL_TYPE_ID, powerLevel, viewOf, type EntryView } from "./entries.ts";
import type { AlternativeRole, BattlefieldRole, Condition, DetachmentMinimum, ConditionalChange, CostChange, CountTarget, Datasheet, Option } from "./model.ts";
import { availabilityOf, flatModifiers, flatModifiersOf, type FlatModifier } from "./modifiers.ts";
import { CONDITION_TARGET_CORRECTIONS, describeSource, MISSING_ROLES, STRAY_ROLE_LINKS } from "./corrections.ts";
import { UnitProfiles } from "./unitProfiles.ts";
import { isMandatory, Wargear, type CategoryHolder, type InfoTarget, type UnitLimit } from "./wargear.ts";
import { addWeaponVariants, carriedWeapon, type VariantContext } from "./weaponVariants.ts";
import { characteristicNamesById, isDroppedProfile, TRANSPORT_PROFILE, transportFromProfile, UNIT_PROFILE, WEAPON_PROFILE } from "./profiles.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

interface SecondaryRole {
   readonly link: Element;
   readonly role: BattlefieldRole;
   readonly holder: CategoryHolder;
}

/** BattleScribe's value for a constraint with no limit. */
const BATTLESCRIBE_UNLIMITED = -1;

export class DatasheetConverter {
   readonly context: ConditionContext;
   private readonly weapons: string[] = [];
   private readonly abilities = new Set<string>();
   private readonly keywords = new Set<string>();
   private readonly factionKeywords = new Set<string>();
   private readonly deferred: (() => void)[] = [];
   private readonly conditionalChanges = new Map<string, ConditionalChange>();
   private readonly wargear: Wargear;
   private readonly unitProfiles: UnitProfiles;
   private readonly costChanges: CostChange[] = [];
   private readonly secondaryRoles: SecondaryRole[] = [];
   private readonly correctedTargets = new Set<string>();
   private readonly alternativeRoles: AlternativeRole[] = [];
   private carriedParts: Map<string, string> | undefined;
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
      this.wargear = new Wargear({
         conversion,
         slugs,
         context: this.context,
         weapons: this.weapons,
         keywords: this.keywords,
         factionKeywords: this.factionKeywords,
         addCategories: (links, keywords, factionKeywords, holder) => this.addCategories(links, keywords, factionKeywords, holder),
         addProfiles: (entry, option) => this.addProfiles(entry, option),
         infoTargets: (profiles, rules, infoLinks, infoGroups) => this.infoTargets(profiles, rules, infoLinks, infoGroups),
         conditionalChange: (when) => this.conditionalChange(when),
         requires: (option) => this.requires(option),
         unitLimit: (constraint, modifiers, label) => this.unitLimit(constraint, modifiers, label),
         optionTaken: (condition) => this.optionTaken(condition),
         defer: (apply) => this.deferred.push(apply),
         unhandled: (element, message) => this.unhandled(element, message),
         fail: () => {
            this.failed = true;
         },
         dropConditionalRename: (modifier) => this.dropConditionalRename(modifier),
      });
      this.unitProfiles = new UnitProfiles({
         conversion,
         view,
         groups: this.wargear.groups,
         optionsBySlug: this.wargear.optionsBySlug,
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

   private countTarget(sourceChildId: string): CountTarget | undefined {
      const childId = this.correctedChildId(sourceChildId);
      const holder = this.carriedPartsOf().get(childId);
      if (holder !== undefined) return { kind: "Option", option: holder };
      const local = this.slugs.byId.get(childId);
      if (local !== undefined && this.slugs.groups.has(local)) return { kind: "OptionGroup", group: local };
      if (local !== undefined) return { kind: "Option", option: local };
      if (childId === MODEL_COUNT_ID) return this.modelOption();
      return this.catalogueTarget(childId) ?? this.conversion.globalCountTarget(this.builder, childId);
   }

   /** Entries an option always carries, by id, mapped to that option: counting one counts the option. */
   private carriedPartsOf(): Map<string, string> {
      if (this.carriedParts !== undefined) return this.carriedParts;
      const parts = new Map<string, string>();
      const walk = (view: EntryView, option: string | undefined) => {
         for (const child of [...view.childEntries, ...view.childGroups]) {
            const childView = viewOf(this.conversion.registry, child);
            if (childView === undefined) continue;
            const isPart = childView.kind !== "group" && isMandatory(childView);
            if (isPart && option !== undefined) for (const id of childView.ids) parts.set(id, option);
            const isOption = childView.kind !== "group" && !isPart;
            walk(childView, isOption ? this.slugs.byId.get(childView.ids[0]) : option);
         }
      };
      walk(this.view, undefined);
      this.carriedParts = parts;
      return parts;
   }

   /** The unit's own entry in place of another unit's that the correction table says a condition names by mistake. */
   private correctedChildId(childId: string): string {
      const correction = CONDITION_TARGET_CORRECTIONS.find((entry) => entry.childId === childId && this.view.ids.includes(entry.unitId));
      if (correction === undefined) return childId;
      if (!this.correctedTargets.has(childId)) this.conversion.report.recordCorrection(this.view.element, `conditions on ${correction.name} name the unit's own entry (${describeSource(correction.source)})`);
      this.correctedTargets.add(childId);
      return correction.correctedChildId;
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
      const constraints = constraintsByScope(view);
      // A top-level unit's parent is its detachment, so scope=parent bounds it per detachment too.
      const maximumKey = constraints.has("force max") ? "force max" : "parent max";
      const detachmentConstraint = constraints.get(maximumKey);
      const armyConstraint = constraints.get("roster max");
      const minimumKey = constraints.has("force min") ? "force min" : "parent min";
      const minimumConstraint = constraints.get(minimumKey);
      const limitIds = new Set([detachmentConstraint, armyConstraint, minimumConstraint].filter((constraint) => constraint !== undefined).map((constraint) => attribute(constraint, "id")));
      this.addCategories(view.categoryLinks, this.keywords, this.factionKeywords, "Unit");
      this.addProfiles(view, undefined);
      this.wargear.addChildren(view, undefined);
      this.unitProfiles.resolve();
      this.applyUnitModifiers(this.applyRoleSwaps(modifiers.filter((modifier) => !limitIds.has(modifier.field))));
      for (const apply of this.deferred) apply();
      this.unitProfiles.addSizedProfiles();
      if (this.role === undefined) this.role = this.roleFromLinks();
      if (this.role === undefined) this.role = this.roleFromCorrections();
      if (this.role === undefined) this.unhandled(view.element, "no primary battlefield role");
      this.resolveSecondaryRoles();
      const profiles = this.unitProfiles.profiles;
      if (profiles.length === 0) this.unitProfiles.checkProfileless();
      const perDetachment = this.unitLimit(detachmentConstraint, modifiers);
      const perArmy = this.unitLimit(armyConstraint, modifiers);
      const required = this.detachmentMinimum(minimumConstraint, modifiers);
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
      if (this.alternativeRoles.length > 0) datasheet.alternativeRoles = this.alternativeRoles;
      const wargear = [...this.wargear.groups];
      if (this.wargear.loose.length > 0) wargear.push({ id: this.slugs.optionsGroup, name: "Upgrades", options: this.wargear.loose });
      if (wargear.length > 0) datasheet.wargear = wargear;
      const availability = availabilityOf(view.hidden, modifiers);
      if (availability === "Never") {
         this.conversion.report.recordDropped(view.element, "unit hidden with no condition that shows it");
         return undefined;
      }
      if (availability !== undefined && availability !== "Always") datasheet.availableWhen = availability;
      if (perDetachment.maximum !== undefined) datasheet.maximumPerDetachment = perDetachment.maximum;
      if (perArmy.maximum !== undefined) datasheet.maximumPerArmy = perArmy.maximum;
      const limitedWhen = allOf(datasheet.availableWhen, perDetachment.availableWhen, perArmy.availableWhen);
      if (limitedWhen !== undefined) datasheet.availableWhen = limitedWhen;
      if (required !== undefined) datasheet.requiredInDetachment = required;
      for (const key of constraints.keys()) if (!["roster max", maximumKey, minimumKey].includes(key)) this.unhandled(constraints.get(key)!, `unit constraint ${key}`);
      return datasheet;
   }

   /** A maximum that conditions drop to 0 makes the unit or option unavailable then; one they lift from 0 makes it available only then. */
   private unitLimit(constraint: Element | undefined, modifiers: FlatModifier[], label = "unit"): UnitLimit {
      const base = constraintValue(constraint);
      if (constraint === undefined || base === undefined) return {};
      const changes = modifiers.filter((modifier) => modifier.field === attribute(constraint, "id"));
      if (changes.length === 0) return { maximum: base };
      if (changes.some((modifier) => modifier.condition === undefined)) {
         this.failed = true;
         return {};
      }
      const conditions = changes.map((modifier) => (modifier.type === "set" && modifier.repeats.length === 0 ? (modifier.condition ?? undefined) : undefined));
      const values = new Set(changes.map((modifier) => Number(modifier.value)));
      const isAllSet = conditions.every((condition) => condition !== undefined);
      const when = isAllSet ? combine("Any", conditions as Condition[]) : undefined;
      if (when !== undefined && base > 0 && values.size === 1 && values.has(0)) return { maximum: base, availableWhen: not(when) };
      if (when !== undefined && base === 0 && values.size === 1 && values.has(BATTLESCRIBE_UNLIMITED)) return { availableWhen: when };
      for (const change of changes) this.unhandled(change.element, `${label} modifier ${change.type} ${change.field}${change.condition ? " with conditions" : ""}`);
      return {};
   }

   /** A detachment minimum of 0 that conditions all raise to one value: the detachment needs that many while any of them holds. */
   private detachmentMinimum(constraint: Element | undefined, modifiers: FlatModifier[]): DetachmentMinimum | undefined {
      if (constraint === undefined) return undefined;
      const changes = modifiers.filter((modifier) => modifier.field === attribute(constraint, "id"));
      if (changes.some((modifier) => modifier.condition === undefined)) {
         this.failed = true;
         return undefined;
      }
      const values = new Set(changes.map((modifier) => Number(modifier.value)));
      const [minimum] = values;
      const isConditionalSet = changes.length > 0 && changes.every((modifier) => modifier.type === "set" && modifier.repeats.length === 0 && modifier.condition !== null);
      if (constraintValue(constraint) === 0 && isConditionalSet && values.size === 1 && minimum >= 1) {
         return { minimum, when: combine("Any", changes.map((modifier) => modifier.condition as Condition))! };
      }
      if (changes.length === 0 && constraintValue(constraint) === 0) return undefined;
      this.unhandled(constraint, "unit detachment minimum that is not raised by conditions alone");
      return undefined;
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
         else if (this.isStrayRoleLink(link, role)) continue;
         else this.unhandled(link, "battlefield role that is not the unit's primary category");
      }
   }

   /** The correction table's stray role link, recorded as removed. */
   private isStrayRoleLink(link: Element, role: BattlefieldRole): boolean {
      const stray = STRAY_ROLE_LINKS.find((entry) => entry.linkId === attribute(link, "id"));
      if (stray !== undefined) this.conversion.report.recordCorrection(link, `second battlefield role ${role} removed (${describeSource(stray.source)})`);
      return stray !== undefined;
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
   private infoTargets(profiles: Element[], rules: Element[], infoLinks: Element[], infoGroups: Element[]): InfoTarget[] {
      const targets: InfoTarget[] = [...profiles.filter((profile) => !isDroppedProfile(profile)), ...rules].map((target) => ({ link: undefined, target }));
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
               const takenOption = this.wargear.optionsBySlug.get(taken);
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

   /** A condition that `parent` is taken, for wargear nested under it, which is flattened into the datasheet's own groups. */
   private requires(parent: Option | undefined): Condition | undefined {
      if (parent === undefined) return undefined;
      return { kind: "Count", scope: "Unit", of: { kind: "Option", option: parent.id! }, minimum: 1 };
   }

   /** A name that changes under a condition only labels what the condition already shows, such as a mount or a model count. */
   private dropConditionalRename(modifier: FlatModifier): void {
      this.conversion.report.recordDropped(modifier.element, `display rename to "${modifier.value}" under a condition`);
   }

   /** Category modifiers that together make another role primary under a condition, e.g. Khorne Berserkers as Troops; returns the rest. */
   private applyRoleSwaps(modifiers: FlatModifier[]): FlatModifier[] {
      const categoryModifiers = modifiers.filter((modifier) => modifier.field === "category" && modifier.condition);
      const rest = modifiers.filter((modifier) => !categoryModifiers.includes(modifier));
      const byCondition = Map.groupBy(categoryModifiers, (modifier) => JSON.stringify(modifier.condition));
      for (const group of byCondition.values()) {
         const primary = group.find((modifier) => modifier.type === "set-primary");
         const role = primary === undefined ? undefined : this.roleOf(primary.value);
         const isSwap = role !== undefined && group.every((modifier) => modifier === primary || (modifier.type === "add" && modifier.value === primary!.value) || (modifier.type === "remove" && this.roleOf(modifier.value) === this.role));
         if (isSwap) this.alternativeRoles.push({ battlefieldRole: role, when: primary!.condition as Condition });
         else rest.push(...group);
      }
      return rest;
   }

   private roleOf(categoryId: string): BattlefieldRole | undefined {
      const category = this.conversion.registry.category(categoryId);
      return category?.kind === "Role" ? category.role : undefined;
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
         const option = taken === undefined ? undefined : this.wargear.optionsBySlug.get(taken);
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
