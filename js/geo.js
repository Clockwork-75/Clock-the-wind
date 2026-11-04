export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const NM_PER_DEG = 60;

// flat-earth local helpers (accurate enough for < 200 nm legs at Adriatic latitudes)
export function distNm(lat1, lon1, lat2, lon2) {
  const dlat = (lat2 - lat1) * NM_PER_DEG;
  const dlon = (lon2 - lon1) * NM_PER_DEG * Math.cos((lat1 + lat2) / 2 * D2R);
  return Math.hypot(dlat, dlon);
}
export function bearing(lat1, lon1, lat2, lon2) {
  const dlat = lat2 - lat1;
  const dlon = (lon2 - lon1) * Math.cos((lat1 + lat2) / 2 * D2R);
  return (Math.atan2(dlon, dlat) * R2D + 360) % 360;
}
export function move(lat, lon, brgDeg, nm) {
  const dlat = nm * Math.cos(brgDeg * D2R) / NM_PER_DEG;
  const dlon = nm * Math.sin(brgDeg * D2R) / (NM_PER_DEG * Math.cos(lat * D2R));
  return [lat + dlat, lon + dlon];
}
// signed smallest difference a-b in (-180,180]
export function angDiff(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}
// wind u/v (m/s or kn, direction FROM) helpers
export function uvFromSpeedDir(spd, dirFrom) {
  const r = dirFrom * D2R;
  return [-spd * Math.sin(r), -spd * Math.cos(r)];
}
export function speedDirFromUV(u, v) {
  return [Math.hypot(u, v), (Math.atan2(-u, -v) * R2D + 360) % 360];
}
export function fmtLatLon(lat, lon) {
  const f = (v, p, n) => {
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return `${d}°${m.toFixed(2).padStart(5, '0')}'${v >= 0 ? p : n}`;
  };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}
