import type { OutputBuilder } from "./builder.ts";
import { allOf, not } from "./conditions.ts";
import type { Conversion } from "./conversion.ts";
import type { Condition, ConditionalChange } from "./model.ts";
import type { FlatModifier } from "./modifiers.ts";
import { characteristicNamesById, correctedCharacteristics, weaponFromCharacteristics } from "./profiles.ts";
import { attribute, type Element } from "./xml.ts";

/** Each combination of conditions is its own weapon, so more than this many conditions is left to a person. */
const MAXIMUM_VARIANT_CONDITIONS = 3;

export interface VariantContext {
   readonly conversion: Conversion;
   readonly builder: OutputBuilder;
   conditionalChange(when: Condition): ConditionalChange;
   unhandled(element: Element, message: string): void;
}

interface ConditionGroup {
   readonly key: string;
   readonly condition: Condition;
   readonly changes: FlatModifier[];
}

/** The weapon as this datasheet carries it, with the modifiers and renames that always apply here. */
export function carriedWeapon(context: VariantContext, profile: Element, original: string, changes: FlatModifier[], renames: FlatModifier[]): string {
   const always = changes.filter((change) => change.condition === null);
   const alwaysRenames = renames.filter((rename) => rename.condition === null);
   if (always.length === 0 && alwaysRenames.length === 0) return original;
   return weaponWith(context, profile, always, alwaysRenames) ?? original;
}

/** A weapon whose characteristics or name modifiers set: one weapon per combination of their conditions, swapped in for the carried one while exactly that combination holds. */
export function addWeaponVariants(context: VariantContext, profile: Element, carried: string, changes: FlatModifier[], renames: FlatModifier[], required: Condition | undefined): void {
   const groups = new Map<string, ConditionGroup>();
   for (const change of [...changes, ...renames]) {
      if (change.condition === undefined || change.condition === null) continue;
      const key = JSON.stringify(change.condition);
      if (!groups.has(key)) groups.set(key, { key, condition: change.condition, changes: [] });
      groups.get(key)!.changes.push(change);
   }
   const conditions = [...groups.values()];
   if (conditions.length > MAXIMUM_VARIANT_CONDITIONS) {
      for (const change of [...changes, ...renames]) context.unhandled(change.element, `weapon modifiers under more than ${MAXIMUM_VARIANT_CONDITIONS} conditions`);
      return;
   }
   for (const chosen of nonEmptySubsets(conditions)) addVariant(context, profile, carried, changes, chosen, conditions, renames, required);
}

/** Changes apply in source order, so a later modifier of the same characteristic wins, as in BattleScribe. */
function addVariant(context: VariantContext, profile: Element, carried: string, changes: FlatModifier[], chosen: ConditionGroup[], all: ConditionGroup[], renames: FlatModifier[], required: Condition | undefined): void {
   const chosenKeys = new Set(chosen.map((group) => group.key));
   const applies = (modifier: FlatModifier) => modifier.condition === null || (modifier.condition !== undefined && chosenKeys.has(JSON.stringify(modifier.condition)));
   const variant = weaponWith(context, profile, changes.filter(applies), renames.filter(applies));
   if (variant === undefined || variant === carried) return;
   const excluded = all.filter((group) => !chosenKeys.has(group.key)).map((group) => not(group.condition));
   const change = context.conditionalChange(allOf(required, ...chosen.map((group) => group.condition), ...excluded)!);
   (change.removesWeapons ??= []).push(carried);
   (change.addsWeapons ??= []).push(variant);
}

/** The profile's weapon with these characteristic changes and the last of these renames applied, as a reference from this datasheet. */
function weaponWith(context: VariantContext, profile: Element, changes: FlatModifier[], renames: FlatModifier[]): string | undefined {
   const names = characteristicNamesById(profile);
   const characteristics = correctedCharacteristics(profile, undefined);
   for (const change of changes) characteristics.set(names.get(change.field)!, change.value);
   const name = (renames.at(-1)?.value ?? attribute(profile, "name")).trim();
   const weapon = weaponFromCharacteristics(characteristics, profile, name, context.conversion.report);
   if (weapon === undefined) return undefined;
   const builder = context.conversion.builderOf(profile);
   return context.conversion.reference(context.builder, { builder, slug: builder.addWeapon(weapon) });
}

function nonEmptySubsets<Item>(items: Item[]): Item[][] {
   const subsets: Item[][] = [[]];
   for (const item of items) subsets.push(...subsets.map((subset) => [...subset, item]));
   return subsets.slice(1);
}
