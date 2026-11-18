import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BattlefieldRole } from "./model.ts";
import { slugify } from "./slug.ts";
import { attribute, childrenOf, parseDocument, type Element } from "./xml.ts";

export interface SourceDocument {
   readonly root: Element;
   readonly fileName: string;
   readonly battleScribeId: string;
   readonly name: string;
   readonly isGameSystem: boolean;
   readonly isLibrary: boolean;
   /** The catalogue id in the new format; empty for the game system, whose references are bare. */
   readonly slug: string;
}

export type Category =
   | { kind: "Role"; role: BattlefieldRole }
   | { kind: "FactionKeyword"; keyword: string }
   | { kind: "Keyword"; keyword: string }
   | { kind: "ListConfiguration" };

const ROLES: Readonly<Record<string, BattlefieldRole>> = {
   HQ: "HQ",
   Troops: "Troops",
   Elites: "Elites",
   "Fast Attack": "FastAttack",
   "Heavy Support": "HeavySupport",
   Flyer: "Flyer",
   "Dedicated Transport": "DedicatedTransport",
   "Lord of War": "LordOfWar",
   Fortification: "Fortification",
   "No Force Org Slot": "NoForceOrgSlot",
};

const FACTION_PREFIX = "Faction: ";
const LIST_CONFIGURATION = "List Configuration";
const CATALOGUE_PREFIXES = /^(Library|Imperium|Chaos|Aeldari|Tyranids) - /;

export function keywordFromName(name: string): string {
   return name.trim().replace(/\s+/g, " ").toUpperCase();
}

export class Registry {
   readonly documents: SourceDocument[] = [];
   private readonly byId = new Map<string, Element>();
   private readonly documentOf = new Map<Element, SourceDocument>();

   constructor(sourceDirectory: string) {
      const files = readdirSync(sourceDirectory).filter((name) => /\.(cat|gst)$/.test(name)).sort();
      const loaded = files.map((fileName) => ({ fileName, root: parseDocument(readFileSync(join(sourceDirectory, fileName), "utf8")) }));
      const factionSlugs = new Set(
         loaded.filter(({ root }) => root.tag === "catalogue" && root.attributes.library !== "true").map(({ root }) => catalogueSlug(root)),
      );
      for (const { fileName, root } of loaded) {
         const isGameSystem = root.tag === "gameSystem";
         const isLibrary = root.attributes.library === "true";
         let slug = isGameSystem ? "" : catalogueSlug(root);
         if (isLibrary && factionSlugs.has(slug)) slug = `${slug}-library`;
         const document: SourceDocument = {
            root,
            fileName,
            battleScribeId: attribute(root, "id"),
            name: attribute(root, "name"),
            isGameSystem,
            isLibrary,
            slug,
         };
         this.documents.push(document);
         this.index(root, document);
      }
   }

   private index(element: Element, document: SourceDocument): void {
      this.documentOf.set(element, document);
      const id = element.attributes.id;
      const indexable = !["constraint", "categoryLink", "infoLink", "catalogueLink", "cost", "costType"].includes(element.tag);
      if (id !== undefined && indexable && !this.byId.has(id)) this.byId.set(id, element);
      for (const child of element.children) this.index(child, document);
   }

   get gameSystem(): SourceDocument {
      const found = this.documents.find((document) => document.isGameSystem);
      if (found === undefined) throw new Error("no .gst file found");
      return found;
   }

   get catalogues(): SourceDocument[] {
      return this.documents.filter((document) => !document.isGameSystem);
   }

   lookup(id: string): Element | undefined {
      return this.byId.get(id);
   }

   documentContaining(element: Element): SourceDocument {
      const document = this.documentOf.get(element);
      if (document === undefined) throw new Error(`element <${element.tag}> is not from a loaded file`);
      return document;
   }

   category(id: string): Category | undefined {
      const entry = this.lookup(id);
      if (entry === undefined || entry.tag !== "categoryEntry") return undefined;
      const name = attribute(entry, "name").trim();
      const role = ROLES[name];
      if (role !== undefined) return { kind: "Role", role };
      if (name === LIST_CONFIGURATION) return { kind: "ListConfiguration" };
      if (name.startsWith(FACTION_PREFIX)) return { kind: "FactionKeyword", keyword: keywordFromName(name.slice(FACTION_PREFIX.length)) };
      return { kind: "Keyword", keyword: keywordFromName(name) };
   }

   forceEntries(): Element[] {
      return childrenOf(this.gameSystem.root, "forceEntries", "forceEntry");
   }
}

function catalogueSlug(root: Element): string {
   return slugify(attribute(root, "name").replace(CATALOGUE_PREFIXES, ""));
}
