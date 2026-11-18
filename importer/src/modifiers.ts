import { combineFolded, conditionsOf, type ConditionContext, type Folded } from "./conditions.ts";
import type { Condition, CountScope, CountTarget, Limit, LimitTerm } from "./model.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

/** One modifier with the conditions of every modifier group around it folded in. */
export interface FlatModifier {
   readonly element: Element;
   readonly type: string;
   readonly field: string;
   readonly value: string;
   /** null when unconditional; undefined when a condition could not be converted (already reported). */
   readonly condition: Condition | null | undefined;
   readonly repeats: Element[];
}

/** Both sets of conditions; null when neither has any, false when they can never hold together. */
function both(outer: Folded | null | undefined, own: Folded | null | undefined): Folded | null | undefined {
   if (own === undefined || outer === undefined) return undefined;
   if (own === null) return outer;
   if (outer === null) return own;
   return combineFolded("All", [outer, own]);
}

function flatten(modifiers: Element[], groups: Element[], outer: Folded | null | undefined, context: ConditionContext): FlatModifier[] {
   const flat: FlatModifier[] = [];
   for (const modifier of modifiers) {
      const folded = both(outer, conditionsOf(modifier, context));
      if (folded === false) continue;
      const condition = folded === true ? null : folded;
      flat.push({
         element: modifier,
         type: attribute(modifier, "type"),
         field: attribute(modifier, "field"),
         value: attribute(modifier, "value"),
         condition,
         repeats: childrenOf(modifier, "repeats", "repeat"),
      });
   }
   for (const group of groups) {
      const condition = both(outer, conditionsOf(group, context));
      if (condition === false) continue;
      flat.push(...flatten(childrenOf(group, "modifiers", "modifier"), childrenOf(group, "modifierGroups", "modifierGroup"), condition, context));
   }
   return flat;
}

export function flatModifiers(modifiers: Element[], groups: Element[], context: ConditionContext): FlatModifier[] {
   return flatten(modifiers, groups, null, context);
}

export function flatModifiersOf(element: Element, context: ConditionContext): FlatModifier[] {
   return flatModifiers(childrenOf(element, "modifiers", "modifier"), childrenOf(element, "modifierGroups", "modifierGroup"), context);
}

export interface RepeatTargets {
   target(childId: string, scope: CountScope): CountTarget | undefined;
   /** Replaces a set of per-detachment terms with a single DetachmentKind term when they name exactly the Core detachments. */
   simplify(terms: LimitTerm[]): LimitTerm[];
}

/** A constraint's number as a limit: its value plus the repeating increments and decrements aimed at it. */
export interface ConvertedLimit {
   readonly limit: Limit;
   /** Set when a conditional `set` raised the limit from 0: the entry is only available while it holds. */
   readonly availableWhen?: Condition;
}

export function limitFrom(
   constraint: Element,
   modifiers: FlatModifier[],
   targets: RepeatTargets,
   context: ConditionContext,
): ConvertedLimit | undefined {
   const constraintId = attribute(constraint, "id");
   const base = Number(attribute(constraint, "value"));
   const aimed = modifiers.filter((modifier) => modifier.field === constraintId);
   const terms: LimitTerm[] = [];
   let availableWhen: Condition | undefined;
   let setValue: number | undefined;
   for (const modifier of aimed) {
      if (modifier.condition === undefined) return undefined;
      const amount = Number(modifier.value) * (modifier.type === "decrement" ? -1 : 1);
      if ((modifier.type === "increment" || modifier.type === "decrement") && modifier.condition === null && modifier.repeats.length > 0) {
         for (const repeat of modifier.repeats) {
            const scope: CountScope | undefined = { force: "Detachment", roster: "Army", parent: "Unit" }[attribute(repeat, "scope")] as CountScope | undefined;
            const per = scope === undefined ? undefined : targets.target(attribute(repeat, "childId"), scope);
            if (scope === undefined || per === undefined || attribute(repeat, "value") !== "1.0") {
               context.unhandled(repeat, `repeat scope=${repeat.attributes.scope} childId=${repeat.attributes.childId} every ${repeat.attributes.value}`);
               return undefined;
            }
            terms.push({ per, scope, amount });
         }
         continue;
      }
      if (modifier.type === "set" && modifier.condition !== null && base === 0 && setValue === undefined) {
         setValue = Number(modifier.value);
         availableWhen = modifier.condition;
         continue;
      }
      context.unhandled(modifier.element, `${modifier.type} on a constraint${modifier.condition === null ? "" : " with conditions"}${modifier.repeats.length > 0 ? " with repeats" : ""}`);
      return undefined;
   }
   if (setValue !== undefined && terms.length > 0) {
      context.unhandled(constraint, "a constraint both raised by a condition and grown by repeats");
      return undefined;
   }
   const limit: Limit = { base: setValue ?? base };
   const simplified = targets.simplify(terms);
   if (simplified.length > 0) limit.terms = simplified;
   return availableWhen === undefined ? { limit } : { limit, availableWhen };
}
