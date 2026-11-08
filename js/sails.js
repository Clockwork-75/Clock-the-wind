import { MAT1180_XOVER } from './boatdata.js';

// Sail crossover for Melges 40 "Clockwork", digitised from the North Sails chart
// (TFWB Relentless SAIL SELECTION CHART). Polygons are in (TWA deg, TWS kn) space.
// Values are approximate (read off the chart, about ±2° / ±0.5 kn), editable in Postavke.

export const SAILS = {
  J1:   { cat: 'jib',  color: '#8fd16a', poly: [[35,9.5],[41,5.5],[60,4.5],[75,5.5],[95,10],[116,20.5],[112,21],[90,17],[75,14],[56,12.6],[35,12]] },
  J2:   { cat: 'jib',  color: '#f5e23a', poly: [[35,11],[41,12],[60,13],[82,16.5],[101,21],[116,25.6],[123,25.6],[105,23.4],[79,19.8],[51,18.5],[35,18]] },
  J3:   { cat: 'jib',  color: '#f0a057', poly: [[34,17.2],[51,17.5],[79,19.1],[108,23],[125,26.3],[124,29.4],[116,28.9],[79,26],[39,24.3],[34,24]] },
  J4:   { cat: 'jib',  color: '#e8433a', poly: [[34,24],[79,26.5],[116,29],[125,29.5],[125,35],[43,35],[35,33]] },
  FRO:  { cat: 'fro',  color: '#b39ddb', poly: [[75,4.8],[116,4.4],[127,7.4],[131,25.3],[129,25.6],[114,20],[97,11],[85,7.5]] },
  'A1.5': { cat: 'kite', color: '#9fd3e6', poly: [[124,4.8],[144,5],[144,10],[140,12.5],[129,12.7],[127,9]] },
  A2:   { cat: 'kite', color: '#4f7fc4', poly: [[130,12],[144,10.3],[148,12.3],[180,12.3],[180,21],[140,21],[134,18.8],[130,15]] },
  A4:   { cat: 'kite', color: '#7a5aa8', poly: [[140,19],[149,20],[180,20],[180,29.2],[147,29],[143,24],[140,21]] },
  A5:   { cat: 'kite', color: '#5f8f6f', poly: [[130,19],[134,18.6],[149,22],[149,33.3],[145.6,32.8],[132.6,26],[130,22]] },
};
// light-air kite region extends to dead downwind
SAILS['A1.5'].poly = [[124,4.8],[144,5],[180,5],[180,11.5],[140,12.5],[129,12.7],[127,9]];

export const STRUT = [[93,11],[97,10.8],[114,18.8],[123,25.3],[126,34],[122,35],[116,28.6],[104.6,19.4],[93,14]];
export const REEF1 = [[0,22.5],[41,22],[54,21],[69,21],[82,22],[97,24.6],[112,27],[131,28.2],[180,28.6]];

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// vertical extent of polygon at a given TWA -> [min,max] tws
function extentAt(x, poly) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((xi <= x && x <= xj) || (xj <= x && x <= xi)) {
      const y = xi === xj ? yi : yi + (yj - yi) * (x - xi) / (xj - xi);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
  }
  return [lo, hi];
}

function lineAt(x, line) {
  for (let i = 0; i < line.length - 1; i++) {
    if (x >= line[i][0] && x <= line[i + 1][0]) {
      const t = (x - line[i][0]) / (line[i + 1][0] - line[i][0]);
      return line[i][1] + (line[i + 1][1] - line[i][1]) * t;
    }
  }
  return line[line.length - 1][1];
}

function score(name, twa, tws) {
  const [lo, hi] = extentAt(twa, SAILS[name].poly);
  const mid = (lo + hi) / 2, half = Math.max(0.5, (hi - lo) / 2);
  return Math.abs(tws - mid) / half;
}

function recommendMelges40(twa, tws) {
  const hits = Object.keys(SAILS).filter(n => inPoly(twa, tws, SAILS[n].poly));
  let pick;
  const kites = hits.filter(n => SAILS[n].cat === 'kite');
  const fro = hits.includes('FRO');
  const jibs = hits.filter(n => SAILS[n].cat === 'jib');
  const best = arr => arr.sort((a, b) => score(a, twa, tws) - score(b, twa, tws))[0];
  if (kites.length) pick = best(kites);
  else if (fro && twa >= 85) pick = 'FRO';
  else if (jibs.length) pick = best(jibs);
  else if (fro) pick = 'FRO';
  else if (twa >= 128) pick = tws < 11.5 ? 'A1.5' : tws < 19.5 ? 'A2' : twa >= 142 ? 'A4' : 'A5';
  else pick = tws < 12 ? 'J1' : tws < 18 ? 'J2' : tws < 24 ? 'J3' : 'J4';
  const strut = SAILS[pick].cat === 'jib' && inPoly(twa, tws, STRUT);
  const reef = tws >= lineAt(twa, REEF1);
  return { sail: pick, strut, reef, label: pick + (strut ? ' + strut' : '') + (reef ? ' · R1' : ''), color: SAILS[pick].color };
}

// ---- LeeLoo (Mat 11.80): North Sails MAT1180 crossover chart, one sail per TWA × TWS cell ----
export const MAT_SAILS = {
  J1: { cat: 'jib', color: '#ffcc99' }, J2: { cat: 'jib', color: '#fff27a' }, J3: { cat: 'jib', color: '#ffc400' }, J4: { cat: 'jib', color: '#ff6a00' },
  A0: { cat: 'kite', color: '#1e6fd0' }, 'A1.5': { cat: 'kite', color: '#00ccff' }, A2: { cat: 'kite', color: '#ff9a00' },
  A4: { cat: 'kite', color: '#ffff00' }, A5: { cat: 'kite', color: '#ff2a2a' },
};
// reef: the chart's "1 Reef" line (upwind only, from ~27.5 kn at 30–40° TWA)
const MAT_REEF = [[0, 27.5], [40, 28], [50, 28.8], [60, 30], [66, 34], [72, 99], [180, 99]];
function recommendMat1180(twa, tws) {
  const X = MAT1180_XOVER, near = (arr, v) => { let b = 0; for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[b] - v)) b = i; return b; };
  const name = X.sail[near(X.twa, twa)][near(X.tws, tws)];
  const reef = tws >= lineAt(twa, MAT_REEF);
  return { sail: name, strut: false, reef, label: name + (reef ? ' · R1' : ''), color: MAT_SAILS[name].color };
}

// sail sets per boat: 'melges40' (Clockwork) · 'mat1180' (LeeLoo)
export const SAIL_SETS = {
  melges40: { name: 'North Sails – Melges 40', sails: SAILS, recommend: recommendMelges40 },
  mat1180: { name: 'North Sails – MAT1180 V1d', sails: MAT_SAILS, recommend: recommendMat1180 },
};
export function recommendSail(twa, tws, set = 'melges40') {
  twa = Math.abs(twa); if (twa > 180) twa = 360 - twa;
  return (SAIL_SETS[set] || SAIL_SETS.melges40).recommend(twa, tws);
}
export const sailColor = (name, set = 'melges40') => { const s = (SAIL_SETS[set] || SAIL_SETS.melges40).sails[name] || SAILS[name] || MAT_SAILS[name]; return s ? s.color : '#888'; };
