# File map

- `astro.config.mjs` — Astro config (site URL)
- `docs/SPEC.md` — product and game spec
- `docs/PLAN.md` — task list and status
- `src/assets/gero.jpg` — portrait for the About section
- `src/styles/tokens.css` — colour, type and glass tokens, plus global base styles
- `src/layouts/Base.astro` — html shell, meta tags, global CSS
- `src/pages/index.astro` — home page: map hero plus sections (placeholders for now)
- `src/components/GridMap.astro` — map markup, styles, client mount (nodes, panel, toast)
- `src/grid/main.ts` — DOM wiring: layout, input, loop, panel, toasts
- `src/grid/sim.ts` — DOM-free grid simulation (electrons, physics)
- `src/grid/layout.ts` — lattice sizing; snaps nodes to vertices
- `src/grid/nodes.ts` — `MapNode` type and current node data
- `src/grid/renderers.ts` — WebGL2 and Canvas 2D electron renderers, static mesh
- `src/grid/spring.ts` — critically damped spring
- `tests/sim.test.ts` — Vitest for the simulation
- `.claude/launch.json` — dev-server config for the preview
