// Cast-shadow shading: given building footprints and a sun position,
// approximates each building's shadow as the convex hull of its footprint
// plus the footprint translated away from the sun by shadowLength =
// height / tan(altitude). Good approximation for typical (roughly convex)
// building footprints; not exact for concave/L-shaped buildings.
const Shading = (() => {
  // Cap so very low sun angles don't produce absurd polygons. height/tan(altitude)
  // blows up fast near the horizon — e.g. a 9m building already hits a 300m cap
  // around altitude 1.7°, well before actual sunset (altitude 0.5°, where shading
  // switches to full-view shade) — so this is set high enough that shadow length
  // keeps visibly growing most of the way to that switch-over.
  const MAX_SHADOW_LENGTH_M = 700;
  const MAX_QUERY_AREA_DEG2 = 0.02; // guard against huge Overpass queries when zoomed out

  let cachedBuildings = null;
  let cachedBoundsKey = null;

  function boundsKey(bounds) {
    return [bounds.south, bounds.west, bounds.north, bounds.east].map((v) => v.toFixed(4)).join(",");
  }

  function boundsAreaTooLarge(bounds) {
    return (bounds.north - bounds.south) * (bounds.east - bounds.west) > MAX_QUERY_AREA_DEG2;
  }

  // Andrew's monotone chain convex hull. Points: [{lat, lon}]. Treats lon as
  // x and lat as y — fine at city scale where the projection distortion is
  // negligible for this purpose.
  function convexHull(points) {
    const pts = points
      .slice()
      .sort((a, b) => a.lon - b.lon || a.lat - b.lat);
    if (pts.length <= 2) return pts;

    const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);

    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  async function loadBuildings(bounds) {
    if (boundsAreaTooLarge(bounds)) {
      return { buildings: null, areaTooLarge: true };
    }
    const key = boundsKey(bounds);
    if (cachedBoundsKey === key && cachedBuildings) {
      return { buildings: cachedBuildings, areaTooLarge: false };
    }
    cachedBuildings = await Obstruction.fetchBuildingFootprintsInBounds(
      bounds.south, bounds.west, bounds.north, bounds.east
    );
    cachedBoundsKey = key;
    return { buildings: cachedBuildings, areaTooLarge: false };
  }

  function invalidateCache() {
    cachedBuildings = null;
    cachedBoundsKey = null;
  }

  // Returns an array of polygons, each an array of [lat, lon] pairs.
  function computeShadowPolygons(buildings, azimuthDeg, altitudeDeg) {
    if (!buildings || altitudeDeg <= 0.5) return [];
    const shadowDirection = (azimuthDeg + 180) % 360;
    const altRad = (altitudeDeg * Math.PI) / 180;

    const polygons = [];
    for (const b of buildings) {
      const shadowLen = Math.min(MAX_SHADOW_LENGTH_M, b.height / Math.tan(altRad));
      const translated = b.footprint.map((v) => Obstruction.destinationPoint(v.lat, v.lon, shadowDirection, shadowLen));
      const hull = convexHull(b.footprint.concat(translated));
      if (hull.length >= 3) polygons.push(hull.map((p) => [p.lat, p.lon]));
    }
    return polygons;
  }

  return { loadBuildings, invalidateCache, computeShadowPolygons, boundsAreaTooLarge };
})();
