export type BattlefieldRole =
   | "HQ"
   | "Troops"
   | "Elites"
   | "FastAttack"
   | "HeavySupport"
   | "Flyer"
   | "DedicatedTransport"
   | "LordOfWar"
   | "Fortification"
   | "NoForceOrgSlot";

export type WeaponType = "SmallArms" | "Heavy" | "Melee";
export type DetachmentKind = "Core" | "Special";
export type CountScope = "Unit" | "Detachment" | "Army";

export interface Fixed {
   kind: "Fixed";
   value: number;
}
export interface Dice {
   kind: "Dice";
   count: number;
   sides: 3 | 6;
}
export type Movement =
   | { kind: "Inches"; inches: number }
   | { kind: "Range"; minimum: number; maximum: number }
   | { kind: "Immobile" };
export type UnitAttacks = Fixed | Dice;
export type WeaponAttacks = Fixed | Dice | { kind: "User" } | { kind: "UserMultiplied"; multiplier: number };
export type WeaponRange = { kind: "Inches"; inches: number } | { kind: "Special" };

export interface ModelProfile {
   name: string;
   movement: Movement;
   weaponSkill?: number;
   ballisticSkill?: number;
   attacks?: UnitAttacks;
   wounds: number;
   leadership?: number;
   save: number;
}

export interface ProfileValues {
   movement?: Movement;
   weaponSkill?: number;
   ballisticSkill?: number;
   attacks?: UnitAttacks;
   wounds?: number;
   leadership?: number;
   save?: number;
}

export interface ProfileIncrements {
   attacks?: number;
   wounds?: number;
   leadership?: number;
}

export interface ProfileChange {
   profile?: string;
   set?: ProfileValues;
   increment?: ProfileIncrements;
}

export interface Ability {
   name: string;
   text: string;
}

export interface Weapon {
   name: string;
   type: WeaponType;
   range?: WeaponRange;
   attacks?: WeaponAttacks;
   antiPersonnel?: number;
   antiTank?: number;
   text?: string;
}

export type CountTarget =
   | { kind: "Datasheet"; datasheet: string }
   | { kind: "Keyword"; keyword: string }
   | { kind: "Role"; battlefieldRole: BattlefieldRole }
   | { kind: "Option"; option: string; datasheet?: string }
   | { kind: "DetachmentChoice"; option: string }
   | { kind: "Detachment"; detachment: string }
   | { kind: "DetachmentKind"; detachmentKind: DetachmentKind }
   | { kind: "AnyUnit" }
   | { kind: "UniversalOption"; option: string; datasheet?: string };

export type Condition =
   | { kind: "Count"; scope: CountScope; of: CountTarget; minimum?: number; maximum?: number }
   | { kind: "PrimaryFaction"; faction: string }
   | { kind: "All" | "Any"; conditions: Condition[] }
   | { kind: "Not"; condition: Condition };

export interface LimitTerm {
   per: CountTarget;
   scope: CountScope;
   amount: number;
}

export interface Limit {
   base: number;
   terms?: LimitTerm[];
}

export interface KeywordChanges {
   addsFactionKeywords?: string[];
   addsKeywords?: string[];
}

export interface CostChange {
   when: Condition;
   set?: number;
   increment?: number;
}

export interface Option extends KeywordChanges {
   id?: string;
   name: string;
   cost?: number;
   costChanges?: CostChange[];
   minimum?: number;
   maximum?: number;
   maximumPerDetachment?: number;
   minimumPerArmy?: number;
   maximumPerArmy?: number;
   addsProfiles?: ModelProfile[];
   addsWeapons?: string[];
   removesWeapons?: string[];
   addsAbilities?: string[];
   profileChanges?: ProfileChange[];
   availableWhen?: Condition;
}

export interface OptionGroup {
   id: string;
   name: string;
   minimum?: number | Limit;
   maximum?: number | Limit;
   default?: string;
   options: Option[];
}

export interface ConditionalChange extends KeywordChanges {
   when: Condition;
   addsWeapons?: string[];
   removesWeapons?: string[];
   addsAbilities?: string[];
   profileChanges?: ProfileChange[];
}

export interface AlternativeRole {
   battlefieldRole: BattlefieldRole;
   when: Condition;
}

export interface Datasheet {
   name: string;
   battlefieldRole: BattlefieldRole;
   alternativeRoles?: AlternativeRole[];
   cost: number;
   factionKeywords?: string[];
   keywords: string[];
   profiles: ModelProfile[];
   weapons?: string[];
   abilities?: string[];
   transport?: string;
   wargear?: OptionGroup[];
   conditionalChanges?: ConditionalChange[];
   availableWhen?: Condition;
   maximumPerDetachment?: number;
   maximumPerArmy?: number;
}

export interface ConditionalKeywords extends KeywordChanges {
   when: Condition;
}

export interface DatasheetLink extends KeywordChanges {
   datasheet: string;
   battlefieldRole?: BattlefieldRole;
   alternativeRoles?: AlternativeRole[];
   cost?: number;
   addsAbilities?: string[];
   conditionalKeywords?: ConditionalKeywords[];
   availableWhen?: Condition;
   maximumPerDetachment?: number;
   maximumPerArmy?: number;
}

export interface DetachmentChoiceOption extends KeywordChanges {
   name: string;
}

export interface DetachmentChoice {
   name: string;
   minimum?: number;
   maximum?: number;
   options: Record<string, DetachmentChoiceOption>;
}

export interface DetachmentAbility {
   ability: string;
   availableWhen?: Condition;
}

export type CatalogueKind = "Faction" | "Library";

export interface Catalogue {
   $schema: string;
   id: string;
   name: string;
   kind: CatalogueKind;
   imports?: string[];
   datasheets?: Record<string, Datasheet>;
   datasheetLinks?: Record<string, DatasheetLink>;
   detachmentChoices?: Record<string, DetachmentChoice>;
   detachmentAbilities?: Record<string, DetachmentAbility>;
   weapons?: Record<string, Weapon>;
   abilities?: Record<string, Ability>;
   warmasterTraits?: Record<string, Ability>;
}

export interface KeywordLimit {
   minimum?: number;
   maximum?: Limit;
}

export interface SlotLimit {
   minimum?: number;
   maximum?: Limit;
}

export interface Detachment {
   name: string;
   kind: DetachmentKind;
   maximumPerArmy?: Limit;
   availableWhen?: Condition;
   slots: Partial<Record<BattlefieldRole, SlotLimit>>;
   keywordLimits?: Record<string, KeywordLimit>;
   abilities?: string[];
}

export interface GameSystem {
   $schema: string;
   release: string;
   detachments: Record<string, Detachment>;
   universalOptions?: Record<string, Option>;
   armyKeywordLimits?: Record<string, KeywordLimit>;
   abilities?: Record<string, Ability>;
   warmasterTraits?: Record<string, Ability>;
}
