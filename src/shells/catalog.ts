/**
 * The identifier's cache: real shells placed in Raup's cube, with what the animal is, where it
 * lives, what the shell does for it, three short facts and a credited Commons photo
 * (`src/assets/shells/<id>.jpg`). W, D and T were tuned by growing each shell and comparing it
 * with photos; they are approximate. Facts were checked against Wikipedia (the entry's page or
 * its group's) on 2026-10-27.
 */
import type { Region, ShellParams } from './model';

export interface Credit {
  author: string;
  license: string;
  /** The file's page on Wikimedia Commons. */
  source: string;
}

export interface CatalogEntry extends ShellParams {
  id: string;
  name: string;
  latin: string;
  group: Region['id'];
  /** Where it lives, one line. */
  habitat: string;
  /** What the shell does for the animal, one line. */
  use: string;
  facts: [string, string, string];
  image: Credit;
  wiki: string;
  /** Shown as a preset chip, under `chip` (or `name`). */
  preset?: boolean;
  chip?: string;
}

const commons = (file: string) => `https://commons.wikimedia.org/wiki/File:${file}`;
const wiki = (page: string) => `https://en.wikipedia.org/wiki/${page}`;

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'nautilus',
    name: 'Chambered nautilus',
    latin: 'Nautilus pompilius',
    group: 'cephalopods',
    W: 3.2,
    D: 0,
    T: 0,
    habitat: 'Deep slopes of Indo-Pacific coral reefs, usually several hundred metres down.',
    use: 'It lives in the last chamber. The older chambers hold gas and liquid, and a tube through them, the siphuncle, slowly changes the liquid to adjust its buoyancy.',
    facts: [
      'It was long called a living fossil; it is now known to be only a distant relative of the ammonites.',
      'It has about 90 tentacles, and none of them have suckers.',
      'Its eye has no lens: it works like a pinhole camera, open to the sea.',
    ],
    image: { author: 'Hans Hillewaert', license: 'CC BY-SA 4.0', source: commons('Nautilus_pompilius_(detail).jpg') },
    wiki: wiki('Chambered_nautilus'),
    preset: true,
    chip: 'Nautilus',
  },
  {
    id: 'placenticeras',
    name: 'Involute ammonite',
    latin: 'Placenticeras',
    group: 'cephalopods',
    W: 2.6,
    D: 0.15,
    T: 0,
    habitat: 'Shallow seas of Late Cretaceous North America, among the last ammonites.',
    use: 'Like the nautilus, a chambered float: the animal lived in the outer whorl and trimmed its buoyancy with the gas-filled chambers behind it.',
    facts: [
      'Each new whorl wraps around the last, so only the outermost one shows.',
      'The gemstone ammolite is the fossil shell of two Placenticeras species, still iridescent after 70 to 75 million years.',
      'Some shells carry rows of round holes that have been read as the bite marks of mosasaurs, giant marine reptiles.',
    ],
    image: { author: 'Ghedoghedo', license: 'CC BY-SA 3.0', source: commons('Placenticeras_meeki.jpg') },
    wiki: wiki('Placenticeras'),
  },
  {
    id: 'dactylioceras',
    name: 'Evolute ammonite',
    latin: 'Dactylioceras',
    group: 'cephalopods',
    W: 1.8,
    D: 0.45,
    T: 0,
    habitat: 'Early Jurassic seas, about 180 million years ago; fine fossils come from England and Germany.',
    use: 'A chambered float, like every ammonite. Its whorls barely overlap, so every turn stays on show.',
    facts: [
      'Ammonites were once sold as "snakestones", sometimes with a snake’s head carved on, and legend credited St Hilda of Whitby with turning snakes to stone.',
      'It spread fast and widely, so geologists use it to date Early Jurassic rocks.',
      'Its ribbed whorls are almost perfectly round in cross-section.',
    ],
    image: { author: 'Kevmin', license: 'CC BY-SA 3.0', source: commons('Dactylioceras_01.jpg') },
    wiki: wiki('Dactylioceras'),
    preset: true,
    chip: 'Ammonite',
  },
  {
    id: 'spirula',
    name: "Ram's horn squid",
    latin: 'Spirula spirula',
    group: 'cephalopods',
    W: 2,
    D: 0.6,
    T: 0,
    habitat: 'The open ocean in tropical and subtropical waters, hundreds of metres down by day and shallower at night.',
    use: 'The coil is inside the squid’s body. Its chambers work as a float; seen alive, the squid hung upright, head up.',
    facts: [
      'The whorls do not touch: a loose coil, rare among shells.',
      'The light shells wash up on beaches by the thousand, yet the living animal is rarely seen; it was first filmed in the wild in 2020.',
      'It carries a light organ at the tip of its body, between its fins, that glows green.',
    ],
    image: { author: 'Ewald Heinrich Rübsaamen', license: 'Public domain', source: commons('Spirula_spirula1.jpg') },
    wiki: wiki('Spirula'),
    preset: true,
    chip: 'Spirula',
  },
  {
    id: 'ramshorn',
    name: "Great ram's horn snail",
    latin: 'Planorbarius corneus',
    group: 'gastropods',
    W: 2,
    D: 0.35,
    T: 0.15,
    habitat: 'Ponds, rivers and canals across Europe, clinging to water plants.',
    use: 'A portable shelter it pulls back into when threatened, or when its pond starts to dry out.',
    facts: [
      'Its blood carries haemoglobin, like ours; most snails use a copper-based protein instead.',
      'When oxygen runs low it reaches up to the surface to fill its lung with air.',
      'Its shell is coiled almost flat, like a nautilus, though it is a snail.',
    ],
    image: { author: 'Claus Ableiter', license: 'CC BY-SA 3.0', source: commons('Posthornschnecke1.jpg') },
    wiki: wiki('Planorbarius_corneus'),
  },
  {
    id: 'garden-snail',
    name: 'Garden snail',
    latin: 'Cornu aspersum',
    group: 'gastropods',
    W: 2.2,
    D: 0.1,
    T: 1.2,
    habitat: 'Native to the Mediterranean; now in gardens across the temperate world.',
    use: 'A portable, moist home. In dry weather it seals the opening with a film of dried mucus and waits for rain.',
    facts: [
      'In French cuisine it is the petit gris escargot.',
      'Every snail is both male and female, and courting pairs stab each other with "love darts".',
      'Adults have a whitish lip folded back around the opening.',
    ],
    image: { author: 'Unknown author', license: 'Public domain', source: commons('Snail1web.jpg') },
    wiki: wiki('Cornu_aspersum'),
    preset: true,
    chip: 'Garden snail',
  },
  {
    id: 'turritella',
    name: 'Screw shell',
    latin: 'Turritella terebra',
    group: 'gastropods',
    W: 1.25,
    D: 0.05,
    T: 3.5,
    habitat: 'Muddy and sandy seabeds of the tropical Indo-West Pacific.',
    use: 'A tall, armoured tower. Turritellids burrow into mud or sand and filter-feed, which is unusual for a snail.',
    facts: [
      'Its slow-widening tube turns again and again: the shell can have as many as 30 whorls.',
      'Fossil turritellids are so common that some limestones are made of little else.',
      'One kind of "Turritella agate" is a misnomer: the snails in it are freshwater Elimia.',
    ],
    image: { author: 'H. Zell', license: 'CC BY-SA 3.0', source: commons('Turritella_terebra_terebra_01.JPG') },
    wiki: wiki('Turritella_terebra'),
    preset: true,
    chip: 'Turritella',
  },
  {
    id: 'cone',
    name: 'Textile cone',
    latin: 'Conus textile',
    group: 'gastropods',
    W: 3.5,
    D: 0,
    T: 0.6,
    habitat: 'The tropical Indo-Pacific and the Red Sea, buried in sand by day.',
    use: 'A thick armoured shelter for a hunter that comes out at night to eat other snails, including cones and cowries.',
    facts: [
      'It hunts with a venomous, harpoon-like tooth, and its sting is dangerous to people.',
      'A painkiller, ziconotide, is made from the venom of a related cone snail, Conus magus.',
      'Its tent pattern resembles Rule 30, a famous one-line cellular automaton.',
    ],
    image: { author: 'Richard Ling', license: 'CC BY-SA 3.0', source: commons('Textile_cone.JPG') },
    wiki: wiki('Conus_textile'),
  },
  {
    id: 'cowrie',
    name: 'Tiger cowrie',
    latin: 'Cypraea tigris',
    group: 'gastropods',
    W: 20,
    D: 0,
    T: 0.3,
    habitat: 'The Indo-Pacific seafloor, 10 to 40 m down, often among live coral.',
    use: 'Shelter and armour. Two flaps of its body, the mantle, can stretch over the shell and cover it completely.',
    facts: [
      'In the adult the last whorl hides the earlier ones, so the spire disappears.',
      'Cowrie shells were used as money across Africa and Asia for centuries.',
      'It is large and heavy for a cowrie, up to 15 cm long.',
    ],
    image: { author: 'Nick Hobgood', license: 'CC BY-SA 3.0', source: commons('Cypraea_tigris_(Tiger_cowrie).jpg') },
    wiki: wiki('Cypraea_tigris'),
  },
  {
    id: 'wentletrap',
    name: 'Precious wentletrap',
    latin: 'Epitonium scalare',
    group: 'gastropods',
    W: 1.4,
    D: 0.4,
    T: 2.5,
    habitat: 'Sandy seabeds from the Red Sea and Indian Ocean to Japan and Fiji, near anemones and corals.',
    use: 'A shelter for a small predator; wentletraps feed on sea anemones and corals.',
    facts: [
      'Its whorls do not touch: only the ribs, called costae, hold them together.',
      'In the 17th and 18th centuries it was so rare that single shells changed hands for large sums.',
      'The name comes from the Dutch for spiral staircase.',
    ],
    image: { author: 'Steve Jurvetson', license: 'CC BY 2.0', source: commons('Epitonium_scalare_shell.jpg') },
    wiki: wiki('Epitonium_scalare'),
  },
  {
    id: 'abalone',
    name: 'Red abalone',
    latin: 'Haliotis rufescens',
    group: 'gastropods',
    W: 60,
    D: 0.05,
    T: 0.5,
    habitat: 'Rocky reefs and kelp forests of the Pacific coast of North America.',
    use: 'A shield over a broad muscular foot that clings to rock. A row of holes vents water from the gills.',
    facts: [
      'It is the largest abalone in the world, with shells up to 31 cm.',
      'Almost all of the shell is one huge, fast-widening whorl, so the coil is hard to see.',
      'Materials scientists study abalone shell layers for ideas for stronger body armour.',
    ],
    image: { author: 'NOAA Southwest Fisheries Science Center', license: 'Public domain', source: commons('Haliotis_rufescens.jpeg') },
    wiki: wiki('Red_abalone'),
  },
  {
    id: 'limpet',
    name: 'Common limpet',
    latin: 'Patella vulgata',
    group: 'gastropods',
    W: 1e5,
    D: 0,
    T: 2,
    habitat: 'Rocks and other firm surfaces on the wave-beaten shores of western Europe.',
    use: 'A tent it clamps to the rock to ride out the waves, settled into a scar that keeps it from drying out at low tide.',
    facts: [
      'After grazing, a limpet follows its own mucus trail back to its favourite spot.',
      'Limpet teeth beat spider silk as the strongest biological material.',
      'In Raup’s terms its W is huge: the coil is lost and the shell becomes a cap.',
    ],
    image: { author: 'Tango22', license: 'CC BY-SA 3.0', source: commons('Common_limpets1.jpg') },
    wiki: wiki('Patella_vulgata'),
  },
  {
    id: 'cockle',
    name: 'Common cockle',
    latin: 'Cerastoderma edule',
    group: 'bivalves',
    W: 300,
    D: 0.1,
    T: 0.25,
    habitat: 'Tidal flats along the coasts of the north and east Atlantic.',
    use: 'Two hinged valves that shut tight around a filter feeder, which draws water in and out through two siphons.',
    facts: [
      'It typically lives five to six years.',
      'Crustaceans, fish and wading birds such as oystercatchers all rely on it as food.',
      'In Raup’s cube its W is in the hundreds, so almost the whole valve is the last half-turn of the tube.',
    ],
    image: { author: 'Féron Benjamin', license: 'CC BY-SA 2.0', source: commons('Coque_blanche_(Cerastoderma_edule).jpg') },
    wiki: wiki('Common_cockle'),
    preset: true,
    chip: 'Clam',
  },
  {
    id: 'scallop',
    name: 'King scallop',
    latin: 'Pecten maximus',
    group: 'bivalves',
    W: 3000,
    D: 0.2,
    T: 0,
    habitat: 'The northeast Atlantic seabed, from Norway to the Iberian Peninsula.',
    use: 'Armour that doubles as a swimming machine: clapping the valves shut jets water out and lets it escape starfish.',
    facts: [
      'The edge of its mantle carries 30 to 36 small blue or green eyes.',
      'It lies on its curved right valve with the flat left valve on top.',
      'Pilgrims to Santiago de Compostela carried its shell in honour of Saint James.',
    ],
    image: { author: 'Manfred Heyde', license: 'CC BY-SA 3.0', source: commons('Pecten_maximus_Pilgermuschel.jpg') },
    wiki: wiki('Pecten_maximus'),
  },
  {
    id: 'lamp-shell',
    name: 'Transverse lamp shell',
    latin: 'Terebratalia transversa',
    group: 'brachiopods',
    W: 1e5,
    D: 0,
    T: 0,
    habitat: 'Coastal waters of the Pacific Northwest; the young attach by a fleshy stalk.',
    use: 'Two valves, top and bottom rather than left and right, guarding the lophophore, a fringed organ that filters food.',
    facts: [
      'Brachiopods are not molluscs: they only look like clams.',
      'They are called lamp shells because they resemble old pottery oil lamps.',
      'Over 12,000 fossil species are known, against about 400 living ones.',
    ],
    image: { author: 'Marilynne Box', license: 'CC BY 4.0', source: commons('Terebratalia_transversa_141510036.jpg') },
    wiki: wiki('Terebratalia_transversa'),
    preset: true,
    chip: 'Brachiopod',
  },
  {
    id: 'argonaut',
    name: 'Greater argonaut',
    latin: 'Argonauta argo',
    group: 'cephalopods',
    W: 6,
    D: 0.1,
    T: 0,
    habitat: 'The open ocean in tropical and subtropical waters worldwide, near the surface.',
    use: 'Not a true shell: the female secretes it with the tips of two arms as a case for her eggs, and keeps a bubble of air in it to float.',
    facts: [
      'Argonauts are octopuses, not nautiluses, despite the nickname "paper nautilus".',
      'Males are tiny, at most about 2 cm, and have no shell.',
      'The paper-thin case is made of calcite, not the aragonite of most mollusc shells.',
    ],
    image: { author: 'Hectonichus', license: 'CC BY-SA 4.0', source: commons('Argonautidae_-_Argonauta_argo.JPG') },
    wiki: wiki('Argonauta_argo'),
  },
];

export const getEntry = (id: string) => CATALOG.find((e) => e.id === id);
