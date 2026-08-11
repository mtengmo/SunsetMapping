// Horizon-profile obstruction calculation: is the sun visible from a given
// point, given terrain elevation and nearby OSM buildings/trees along the
// sun's azimuth?
//
// Split into small pieces so the city-wide "best spot" wizard can batch
// elevation/Overpass requests across many candidate points instead of
// repeating the single-point flow (which would multiply API calls).
const Obstruction = (() => {
  const EARTH_RADIUS_M = 6371000;
  const EYE_HEIGHT_M = 1.7;
  const DEFAULT_BUILDING_HEIGHT_M = 9; // ~3 storeys, used when untagged
  const DEFAULT_TREE_HEIGHT_M = 12;
  const SAMPLE_STEP_M = 40;
  const MAX_DISTANCE_M = 2000;
  const CORRIDOR_HALF_WIDTH_DEG = 4; // bearing tolerance either side of azimuth

  const ELEVATION_API = "https://api.open-meteo.com/v1/elevation";
  // Public Overpass instances to cycle through on rate-limit/server errors —
  // there's no backend here to absorb load, so spreading across mirrors and
  // backing off is the main defense against 429s.
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/api/interpreter",
  ];
  const MAX_RETRIES = 4;

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function backoffMs(attempt) { return Math.min(8000, 500 * 2 ** attempt) + Math.random() * 300; }

  // POSTs an Overpass query, retrying with backoff and cycling through
  // mirrors on 429 (rate limited) / 5xx (server busy/timeout) responses.
  async function fetchOverpass(query) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          body: "data=" + encodeURIComponent(query),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Overpass API busy (${res.status}) at ${endpoint}`);
        } else if (!res.ok) {
          throw new Error(`Overpass API failed: ${res.status}`);
        } else {
          return await res.json();
        }
      } catch (err) {
        lastErr = err;
      }
      if (attempt < MAX_RETRIES - 1) await sleep(backoffMs(attempt));
    }
    throw lastErr || new Error("Overpass API failed after retries");
  }

  // Fetches one elevation batch URL, retrying with backoff on 429/5xx.
  async function fetchElevationBatch(url) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Elevation API busy (${res.status})`);
        } else if (!res.ok) {
          throw new Error(`Elevation API failed: ${res.status}`);
        } else {
          return await res.json();
        }
      } catch (err) {
        lastErr = err;
      }
      if (attempt < MAX_RETRIES - 1) await sleep(backoffMs(attempt));
    }
    throw lastErr || new Error("Elevation API failed after retries");
  }

  function toRad(d) { return (d * Math.PI) / 180; }
  function toDeg(r) { return (r * 180) / Math.PI; }

  // Destination point given start lat/lon, bearing (deg), distance (m).
  function destinationPoint(lat, lon, bearingDeg, distanceM) {
    const bearing = toRad(bearingDeg);
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);
    const angDist = distanceM / EARTH_RADIUS_M;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angDist) +
      Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing)
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
    );
    return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function bearingBetween(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function angleDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // Build the list of sample points along a ray from (lat, lon) toward
  // azimuthDeg, out to maxDistance, every stepM. Does not fetch elevation.
  function buildRayPoints(lat, lon, azimuthDeg, maxDistance = MAX_DISTANCE_M, stepM = SAMPLE_STEP_M) {
    const numSteps = Math.floor(maxDistance / stepM);
    const points = [{ lat, lon, distance: 0 }];
    for (let i = 1; i <= numSteps; i++) {
      const d = i * stepM;
      const p = destinationPoint(lat, lon, azimuthDeg, d);
      points.push({ lat: p.lat, lon: p.lon, distance: d });
    }
    return points;
  }

  async function fetchElevations(points) {
    // points: [{lat, lon}, ...]. Batches to stay well under typical URL limits.
    const BATCH = 90;
    const results = [];
    for (let i = 0; i < points.length; i += BATCH) {
      const batch = points.slice(i, i + BATCH);
      const lats = batch.map((p) => p.lat.toFixed(6)).join(",");
      const lons = batch.map((p) => p.lon.toFixed(6)).join(",");
      const url = `${ELEVATION_API}?latitude=${lats}&longitude=${lons}`;
      const data = await fetchElevationBatch(url);
      results.push(...data.elevation);
    }
    return results;
  }

  function parseObstacleElements(elements) {
    const obstacles = [];
    for (const el of elements) {
      if (el.type === "way" && el.tags && el.tags.building) {
        const geom = el.geometry;
        if (!geom || geom.length === 0) continue;
        const cLat = geom.reduce((s, g) => s + g.lat, 0) / geom.length;
        const cLon = geom.reduce((s, g) => s + g.lon, 0) / geom.length;
        let height = null;
        let estimated = true;
        if (el.tags.height) {
          height = parseFloat(el.tags.height);
          estimated = false;
        } else if (el.tags["building:levels"]) {
          height = parseFloat(el.tags["building:levels"]) * 3;
          estimated = false;
        }
        if (!height || Number.isNaN(height)) {
          height = DEFAULT_BUILDING_HEIGHT_M;
          estimated = true;
        }
        obstacles.push({ lat: cLat, lon: cLon, height, type: "building", estimated });
      } else if (el.type === "node" && el.tags && el.tags.natural === "tree") {
        obstacles.push({
          lat: el.lat, lon: el.lon,
          height: DEFAULT_TREE_HEIGHT_M, type: "tree", estimated: true,
        });
      }
    }
    return obstacles;
  }

  async function fetchObstacles(lat, lon, radiusM) {
    const query = `[out:json][timeout:25];(way["building"](around:${radiusM},${lat},${lon});node["natural"="tree"](around:${radiusM},${lat},${lon}););out body geom;`;
    const data = await fetchOverpass(query);
    return parseObstacleElements(data.elements);
  }

  // Fetch all buildings/trees within a lat/lon bounding box in one query —
  // used by the city-wide wizard so it doesn't issue one Overpass query per
  // candidate point.
  async function fetchObstaclesInBounds(south, west, north, east) {
    const bbox = `${south},${west},${north},${east}`;
    const query = `[out:json][timeout:30];(way["building"](${bbox});node["natural"="tree"](${bbox}););out body geom;`;
    const data = await fetchOverpass(query);
    return parseObstacleElements(data.elements);
  }

  // Fetch building footprints (full outline, not just centroid) within a
  // bounding box — used to render cast-shadow shapes on the map.
  async function fetchBuildingFootprintsInBounds(south, west, north, east) {
    const bbox = `${south},${west},${north},${east}`;
    const query = `[out:json][timeout:30];(way["building"](${bbox}););out body geom;`;
    const data = await fetchOverpass(query);

    const buildings = [];
    for (const el of data.elements) {
      if (el.type !== "way" || !el.tags || !el.tags.building) continue;
      const geom = el.geometry;
      if (!geom || geom.length < 3) continue;
      let height = null;
      let estimated = true;
      if (el.tags.height) {
        height = parseFloat(el.tags.height);
        estimated = false;
      } else if (el.tags["building:levels"]) {
        height = parseFloat(el.tags["building:levels"]) * 3;
        estimated = false;
      }
      if (!height || Number.isNaN(height)) {
        height = DEFAULT_BUILDING_HEIGHT_M;
        estimated = true;
      }
      buildings.push({
        footprint: geom.map((g) => ({ lat: g.lat, lon: g.lon })),
        height,
        estimated,
      });
    }
    return buildings;
  }

  // Pure computation: given a ray of terrain points (with elevation already
  // attached) and a list of obstacles (anywhere — will be filtered to the
  // azimuth corridor here), determine whether the sun is visible.
  function computeVisibilityFromData(lat, lon, azimuthDeg, altitudeDeg, terrainPoints, obstacles, maxDistance) {
    const viewerElevation = terrainPoints[0].elevation;
    const viewerEyeElevation = viewerElevation + EYE_HEIGHT_M;
    const stepM = terrainPoints.length > 1 ? terrainPoints[1].distance - terrainPoints[0].distance : SAMPLE_STEP_M;
    const lastPoint = terrainPoints[terrainPoints.length - 1];

    function groundElevationAt(distance) {
      if (distance <= 0) return viewerElevation;
      if (distance >= lastPoint.distance) return lastPoint.elevation;
      const idx = Math.min(terrainPoints.length - 2, Math.floor(distance / stepM));
      const a = terrainPoints[idx];
      const b = terrainPoints[idx + 1];
      const t = (distance - a.distance) / (b.distance - a.distance);
      return a.elevation + t * (b.elevation - a.elevation);
    }

    const corridorObstacles = obstacles
      .map((o) => {
        const distance = haversineDistance(lat, lon, o.lat, o.lon);
        const bearing = bearingBetween(lat, lon, o.lat, o.lon);
        return { ...o, distance, bearingDiff: angleDiff(bearing, azimuthDeg) };
      })
      .filter((o) => o.distance > 0 && o.distance <= maxDistance && o.bearingDiff <= CORRIDOR_HALF_WIDTH_DEG);

    const profile = terrainPoints.map((p) => ({
      distance: p.distance,
      topElevation: p.elevation,
      angleDeg: p.distance > 0
        ? toDeg(Math.atan2(p.elevation - viewerEyeElevation, p.distance))
        : -90,
      isObstacle: false,
    }));

    for (const o of corridorObstacles) {
      const groundAtObstacle = groundElevationAt(o.distance);
      const topElevation = groundAtObstacle + o.height;
      const angleDeg = toDeg(Math.atan2(topElevation - viewerEyeElevation, o.distance));
      profile.push({
        distance: o.distance,
        topElevation,
        angleDeg,
        isObstacle: true,
        obstacleType: o.type,
        estimated: o.estimated,
      });
    }

    profile.sort((a, b) => a.distance - b.distance);

    let horizonAngleDeg = -90;
    let blockingPoint = null;
    for (const p of profile) {
      if (p.angleDeg > horizonAngleDeg) {
        horizonAngleDeg = p.angleDeg;
        blockingPoint = p;
      }
    }

    const visible = altitudeDeg > horizonAngleDeg;

    return {
      visible,
      horizonAngleDeg,
      sunAltitudeDeg: altitudeDeg,
      marginDeg: altitudeDeg - horizonAngleDeg,
      blockingPoint: visible ? null : blockingPoint,
      profile,
      viewerElevation,
      maxDistance,
    };
  }

  // Single-point entry point used by the main simulator: builds its own ray,
  // fetches elevation + nearby obstacles, and computes visibility.
  async function computeVisibility(lat, lon, azimuthDeg, altitudeDeg) {
    const terrainPoints = buildRayPoints(lat, lon, azimuthDeg, MAX_DISTANCE_M, SAMPLE_STEP_M);
    const [terrainElevations, obstacles] = await Promise.all([
      fetchElevations(terrainPoints),
      fetchObstacles(lat, lon, MAX_DISTANCE_M),
    ]);
    terrainPoints.forEach((p, i) => { p.elevation = terrainElevations[i]; });
    return computeVisibilityFromData(lat, lon, azimuthDeg, altitudeDeg, terrainPoints, obstacles, MAX_DISTANCE_M);
  }

  return {
    computeVisibility,
    computeVisibilityFromData,
    buildRayPoints,
    fetchElevations,
    fetchObstacles,
    fetchObstaclesInBounds,
    fetchBuildingFootprintsInBounds,
    destinationPoint,
    haversineDistance,
  };
})();
