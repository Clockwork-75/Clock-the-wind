// Regattas with stages. Names and organisers checked against public sources (JK Labud sailing instructions,
// JK Tijat / sail-world reports). Mark positions are approximate unless noted – always drag them to the
// official positions from the current sailing instructions. Every name can be edited in the app.
export const REGATTAS = [
  {
    id: 'viska', name: 'Viška regata', org: 'JK Labud, Split',
    stages: [
      { name: '1. dan: Split → Vis', marks: [
        { name: 'Start – ispred trajektne luke Split', lat: 43.4952, lon: 16.4372 },
        { name: 'Splitska vrata (prolaz)', lat: 43.3622, lon: 16.3470 },
        { name: 'Cilj – ulaz u Višku uvalu (Češka vila)', lat: 43.0712, lon: 16.1747 } ] },
      { name: '2. dan: In-port race (Vis)', inport: true, marks: [] },
      { name: '3. dan: Vis → Split', marks: [
        { name: 'Start – ispred hridi Host', lat: 43.0765, lon: 16.2040 },
        { name: 'Cilj – Sustipan / JK Labud', lat: 43.5005, lon: 16.4262 } ] },
    ],
  },
  {
    id: 'jabuka', name: 'Regata Jabuka', org: 'JK Tijat, Vodice',
    stages: [{ name: 'Vodice → Jabuka → Vodice', marks: [
      { name: 'Start – Vodice', lat: 43.7520, lon: 15.7700 },
      { name: 'Jabuka (obilazak otoka)', lat: 43.0880, lon: 15.4550 },
      { name: 'Cilj – Vodice', lat: 43.7520, lon: 15.7700 } ] }],
  },
  {
    id: 'mrdujska', name: 'Mrdujska regata', org: 'JK Labud, Split',
    stages: [{ name: 'Split → Mrduja → Split', marks: [
      { name: 'Start – Split (Sustipan)', lat: 43.4990, lon: 16.4240 },
      { name: 'Mrduja (obilazak)', lat: 43.3640, lon: 16.3570 },
      { name: 'Cilj – Split (Sustipan)', lat: 43.4990, lon: 16.4240 } ] }],
  },
  {
    id: 'fiumanka', name: 'Fiumanka', org: 'Rijeka (start Kostrena)',
    stages: [{ name: 'Kvarner – primjer staze', marks: [
      { name: 'Start – Kostrena', lat: 45.2950, lon: 14.4950 },
      { name: 'Okret – Cres (Porozina)', lat: 45.1300, lon: 14.2700 },
      { name: 'Cilj – Kostrena', lat: 45.2950, lon: 14.4950 } ] }],
  },
  {
    id: 'susac', name: 'Regata Sušac 100×2', org: 'JK Mornar, Split',
    stages: [{ name: 'Split → Sušac → Split (primjer)', marks: [
      { name: 'Start – Split', lat: 43.4950, lon: 16.4300 },
      { name: 'Sušac (obilazak)', lat: 42.7580, lon: 16.4700 },
      { name: 'Cilj – Split', lat: 43.4950, lon: 16.4300 } ] }],
  },
  {
    id: 'rovinj-pula', name: 'Primjer: Rovinj → Pula', org: '',
    stages: [{ name: 'Rovinj → Pula', marks: [
      { name: 'Start – Rovinj', lat: 45.0850, lon: 13.6100 },
      { name: 'Cilj – Pula', lat: 44.8800, lon: 13.7950 } ] }],
  },
];

// backwards compatible flat list (one entry per routable stage)
export const PRESETS = REGATTAS.flatMap(r => r.stages.filter(s => !s.inport).map((s, i) => ({
  id: r.stages.length > 1 ? `${r.id}#${r.stages.indexOf(s)}` : r.id,
  name: r.stages.length > 1 ? `${r.name} – ${s.name}` : r.name,
  marks: s.marks,
})));
// legacy ids from earlier versions
export const LEGACY = { viski: 'viska#0' };

export const PLACES = [
  { name: 'Trieste', lat: 45.65, lon: 13.77, z: 7 }, { name: 'Rovinj', lat: 45.08, lon: 13.64, z: 8 },
  { name: 'Pula', lat: 44.87, lon: 13.85, z: 7 }, { name: 'Rijeka', lat: 45.33, lon: 14.44, z: 7 },
  { name: 'Mali Lošinj', lat: 44.53, lon: 14.47, z: 9 }, { name: 'Zadar', lat: 44.12, lon: 15.23, z: 7 },
  { name: 'Vodice', lat: 43.76, lon: 15.78, z: 9 },
  { name: 'Šibenik', lat: 43.73, lon: 15.89, z: 8 }, { name: 'Split', lat: 43.51, lon: 16.44, z: 7 },
  { name: 'Hvar', lat: 43.17, lon: 16.44, z: 9 }, { name: 'Vis', lat: 43.06, lon: 16.18, z: 9 },
  { name: 'Komiža', lat: 43.04, lon: 16.09, z: 10 }, { name: 'Korčula', lat: 42.96, lon: 17.13, z: 9 },
  { name: 'Lastovo', lat: 42.76, lon: 16.88, z: 9 }, { name: 'Sušac', lat: 42.765, lon: 16.50, z: 9 },
  { name: 'Jabuka', lat: 43.10, lon: 15.46, z: 9 }, { name: 'Palagruža', lat: 42.40, lon: 16.25, z: 9 },
  { name: 'Biševo', lat: 42.98, lon: 16.02, z: 10 }, { name: 'Dubrovnik', lat: 42.65, lon: 18.09, z: 7 },
  { name: 'Ancona', lat: 43.62, lon: 13.51, z: 7 }, { name: 'Pescara', lat: 42.46, lon: 14.21, z: 7 },
  { name: 'Milna', lat: 43.33, lon: 16.45, z: 10 }, { name: 'Brač', lat: 43.31, lon: 16.65, z: 9 },
  { name: 'Šolta', lat: 43.38, lon: 16.28, z: 9 }, { name: 'Cres', lat: 44.96, lon: 14.41, z: 9 },
  { name: 'Krk', lat: 45.03, lon: 14.57, z: 9 }, { name: 'Pag', lat: 44.45, lon: 15.05, z: 9 },
  { name: 'Dugi otok', lat: 44.0, lon: 15.05, z: 9 }, { name: 'Kornati', lat: 43.82, lon: 15.3, z: 9 },
  { name: 'Poreč', lat: 45.23, lon: 13.6, z: 8 }, { name: 'Umag', lat: 45.43, lon: 13.52, z: 9 },
];
