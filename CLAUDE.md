# geromolina.com

Astro 7 + TypeScript static site. Custom WebGL2 and Canvas 2D grid renderer. Vitest. Deployed on Vercel.

## Commands
- Dev: `npx astro dev --port 4321` (Astro 7 daemonizes; stop it with `npx astro dev stop`)
- Build: `npm run build` · Typecheck: `npx astro check` (TypeScript must stay on 6.x)
- Tests: `npx vitest run`
- Force the Canvas fallback in the browser: `?renderer=canvas`

## Conventions
- `src/grid/*` simulation and game code must stay DOM-free, so Vitest can run it. DOM wiring lives in `src/grid/main.ts`.
- Animate with `Spring` (`src/grid/spring.ts`: response plus damping, critically damped by default). Use CSS transitions only for non-gesture fades. Respond on pointer-down. Never block input during an animation.
- Colours and glass come from `src/styles/tokens.css`. Don't introduce new hex values in components.
- Use the system font. `var(--mono)` is only for numbers and labels.
- Respect `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast`.
- Wrap browser storage in try/catch. The page must work without it.
- When you add or move files, update `filemap.md`.

## Docs
- `docs/SPEC.md`: product and game spec (the source of truth)
- `docs/PLAN.md`: task list and status
- `filemap.md`: where things live
