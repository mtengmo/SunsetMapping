// Leaflet map, geolocation, and location-selection handling.
const MapModule = (() => {
  let map, marker;
  let onLocationChange = null;
  let wizardLayer = null;
  let shadowLayer = null;

  function init(onChange) {
    onLocationChange = onChange;

    map = L.map("map", { zoomControl: true }).setView([51.505, -0.09], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    map.on("click", (e) => setLocation(e.latlng.lat, e.latlng.lng));

    tryGeolocate();
  }

  function setLocation(lat, lon, recenter = false) {
    if (marker) {
      marker.setLatLng([lat, lon]);
    } else {
      marker = L.marker([lat, lon], { draggable: true }).addTo(map);
      marker.on("dragend", () => {
        const p = marker.getLatLng();
        setLocation(p.lat, p.lng);
      });
    }
    if (recenter) map.setView([lat, lon], 16);
    if (onLocationChange) onLocationChange(lat, lon);
  }

  function tryGeolocate() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, true),
      () => { /* denied or unavailable — user can click the map instead */ },
      { timeout: 8000 }
    );
  }

  function drawSunRay(lat, lon, azimuthDeg, distanceM) {
    if (window.__sunRayLine) map.removeLayer(window.__sunRayLine);
    const end = Obstruction.destinationPoint(lat, lon, azimuthDeg, distanceM);
    window.__sunRayLine = L.polyline(
      [[lat, lon], [end.lat, end.lon]],
      { color: "#e08b1d", weight: 3, dashArray: "6 6" }
    ).addTo(map);
  }

  function getBounds() {
    const b = map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  function clearWizardResults() {
    if (wizardLayer) { map.removeLayer(wizardLayer); wizardLayer = null; }
  }

  // results: array from Wizard.run(), already sorted best-first. onSelect(lat, lon).
  function showWizardResults(results, onSelect) {
    clearWizardResults();
    wizardLayer = L.layerGroup().addTo(map);
    const topN = new Set(results.filter((r) => !r.belowHorizon).slice(0, 3).map((r) => `${r.lat},${r.lon}`));

    results.forEach((r) => {
      const key = `${r.lat},${r.lon}`;
      let color = "#999";
      if (!r.belowHorizon) color = r.visible ? "#2f8f4e" : "#a33";
      const isTop = topN.has(key);
      const circle = L.circleMarker([r.lat, r.lon], {
        radius: isTop ? 9 : 6,
        color: isTop ? "#e08b1d" : color,
        weight: isTop ? 3 : 1,
        fillColor: color,
        fillOpacity: 0.75,
      }).addTo(wizardLayer);

      const label = r.belowHorizon
        ? "Sun below horizon at this time"
        : `${r.visible ? "Visible" : "Blocked"} (margin ${r.marginDeg.toFixed(1)}°)`;
      circle.bindTooltip(label, { direction: "top" });
      circle.on("click", () => onSelect(r.lat, r.lon));
    });
  }

  function clearShadows() {
    if (shadowLayer) { map.removeLayer(shadowLayer); shadowLayer = null; }
  }

  // polygons: array of [[lat, lon], ...] rings.
  function showShadows(polygons) {
    clearShadows();
    shadowLayer = L.layerGroup().addTo(map);
    polygons.forEach((ring) => {
      L.polygon(ring, { stroke: false, fillColor: "#12141c", fillOpacity: 0.38 }).addTo(shadowLayer);
    });
  }

  function onMoveEnd(cb) {
    map.on("moveend", cb);
  }

  function getCenter() {
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  return {
    init, setLocation, tryGeolocate, drawSunRay, getBounds, getCenter,
    showWizardResults, clearWizardResults, showShadows, clearShadows, onMoveEnd,
  };
})();
