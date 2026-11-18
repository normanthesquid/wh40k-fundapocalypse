import type { Movement, UnitAttacks, WeaponAttacks, WeaponRange, WeaponType } from "./model.ts";

/** A parsed characteristic: its value, and a note when the printed text had to be corrected. */
export type Parsed<Value> =
   | { kind: "Value"; value: Value; correction?: string }
   | { kind: "Absent" }
   | { kind: "Unparseable" };

const absent = { kind: "Absent" } as const;
const unparseable = { kind: "Unparseable" } as const;

function value<Value>(parsed: Value, printed: string, canonical: string): Parsed<Value> {
   return canonical === printed ? { kind: "Value", value: parsed } : { kind: "Value", value: parsed, correction: `"${printed}" read as "${canonical}"` };
}

const D6_SKILL_MAXIMUM = 6;
const TWO_DICE_MAXIMUM = 12;

function rollTarget(printed: string, maximum: number): Parsed<number> {
   const text = printed.trim();
   if (text === "-") return absent;
   const match = /^\+?(\d+)\+?-?$/.exec(text);
   if (match === null) return unparseable;
   const target = Number(match[1]);
   if (target < 2 || target > maximum) return unparseable;
   return value(target, printed, `${target}+`);
}

export function parseSkill(printed: string): Parsed<number> {
   return rollTarget(printed, D6_SKILL_MAXIMUM);
}

export function parseTwoDiceTarget(printed: string): Parsed<number> {
   return rollTarget(printed, TWO_DICE_MAXIMUM);
}

export function parseInteger(printed: string, minimum: number): Parsed<number> {
   const text = printed.trim();
   if (text === "-") return absent;
   const match = /^(\d+)\+?$/.exec(text);
   if (match === null || Number(match[1]) < minimum) return unparseable;
   return value(Number(match[1]), printed, match[1]);
}

function inches(text: string): number | undefined {
   const match = /^(\d+)"*$/.exec(text.trim());
   return match === null ? undefined : Number(match[1]);
}

export function parseMovement(printed: string): Parsed<Movement> {
   const text = printed.trim();
   if (text === "-") return value({ kind: "Immobile" }, printed, "-");
   const single = inches(text);
   if (single !== undefined) return value({ kind: "Inches", inches: single }, printed, `${single}"`);
   const range = /^(\d+)"?\s*-\s*(\d+)"$/.exec(text);
   if (range === null) return unparseable;
   const [minimum, maximum] = [Number(range[1]), Number(range[2])];
   return value({ kind: "Range", minimum, maximum }, printed, `${minimum}"-${maximum}"`);
}

function dice(text: string): UnitAttacks | undefined {
   const match = /^(\d*)D([36])$/.exec(text);
   if (match === null) return undefined;
   const sides = match[2] === "3" ? 3 : 6;
   return { kind: "Dice", count: match[1] === "" ? 1 : Number(match[1]), sides };
}

export function parseUnitAttacks(printed: string): Parsed<UnitAttacks> {
   const text = printed.trim();
   if (text === "-") return absent;
   const rolled = dice(text);
   if (rolled !== undefined) return value(rolled, printed, text);
   if (!/^\d+$/.test(text)) return unparseable;
   return value({ kind: "Fixed", value: Number(text) }, printed, text);
}

export function parseWeaponAttacks(printed: string): Parsed<WeaponAttacks> {
   const text = printed.trim();
   if (text === "-") return absent;
   if (text.toLowerCase() === "user") return value({ kind: "User" }, printed, "User");
   const multiplied = /^x(\d)$|^(\d)x$/.exec(text);
   if (multiplied !== null) {
      const multiplier = Number(multiplied[1] ?? multiplied[2]);
      return value({ kind: "UserMultiplied", multiplier }, printed, `x${multiplier}`);
   }
   return parseUnitAttacks(printed);
}

export function parseWeaponType(printed: string): Parsed<WeaponType> {
   const text = printed.trim().toLowerCase();
   if (text === "heavy") return value("Heavy", printed, "Heavy");
   if (text === "melee" || text === "mele") return value("Melee", printed, "Melee");
   if (text === "small arms" || text === "smaill arms") return value("SmallArms", printed, "Small Arms");
   return unparseable;
}

export function parseWeaponRange(printed: string): Parsed<WeaponRange> {
   const text = printed.trim();
   if (text.toLowerCase() === "melee" || text.toLowerCase() === "mele") return absent;
   if (text === "*") return value({ kind: "Special" }, printed, "*");
   const single = inches(text);
   if (single === undefined || single < 1) return unparseable;
   return value({ kind: "Inches", inches: single }, printed, `${single}"`);
}

export function cleanText(printed: string): string | undefined {
   const text = printed.trim();
   return text === "" || text === "-" ? undefined : text;
}
