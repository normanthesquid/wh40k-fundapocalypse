import type { Registry } from "./registry.ts";
import { attribute, childrenOf, isHidden, type Element } from "./xml.ts";

export const POWER_LEVEL_TYPE_ID = "1466-da3f-0d27-dace";

export type EntryKind = "unit" | "model" | "upgrade" | "group";

/** A selection entry or group as BattleScribe sees it: an entryLink merged with its target. */
export interface EntryView {
   /** The id conditions use to name this entry: the link's when it's a link, since that's the selection's entryId. */
   readonly ids: readonly string[];
   readonly element: Element;
   readonly target: Element;
   readonly kind: EntryKind;
   readonly name: string;
   readonly hidden: boolean;
   readonly constraints: Element[];
   readonly modifiers: Element[];
   readonly modifierGroups: Element[];
   readonly categoryLinks: Element[];
   readonly profiles: Element[];
   readonly infoLinks: Element[];
   readonly rules: Element[];
   readonly costs: Element[];
   readonly childEntries: Element[];
   readonly childGroups: Element[];
   readonly defaultSelectionEntryId: string | undefined;
}

function isGroupLink(element: Element): boolean {
   return element.attributes.type === "selectionEntryGroup";
}

function both(link: Element | undefined, target: Element, container: string, item: string): Element[] {
   return [...(link === undefined ? [] : childrenOf(link, container, item)), ...childrenOf(target, container, item)];
}

export function viewOf(registry: Registry, element: Element): EntryView | undefined {
   const link = element.tag === "entryLink" ? element : undefined;
   const target = link === undefined ? element : registry.lookup(attribute(link, "targetId"));
   if (target === undefined) return undefined;
   const kind: EntryKind = target.tag === "selectionEntryGroup" ? "group" : (attribute(target, "type") as EntryKind);
   const children = [...(link === undefined ? [] : link.children), ...target.children];
   const nested = (container: string, item: string) =>
      children.filter((child) => child.tag === container).flatMap((holder) => holder.children.filter((child) => child.tag === item));
   const linkCosts = link === undefined ? [] : childrenOf(link, "costs", "cost");
   const costs = [...linkCosts, ...childrenOf(target, "costs", "cost").filter((cost) => !linkCosts.some((own) => own.attributes.typeId === cost.attributes.typeId))];
   return {
      ids: link === undefined ? [attribute(target, "id")] : [attribute(link, "id"), attribute(target, "id")],
      element,
      target,
      kind,
      name: attribute(target, "name").trim(),
      hidden: isHidden(target) || (link !== undefined && isHidden(link)),
      constraints: both(link, target, "constraints", "constraint"),
      modifiers: both(link, target, "modifiers", "modifier"),
      modifierGroups: both(link, target, "modifierGroups", "modifierGroup"),
      categoryLinks: both(link, target, "categoryLinks", "categoryLink"),
      profiles: both(link, target, "profiles", "profile"),
      infoLinks: both(link, target, "infoLinks", "infoLink"),
      rules: both(link, target, "rules", "rule"),
      costs,
      childEntries: [...nested("selectionEntries", "selectionEntry"), ...nested("entryLinks", "entryLink").filter((child) => !isGroupLink(child))],
      childGroups: [...nested("selectionEntryGroups", "selectionEntryGroup"), ...nested("entryLinks", "entryLink").filter(isGroupLink)],
      defaultSelectionEntryId: target.attributes.defaultSelectionEntryId ?? link?.attributes.defaultSelectionEntryId,
   };
}

export function powerLevel(view: EntryView): number {
   const cost = view.costs.find((candidate) => candidate.attributes.typeId === POWER_LEVEL_TYPE_ID);
   return cost === undefined ? 0 : Number(attribute(cost, "value"));
}

export interface Bounds {
   minimum?: number;
   maximum?: number;
}

/** Constraint limits by scope, keyed by `<scope> <type>`, e.g. `parent max`. */
export function constraintsByScope(view: EntryView): Map<string, Element> {
   const found = new Map<string, Element>();
   for (const constraint of view.constraints) {
      if (attribute(constraint, "field") !== "selections") continue;
      const key = `${attribute(constraint, "scope")} ${attribute(constraint, "type")}`;
      if (!found.has(key)) found.set(key, constraint);
   }
   return found;
}

export function constraintValue(constraint: Element | undefined): number | undefined {
   return constraint === undefined ? undefined : Number(attribute(constraint, "value"));
}
