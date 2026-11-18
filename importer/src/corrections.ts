/** Values the v1.10.0 data has wrong or lacks, taken from the official Apocalypse datasheets and the maintainer's checks of them. */

import type { BattlefieldRole } from "./model.ts";

export type UnitCharacteristic = "M" | "WS" | "BS" | "A" | "W" | "Ld" | "Sv";
export type WeaponCharacteristic = "Type" | "Range" | "A" | "SAP" | "SAT";

/** Where a value comes from: a datasheet PDF and its page, or the maintainer's ruling. */
export interface Source {
   readonly document: string;
   readonly page?: number;
}

const MAINTAINER: Source = { document: "maintainer ruling" };

/** Printed characteristics replacing what a BattleScribe profile has, keyed by the profile's id. */
export interface ProfileCorrection {
   readonly profileId: string;
   readonly name: string;
   readonly printed: Partial<Record<UnitCharacteristic | WeaponCharacteristic, string>>;
   readonly source: Source;
}

/** A Unit profile the data has none of, for the unit with this id (its definition, which every link to it shares). */
export interface MissingProfile {
   readonly unitId: string;
   readonly name: string;
   readonly printed: Record<UnitCharacteristic, string>;
   readonly source: Source;
}

/** A profile that changes with the number of models, e.g. a squadron's Attacks and Wounds. */
export interface SizedProfile {
   readonly unitId: string;
   readonly sizes: readonly { readonly models: number; readonly printed: Partial<Record<UnitCharacteristic, string>> }[];
   readonly source: Source;
}

/** Blank profiles of the wrong type, named after their unit, which carry nothing. */
export interface DroppedProfile {
   readonly profileId: string;
   readonly name: string;
}

const pdf = (document: string, page: number): Source => ({ document: `Apoc_Datasheet_${document}_web.pdf`, page });

export const PROFILE_CORRECTIONS: readonly ProfileCorrection[] = [
   { profileId: "570a-c6dd-0607-5609", name: "Azrael", printed: { WS: "2+", BS: "2+" }, source: MAINTAINER },
   { profileId: "f405-3074-6728-00ed", name: "Electrostatic Gauntlets (Ranged)", printed: { A: "x3" }, source: MAINTAINER },
   { profileId: "df05-4c61-44c0-a2fa", name: "Inquisitor-Lord Hector Rex", printed: { W: "1" }, source: pdf("FW_Inquisition", 2) },
   { profileId: "c189-6c71-4909-ff22", name: "Victrix Honour Guard (2 models)", printed: { Ld: "7" }, source: pdf("Adeptus_Astartes", 69) },
   { profileId: "c6aa-85d2-5df7-30fb", name: "Captain-General Trajann Valoris", printed: { M: "6\"" }, source: MAINTAINER },
   { profileId: "674b-e3c2-cbd0-3f80", name: "Paladin Ancient", printed: { M: "5\"" }, source: MAINTAINER },
   { profileId: "3730-5305-f0a5-8b2d", name: "Imperial Fortress Wall", printed: { WS: "-" }, source: pdf("FW_Astra_Militarum", 63) },
   {
      profileId: "36b4-9f09-2ea9-58f0",
      name: "Imperial Space Marine",
      printed: { M: "6\"", WS: "3+", BS: "3+", A: "1", W: "1", Ld: "6", Sv: "6+" },
      source: pdf("Adeptus_Astartes", 63),
   },
   {
      profileId: "9afb-27a3-1fe8-19d3",
      name: "Elysian Sniper Squad (3 models)",
      printed: { M: "6\"", WS: "4+", BS: "3+", A: "1", W: "1", Ld: "5", Sv: "10+" },
      source: pdf("FW_Elysian_Drop_Troops", 9),
   },
   { profileId: "ddc9-60e5-6c49-99a1", name: "Cyberwolf", printed: { M: "11\"", WS: "3+", BS: "-", A: "1", W: "1", Ld: "4", Sv: "7+" }, source: pdf("Space_Wolves", 51) },
   { profileId: "4d58-264e-052e-1312", name: "Stormhammer Cannon", printed: { Type: "Heavy", Range: "60\"", A: "4", SAP: "7+", SAT: "4+" }, source: pdf("FW_Astra_Militarum", 40) },
   { profileId: "4ded-f0cc-8dd9-1c09", name: "Twin Battle Cannon", printed: { Type: "Heavy", Range: "72\"", A: "2", SAP: "6+", SAT: "6+" }, source: pdf("FW_Astra_Militarum", 40) },
];

const statLine = (M: string, WS: string, BS: string, A: string, W: string, Ld: string, Sv: string): Record<UnitCharacteristic, string> => ({ M, WS, BS, A, W, Ld, Sv });

