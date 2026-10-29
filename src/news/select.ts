/**
 * The editor's picks: check what Claude returned against the candidates, and the score-only
 * fallback when the editor fails (SPEC "News wire" step 6). Pure.
 */
import { SECTIONS, type Pick, type Picks, type Section, type Story } from './types';

export const MUST_KNOW_MAX = 5;
export const MUST_KNOW_MIN_IMPORTANCE = 7;
export const FALLBACK_MUST_KNOW = 4;
export const SECTION_MAX = 6;
export const WHY_WORDS = 12;

const emptySections = (): Record<Section, Pick[]> => ({ cleantech: [], ai: [], world: [] });

export function clampWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(' ') : `${words.slice(0, max).join(' ').replace(/[,;:.]$/, '')}…`;
}

export const pickCount = (p: Picks): number => p.mustKnow.length + SECTIONS.reduce((n, s) => n + p.sections[s].length, 0);

/**
 * Keep only ids that are candidates, each once (Must know first), each in its own section,
 * within the limits; trim every `why`. Null when too little survives to make an edition.
 */
export function sanitizePicks(raw: Picks, candidates: readonly Story[]): Picks | null {
  const byId = new Map(candidates.map((s) => [s.id, s]));
  const used = new Set<string>();
  const take = (p: Pick, section?: Section): Pick | null => {
    const story = byId.get(p.id);
    if (!story || used.has(p.id) || (section && story.category !== section)) return null;
    used.add(p.id);
    return { id: p.id, why: clampWords(p.why ?? '', WHY_WORDS) };
  };
  const mustKnow = raw.mustKnow.map((p) => take(p)).filter((p): p is Pick => p !== null).slice(0, MUST_KNOW_MAX);
  // Ids beyond the cap go back to the pool, so a section can still use them.
  for (const p of raw.mustKnow) if (!mustKnow.some((m) => m.id === p.id)) used.delete(p.id);
  const sections = emptySections();
  for (const s of SECTIONS) {
    sections[s] = (raw.sections[s] ?? []).map((p) => take(p, s)).filter((p): p is Pick => p !== null).slice(0, SECTION_MAX);
  }
  const picks = { mustKnow, sections };
  const enough = Math.min(6, candidates.length);
  return mustKnow.length >= 1 && pickCount(picks) >= enough ? picks : null;
}

/** Score-only edition: the most important, widely covered stories, then each section's best. */
export function fallbackPicks(candidates: readonly Story[]): Picks {
  const weight = (s: Story) => s.importance + Math.log2(1 + s.items.length);
  const mustKnow = candidates
    .filter((s) => s.importance >= MUST_KNOW_MIN_IMPORTANCE)
    .sort((a, b) => weight(b) - weight(a) || b.score - a.score)
    .slice(0, FALLBACK_MUST_KNOW)
    .map((s) => ({ id: s.id, why: '' }));
  const used = new Set(mustKnow.map((p) => p.id));
  const sections = emptySections();
  for (const section of SECTIONS) {
    sections[section] = candidates
      .filter((s) => s.category === section && !used.has(s.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, SECTION_MAX)
      .map((s) => ({ id: s.id, why: '' }));
  }
  return { mustKnow, sections };
}
