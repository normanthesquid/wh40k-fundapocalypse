import type { Condition, CountScope, CountTarget } from "./model.ts";
import { attribute, childrenOf, type Element } from "./xml.ts";

/** What a condition's ids mean where it appears: the unit around it, the catalogue, the game system. */
export interface ConditionContext {
   /** A count target for a BattleScribe childId, or undefined when the id names nothing countable. */
   countTarget(childId: string, scope: CountScope): CountTarget | undefined;
   /** The options of a detachment choice's group, which a condition counts as any of them. */
   choiceGroupTargets(childId: string): CountTarget[] | undefined;
   /** True when a scope id names the unit being converted or one of its own selections. */
   isUnitScope(scopeId: string): boolean;
   detachmentSlug(forceEntryId: string): string | undefined;
   /** Whether the unit being converted is (or is a copy of) this entry; undefined when the id is not a unit. */
   isThisUnit(entryId: string): boolean | undefined;
   /** Whether the unit always has a category; undefined when that depends on its options or its faction. */
   unitHasCategory(categoryId: string): boolean | undefined;
   factionSlug(catalogueId: string): string | undefined;
   unhandled(element: Element, message: string): void;
}

/** A condition, or a constant once the conversion could decide it statically. */
export type Folded = Condition | boolean;

export function not(condition: Condition): Condition {
   if (condition.kind === "Not") return condition.condition;
   return { kind: "Not", condition };
}

export function negate(condition: Folded): Folded {
   return typeof condition === "boolean" ? !condition : not(condition);
}

/** Combines folded conditions; constants decide or drop out. */
export function combineFolded(kind: "All" | "Any", conditions: Folded[]): Folded {
   const deciding = kind === "Any";
   if (conditions.includes(deciding)) return deciding;
   const rest = conditions.filter((condition) => typeof condition !== "boolean");
   return combine(kind, rest) ?? !deciding;
}

export function combine(kind: "All" | "Any", conditions: Condition[]): Condition | undefined {
   const flat = conditions.flatMap((condition) => (condition.kind === kind ? condition.conditions : [condition]));
   if (flat.length === 0) return undefined;
   if (flat.length === 1) return flat[0];
   return { kind, conditions: flat };
}

export function allOf(...conditions: (Condition | undefined)[]): Condition | undefined {
   return combine("All", conditions.filter((condition) => condition !== undefined));
}

function countScope(scope: string, context: ConditionContext): CountScope | undefined {
   if (scope === "force") return "Detachment";
   if (scope === "roster") return "Army";
   if (scope === "parent" || scope === "self" || context.isUnitScope(scope)) return "Unit";
   return undefined;
}

function comparison(type: string, threshold: number): { minimum?: number; maximum?: number; negate: boolean } | undefined {
   switch (type) {
      case "equalTo":
         return threshold === 0 ? { maximum: 0, negate: false } : { minimum: threshold, maximum: threshold, negate: false };
      case "notEqualTo":
         return threshold === 0 ? { minimum: 1, negate: false } : { minimum: threshold, maximum: threshold, negate: true };
      case "atLeast":
         return { minimum: threshold, negate: false };
      case "greaterThan":
         return { minimum: threshold + 1, negate: false };
      case "atMost":
         return { maximum: threshold, negate: false };
      case "lessThan":
         return threshold === 0 ? undefined : { maximum: threshold - 1, negate: false };
      default:
         return undefined;
   }
}

function instanceCondition(element: Element, context: ConditionContext): Folded | undefined {
   const scope = attribute(element, "scope");
   const childId = attribute(element, "childId");
   if (scope === "primary-catalogue") {
      const faction = context.factionSlug(childId);
      return faction === undefined ? undefined : { kind: "PrimaryFaction", faction };
   }
   const detachment = context.detachmentSlug(childId);
   if (detachment !== undefined && (scope === "ancestor" || scope === "force" || scope === "parent")) {
      return { kind: "Count", scope: "Detachment", of: { kind: "Detachment", detachment }, minimum: 1 };
   }
   const onThisUnit = scope === "ancestor" || scope === "self";
   const isThisUnit = onThisUnit ? (context.isThisUnit(childId) ?? context.unitHasCategory(childId)) : undefined;
   if (isThisUnit !== undefined) return isThisUnit;
   if (scope === "ancestor" || scope === "parent" || scope === "self") {
      const target = context.countTarget(childId, "Unit");
      if (target !== undefined && (target.kind === "Keyword" || target.kind === "Role")) return { kind: "Count", scope: "Unit", of: target, minimum: 1 };
   }
   return undefined;
}

