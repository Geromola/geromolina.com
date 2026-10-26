/**
 * Ballpark catalog: everyday things and how much energy they take. US reference values (120 V
 * homes, gallons, miles). Each item carries the source its number comes from.
 *
 * - `power` items run at a steady average draw, so energy = count × watts × hours.
 * - `event` items come in units with a fixed energy each (a charge, a mile, a gallon).
 */

export interface Source {
  label: string;
  url: string;
}

interface ItemBase {
  id: string;
  name: string;
  /** One line shown on the reveal. */
  fact: string;
  source: Source;
}

export interface PowerItem extends ItemBase {
  kind: 'power';
  /** Average draw while running, in watts. */
  watts: number;
  /** How many of them run at once (e.g. 10 bulbs). */
  counts: number[];
  /** Realistic run times, in hours. */
  hours: number[];
}

export interface EventItem extends ItemBase {
  kind: 'event';
  /** Energy per unit, in Wh. */
  whPer: number;
  unit: { one: string; many: string };
  amounts: number[];
}

export type Item = PowerItem | EventItem;

export interface Anchor {
  id: string;
  /** The single scenario line that defines the anchor. */
  line: Line;
  /** For equivalences: "≈ 28 phone charges". */
  one: string;
  many: string;
  /** Short label for the axis landmark. */
  short: string;
}

/** One line of a scenario: an item, how many, and (for power items) for how long. */
export interface Line {
  itemId: string;
  count: number;
  hours?: number;
}

const MIN = 1 / 60;
const DAY = 24;
const WEEK = 7 * DAY;
const MONTH = 730;
const YEAR = 8760;

const DOE: Source = {
  label: 'DOE Energy Saver: appliance energy use',
  url: 'https://www.energy.gov/energysaver/estimating-appliance-and-home-electronic-energy-use',
};
const EIA_HOME: Source = {
  label: 'EIA: how much electricity does an American home use?',
  url: 'https://www.eia.gov/tools/faqs/faq.php?id=97&t=3',
};

