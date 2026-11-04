// Course presets. Coordinates are APPROXIMATE examples – always check against the sailing instructions
// and drag the marks to the official positions before routing.
export const PRESETS = [
  { id: 'viski', name: 'Viški boj (Split → Vis)', marks: [
    { name: 'Start Split', lat: 43.492, lon: 16.418 },
    { name: 'Cilj Vis', lat: 43.068, lon: 16.196 } ] },
  { id: 'mrdujska', name: 'Mrdujska (Split – Mrduja – Split)', marks: [
    { name: 'Start Split', lat: 43.495, lon: 16.425 },
    { name: 'Mrduja', lat: 43.364, lon: 16.357 },
    { name: 'Cilj Split', lat: 43.495, lon: 16.425 } ] },
  { id: 'rovinj-pula', name: 'Rovinj → Pula', marks: [
    { name: 'Start Rovinj', lat: 45.085, lon: 13.610 },
    { name: 'Cilj Pula', lat: 44.880, lon: 13.795 } ] },
  { id: 'fiumanka', name: 'Fiumanka (primjer – Kvarner)', marks: [
    { name: 'Start Rijeka', lat: 45.318, lon: 14.410 },
    { name: 'Okret Cres (Porozina)', lat: 45.130, lon: 14.270 },
    { name: 'Cilj Rijeka', lat: 45.318, lon: 14.410 } ] },
  { id: 'jabuka', name: 'Offshore Jabuka (primjer)', marks: [
    { name: 'Start Split', lat: 43.480, lon: 16.380 },
    { name: 'Jabuka', lat: 43.088, lon: 15.455 },
    { name: 'Cilj Split', lat: 43.480, lon: 16.380 } ] },
  { id: 'susac', name: 'Offshore Sušac (primjer)', marks: [
    { name: 'Start Split', lat: 43.480, lon: 16.380 },
    { name: 'Sušac', lat: 42.758, lon: 16.470 },
    { name: 'Cilj Split', lat: 43.480, lon: 16.380 } ] },
];

export const PLACES = [
  { name: 'Trieste', lat: 45.65, lon: 13.77, z: 7 }, { name: 'Rovinj', lat: 45.08, lon: 13.64, z: 8 },
  { name: 'Pula', lat: 44.87, lon: 13.85, z: 7 }, { name: 'Rijeka', lat: 45.33, lon: 14.44, z: 7 },
  { name: 'Mali Lošinj', lat: 44.53, lon: 14.47, z: 9 }, { name: 'Zadar', lat: 44.12, lon: 15.23, z: 7 },
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
