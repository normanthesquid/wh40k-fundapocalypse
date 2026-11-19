import { describe, type Element } from "./xml.ts";

export interface Finding {
   readonly file: string;
   readonly where: string;
   readonly message: string;
}

/** Counts on one side of the conversion; weapons and abilities are their distinct names. */
export interface CatalogueCounts {
   units: number;
   weapons: Set<string>;
   abilities: Set<string>;
   options: number;
}

export function emptyCounts(): CatalogueCounts {
   return { units: 0, weapons: new Set(), abilities: new Set(), options: 0 };
}

export class Report {
   readonly unhandled: Finding[] = [];
   readonly corrections: Finding[] = [];
   readonly dropped: Finding[] = [];
   readonly renames: Finding[] = [];
   readonly before = new Map<string, CatalogueCounts>();
   readonly after = new Map<string, CatalogueCounts>();
   readonly idMapping = new Map<string, string>();

   private finding(element: Element, message: string): Finding {
      return { file: fileOf(element), where: describe(element), message };
   }

   failUnhandled(element: Element, message: string): void {
      this.unhandled.push(this.finding(element, message));
   }

   recordCorrection(element: Element, message: string): void {
      this.corrections.push(this.finding(element, message));
   }

   recordDropped(element: Element, message: string): void {
      this.dropped.push(this.finding(element, message));
   }

   /** A name modifier applied as it stands, giving the official datasheet's name. */
   recordRename(element: Element, message: string): void {
      this.renames.push(this.finding(element, message));
   }

   mapId(battleScribeId: string, globalId: string): void {
      this.idMapping.set(battleScribeId, globalId);
   }
}

function fileOf(element: Element): string {
   let current = element;
   while (current.parent !== undefined) current = current.parent;
   return current.attributes.name ?? "?";
}