export const ITEMS: Item[] = [
  // Power items, smallest draw first.
  {
    id: 'led',
    kind: 'power',
    name: 'LED bulb',
    watts: 9,
    counts: [1, 10, 20],
    hours: [1, 5, 12, DAY],
    fact: 'A 9 W LED gives the light of an old 60 W incandescent.',
    source: DOE,
  },
  {
    id: 'router',
    kind: 'power',
    name: 'Wi-Fi router',
    watts: 10,
    counts: [1],
    hours: [DAY, WEEK, MONTH, YEAR],
    fact: 'Always-on gadgets are small, but they never stop: a router burns ~90 kWh a year.',
    source: DOE,
  },
  {
    id: 'laptop',
    kind: 'power',
    name: 'Laptop',
    watts: 30,
    counts: [1],
    hours: [1, 3, 8, 40],
    fact: 'A laptop sips ~30 W while you work, about a tenth of a gaming PC under load.',
    source: DOE,
  },
  {
    id: 'fridge',
    kind: 'power',
    name: 'Fridge',
    watts: 50,
    counts: [1],
    hours: [DAY, WEEK, MONTH, YEAR],
    fact: 'A fridge cycles on and off; ~450 kWh a year averages out to ~50 W.',
    source: { label: 'EIA RECS 2020 via EnergyGuide labels', url: 'https://www.eia.gov/consumption/residential/' },
  },
  {
    id: 'tv',
    kind: 'power',
    name: '65" TV',
    watts: 100,
    counts: [1],
    hours: [1, 3, 5],
    fact: 'A big LED TV draws ~100 W, about the same as one old incandescent bulb.',
    source: DOE,
  },
  {
    id: 'gaming-pc',
    kind: 'power',
    name: 'Gaming PC',
    watts: 400,
    counts: [1],
    hours: [1, 3, 8],
    fact: 'Under load, a gaming PC pulls ~400 W: most of it is the graphics card.',
    source: DOE,
  },
  {
    id: 'h100',
    kind: 'power',
    name: 'H100 GPU',
    watts: 700,
    counts: [1, 8, 1000],
    hours: [1, DAY, WEEK],
    fact: 'One H100 is rated at up to 700 W. AI clusters run tens of thousands of them.',
    source: { label: 'NVIDIA H100 specifications', url: 'https://www.nvidia.com/en-us/data-center/h100/' },
  },
  {
    id: 'window-ac',
    kind: 'power',
    name: 'Window AC',
    watts: 1000,
    counts: [1],
    hours: [1, 8, DAY],
    fact: 'A window unit draws ~1 kW. Heat pumps move ~3 units of heat per unit of electricity.',
    source: DOE,
  },
  {
    id: 'microwave',
    kind: 'power',
    name: 'Microwave',
    watts: 1100,
    counts: [1],
    hours: [2 * MIN, 5 * MIN, 15 * MIN],
    fact: 'High power, short runs: two minutes of microwave is under 40 Wh.',
    source: DOE,
  },
  {
    id: 'kettle',
    kind: 'power',
    name: 'Electric kettle',
    watts: 1500,
    counts: [1],
    hours: [3 * MIN, 5 * MIN, 10 * MIN],
    fact: 'A US kettle maxes out near 1,500 W, the limit of a 15 A, 120 V outlet.',
    source: DOE,
  },
  {
    id: 'space-heater',
    kind: 'power',
    name: 'Space heater',
    watts: 1500,
    counts: [1],
    hours: [1, 8, MONTH],
    fact: 'Resistance heat turns 1 W into exactly 1 W of heat; a heat pump gets ~3×.',
    source: DOE,
  },
  {
    id: 'hair-dryer',
    kind: 'power',
    name: 'Hair dryer',
    watts: 1800,
    counts: [1],
    hours: [5 * MIN, 10 * MIN, 30 * MIN],
    fact: 'At 1,800 W, a hair dryer is one of the hungriest things you can plug into a wall.',
    source: DOE,
  },
  {
    id: 'oven',
    kind: 'power',
    name: 'Electric oven',
    watts: 2000,
    counts: [1],
    hours: [30 * MIN, 1, 3],
    fact: 'The element is ~3–5 kW, but the thermostat cycles it: ~2 kW on average.',
    source: DOE,
  },
  {
    id: 'dryer',
    kind: 'power',
    name: 'Clothes dryer',
    watts: 3000,
    counts: [1],
    hours: [45 * MIN, 1],
    fact: 'An electric dryer load is ~3 kWh, more than a whole day of a fridge.',
    source: DOE,
  },
  {
    id: 'central-ac',
    kind: 'power',
    name: 'Central AC',
    watts: 3500,
    counts: [1],
    hours: [1, 8, MONTH],
    fact: 'A 3-ton central AC draws ~3.5 kW. In a hot summer it is the biggest load in the house.',
    source: DOE,
  },
  {
    id: 'l2-charger',
    kind: 'power',
    name: 'Level 2 EV charger',
    watts: 7200,
    counts: [1],
    hours: [1, 4, 10],
    fact: 'A 30 A, 240 V home charger adds ~25 miles of range per hour.',
    source: { label: 'DOE AFDC: charging at home', url: 'https://afdc.energy.gov/fuels/electricity-charging-home' },
  },
  {
    id: 'wind-turbine',
    kind: 'power',
    name: '3 MW wind turbine at full output',
    watts: 3_000_000,
    counts: [1],
    hours: [1, DAY],
    fact: 'One hour of a 3 MW turbine at full output is ~100 US home-days of electricity.',
    source: { label: 'DOE: wind turbine sizes', url: 'https://www.energy.gov/eere/articles/wind-turbines-bigger-better' },
  },

  // Event items, smallest unit first.
  {
    id: 'ai-query',
    kind: 'event',
    name: 'Ask an AI chatbot',
    whPer: 0.3,
    unit: { one: 'query', many: 'queries' },
    amounts: [1, 20, 1000],
    fact: 'A typical GPT-4o reply is ~0.3 Wh, a tenth of the old 3 Wh estimate. Long reasoning costs more.',
    source: { label: 'Epoch AI, 2025', url: 'https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use' },
  },
  {
    id: 'phone-charge',
    kind: 'event',
    name: 'Charge a phone from empty',
    whPer: 15,
    unit: { one: 'full charge', many: 'full charges' },
    amounts: [1, 7, 365],
    fact: 'A phone battery holds ~13 Wh; charger losses bring a full charge to ~15 Wh.',
    source: { label: 'Apple iPhone battery specs (13 Wh) plus ~85% charger efficiency', url: 'https://support.apple.com/specs/iphone' },
  },
  {
    id: 'laptop-charge',
    kind: 'event',
    name: 'Charge a laptop from empty',
    whPer: 60,
    unit: { one: 'full charge', many: 'full charges' },
    amounts: [1, 5, 250],
    fact: 'Airlines cap carry-on batteries at 100 Wh, so a laptop battery is always smaller.',
    source: { label: 'FAA: lithium batteries in baggage', url: 'https://www.faa.gov/hazmat/packsafe/lithium-batteries' },
  },
  {
    id: 'dishwasher',
    kind: 'event',
    name: 'Run the dishwasher',
    whPer: 1200,
    unit: { one: 'cycle', many: 'cycles' },
    amounts: [1, 4, 200],
    fact: 'Most of a dishwasher’s energy goes into heating water, not spinning it.',
    source: DOE,
  },
  {
    id: 'food',
    kind: 'event',
    name: 'Eat a 2,000 kcal diet',
    whPer: 2326,
    unit: { one: 'day', many: 'days' },
    amounts: [1, 7, 365],
    fact: '2,000 kcal is 2.3 kWh: you run on roughly 100 W, like an old light bulb.',
    source: { label: 'Unit conversion: 1 kcal = 4,184 J', url: 'https://www.nist.gov/pml/special-publication-811' },
  },
  {
    id: 'ev-mile',
    kind: 'event',
    name: 'Drive an EV',
    whPer: 300,
    unit: { one: 'mile', many: 'miles' },
    amounts: [5, 30, 300, 12000],
    fact: 'An EV uses ~0.3 kWh a mile, about a quarter of the energy a gas car burns.',
    source: { label: 'fueleconomy.gov', url: 'https://www.fueleconomy.gov/feg/evtech.shtml' },
  },
  {
    id: 'gas-mile',
    kind: 'event',
    name: 'Drive a 30 mpg gas car',
    whPer: 1123,
    unit: { one: 'mile', many: 'miles' },
    amounts: [5, 30, 300, 12000],
    fact: 'At 30 mpg, every mile burns 1.1 kWh of gasoline, and ~75% of it leaves as heat.',
    source: { label: 'EPA: 33.7 kWh per gallon of gasoline', url: 'https://www.fueleconomy.gov/feg/label/learn-more-electric-label.jsp' },
  },
  {
    id: 'gasoline',
    kind: 'event',
    name: 'Burn gasoline',
    whPer: 33_700,
    unit: { one: 'gallon', many: 'gallons' },
    amounts: [1, 12, 500],
    fact: 'One gallon holds 33.7 kWh: more than a US home uses in a day.',
    source: { label: 'EPA: 33.7 kWh per gallon of gasoline', url: 'https://www.fueleconomy.gov/feg/label/learn-more-electric-label.jsp' },
  },
  {
    id: 'ev-charge',
    kind: 'event',
    name: 'Fill a 75 kWh EV battery',
    whPer: 75_000,
    unit: { one: 'full charge', many: 'full charges' },
    amounts: [1, 4, 50],
    fact: 'A full EV battery holds about as much energy as 2 gallons of gas, and goes ~250 miles.',
    source: { label: 'fueleconomy.gov', url: 'https://www.fueleconomy.gov/feg/evtech.shtml' },
  },
  {
    id: 'home-day',
    kind: 'event',
    name: 'Power a US home',
    whPer: 29_600,
    unit: { one: 'day', many: 'days' },
    amounts: [1, 7, 30, 365],
    fact: 'The average US home bought 10,791 kWh of electricity in 2022: ~30 kWh a day.',
    source: EIA_HOME,
  },
  {
    id: 'flight',
    kind: 'event',
    name: 'Fly SFO → JFK in economy',
    whPer: 1_100_000,
    unit: { one: 'seat', many: 'seats' },
    amounts: [1, 2, 200],
    fact: 'A coast-to-coast seat burns ~30 gallons of jet fuel: about 1 MWh, or a month of a US home.',
    source: { label: 'Ask the Pilot (fuel per seat) and EIA (135,000 Btu per gallon of jet fuel)', url: 'https://www.eia.gov/energyexplained/units-and-calculators/british-thermal-units.php' },
  },
  {
    id: 'megapack',
    kind: 'event',
    name: 'Fill a Tesla Megapack',
    whPer: 3_900_000,
    unit: { one: 'Megapack', many: 'Megapacks' },
    amounts: [1, 10, 100],
    fact: 'One Megapack stores 3.9 MWh: enough to run ~130 US homes for a day.',
    source: { label: 'Tesla Megapack', url: 'https://www.tesla.com/megapack' },
  },
  {
    id: 'american-year',
    kind: 'event',
    name: 'All the energy an average American uses',
    whPer: 82_000_000,
    unit: { one: 'year', many: 'years' },
    amounts: [1, 10],
    fact: 'Counting fuel, power plants and industry, each American uses ~279 million Btu a year: ~82 MWh, about 9,000 W nonstop.',
    source: { label: 'EIA: how much energy does a person use in a year?', url: 'https://www.eia.gov/tools/faqs/faq.php?id=85&t=1' },
  },
  {
    id: 'gpt3',
    kind: 'event',
    name: 'Train GPT-3',
    whPer: 1_287_000_000,
    unit: { one: 'training run', many: 'training runs' },
    amounts: [1],
    fact: 'Training GPT-3 took ~1,287 MWh: about 120 US homes for a year. Newer frontier models use far more.',
    source: { label: 'Patterson et al., 2021', url: 'https://arxiv.org/abs/2104.10350' },
  },
];

