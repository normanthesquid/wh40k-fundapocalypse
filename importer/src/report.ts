import { describe, type Element } from "./xml.ts";

export interface Finding {
   readonly file: string;
   readonly where: string;
   readonly message: string;
}

export interface CatalogueCounts {
   units: number;
   weapons: number;
   abilities: number;
   options: number;
}

export function emptyCounts(): CatalogueCounts {
   return { units: 0, weapons: 0, abilities: 0, options: 0 };
}

export class Report {
   readonly unhandled: Finding[] = [];
   readonly corrections: Finding[] = [];
   readonly dropped: Finding[] = [];
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

   mapId(battleScribeId: string, globalId: string): void {
      this.idMapping.set(battleScribeId, globalId);
   }
}

function fileOf(element: Element): string {
   let current = element;
   while (current.parent !== undefined) current = current.parent;
   return current.attributes.name ?? "?";
}
