import { not, allOf } from "./conditions.ts";
import type { Conversion } from "./conversion.ts";
import { describeSource, MISSING_PROFILES, PROFILELESS_DATASHEETS, SIZED_PROFILES } from "./corrections.ts";
import type { EntryView } from "./entries.ts";
import type { Condition, ConditionalChange, CountTarget, ModelProfile, Option, OptionGroup, ProfileValues } from "./model.ts";
import type { FlatModifier } from "./modifiers.ts";
import { CHARACTERISTIC_TYPE_IDS, parseCharacteristic, profileFromCharacteristics, take, UNIT_CHARACTERISTICS, unitProfile } from "./profiles.ts";
import { attribute, type Element } from "./xml.ts";

const INCREMENTABLE: ReadonlySet<keyof ProfileValues> = new Set(["attacks", "wounds", "leadership"]);

const SIZE_SUFFIX = /\s*\(\s*\d+(\s*-\s*\d+)?\s+models?\s*\)\s*$/i;

/** What building a unit's profiles needs from the datasheet converter around it. */
export interface ProfileHost {
   readonly conversion: Conversion;
   readonly view: EntryView;
   readonly groups: readonly OptionGroup[];
   readonly optionsBySlug: ReadonlyMap<string, Option>;
   defer(apply: () => void): void;
   optionTaken(condition: Condition | null | undefined): string | undefined;
   requires(option: Option | undefined): Condition | undefined;
   conditionalChange(when: Condition): ConditionalChange;
   modelOption(): CountTarget | undefined;
   unhandled(element: Element, message: string): void;
   fail(): void;
   dropConditionalRename(modifier: FlatModifier): void;
}

interface OptionProfile {
   readonly option: Option;
   readonly profile: ModelProfile;
   readonly element: Element;
   /** Its modifiers that apply only under a condition. */
   readonly conditional: FlatModifier[];
}

/** The option, if it can be taken only once (by its own maximum or its group's), so a change made while it is taken can be made by taking it. */
export function takenOnce(option: Option | undefined, groups: readonly OptionGroup[]): Option | undefined {
   const group = groups.find((candidate) => candidate.options.includes(option!));
   return option?.maximum === 1 || (option !== undefined && group?.maximum === 1) ? option : undefined;
}

/** A unit's stat lines: its own Unit profiles, those its options carry, and the changes conditions and model counts make to them. */
export class UnitProfiles {
   readonly profiles: ModelProfile[] = [];
   private readonly optionProfiles: OptionProfile[] = [];
   /** The unit's own profiles that are hidden while a condition holds. */
   private readonly hiddenProfiles: { profile: ModelProfile; hiddenWhen: Condition }[] = [];
   private readonly host: ProfileHost;

   constructor(host: ProfileHost) {
      this.host = host;
   }

   add(target: Element, modifiers: FlatModifier[], option: Option | undefined): void {
      let name = attribute(target, "name").trim();
      const overrides = new Map<keyof ProfileValues, string>();
      const conditional: FlatModifier[] = [];
      for (const modifier of modifiers) {
         if (modifier.condition === undefined) return;
         if (modifier.condition !== null) conditional.push(modifier);
         else if (modifier.field === "name" && modifier.type === "set") name = modifier.value;
         else if (modifier.type === "set" && CHARACTERISTIC_TYPE_IDS[modifier.field] !== undefined) overrides.set(CHARACTERISTIC_TYPE_IDS[modifier.field], modifier.value);
         else if (this.isSizedIncrement(modifier)) this.host.conversion.report.recordDropped(modifier.element, "per-model increment the sized profiles already print");
         else this.host.unhandled(modifier.element, `unit profile modifier ${modifier.type} ${modifier.field}`);
      }
      const profile = unitProfile(target, name, overrides, this.host.conversion.report);
      if (profile === undefined) {
         this.host.fail();
         return;
      }
      if (option !== undefined) {
         this.optionProfiles.push({ option, profile, element: target, conditional });
         return;
      }
      const hiding = conditional.filter(isHiding);
      const isRepeat = hiding.length === 0 && this.profiles.some((existing) => JSON.stringify(existing) === JSON.stringify(profile));
      if (hiding.length === 1) this.hiddenProfiles.push({ profile, hiddenWhen: hiding[0].condition! });
      else if (isRepeat) this.host.conversion.report.recordDropped(target, "profile repeating one the unit already has");
      else this.profiles.push(profile);
      for (const modifier of conditional.filter((candidate) => !hiding.includes(candidate))) this.host.defer(() => this.addProfileChange(modifier, profile.name));
   }

   /** Settles which profiles are the datasheet's once every entry has been read; the correction table fills a unit that has none. */
   resolve(): void {
      this.resolveHiddenProfiles();
      this.resolveOptionProfiles();
      if (this.profiles.length === 0) this.addMissingProfile();
   }

   /** A per-model increment on a unit whose sized stat lines come from the correction table. */
   private isSizedIncrement(modifier: FlatModifier): boolean {
      const isSized = SIZED_PROFILES.some((entry) => this.host.view.ids.includes(entry.unitId));
      return isSized && modifier.type === "increment" && modifier.repeats.length > 0 && modifier.repeats.every((repeat) => attribute(repeat, "childId") === "model");
   }

