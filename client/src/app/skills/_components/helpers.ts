/* Pure helpers shared across the /skills route components. */

/** Kebab-case a skill name for the editor's `<slug>.md` filename chip. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}
