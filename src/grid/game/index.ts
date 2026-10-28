/** Public surface of the DOM-free grid game. */
export * from './physics';
export { Board, inBounds, type Bounds } from './board';
export { costTable, bestPlant, type LoadRoute } from './routing';
export { LEVELS, generateFaults, type LevelDef } from './levels';
export { solve, scoreMask, candidatesFor, type Problem, type Score, type Solution } from './solver';
export { layoutGame, visibleBounds, type GameLayout, type GameNode, type GameNodeKind, type NodeSpec } from './layout';
export { GridGame, starsFor, type EngineOptions, type Evaluation, type LoadResult, type Transformer } from './engine';
export {
  CATEGORY_GRID,
  MENU_PX,
  bandSqueeze,
  circuitPaths,
  circuitTransformers,
  menuAnchors,
  menuBands,
  menuLayout,
  squeezeRow,
  type Band,
  type MenuCategoryLayout,
  type Feed,
  type FeedPath,
  type LatticeRect,
  type MenuLayout,
  type MenuMode,
  type MenuSectionLayout,
  type MenuStyle,
  corridorPaths,
  corridorTransformers,
  decorLattice,
  decorLevel,
  layoutDecor,
  menuLattice,
  snapMenu,
  type CorridorPath,
  type CorridorStep,
  type DecorCard,
  type DecorLayout,
  type MenuPoint,
  type MenuSnap,
  type MenuSnapOptions,
} from './decor';