   /** Characteristics that grow with the unit's models, as changes while it has that many. */
   addSizedProfiles(): void {
      const view = this.host.view;
      const report = this.host.conversion.report;
      const sized = SIZED_PROFILES.find((entry) => view.ids.includes(entry.unitId));
      if (sized === undefined) return;
      const models = this.host.modelOption();
      if (models === undefined || this.profiles.length !== 1) {
         this.host.unhandled(view.element, "sized profile without one model option and one profile");
         return;
      }
      for (const { models: count, printed } of sized.sizes) {
         const set: ProfileValues = {};
         for (const [characteristic, field] of UNIT_CHARACTERISTICS) {
            const value = printed[characteristic];
            if (value === undefined) continue;
            const parsed = take(parseCharacteristic(field, value), view.element, characteristic, report);
            if (parsed !== null && parsed !== undefined) (set as Record<string, unknown>)[field] = parsed;
         }
         const when: Condition = { kind: "Count", scope: "Unit", of: models, minimum: count, maximum: count };
         (this.host.conditionalChange(when).profileChanges ??= []).push({ set });
      }
      report.recordCorrection(view.element, `profile by model count added (${describeSource(sized.source)})`);
   }

   /** A datasheet without a stat line is right only where the official datasheet prints none. */
   checkProfileless(): void {
      const view = this.host.view;
      const profileless = PROFILELESS_DATASHEETS.find((entry) => view.ids.includes(entry.unitId));
      if (profileless === undefined) this.host.unhandled(view.element, "no unit profile");
      else this.host.conversion.report.recordCorrection(view.element, `no stat line, as printed (${describeSource(profileless.source)})`);
   }

   /** The correction table's profile for a unit the data gives none. */
   private addMissingProfile(): void {
      const view = this.host.view;
      const report = this.host.conversion.report;
      const missing = MISSING_PROFILES.find((entry) => view.ids.includes(entry.unitId));
      if (missing === undefined) return;
      const profile = profileFromCharacteristics(new Map(Object.entries(missing.printed)), view.element, missing.name, new Map(), report);
      if (profile === undefined) return;
      report.recordCorrection(view.element, `profile ${missing.name} added (${describeSource(missing.source)})`);
      this.profiles.push(profile);
   }

   /** The option whose taking hides `profile` changes it to the option's own profile instead of adding that as another model. */
   private replaceHiddenProfile(profile: ModelProfile, hiddenWhen: Condition, element: Element): void {
      const taken = this.host.optionTaken(hiddenWhen);
      const replacements = this.optionProfiles.filter((entry) => entry.option.id === taken);
      if (replacements.length !== 1) {
         this.host.unhandled(element, "profile hidden by a condition that is not one option with its own profile");
         return;
      }
      const [replacement] = replacements;
      this.optionProfiles.splice(this.optionProfiles.indexOf(replacement), 1);
      const set = profileDifferences(profile, replacement.profile, (field) => this.host.unhandled(replacement.element, `replacement profile without the ${field} it replaces`));
      this.host.defer(() => {
         const forProfile = this.profiles.length > 1 || !this.profiles.some((existing) => existing.name === profile.name) ? profile.name : undefined;
         if (Object.keys(set).length > 0) (replacement.option.profileChanges ??= []).push(forProfile === undefined ? { set } : { profile: forProfile, set });
      });
      for (const modifier of replacement.conditional) this.host.defer(() => this.addProfileChange(modifier, profile.name));
   }

   /** A profile hidden while an option is taken gives way to that option's own profile; several hidden in turn are one profile per model count. */
   private resolveHiddenProfiles(): void {
      if (this.hiddenProfiles.length === 0) return;
      if (this.hiddenProfiles.length === 1) {
         const [{ profile, hiddenWhen }] = this.hiddenProfiles;
         this.profiles.push(profile);
         this.replaceHiddenProfile(profile, hiddenWhen, this.host.view.element);
         return;
      }
      const [first, ...others] = this.hiddenProfiles;
      const base = { ...first.profile, name: baseProfileName(first.profile.name) };
      this.profiles.push(base);
      for (const { profile, hiddenWhen } of others) {
         const set = profileDifferences(base, profile, (field) => this.host.unhandled(this.host.view.element, `profile ${profile.name} without the ${field} the others have`));
         if (Object.keys(set).length > 0) (this.host.conditionalChange(not(hiddenWhen)).profileChanges ??= []).push({ set });
      }
   }

