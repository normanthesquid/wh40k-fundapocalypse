import type { Ability, Weapon } from "./model.ts";
import type { SourceDocument } from "./registry.ts";
import { SlugAllocator } from "./slug.ts";

/** The entries of one output file (a catalogue or the game system), keyed by slug, plus its slug namespace. */
export class OutputBuilder {
   readonly slugs: SlugAllocator;
   readonly weapons = new Map<string, Weapon>();
   readonly abilities = new Map<string, Ability>();
   readonly warmasterTraits = new Map<string, Ability>();
   readonly imports = new Set<string>();
   private readonly weaponByContent = new Map<string, string>();
   private readonly abilityByContent = new Map<string, string>();
   private readonly slugByBattleScribeId = new Map<string, string>();

   readonly document: SourceDocument;

   constructor(document: SourceDocument, reserved: Iterable<string>) {
      this.document = document;
      this.slugs = new SlugAllocator(reserved);
   }

   /** The slug of an entry identified by its BattleScribe id, allocated from `name` on first use. */
   slugFor(battleScribeId: string, name: string): string {
      let slug = this.slugByBattleScribeId.get(battleScribeId);
      if (slug === undefined) {
         slug = this.slugs.allocate(name);
         this.slugByBattleScribeId.set(battleScribeId, slug);
      }
      return slug;
   }

   knownSlug(battleScribeId: string): string | undefined {
      return this.slugByBattleScribeId.get(battleScribeId);
   }

   addWeapon(weapon: Weapon): string {
      const content = JSON.stringify(weapon);
      let slug = this.weaponByContent.get(content);
      if (slug === undefined) {
         slug = this.slugs.allocate(weapon.name);
         this.weaponByContent.set(content, slug);
         this.weapons.set(slug, weapon);
      }
      return slug;
   }

   addAbility(ability: Ability): string {
      const content = JSON.stringify(ability);
      let slug = this.abilityByContent.get(content);
      if (slug === undefined) {
         slug = this.slugs.allocate(ability.name);
         this.abilityByContent.set(content, slug);
         this.abilities.set(slug, ability);
      }
      return slug;
   }

   findAbility(ability: Ability): string | undefined {
      return this.abilityByContent.get(JSON.stringify(ability));
   }

   addWarmasterTrait(battleScribeId: string, trait: Ability): string {
      const slug = this.slugFor(battleScribeId, trait.name);
      this.warmasterTraits.set(slug, trait);
      return slug;
   }
}

export function referenceFrom(from: OutputBuilder, to: OutputBuilder, slug: string): string {
   if (from === to || to.document.isGameSystem) return slug;
   from.imports.add(to.document.slug);
   return `${to.document.slug}/${slug}`;
}