export function convertCondition(element: Element, context: ConditionContext): Folded | undefined {
   const type = attribute(element, "type");
   if (type === "instanceOf" || type === "notInstanceOf") {
      const condition = instanceCondition(element, context);
      if (condition === undefined) {
         context.unhandled(element, `condition ${type} scope=${element.attributes.scope} childId=${element.attributes.childId}`);
         return undefined;
      }
      return type === "instanceOf" ? condition : negate(condition);
   }
   const field = attribute(element, "field");
   const scopeText = attribute(element, "scope");
   const childId = attribute(element, "childId");
   const threshold = Number(attribute(element, "value"));
   const bounds = comparison(type, threshold);
   if (field === "forces") {
      const detachment = context.detachmentSlug(childId);
      if (detachment === undefined || scopeText !== "roster" || bounds === undefined || bounds.negate) {
         context.unhandled(element, `forces condition ${type} scope=${scopeText}`);
         return undefined;
      }
      return { kind: "Count", scope: "Army", of: { kind: "Detachment", detachment }, minimum: bounds.minimum, maximum: bounds.maximum };
   }
   const scope = countScope(scopeText, context);
   if (field !== "selections" || scope === undefined || bounds === undefined) {
      context.unhandled(element, `condition field=${field} scope=${scopeText} type=${type} value=${threshold}`);
      return undefined;
   }
   const target: CountTarget | undefined = childId === "unit" ? { kind: "AnyUnit" } : context.countTarget(childId, scope);
   const groupTargets = target === undefined ? context.choiceGroupTargets(childId) : undefined;
   if (groupTargets !== undefined) {
      const condition = choiceGroupCondition(scope, groupTargets, bounds);
      if (condition === undefined) context.unhandled(element, `condition ${type} ${threshold} on a detachment choice group`);
      return condition;
   }
   if (target === undefined) {
      context.unhandled(element, `condition counts unknown id ${childId} in scope ${scopeText}`);
      return undefined;
   }
   const count: Condition = { kind: "Count", scope, of: target };
   if (bounds.minimum !== undefined) count.minimum = bounds.minimum;
   if (bounds.maximum !== undefined) count.maximum = bounds.maximum;
   return bounds.negate ? not(count) : count;
}

/** Taking a choice group is taking any one of its options, which the choice allows only one of. */
function choiceGroupCondition(scope: CountScope, targets: CountTarget[], bounds: { minimum?: number; maximum?: number; negate: boolean }): Condition | undefined {
   const counts = (minimum: number | undefined, maximum: number | undefined): Condition[] =>
      targets.map((of) => ({ kind: "Count", scope, of, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) }));
   let condition: Condition | undefined;
   if (bounds.minimum === undefined && bounds.maximum === 0) condition = combine("All", counts(undefined, 0));
   else if (bounds.minimum === 1 && (bounds.maximum === undefined || bounds.maximum === 1)) condition = combine("Any", counts(1, undefined));
   if (condition === undefined) return undefined;
   return bounds.negate ? not(condition) : condition;
}

function convertGroup(element: Element, context: ConditionContext): Folded | undefined {
   const parts = [
      ...childrenOf(element, "conditions", "condition").map((child) => convertCondition(child, context)),
      ...childrenOf(element, "conditionGroups", "conditionGroup").map((child) => convertGroup(child, context)),
   ];
   if (parts.some((part) => part === undefined)) return undefined;
   const kind = attribute(element, "type") === "or" ? "Any" : "All";
   return combineFolded(kind, parts as Folded[]);
}

/** The conditions of a modifier or modifier group, ANDed; `null` when there are none, undefined when one failed. */
export function conditionsOf(element: Element, context: ConditionContext): Folded | null | undefined {
   const conditions = childrenOf(element, "conditions", "condition");
   const groups = childrenOf(element, "conditionGroups", "conditionGroup");
   if (conditions.length === 0 && groups.length === 0) return null;
   const parts = [...conditions.map((child) => convertCondition(child, context)), ...groups.map((child) => convertGroup(child, context))];
   if (parts.some((part) => part === undefined)) return undefined;
   return combineFolded("All", parts as Folded[]);
}
