import type { OutputBuilder } from "./builder.ts";
import { allOf, combine, not, type ConditionContext } from "./conditions.ts";
import { COMMANDER_ENTRY_ID, WARMASTER_TRAITS_GROUP_ID, type Conversion, type OptionSlugs } from "./conversion.ts";
import { constraintsByScope, constraintValue, POWER_LEVEL_TYPE_ID, powerLevel, viewOf, type EntryView } from "./entries.ts";
import type { BattlefieldRole, Condition, ConditionalChange, CountTarget, Datasheet, LimitTerm, ModelProfile, Option, OptionGroup, ProfileValues } from "./model.ts";
import { flatModifiers, flatModifiersOf, limitFrom, type FlatModifier } from "./modifiers.ts";
import { describeSource, MISSING_PROFILES, MISSING_ROLES, PROFILELESS_DATASHEETS, SIZED_PROFILES } from "./corrections.ts";
import { addWeaponVariants, carriedWeapon, type VariantContext } from "./weaponVariants.ts";
import { characteristicNamesById, CHARACTERISTIC_TYPE_IDS, isDroppedProfile, parseCharacteristic, profileFromCharacteristics, take, UNIT_CHARACTERISTICS, TRANSPORT_PROFILE, transportFromProfile, UNIT_PROFILE, unitProfile, WEAPON_PROFILE } from "./profiles.ts";
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

const INCREMENTABLE: ReadonlySet<keyof ProfileValues> = new Set(["attacks", "wounds", "leadership"]);

