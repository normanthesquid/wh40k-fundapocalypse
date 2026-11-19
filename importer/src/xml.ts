import { XMLParser } from "fast-xml-parser";

export interface Element {
   readonly tag: string;
   readonly attributes: Readonly<Record<string, string>>;
   readonly children: readonly Element[];
   readonly text: string;
   parent: Element | undefined;
}

type ParsedNode = Record<string, unknown> & { ":@"?: Record<string, string> };

const parser = new XMLParser({
   ignoreAttributes: false,
   attributeNamePrefix: "",
   preserveOrder: true,
   parseAttributeValue: false,
   parseTagValue: false,
   trimValues: false,
   processEntities: true,
});

function build(node: ParsedNode, parent: Element | undefined): Element | undefined {
   const tag = Object.keys(node).find((key) => key !== ":@");
   if (tag === undefined || tag === "#text" || tag === "?xml") return undefined;
   const element: Element = { tag, attributes: node[":@"] ?? {}, children: [], text: "", parent };
   const children: Element[] = [];
   let text = "";
   for (const child of node[tag] as ParsedNode[]) {
      if ("#text" in child) text += String(child["#text"]);
      const built = build(child, element);
      if (built !== undefined) children.push(built);
   }
   return Object.assign(element, { children, text: text.trim() });
}

export function parseDocument(source: string): Element {
   const roots = (parser.parse(source) as ParsedNode[])
      .map((node) => build(node, undefined))
      .filter((element) => element !== undefined);
   if (roots.length !== 1) throw new Error(`expected one root element, found ${roots.length}`);
   return roots[0];
}

export function childrenOf(element: Element, containerTag: string, itemTag: string): Element[] {
   return element.children
      .filter((child) => child.tag === containerTag)
      .flatMap((container) => container.children.filter((child) => child.tag === itemTag));
}

export function firstChild(element: Element, tag: string): Element | undefined {
   return element.children.find((child) => child.tag === tag);
}

export function attribute(element: Element, name: string): string {
   const value = element.attributes[name];
   if (value === undefined) throw new Error(`<${element.tag}> has no ${name} attribute (${describe(element)})`);
   return value;
}

export function isHidden(element: Element): boolean {
   return element.attributes.hidden === "true";
}

export function describe(element: Element): string {
   const steps: string[] = [];
   for (let current: Element | undefined = element; current !== undefined; current = current.parent) {
      const name = current.attributes.name;
      if (name !== undefined) steps.unshift(name);
   }
   return steps.join(" > ");
}