   private addProfileChange(modifier: FlatModifier, profileName: string, required?: Condition): void {
      if (modifier.field === "name") {
         this.host.dropConditionalRename(modifier);
         return;
      }
      const field = CHARACTERISTIC_TYPE_IDS[modifier.field];
      const taken = required === undefined ? this.host.optionTaken(modifier.condition) : undefined;
      const option = taken === undefined ? undefined : takenOnce(this.host.optionsBySlug.get(taken), this.host.groups);
      if (field === undefined || modifier.condition === null || modifier.condition === undefined) {
         this.host.unhandled(modifier.element, `conditional unit profile modifier ${modifier.type} ${modifier.field}`);
         return;
      }
      const changes = ((option ?? this.host.conditionalChange(allOf(required, modifier.condition)!)).profileChanges ??= []);
      const isAdded = !this.profiles.some((profile) => profile.name === profileName);
      const forProfile = this.profiles.length > 1 || isAdded ? profileName : undefined;
      let change = changes.find((existing) => existing.profile === forProfile);
      if (change === undefined) {
         change = forProfile === undefined ? {} : { profile: forProfile };
         changes.push(change);
      }
      if (modifier.type === "set") {
         const parsed = take(parseCharacteristic(field, modifier.value), modifier.element, field, this.host.conversion.report);
         if (parsed === null || parsed === undefined) this.host.fail();
         else (change.set ??= {})[field] = parsed as never;
      } else if ((modifier.type === "increment" || modifier.type === "decrement") && INCREMENTABLE.has(field)) {
         const amount = Number(modifier.value) * (modifier.type === "decrement" ? -1 : 1);
         const increment = (change.increment ??= {});
         const incremented = field as "attacks" | "wounds" | "leadership";
         increment[incremented] = (increment[incremented] ?? 0) + amount;
      } else this.host.unhandled(modifier.element, `profile ${modifier.type} on ${field}`);
   }

   /** Unit-size options that each carry the whole unit's profile: the default size's becomes the datasheet's, the others change it. */
   private resolveOptionProfiles(): void {
      for (const entry of [...this.optionProfiles]) {
         const hiding = entry.conditional.filter(isHiding);
         if (hiding.length !== 1 || !this.optionProfiles.includes(entry)) continue;
         this.optionProfiles[this.optionProfiles.indexOf(entry)] = { ...entry, conditional: entry.conditional.filter((modifier) => modifier !== hiding[0]) };
         this.replaceHiddenProfile(entry.profile, hiding[0].condition!, entry.element);
      }
      const byOption = new Map<Option, OptionProfile[]>();
      for (const entry of this.optionProfiles) byOption.set(entry.option, [...(byOption.get(entry.option) ?? []), entry]);
      const isUnitSize = (group: OptionGroup) => group.options.every((option) => byOption.get(option)?.length === 1);
      for (const group of this.host.groups) {
         if (this.profiles.length > 0 || !isUnitSize(group)) continue;
         const baseOption = group.options.find((option) => option.id === group.default) ?? group.options[0];
         const base = { ...byOption.get(baseOption)![0].profile, name: baseProfileName(byOption.get(baseOption)![0].profile.name) };
         this.profiles.push(base);
         for (const option of group.options) {
            for (const { conditional } of byOption.get(option)!) for (const modifier of conditional) this.host.defer(() => this.addProfileChange(modifier, base.name, this.host.requires(option)));
         }
         for (const option of group.options) {
            if (option === baseOption) continue;
            const { profile, element } = byOption.get(option)![0];
            const set = profileDifferences(base, profile, (field) => this.host.unhandled(element, `unit-size profile without the ${field} the default size has`));
            if (Object.keys(set).length > 0) (option.profileChanges ??= []).push({ set });
            byOption.delete(option);
         }
         byOption.delete(baseOption);
      }
      for (const [option, entries] of byOption) this.placeOptionProfiles(option, entries);
   }

   /** A model the unit must take (e.g. a squadron's first vehicle) is the datasheet's profile; an optional one is added by its option. */
   private placeOptionProfiles(option: Option, entries: OptionProfile[]): void {
      for (const { profile, conditional } of entries) for (const modifier of conditional) this.host.defer(() => this.addProfileChange(modifier, profile.name));
      if (this.profiles.length === 0 && (option.minimum ?? 0) >= 1) {
         this.profiles.push(...entries.map((entry) => entry.profile));
         return;
      }
      for (const { profile, element } of entries) {
         const same = this.profiles.find((existing) => existing.name === profile.name);
         if (same !== undefined && JSON.stringify(same) === JSON.stringify(profile)) continue;
         if (same !== undefined || option.addsProfiles?.some((added) => added.name === profile.name)) this.host.unhandled(element, "option profile whose name the unit already uses");
         else (option.addsProfiles ??= []).push(profile);
      }
   }
}

function isHiding(modifier: FlatModifier): boolean {
   return modifier.field === "hidden" && modifier.type === "set" && modifier.value === "true";
}

/** The characteristics `other` gives differently from `base`, reporting any it lacks. */
function profileDifferences(base: ModelProfile, other: ModelProfile, reportMissing: (field: keyof ProfileValues) => void): ProfileValues {
   const set: ProfileValues = {};
   for (const key of new Set([...Object.keys(base), ...Object.keys(other)])) {
      if (key === "name") continue;
      const field = key as keyof ProfileValues;
      if (JSON.stringify(base[field]) === JSON.stringify(other[field])) continue;
      if (other[field] === undefined) reportMissing(field);
      else (set as Record<string, unknown>)[field] = other[field];
   }
   return set;
}

function baseProfileName(name: string): string {
   return name.replace(SIZE_SUFFIX, "");
}
