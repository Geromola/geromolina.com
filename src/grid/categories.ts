/**
 * Project categories (SPEC "Projects menu by category"): what a project is and what a visitor
 * does with it, never where it came from (an origin is only a tag). Fixed, in this order.
 * DOM-free, so Vitest can check the grouping.
 */
export const CATEGORIES = [
  { id: 'math-nature', label: 'Math & Nature', tagline: 'Simple rules, living patterns.' },
  { id: 'games', label: 'Games', tagline: 'Playable, with something to learn.' },
  { id: 'solutions', label: 'Solutions', tagline: 'Systems that automate, organize or analyze real work.' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]];

export interface CategoryGroup<T> {
  id: CategoryId;
  label: string;
  tagline: string;
  items: T[];
}

/**
 * Projects grouped by category, in the fixed category order, each sorted by `order` (ties keep
 * their input order). Empty categories are left out; items without a category are dropped.
 */
export function groupByCategory<T extends { category?: string; order: number }>(items: readonly T[]): CategoryGroup<T>[] {
  return CATEGORIES.map((c) => ({
    ...c,
    items: items
      .map((item, k) => ({ item, k }))
      .filter(({ item }) => item.category === c.id)
      .sort((a, b) => a.item.order - b.item.order || a.k - b.k)
      .map(({ item }) => item),
  })).filter((g) => g.items.length > 0);
}
