/**
 * Grid-game physics constants (SPEC "Physics"). Pure numbers, no DOM.
 *
 * Two voltage levels joined by a ×25 transformer. Line loss follows I²R, so
 * 25× less current at HIGH means 625× less loss per segment.
 */

/** Voltage level of an energy packet. Numeric so it can live in a typed array. */
export const LOW = 0;
export const HIGH = 1;
export type VoltageLevel = typeof LOW | typeof HIGH;

export const VOLTAGE_LOW = 13_800; // V, generation and distribution
export const VOLTAGE_HIGH = 345_000; // V, transmission
export const RATIO = VOLTAGE_HIGH / VOLTAGE_LOW; // 25

/** Fraction of energy lost per lattice segment at LOW. */
export const LOSS_LOW = 0.06;
/** I²R: 25× less current → 625× less loss. */
export const LOSS_HIGH = LOSS_LOW / (RATIO * RATIO);
/** Fraction of energy lost per transformer pass. */
export const T_LOSS = 0.01;
/** A load is lit when its expected efficiency reaches this. */
export const LIT_THRESHOLD = 0.8;
/** Output of each active plant. */
export const PLANT_MW = 50;

/** Routing cost (nats) of one segment at a level: −ln(1 − loss). */
export const SEG_COST: readonly [number, number] = [-Math.log(1 - LOSS_LOW), -Math.log(1 - LOSS_HIGH)];
/** Routing cost (nats) of one transformer pass. */
export const T_COST = -Math.log(1 - T_LOSS);

/** Softmax temperature for electron routing at LOW, in nats. Scaled per level (see engine). */
export const ROUTE_TEMP = 0.06; // orchestrator: tighter HV corridor (≈88% within ±1 row)
/** Drift speed multiplier per level: HIGH carries less current, so it drifts slower. */
export const DRIFT: readonly [number, number] = [1, 0.6];
/** Heat accumulator decay time constant, seconds. */
export const HEAT_TAU = 1;
/** Fraction of the electron pool that are ambient wanderers (never counted). */
export const AMBIENT_FRACTION = 0.35;
