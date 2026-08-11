// Terrain elevation from Terrarium-encoded PNG tiles (AWS Open Data,
// s3://elevation-tiles-prod — free, keyless, publicly hosted, originally
// compiled by Mapzen). Each 256x256 tile packs elevation into RGB:
//   elevation = R*256 + G + B/256 - 32768
// This replaces point-query calls to Open-Meteo (which was rate-limiting
// us) with tile fetches, which the browser can cache like any image and
// which aren't subject to a per-request API quota.
const Elevation = (() => {
  const TILE_ZOOM = 12; // ~25-40m/pixel at mid-latitudes; matches our ~40m sampling step
  const tilePromises = new Map(); // "z/x/y" -> Promise<ImageData>

  function tileUrl(z, x, y) {
    return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  }

  // Fractional tile coordinates (Web Mercator slippy-map math).
  function lonLatToTileCoords(lon, lat, z) {
    const n = 2 ** z;
    const x = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    return { x, y };
  }

  function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tilePromises.has(key)) return tilePromises.get(key);

    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
        } catch (err) {
          reject(err); // canvas tainted — tile server didn't send CORS headers
        }
      };
      img.onerror = () => reject(new Error(`Failed to load elevation tile ${key}`));
      img.src = tileUrl(z, x, y);
    });

    tilePromises.set(key, promise);
    return promise;
  }

  function decode(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
  }

  // points: [{lat, lon}, ...]. Returns elevations in the same order.
  // Groups points by which tile they fall in so each tile is fetched once.
  async function getElevations(points) {
    const results = new Array(points.length);
    const groups = new Map(); // "x,y" -> { x, y, indices: [] }

    points.forEach((p, i) => {
      const { x, y } = lonLatToTileCoords(p.lon, p.lat, TILE_ZOOM);
      const tileX = Math.floor(x);
      const tileY = Math.floor(y);
      const key = `${tileX},${tileY}`;
      if (!groups.has(key)) groups.set(key, { x: tileX, y: tileY, indices: [] });
      groups.get(key).indices.push(i);
    });

    await Promise.all(
      Array.from(groups.values()).map(async ({ x, y, indices }) => {
        const imageData = await loadTile(TILE_ZOOM, x, y);
        for (const i of indices) {
          const p = points[i];
          const frac = lonLatToTileCoords(p.lon, p.lat, TILE_ZOOM);
          const px = Math.min(255, Math.max(0, Math.floor((frac.x - x) * 256)));
          const py = Math.min(255, Math.max(0, Math.floor((frac.y - y) * 256)));
          const idx = (py * imageData.width + px) * 4;
          results[i] = decode(imageData.data[idx], imageData.data[idx + 1], imageData.data[idx + 2]);
        }
      })
    );

    return results;
  }

  return { getElevations, TILE_ZOOM };
})();
