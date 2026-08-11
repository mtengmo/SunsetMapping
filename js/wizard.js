// City-wide "best sunset spot" wizard (v2). Grid-searches the current map
// view at a given date/time and ranks points by how much clearance the sun
// has over the horizon/obstructions.
//
// Kept deliberately coarse (small grid, short ray distance) since every
// point needs its own terrain profile — this is the part most exposed to
// public API rate limits when run client-side with no backend.
const Wizard = (() => {
  const GRID_SIDE = 6; // 6x6 = 36 candidate points
  const MAX_GRID_SIDE = 8; // hard cap even if caller asks for more
  const RAY_MAX_DISTANCE = 800; // shorter/coarser ray than the single-point simulator
  const RAY_STEP = 100;
  const BOUNDS_PAD_DEG = 0.01; // pad obstacle bbox so rays near the edge still see obstacles

  function buildGrid(bounds, side) {
    const points = [];
    if (side === 1) {
      points.push({ lat: (bounds.south + bounds.north) / 2, lon: (bounds.west + bounds.east) / 2 });
      return points;
    }
    const latStep = (bounds.north - bounds.south) / (side - 1);
    const lonStep = (bounds.east - bounds.west) / (side - 1);
    for (let i = 0; i < side; i++) {
      for (let j = 0; j < side; j++) {
        points.push({
          lat: bounds.south + i * latStep,
          lon: bounds.west + j * lonStep,
        });
      }
    }
    return points;
  }

  // bounds: {south, west, north, east}. date: JS Date. onProgress: (text) => void.
  async function run(bounds, date, onProgress = () => {}) {
    const side = Math.min(MAX_GRID_SIDE, GRID_SIDE);
    const gridPoints = buildGrid(bounds, side);

    onProgress(`Fetching building/tree data for the area (${gridPoints.length} points)…`);
    const obstaclesPromise = Obstruction.fetchObstaclesInBounds(
      bounds.south - BOUNDS_PAD_DEG,
      bounds.west - BOUNDS_PAD_DEG,
      bounds.north + BOUNDS_PAD_DEG,
      bounds.east + BOUNDS_PAD_DEG
    );

    const candidates = gridPoints.map((p) => {
      const sunPos = SunModel.getPosition(date, p.lat, p.lon);
      const ray = sunPos.altitudeDeg >= -6
        ? Obstruction.buildRayPoints(p.lat, p.lon, sunPos.azimuthDeg, RAY_MAX_DISTANCE, RAY_STEP)
        : null;
      return { lat: p.lat, lon: p.lon, sunPos, ray };
    });

    const allRayPoints = [];
    for (const c of candidates) {
      if (c.ray) allRayPoints.push(...c.ray);
    }

    onProgress(`Fetching terrain elevation for ${allRayPoints.length} sample points…`);
    const elevations = allRayPoints.length ? await Obstruction.fetchElevations(allRayPoints) : [];
    let cursor = 0;
    for (const c of candidates) {
      if (!c.ray) continue;
      for (const p of c.ray) { p.elevation = elevations[cursor++]; }
    }

    const obstacles = await obstaclesPromise;

    onProgress("Scoring locations…");
    const results = candidates.map((c) => {
      if (!c.ray) {
        return { lat: c.lat, lon: c.lon, sunPos: c.sunPos, belowHorizon: true, marginDeg: -999 };
      }
      const r = Obstruction.computeVisibilityFromData(
        c.lat, c.lon, c.sunPos.azimuthDeg, c.sunPos.altitudeDeg, c.ray, obstacles, RAY_MAX_DISTANCE
      );
      return { lat: c.lat, lon: c.lon, sunPos: c.sunPos, belowHorizon: false, ...r };
    });

    results.sort((a, b) => b.marginDeg - a.marginDeg);
    return results;
  }

  return { run, buildGrid, GRID_SIDE };
})();