const byId = new Map(ITEMS.map((i) => [i.id, i]));

export function getItem(id: string): Item {
  const item = byId.get(id);
  if (!item) throw new Error(`Unknown item: ${id}`);
  return item;
}

/** Energy of one scenario line, in Wh. */
export function lineWh(line: Line): number {
  const item = getItem(line.itemId);
  return item.kind === 'power' ? line.count * item.watts * (line.hours ?? 0) : line.count * item.whPer;
}

/**
 * The memory ladder: about one landmark per decade, smallest first. Learning one pins it to the
 * axis, so the axis turns into a personal ruler.
 */
export const ANCHORS: Anchor[] = [
  { id: 'ai-query', line: { itemId: 'ai-query', count: 1 }, one: 'AI chat query', many: 'AI chat queries', short: 'AI query' },
  { id: 'phone', line: { itemId: 'phone-charge', count: 1 }, one: 'phone charge', many: 'phone charges', short: 'Phone' },
  { id: 'laptop', line: { itemId: 'laptop-charge', count: 1 }, one: 'laptop charge', many: 'laptop charges', short: 'Laptop' },
  { id: 'fridge-day', line: { itemId: 'fridge', count: 1, hours: DAY }, one: 'day of a fridge', many: 'days of a fridge', short: 'Fridge·day' },
  { id: 'food-day', line: { itemId: 'food', count: 1 }, one: 'day of food', many: 'days of food', short: 'Food·day' },
  { id: 'home-day', line: { itemId: 'home-day', count: 1 }, one: 'US home-day', many: 'US home-days', short: 'Home·day' },
  { id: 'gallon', line: { itemId: 'gasoline', count: 1 }, one: 'gallon of gas', many: 'gallons of gas', short: 'Gallon' },
  { id: 'ev', line: { itemId: 'ev-charge', count: 1 }, one: 'EV charge', many: 'EV charges', short: 'EV' },
  { id: 'flight', line: { itemId: 'flight', count: 1 }, one: 'coast-to-coast seat', many: 'coast-to-coast seats', short: 'Flight' },
  { id: 'home-year', line: { itemId: 'home-day', count: 365 }, one: 'US home-year', many: 'US home-years', short: 'Home·year' },
  { id: 'american-year', line: { itemId: 'american-year', count: 1 }, one: 'American-year', many: 'American-years', short: 'You·year' },
  { id: 'gpt3', line: { itemId: 'gpt3', count: 1 }, one: 'GPT-3 training run', many: 'GPT-3 training runs', short: 'GPT-3' },
];

export function anchorWh(anchor: Anchor): number {
  return lineWh(anchor.line);
}