export class DatasheetConverter {
   readonly context: ConditionContext;
   private readonly profiles: ModelProfile[] = [];
   private readonly weapons: string[] = [];
   private readonly abilities = new Set<string>();
   private readonly keywords = new Set<string>();
   private readonly factionKeywords = new Set<string>();
   private readonly groups: OptionGroup[] = [];
   private readonly loose: Option[] = [];
   private readonly optionsBySlug = new Map<string, Option>();
   private readonly deferred: (() => void)[] = [];
   private readonly optionProfiles: OptionProfile[] = [];
   private readonly groupOf = new Map<OptionGroup, EntryView>();
   private readonly conditionalChanges = new Map<string, ConditionalChange>();
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
   }

   private unhandled(element: Element, message: string): void {
      this.failed = true;
      this.conversion.report.failUnhandled(element, message);
   }

   private countTarget(childId: string): CountTarget | undefined {
      const local = this.slugs.byId.get(childId);
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
      this.addCategories(view.categoryLinks, this.keywords, this.factionKeywords, true);
      this.addProfiles(view, undefined);
      this.addChildren(view, undefined);
      this.resolveOptionProfiles();
      if (this.profiles.length === 0) this.addMissingProfile();
      this.applyUnitModifiers(modifiers);
      for (const apply of this.deferred) apply();
      this.addSizedProfiles();
      if (this.role === undefined) this.role = this.roleFromLinks();
      if (this.role === undefined) this.role = this.roleFromCorrections();
      if (this.role === undefined) this.unhandled(view.element, "no primary battlefield role");
      if (this.profiles.length === 0) this.checkProfileless();
      if (this.failed || this.role === undefined) return undefined;
      const renamed = modifiers.find((modifier) => modifier.field === "name" && modifier.type === "set" && modifier.condition === null);
      const datasheet: Datasheet = { name: renamed?.value ?? view.name, battlefieldRole: this.role, cost: this.cost, keywords: [...this.keywords] };
      if (this.profiles.length > 0) datasheet.profiles = this.profiles;
      if (this.factionKeywords.size > 0) datasheet.factionKeywords = [...this.factionKeywords];
      if (this.weapons.length > 0) datasheet.weapons = this.weapons;
      if (this.abilities.size > 0) datasheet.abilities = [...this.abilities];
      if (this.transport !== undefined) datasheet.transport = this.transport;
      if (this.conditionalChanges.size > 0) datasheet.conditionalChanges = [...this.conditionalChanges.values()];
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

   private addCategories(links: Element[], keywords: Set<string>, factionKeywords: Set<string>, isUnit: boolean): void {
      for (const link of links) {
         if (link.children.length > 0) this.unhandled(link, "category link with modifiers or constraints");
         const category = this.conversion.registry.category(attribute(link, "targetId"));
         if (category === undefined) this.unhandled(link, "category link to a missing category");
         else if (category.kind === "Role" && isUnit && link.attributes.primary === "true") this.role = category.role;
         else if (category.kind === "Role") this.unhandled(link, "battlefield role that is not the unit's primary category");
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
         else if (target.tag === "profile" && attribute(target, "typeName") === UNIT_PROFILE) this.addUnitProfile(target, kept, option);
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

   /** The correction table's profile for a unit the data gives none. */
   private addMissingProfile(): void {
      const missing = MISSING_PROFILES.find((entry) => this.view.ids.includes(entry.unitId));
      if (missing === undefined) return;
      const profile = profileFromCharacteristics(new Map(Object.entries(missing.printed)), this.view.element, missing.name, new Map(), this.conversion.report);
      if (profile === undefined) return;
      this.conversion.report.recordCorrection(this.view.element, `profile ${missing.name} added (${describeSource(missing.source)})`);
      this.profiles.push(profile);
   }

   /** A datasheet without a stat line is right only where the official datasheet prints none. */
   private checkProfileless(): void {
      const profileless = PROFILELESS_DATASHEETS.find((entry) => this.view.ids.includes(entry.unitId));
      if (profileless === undefined) this.unhandled(this.view.element, "no unit profile");
      else this.conversion.report.recordCorrection(this.view.element, `no stat line, as printed (${describeSource(profileless.source)})`);
   }

   /** Characteristics that grow with the unit's models, as changes while it has that many. */
   private addSizedProfiles(): void {
      const sized = SIZED_PROFILES.find((entry) => this.view.ids.includes(entry.unitId));
      if (sized === undefined) return;
      const models = this.modelOption();
      if (models === undefined || this.profiles.length !== 1) {
         this.unhandled(this.view.element, "sized profile without one model option and one profile");
         return;
      }
      for (const { models: count, printed } of sized.sizes) {
         const set: ProfileValues = {};
         for (const [characteristic, field] of UNIT_CHARACTERISTICS) {
            const value = printed[characteristic];
            if (value === undefined) continue;
            const parsed = take(parseCharacteristic(field, value), this.view.element, characteristic, this.conversion.report);
            if (parsed !== null && parsed !== undefined) (set as Record<string, unknown>)[field] = parsed;
         }
         const when: Condition = { kind: "Count", scope: "Unit", of: models, minimum: count, maximum: count };
         (this.conditionalChange(when).profileChanges ??= []).push({ set });
      }
      this.conversion.report.recordCorrection(this.view.element, `profile by model count added (${describeSource(sized.source)})`);
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

   private addUnitProfile(target: Element, modifiers: FlatModifier[], option: Option | undefined): void {
      let name = attribute(target, "name").trim();
      const overrides = new Map<keyof ProfileValues, string>();
      const conditional: FlatModifier[] = [];
      for (const modifier of modifiers) {
         if (modifier.condition === undefined) return;
         if (modifier.condition !== null) conditional.push(modifier);
         else if (modifier.field === "name" && modifier.type === "set") name = modifier.value;
         else if (modifier.type === "set" && CHARACTERISTIC_TYPE_IDS[modifier.field] !== undefined) overrides.set(CHARACTERISTIC_TYPE_IDS[modifier.field], modifier.value);
         else this.unhandled(modifier.element, `unit profile modifier ${modifier.type} ${modifier.field}`);
      }
      const profile = unitProfile(target, name, overrides, this.conversion.report);
      if (profile === undefined) {
         this.failed = true;
         return;
      }
      if (option !== undefined) {
         this.optionProfiles.push({ option, profile, element: target, conditional });
         return;
      }
      this.profiles.push(profile);
      for (const modifier of conditional) this.deferred.push(() => this.addProfileChange(modifier, profile.name));
   }

   private addProfileChange(modifier: FlatModifier, profileName: string): void {
      const field = CHARACTERISTIC_TYPE_IDS[modifier.field];
      const taken = this.optionTaken(modifier.condition);
      const option = taken === undefined ? undefined : this.optionsBySlug.get(taken);
      if (field === undefined || modifier.condition === null || modifier.condition === undefined) {
         this.unhandled(modifier.element, `conditional unit profile modifier ${modifier.type} ${modifier.field}`);
         return;
      }
      const changes = ((option ?? this.conditionalChange(modifier.condition)).profileChanges ??= []);
      const isAdded = !this.profiles.some((profile) => profile.name === profileName);
      const forProfile = this.profiles.length > 1 || isAdded ? profileName : undefined;
      let change = changes.find((existing) => existing.profile === forProfile);
      if (change === undefined) {
         change = forProfile === undefined ? {} : { profile: forProfile };
         changes.push(change);
      }
      if (modifier.type === "set") {
         const parsed = take(parseCharacteristic(field, modifier.value), modifier.element, field, this.conversion.report);
         if (parsed === null || parsed === undefined) this.failed = true;
         else (change.set ??= {})[field] = parsed as never;
      } else if ((modifier.type === "increment" || modifier.type === "decrement") && INCREMENTABLE.has(field)) {
         const amount = Number(modifier.value) * (modifier.type === "decrement" ? -1 : 1);
         (change.increment ??= {})[field as "attacks" | "wounds" | "leadership"] = amount;
      } else this.unhandled(modifier.element, `profile ${modifier.type} on ${field}`);
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
         else {
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

   /** A mandatory entry is part of what holds it (the datasheet, or the option `parent`), with its own children. */
   private absorb(view: EntryView, parent: Option | undefined): void {
      if (parent === undefined) this.addCategories(view.categoryLinks, this.keywords, this.factionKeywords, false);
      else this.addOptionCategories(view, parent);
      this.addProfiles(view, parent);
      this.addChildren(view, parent);
   }

   private addOptionCategories(view: EntryView, option: Option): void {
      const keywords = new Set<string>(option.addsKeywords);
      const factionKeywords = new Set<string>(option.addsFactionKeywords);
      this.addCategories(view.categoryLinks, keywords, factionKeywords, false);
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
      if (maximumConstraint !== undefined) {
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
      if (minimum !== undefined && minimum > 0) option.minimum = minimum;
      const constraintIds = new Set(view.constraints.map((constraint) => attribute(constraint, "id")));
      const wider = { "force max": "maximumPerDetachment", "roster max": "maximumPerArmy", "roster min": "minimumPerArmy" } as const;
      for (const [key, constraint] of constraints) {
         if (key === "parent min" || key === "parent max") continue;
         const field = wider[key as keyof typeof wider];
         const value = constraintValue(constraint);
         const modified = modifiers.some((modifier) => modifier.field === attribute(constraint, "id"));
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
      if (minimumModified && parent === undefined) this.deferred.push(() => this.setGroupBound(group, "minimum", minimumConstraint, modifiers));
      if (maximumConstraint !== undefined && modifiers.some((modifier) => modifier.field === attribute(maximumConstraint, "id"))) {
         this.deferred.push(() => this.setGroupBound(group, "maximum", maximumConstraint, modifiers));
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

   /** A group bound set or incremented by other options, as a limit counting them; a set needs options that exclude each other. */
   private setGroupBound(group: OptionGroup, bound: "minimum" | "maximum", constraint: Element, modifiers: FlatModifier[]): void {
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
            this.unhandled(modifier.element, `option group ${bound} ${modifier.type} that does not count the unit's options`);
            return;
         }
         for (const option of counted) {
            const amount = amounts.get(option) ?? { increment: 0 };
            if (modifier.type === "set") {
               if (amount.increment !== 0) {
                  this.unhandled(modifier.element, `option group ${bound} set after an increment for the same option`);
                  return;
               }
               amount.set = signed;
            } else amount.increment += signed;
            amounts.set(option, amount);
         }
      }
      const setOptions = [...amounts].filter(([, amount]) => amount.set !== undefined).map(([option]) => option);
      const exclusive = new Set(setOptions.map((option) => this.exclusiveGroupOf(option)));
      if (setOptions.length > 0 && (exclusive.size !== 1 || exclusive.has(undefined) || exclusive.has(group))) {
         this.unhandled(constraint, `option group ${bound} set by options that do not exclude each other`);
         return;
      }
      const [setGroup] = exclusive;
      if (setGroup !== undefined && this.alwaysTakesOneOf(setGroup, setOptions)) base = 0;
      if (base < 0) {
         this.unhandled(constraint, `option group ${bound} with a negative base`);
         return;
      }
      const terms: LimitTerm[] = [];
      for (const [option, amount] of amounts) {
         const total = (amount.set === undefined ? 0 : amount.set - base) + amount.increment;
         if (total !== 0) terms.push({ per: { kind: "Option", option }, scope: "Unit", amount: total });
      }
      if (terms.length > 0) group[bound] = { base, terms };
      else if (bound === "minimum" && base > 0) group.minimum = base;
      else if (bound === "maximum") group.maximum = base;
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

   /** Unit-size options that each carry the whole unit's profile: the default size's becomes the datasheet's, the others change it. */
   private resolveOptionProfiles(): void {
      const byOption = new Map<Option, OptionProfile[]>();
      for (const entry of this.optionProfiles) byOption.set(entry.option, [...(byOption.get(entry.option) ?? []), entry]);
      const isUnitSize = (group: OptionGroup) => group.options.every((option) => byOption.get(option)?.length === 1);
      for (const group of this.groups) {
         if (this.profiles.length > 0 || !isUnitSize(group)) continue;
         for (const option of group.options) for (const { conditional } of byOption.get(option)!) for (const modifier of conditional) this.unhandled(modifier.element, "conditional modifier on a unit-size profile");
         const baseOption = group.options.find((option) => option.id === group.default) ?? group.options[0];
         const base = { ...byOption.get(baseOption)![0].profile, name: baseProfileName(byOption.get(baseOption)![0].profile.name) };
         this.profiles.push(base);
         for (const option of group.options) {
            if (option === baseOption) continue;
            const { profile, element } = byOption.get(option)![0];
            const set: ProfileValues = {};
            for (const key of new Set([...Object.keys(base), ...Object.keys(profile)])) {
               if (key === "name") continue;
               const field = key as keyof ProfileValues;
               if (JSON.stringify(base[field]) === JSON.stringify(profile[field])) continue;
               if (profile[field] === undefined) this.unhandled(element, `unit-size profile without the ${field} the default size has`);
               else (set as Record<string, unknown>)[field] = profile[field];
            }
            if (Object.keys(set).length > 0) (option.profileChanges ??= []).push({ set });
            byOption.delete(option);
         }
         byOption.delete(baseOption);
      }
      for (const [option, entries] of byOption) this.placeOptionProfiles(option, entries);
   }

   /** A model the unit must take (e.g. a squadron's first vehicle) is the datasheet's profile; an optional one is added by its option. */
   private placeOptionProfiles(option: Option, entries: OptionProfile[]): void {
      for (const { profile, conditional } of entries) for (const modifier of conditional) this.deferred.push(() => this.addProfileChange(modifier, profile.name));
      if (this.profiles.length === 0 && (option.minimum ?? 0) >= 1) {
         this.profiles.push(...entries.map((entry) => entry.profile));
         return;
      }
      for (const { profile, element } of entries) {
         const same = this.profiles.find((existing) => existing.name === profile.name);
         if (same !== undefined && JSON.stringify(same) === JSON.stringify(profile)) continue;
         if (same !== undefined || option.addsProfiles?.some((added) => added.name === profile.name)) this.unhandled(element, "option profile whose name the unit already uses");
         else (option.addsProfiles ??= []).push(profile);
      }
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
         if (modifier.field === "name" && modifier.condition === null) continue;
         this.unhandled(modifier.element, `unit modifier ${modifier.type} ${modifier.field}${modifier.condition ? " with conditions" : ""}${modifier.repeats.length > 0 ? " with repeats" : ""}`);
      }
   }
}


interface OptionProfile {
   readonly option: Option;
   readonly profile: ModelProfile;
   readonly element: Element;
   /** Its modifiers that apply only under a condition. */
   readonly conditional: FlatModifier[];
}

/** The childId BattleScribe uses to count every model in a unit. */
const MODEL_COUNT_ID = "model";

const SIZE_SUFFIX = /\s*\(\s*\d+(\s*-\s*\d+)?\s+models?\s*\)\s*$/i;

function baseProfileName(name: string): string {
   return name.replace(SIZE_SUFFIX, "");
}
