/** Public surface of the DOM-free grid game. */
export * from './physics';
export { Board, inBounds, type Bounds } from './board';
export { costTable, bestPlant, type LoadRoute } from './routing';
export { LEVELS, generateFaults, type LevelDef } from './levels';
export { solve, scoreMask, candidatesFor, type Problem, type Score, type Solution } from './solver';
export { layoutGame, visibleBounds, type GameLayout, type GameNode, type GameNodeKind, type NodeSpec } from './layout';
export { GridGame, starsFor, type EngineOptions, type Evaluation, type LoadResult, type Transformer } from './engine';
export { decorLattice, decorLevel, layoutDecor, type DecorCard, type DecorLayout } from './decor';
