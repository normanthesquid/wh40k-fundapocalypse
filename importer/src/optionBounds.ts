import type { OptionSlugs } from "./conversion.ts";
import type { Condition, LimitTerm, Option, OptionGroup } from "./model.ts";
import type { FlatModifier } from "./modifiers.ts";
import { attribute, type Element } from "./xml.ts";

/** What bound conversion reads from the datasheet being converted. */
export interface BoundsHost {
   readonly groups: readonly OptionGroup[];
   readonly slugs: OptionSlugs;
   optionTaken(condition: Condition | null | undefined): string | undefined;
   unhandled(element: Element, message: string): void;
   fail(): void;
}

/** Option and option-group bounds that other options raise, lower or set. */
export class OptionBounds {
   private readonly host: BoundsHost;

   constructor(host: BoundsHost) {
      this.host = host;
   }

   /** The step of a minimum raised to the next multiple whenever the group is one short of it, e.g. sponsons taken in pairs. */
   multipleOf(groupSlug: string, constraint: Element, modifiers: FlatModifier[]): number | undefined {
      const raises = modifiers.filter((modifier) => modifier.field === attribute(constraint, "id"));
      const values = raises.map((modifier) => {
         const condition = modifier.condition;
         const value = Number(modifier.value);
         const oneShort = value - 1;
         const countsOwnGroup = condition?.kind === "Count" && condition.scope === "Unit" && condition.of.kind === "OptionGroup" && condition.of.group === groupSlug;
         const isOneShort = countsOwnGroup && condition.minimum === oneShort && (condition.maximum === undefined || condition.maximum === oneShort);
         return modifier.type === "set" && modifier.repeats.length === 0 && isOneShort ? value : undefined;
      });
      if (values.some((value) => value === undefined)) return undefined;
      const sorted = (values as number[]).toSorted((first, second) => first - second);
      const step = sorted[0];
      const isEveryMultiple = sorted.every((value, index) => value === step * (index + 1));
      return step >= 2 && isEveryMultiple ? step : undefined;
   }

   /** The options a condition requires, when it is one option taken or any of several. */
   private optionsTaken(condition: Condition | null | undefined): string[] | undefined {
      const single = this.host.optionTaken(condition);
      if (single !== undefined) return [single];
      const others = this.othersOfUntaken(condition);
      if (others !== undefined) return others;
      if (condition?.kind !== "Any") return undefined;
      const each = condition.conditions.map((part) => this.host.optionTaken(part));
      return each.every((option) => option !== undefined) ? (each as string[]) : undefined;
   }

   /** The rest of a group the unit takes exactly one of, when a condition says one of its options is not taken. */
   private othersOfUntaken(condition: Condition | null | undefined): string[] | undefined {
      if (condition?.kind !== "Count" || condition.of.kind !== "Option") return undefined;
      const isUntakenHere = condition.scope === "Unit" && condition.of.datasheet === undefined && condition.maximum === 0;
      if (!isUntakenHere) return undefined;
      const untaken = condition.of.option;
      const group = this.exclusiveGroupOf(untaken);
      const optionIds = group?.options.map((option) => option.id!) ?? [];
      if (group === undefined || !this.alwaysTakesOneOf(group, optionIds)) return undefined;
      return optionIds.filter((option) => option !== untaken);
   }

   /** The group holding an option, when that group lets the unit take only one of its options. */
   private exclusiveGroupOf(optionSlug: string): OptionGroup | undefined {
      const group = this.host.groups.find((candidate) => candidate.options.some((option) => option.id === optionSlug));
      return group?.maximum === 1 ? group : undefined;
   }

   /** Whether the unit must take exactly one of the group's options and each is one of these, so a set always replaces the base. */
   private alwaysTakesOneOf(group: OptionGroup, options: string[]): boolean {
      const isRequired = typeof group.minimum === "number" && group.minimum >= 1;
      return isRequired && group.options.every((option) => options.includes(option.id!));
   }

   /** A group's or option's bound set or incremented by other options, as a limit counting them; a set needs options that exclude each other. */
   setBound(holder: OptionGroup | Option, bound: "minimum" | "maximum", constraint: Element, modifiers: FlatModifier[], label: string): void {
      const owner = "options" in holder ? holder : this.host.groups.find((candidate) => candidate.options.includes(holder));
      const constraintId = attribute(constraint, "id");
      let base = Number(attribute(constraint, "value"));
      const amounts = new Map<string, { set?: number; increment: number }>();
      for (const modifier of modifiers.filter((candidate) => candidate.field === constraintId)) {
         if (modifier.condition === undefined) {
            this.host.fail();
            return;
         }
         const signed = Number(modifier.value) * (modifier.type === "decrement" ? -1 : 1);
         if (modifier.condition === null && modifier.type === "set" && modifier.repeats.length === 0 && amounts.size === 0) {
            base = signed;
            continue;
         }
         const counted = modifier.condition === null ? this.repeatedOptions(modifier) : modifier.repeats.length === 0 ? this.optionsTaken(modifier.condition) : undefined;
         if (counted === undefined || (modifier.type === "set" && modifier.condition === null)) {
            this.host.unhandled(modifier.element, `${label} ${bound} ${modifier.type} that does not count the unit's options`);
            return;
         }
         for (const option of counted) {
            const amount = amounts.get(option) ?? { increment: 0 };
            if (modifier.type === "set") {
               if (amount.increment !== 0) {
                  this.host.unhandled(modifier.element, `${label} ${bound} set after an increment for the same option`);
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
         this.host.unhandled(constraint, `${label} ${bound} set by options that do not exclude each other`);
         return;
      }
      const [setGroup] = exclusive;
      if (setGroup !== undefined && this.alwaysTakesOneOf(setGroup, setOptions)) base = 0;
      if (base < 0) {
         this.host.unhandled(constraint, `${label} ${bound} with a negative base`);
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
         const isUnit = scopeId === "parent" || this.host.slugs.allIds.has(scopeId);
         return isUnit && attribute(repeat, "value") === "1.0" ? this.host.slugs.byId.get(attribute(repeat, "childId")) : undefined;
      });
      return options.every((option) => option !== undefined) ? (options as string[]) : undefined;
   }
}
