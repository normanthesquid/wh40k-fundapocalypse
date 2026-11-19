import { describeSource, DROPPED_PROFILES, PROFILE_CORRECTIONS, type UnitCharacteristic } from "./corrections.ts";
import type { Ability, ModelProfile, ProfileValues, Weapon } from "./model.ts";
import type { Report } from "./report.ts";
import {
   cleanText,
   parseInteger,
   parseMovement,
   parseSkill,
   parseTwoDiceTarget,
   parseUnitAttacks,
   parseWeaponAttacks,
   parseWeaponRange,
   parseWeaponType,
   type Parsed,
} from "./values.ts";
import { attribute, childrenOf, firstChild, type Element } from "./xml.ts";

export const UNIT_PROFILE = "Unit";
export const WEAPON_PROFILE = "Weapons";
export const TRANSPORT_PROFILE = "Transport";
export const WARMASTER_TRAIT_PROFILE = "Warmaster Trait";

/** Characteristic type ids, which modifiers name in `field`. */
export const CHARACTERISTIC_TYPE_IDS: Readonly<Record<string, keyof ProfileValues>> = {
   "606d-344a-bc3d-9dce": "movement",
   "e2a3-fade-c12d-860b": "weaponSkill",
   "bcfe-d5af-2691-5c77": "ballisticSkill",
   "ddfe-6a9e-32c1-a51c": "attacks",
   "7c7f-f763-1f39-410c": "wounds",
   "91b0-3d37-1843-1290": "leadership",
   "a56f-38ae-3917-aadc": "save",
};

export type Characteristics = Map<string, string>;

export function characteristicsOf(profile: Element): Characteristics {
   return new Map(childrenOf(profile, "characteristics", "characteristic").map((characteristic) => [attribute(characteristic, "name"), characteristic.text]));
}

const correctionsById = new Map(PROFILE_CORRECTIONS.map((correction) => [correction.profileId, correction]));
const droppedIds = new Set(DROPPED_PROFILES.map((dropped) => dropped.profileId));

/** A blank placeholder profile the importer leaves out. */
export function isDroppedProfile(profile: Element): boolean {
   return droppedIds.has(attribute(profile, "id"));
}

/** Characteristic names by type id, which modifiers name in `field`. */
export function characteristicNamesById(profile: Element): Map<string, string> {
   return new Map(childrenOf(profile, "characteristics", "characteristic").map((characteristic) => [attribute(characteristic, "typeId"), attribute(characteristic, "name")]));
}

/** The profile's characteristics with the correction table's values in place of wrong or missing ones; a report records each correction. */
export function correctedCharacteristics(profile: Element, report: Report | undefined): Characteristics {
   const characteristics = characteristicsOf(profile);
   const correction = correctionsById.get(attribute(profile, "id"));
   if (correction === undefined) return characteristics;
   for (const [name, printed] of Object.entries(correction.printed)) {
      report?.recordCorrection(profile, `${name}: "${characteristics.get(name) ?? ""}" set to "${printed}" (${describeSource(correction.source)})`);
      characteristics.set(name, printed);
   }
   return characteristics;
}

/** Unwraps a parsed value, reporting corrections and failures against the profile. */
export function take<Value>(parsed: Parsed<Value>, profile: Element, characteristic: string, report: Report): Value | undefined | null {
   if (parsed.kind === "Unparseable") {
      report.failUnhandled(profile, `unreadable ${characteristic}`);
      return null;
   }
   if (parsed.kind === "Absent") return undefined;
   if (parsed.correction !== undefined) report.recordCorrection(profile, `${characteristic}: ${parsed.correction}`);
   return parsed.value;
}

export function parseCharacteristic(name: keyof ProfileValues, printed: string): Parsed<ProfileValues[keyof ProfileValues]> {
   switch (name) {
      case "movement":
         return parseMovement(printed);
      case "weaponSkill":
      case "ballisticSkill":
         return parseSkill(printed);
      case "attacks":
         return parseUnitAttacks(printed);
      case "wounds":
      case "leadership":
         return parseInteger(printed, 1);
      case "save":
         return parseTwoDiceTarget(printed);
   }
}

export const UNIT_CHARACTERISTICS: readonly [UnitCharacteristic, keyof ProfileValues][] = [
   ["M", "movement"],
   ["WS", "weaponSkill"],
   ["BS", "ballisticSkill"],
   ["A", "attacks"],
   ["W", "wounds"],
   ["Ld", "leadership"],
   ["Sv", "save"],
];