export const MISSING_PROFILES: readonly MissingProfile[] = [
   { unitId: "65be-9a08-e178-9ce9", name: "Deathstrike", printed: statLine("12\"", "6+", "4+", "1", "2", "5", "6+"), source: pdf("Astra_Militarum", 45) },
   { unitId: "a715-ef27-e673-9234", name: "Captain Corien Sumatris", printed: statLine("6\"", "2+", "2+", "1", "1", "7", "5+"), source: pdf("FW_Adeptus_Astartes", 59) },
   { unitId: "7a88-172e-ca96-4246", name: "Chaplain Dreadnought Titus", printed: statLine("6\"", "2+", "2+", "2", "2", "8", "5+"), source: pdf("FW_Adeptus_Astartes", 65) },
   { unitId: "8590-d531-d2f4-f0d5", name: "Vaylund Cal", printed: statLine("5\"", "2+", "2+", "1", "1", "7", "4+"), source: pdf("FW_Adeptus_Astartes", 78) },
   { unitId: "68a3-54e1-9063-9a5a", name: "Elucia Vhane", printed: statLine("6\"", "3+", "3+", "1", "1", "7", "6+"), source: pdf("Agents_of_the_Imperium", 20) },
   { unitId: "6435-f40e-7cff-3d10", name: "Jokaero Weaponsmith", printed: statLine("6\"", "6+", "4+", "1", "1", "5", "10+"), source: pdf("Agents_of_the_Imperium", 17) },
   { unitId: "ed7d-3992-a081-bc89", name: "Gryphonne Pattern Chimera", printed: statLine("12\"", "6+", "4+", "1", "2", "5", "6+"), source: pdf("FW_Astra_Militarum", 6) },
   { unitId: "fd5f-3162-4a1d-fd66", name: "Salamander Command Vehicle", printed: statLine("12\"", "6+", "3+", "1", "2", "6", "6+"), source: pdf("FW_Astra_Militarum", 3) },
   { unitId: "6442-06e8-4d19-262c", name: "Valdor Tank Hunter", printed: statLine("10\"", "6+", "4+", "1", "4", "6", "6+"), source: pdf("FW_Astra_Militarum", 54) },
   { unitId: "c003-0b9a-1ccc-b5e4", name: "Ryza Pattern Leman Russ Vanquisher", printed: statLine("10\"", "6+", "4+", "1", "2", "5", "6+"), source: pdf("FW_Astra_Militarum", 25) },
   { unitId: "08da-6346-ad66-be8f", name: "Bane Wolf", printed: statLine("12\"", "6+", "4+", "1", "2", "5", "6+"), source: pdf("Astra_Militarum", 39) },
   { unitId: "10e7-ff85-0ce0-ecdf", name: "Devil Dog", printed: statLine("12\"", "6+", "4+", "1", "2", "5", "6+"), source: pdf("Astra_Militarum", 40) },
   { unitId: "e6eb-f9a4-3a09-1eaf", name: "Stormsword", printed: statLine("10\"", "5+", "4+", "2", "5", "6", "6+"), source: pdf("Astra_Militarum", 55) },
   { unitId: "dc7c-2b53-9738-6582", name: "Elysian Command Squad (3/4 models)", printed: statLine("6\"", "4+", "3+", "1", "1", "6", "10+"), source: pdf("FW_Elysian_Drop_Troops", 6) },
   { unitId: "de21-3e8b-fb9a-36dc", name: "Elysian Heavy Weapons Squad (3 models)", printed: statLine("6\"", "4+", "4+", "1", "1", "5", "10+"), source: pdf("FW_Elysian_Drop_Troops", 10) },
   { unitId: "cce2-2884-a0ad-88a7", name: "Primaris Battle Leader", printed: statLine("6\"", "2+", "3+", "1", "1", "6", "6+"), source: pdf("Space_Wolves", 20) },
   { unitId: "db32-a3d3-5ee4-7722", name: "Ravenwing Land Speeder Vengeance", printed: statLine("12\"", "3+", "3+", "1", "2", "6", "6+"), source: pdf("Dark_Angels", 56) },
   { unitId: "2468-48de-617e-2258", name: "Relic Land Raider Proteus", printed: statLine("10\"", "5+", "3+", "2", "3", "7", "4+"), source: pdf("FW_Adeptus_Astartes", 5) },
   { unitId: "2235-b44c-a7d2-d517", name: "Terrax-pattern Termite Assault Drill", printed: statLine("8\"", "4+", "3+", "2", "2", "6", "5+"), source: pdf("FW_Adeptus_Astartes", 7) },
   { unitId: "0fb2-fc72-9e69-d8ad", name: "Centurion Assault Squad (3 models)", printed: statLine("4\"", "3+", "3+", "1", "2", "6", "4+"), source: pdf("Adeptus_Astartes", 17) },
   { unitId: "2471-f69b-08e2-34a7", name: "Centurion Devastator Squad (3 models)", printed: statLine("4\"", "3+", "3+", "1", "2", "6", "4+"), source: pdf("Adeptus_Astartes", 34) },
   { unitId: "ea0b-da21-710a-a0b8", name: "Land Speeder Tempests", printed: statLine("15\"", "3+", "3+", "1", "1", "6", "6+"), source: pdf("FW_Adeptus_Astartes", 30) },
   { unitId: "1dd1-6a73-648b-44c0", name: "Skorpius Disintegrator", printed: statLine("12\"", "6+", "3+", "1", "2", "6", "6+"), source: pdf("Adeptus_Mechanicus", 21) },
   { unitId: "82fa-bcd3-d0ce-cde6", name: "Tech-Priest Manipulus", printed: statLine("6\"", "3+", "3+", "1", "1", "6", "4+"), source: pdf("Adeptus_Mechanicus", 3) },
   { unitId: "ab08-5e01-37f6-dc3e", name: "Spoilpox Scrivener", printed: statLine("5\"", "2+", "2+", "1", "1", "6", "9+"), source: pdf("Legiones_Daemonica", 22) },
   { unitId: "b6f8-5507-d8a2-6cd1", name: "Hellforged Rapier (3 models)", printed: statLine("4\"", "6+", "3+", "1", "1", "6", "6+"), source: pdf("FW_Heretic_Astartes", 18) },
   { unitId: "f5e0-821e-23d1-4dd7", name: "Vengeance Weapon Battery", printed: statLine("-", "-", "5+", "-", "2", "8", "6+"), source: pdf("Unaligned", 6) },
   { unitId: "8424-07c3-523d-a146", name: "Vortex Missile Aquila Strongpoint", printed: statLine("-", "-", "5+", "-", "6", "10", "6+"), source: pdf("Unaligned", 10) },
];

