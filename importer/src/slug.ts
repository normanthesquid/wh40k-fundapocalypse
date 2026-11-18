export function slugify(name: string): string {
   const slug = name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/'/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
   return slug === "" ? "unnamed" : slug;
}

/** Hands out unique slugs within one namespace, adding `-2`, `-3`, ... when a name repeats. */
export class SlugAllocator {
   private readonly taken = new Set<string>();

   constructor(reserved: Iterable<string> = []) {
      for (const slug of reserved) this.taken.add(slug);
   }

   allocate(name: string): string {
      const base = slugify(name);
      let candidate = base;
      for (let suffix = 2; this.taken.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
      this.taken.add(candidate);
      return candidate;
   }

   has(slug: string): boolean {
      return this.taken.has(slug);
   }
}