/** A Unit profile; `overrides` are printed values from unconditional modifiers, keyed by characteristic. */
export function unitProfile(profile: Element, name: string, overrides: Map<keyof ProfileValues, string>, report: Report): ModelProfile | undefined {
   return profileFromCharacteristics(correctedCharacteristics(profile, report), profile, name, overrides, report);
}

/** A Unit profile from printed values; `profile` is where findings are reported. */
export function profileFromCharacteristics(characteristics: Characteristics, profile: Element, name: string, overrides: Map<keyof ProfileValues, string>, report: Report): ModelProfile | undefined {
   const values: Record<string, unknown> = { name };
   let failed = false;
   for (const [printedName, field] of UNIT_CHARACTERISTICS) {
      const printed = overrides.get(field) ?? characteristics.get(printedName);
      if (printed === undefined) {
         report.failUnhandled(profile, `missing ${printedName}`);
         failed = true;
         continue;
      }
      const parsed = take(parseCharacteristic(field, printed), profile, printedName, report);
      if (parsed === null) failed = true;
      else if (parsed !== undefined) values[field] = parsed;
   }
   if (failed) return undefined;
   for (const required of ["movement", "wounds", "save"]) {
      if (!(required in values)) {
         report.failUnhandled(profile, `no ${required}`);
         return undefined;
      }
   }
   return values as unknown as ModelProfile;
}

export function weaponFromProfile(profile: Element, report: Report): Weapon | undefined {
   if (isDroppedProfile(profile)) {
      report.recordDropped(profile, "blank placeholder profile of the wrong type");
      return undefined;
   }
   return weaponFromCharacteristics(correctedCharacteristics(profile, report), profile, attribute(profile, "name").trim(), report);
}

/** A weapon from characteristics, reporting parse failures against the profile they came from. */
export function weaponFromCharacteristics(characteristics: Characteristics, profile: Element, name: string, report: Report): Weapon | undefined {
   const type = take(parseWeaponType(characteristics.get("Type") ?? ""), profile, "Type", report);
   if (type === null || type === undefined) return undefined;
   const weapon: Weapon = { name, type };
   const range = take(parseWeaponRange(characteristics.get("Range") ?? ""), profile, "Range", report);
   const attacks = take(parseWeaponAttacks(characteristics.get("A") ?? "-"), profile, "A", report);
   const antiPersonnel = take(parseTwoDiceTarget(characteristics.get("SAP") ?? "-"), profile, "SAP", report);
   const antiTank = take(parseTwoDiceTarget(characteristics.get("SAT") ?? "-"), profile, "SAT", report);
   if ([range, attacks, antiPersonnel, antiTank].includes(null)) return undefined;
   const isStarredMelee = type === "Melee" && range?.kind === "Special";
   if (isStarredMelee) report.recordDropped(profile, "melee range * that the unit's abilities explain");
   const keptRange = isStarredMelee ? undefined : range;
   if ((type === "Melee") !== (keptRange === undefined)) {
      report.failUnhandled(profile, `a ${type} weapon with range ${characteristics.get("Range")}`);
      return undefined;
   }
   if (keptRange) weapon.range = keptRange;
   if (attacks) weapon.attacks = attacks;
   if (antiPersonnel) weapon.antiPersonnel = antiPersonnel;
   if (antiTank) weapon.antiTank = antiTank;
   const text = cleanText(characteristics.get("Abilities") ?? "");
   if (text !== undefined) weapon.text = text;
   return weapon;
}

/** A profile's characteristics that carry any text. */
export function profileTexts(profile: Element): string[] {
   return [...characteristicsOf(profile).values()].map((text) => cleanText(text)).filter((text) => text !== undefined);
}

/** An ability from an Abilities profile or any one-text profile type (D3 roll tables, warmaster traits, ...). */
export function abilityFromProfile(profile: Element, report: Report): Ability | undefined {
   const characteristics = profileTexts(profile);
   if (characteristics.length !== 1) {
      report.failUnhandled(profile, `${attribute(profile, "typeName")} profile with ${characteristics.length} texts`);
      return undefined;
   }
   return { name: attribute(profile, "name").trim(), text: characteristics[0] };
}

export function abilityFromRule(rule: Element): Ability {
   const text = cleanText(firstChild(rule, "description")?.text ?? "") ?? attribute(rule, "name");
   return { name: attribute(rule, "name").trim(), text };
}

export function transportFromProfile(profile: Element): string | undefined {
   return cleanText([...characteristicsOf(profile).values()].join(" "));
}