export const SIZED_PROFILES: readonly SizedProfile[] = [
   {
      unitId: "ea0b-da21-710a-a0b8",
      sizes: [
         { models: 2, printed: { A: "2", W: "2" } },
         { models: 3, printed: { A: "3", W: "3" } },
      ],
      source: pdf("FW_Adeptus_Astartes", 30),
   },
   {
      unitId: "5855-5edc-c417-a7ad",
      sizes: [
         { models: 2, printed: { A: "2", W: "2" } },
         { models: 3, printed: { A: "3", W: "3" } },
         { models: 4, printed: { A: "4", W: "4" } },
         { models: 5, printed: { A: "5", W: "5" } },
      ],
      source: pdf("Space_Wolves", 51),
   },
];

export const DROPPED_PROFILES: readonly DroppedProfile[] = [
   { profileId: "7564-695e-3a36-fe93", name: "Gryphonne Pattern Chimera" },
   { profileId: "1cf5-887f-fc99-5c87", name: "Arkurian Pattern Stormhammer" },
   { profileId: "bfb5-2a25-f051-7645", name: "Ryza Pattern Leman Russ Vanquisher" },
   { profileId: "2313-7ff2-61ad-7700", name: "Valdor Tank Hunter" },
   { profileId: "f124-5fae-59f7-d57c", name: "Elysian Command Squad (3/4 Models)" },
];

/** Terrain features whose official datasheet prints no stat line: once set up, they are terrain rather than a unit. */
export const PROFILELESS_DATASHEETS: readonly { readonly unitId: string; readonly name: string; readonly source: Source }[] = [
   { unitId: "f46d-c8d1-dff8-817b", name: "Aegis Defence Line", source: pdf("Unaligned", 1) },
   { unitId: "1ff8-573b-e9de-08c0", name: "Imperial Defence Line", source: pdf("Unaligned", 4) },
   { unitId: "39c7-dbab-c476-e28d", name: "Mekboy Workshop", source: pdf("Orks", 51) },
   { unitId: "5853-cb10-ede1-3e7d", name: "Sacristan Forgeshrine", source: pdf("Imperial_Knights", 13) },
   { unitId: "5667-2d59-4000-4303", name: "Tectonic Fragdrill", source: pdf("Genestealers", 29) },
   { unitId: "646a-f716-9cdf-247b", name: "Feculent Gnarlmaw", source: pdf("Legiones_Daemonica", 49) },
   { unitId: "03eb-2033-4a6c-669a", name: "Skull Altar", source: pdf("Legiones_Daemonica", 50) },
];

const MINISTORUM: Source = { document: "f803d0c4.pdf (Adeptus Ministorum)" };
const ministorum = (page: number): Source => ({ ...MINISTORUM, page });

/** Battlefield roles the data lacks, read from the role icon on the official datasheet. */
export const MISSING_ROLES: readonly { readonly unitId: string; readonly name: string; readonly role: BattlefieldRole; readonly source: Source }[] = [
   { unitId: "ef0f-f67c-da10-8dcf", name: "Geminae Superia", role: "Elites", source: ministorum(3) },
   { unitId: "4c42-09d7-f233-74e0", name: "Mistress of Repentance", role: "Elites", source: ministorum(14) },
   { unitId: "0e13-ead1-f97f-e444", name: "Crusaders", role: "Elites", source: ministorum(24) },
   { unitId: "428a-591c-d180-58b4", name: "Death Cult Assassins", role: "Elites", source: ministorum(25) },
   { unitId: "9767-fee3-b260-d67f", name: "Arco-flagellants", role: "Elites", source: ministorum(26) },
   { unitId: "d968-ea96-4863-9ddf", name: "Mutoid Vermin", role: "FastAttack", source: pdf("Gellerpox_Infected", 5) },
];

export function describeSource(source: Source): string {
   return source.page === undefined ? source.document : `${source.document} p${source.page}`;
}
