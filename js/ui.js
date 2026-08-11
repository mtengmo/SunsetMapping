// Wires the date/time controls + location selection together, runs the
// sun position + obstruction pipeline, and renders results.
(() => {
  let currentLat = null;
  let currentLon = null;
  let debounceTimer = null;
  let requestSeq = 0;

  const statusText = document.getElementById("status-text");
  const results = document.getElementById("results");
  const headline = document.getElementById("result-headline");
  const detail = document.getElementById("result-detail");
  const chart = document.getElementById("profile-chart");
  const dateInput = document.getElementById("date-input");
  const timeSlider = document.getElementById("time-slider");
  const timeLabel = document.getElementById("time-label");
  const locateBtn = document.getElementById("locate-btn");
  const wizardBtn = document.getElementById("wizard-btn");
  const wizardPanel = document.getElementById("wizard-panel");
  const wizardClose = document.getElementById("wizard-close");
  const wizardStatus = document.getElementById("wizard-status");
  const wizardList = document.getElementById("wizard-list");
  const shadeBtn = document.getElementById("shade-btn");
  const shadingStatus = document.getElementById("shading-status");
  const helpBtn = document.getElementById("help-btn");
  const helpOverlay = document.getElementById("help-overlay");
  const helpClose = document.getElementById("help-close");
  const timelineTrack = document.getElementById("timeline-track");
  const timelineSunsetMarker = document.getElementById("timeline-sunset-marker");
  const timelineCaption = document.getElementById("timeline-caption");

  let shadingEnabled = false;
  let shadeMoveTimer = null;

  function initDateTime() {
    const now = new Date();
    dateInput.value = now.toISOString().slice(0, 10);
    const minutes = now.getHours() * 60 + now.getMinutes();
    timeSlider.value = minutes;
    updateTimeLabel(minutes);
  }

  function updateTimeLabel(minutes) {
    const h = String(Math.floor(minutes / 60)).padStart(2, "0");
    const m = String(minutes % 60).padStart(2, "0");
    timeLabel.textContent = `${h}:${m}`;
  }

  function getSelectedDate() {
    const [y, mo, d] = dateInput.value.split("-").map(Number);
    const minutes = parseInt(timeSlider.value, 10);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return new Date(y, mo - 1, d, h, m, 0);
  }

  function dateToMinutes(d) {
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  }

  function formatMinutes(min) {
    const h = String(Math.floor(min / 60)).padStart(2, "0");
    const m = String(Math.round(min % 60)).padStart(2, "0");
    return `${h}:${m}`;
  }

  // Decorates the timeline (background shading + sunset marker) using
  // sunrise/sunset/golden-hour times for the selected location + date.
  // Only depends on date + location, not the time-of-day slider value, so
  // it's cheap to call on every location/date change (no network calls).
  function updateTimelineDecoration() {
    if (currentLat === null) {
      timelineTrack.style.background = "#0f1520";
      timelineSunsetMarker.classList.add("hidden");
      timelineCaption.textContent = "";
      return;
    }

    const date = getSelectedDate();
    const times = SunModel.getTimes(date, currentLat, currentLon);
    const sunriseMin = dateToMinutes(times.sunrise);
    const sunsetMin = dateToMinutes(times.sunset);
    const morningGoldenEndMin = dateToMinutes(times.goldenHourEnd);
    const eveningGoldenStartMin = dateToMinutes(times.goldenHour);

    if (sunriseMin === null || sunsetMin === null) {
      // Polar day/night or similar edge case — SunCalc gives invalid dates.
      timelineTrack.style.background = "#0f1520";
      timelineSunsetMarker.classList.add("hidden");
      timelineCaption.textContent = "No standard sunrise/sunset at this location today (polar day/night or extreme latitude).";
      return;
    }

    const pct = (min) => Math.max(0, Math.min(100, (min / 1440) * 100));
    const night = "#0f1520";
    const day = "#bcd6f2";
    const golden = "#f0a63f";

    const stops = [
      `${night} 0%`,
      `${night} ${pct(sunriseMin)}%`,
      `${golden} ${pct(sunriseMin)}%`,
      `${golden} ${pct(morningGoldenEndMin ?? sunriseMin)}%`,
      `${day} ${pct(morningGoldenEndMin ?? sunriseMin)}%`,
      `${day} ${pct(eveningGoldenStartMin ?? sunsetMin)}%`,
      `${golden} ${pct(eveningGoldenStartMin ?? sunsetMin)}%`,
      `${golden} ${pct(sunsetMin)}%`,
      `${night} ${pct(sunsetMin)}%`,
      `${night} 100%`,
    ];
    timelineTrack.style.background = `linear-gradient(to right, ${stops.join(", ")})`;

    timelineSunsetMarker.classList.remove("hidden");
    timelineSunsetMarker.style.left = `${pct(sunsetMin)}%`;

    const goldenLabel = eveningGoldenStartMin !== null
      ? ` · Golden hour ${formatMinutes(eveningGoldenStartMin)}–${formatMinutes(sunsetMin)}`
      : "";
    timelineCaption.textContent = `Sunset ${formatMinutes(sunsetMin)}${goldenLabel}`;
  }

  function scheduleRecompute(immediate = false) {
    if (currentLat === null) return;
    clearTimeout(debounceTimer);
    if (immediate) {
      runComputation();
    } else {
      debounceTimer = setTimeout(runComputation, 400);
    }
  }

  async function runComputation() {
    const mySeq = ++requestSeq;
    const date = getSelectedDate();
    const sunPos = SunModel.getPosition(date, currentLat, currentLon);

    if (sunPos.altitudeDeg < -6) {
      renderStatus(`Sun is below the horizon (altitude ${sunPos.altitudeDeg.toFixed(1)}°) at this time — nothing to simulate.`);
      results.classList.add("hidden");
      MapModule.drawSunRay(currentLat, currentLon, sunPos.azimuthDeg, 200);
      updateShading();
      return;
    }

    renderStatus("Computing horizon profile (elevation + nearby buildings)…");
    MapModule.drawSunRay(currentLat, currentLon, sunPos.azimuthDeg, 2000);
    updateShading();

    try {
      const result = await Obstruction.computeVisibility(
        currentLat, currentLon, sunPos.azimuthDeg, sunPos.altitudeDeg
      );
      if (mySeq !== requestSeq) return; // a newer request superseded this one

      renderStatus("");
      renderResult(sunPos, result);
    } catch (err) {
      if (mySeq !== requestSeq) return;
      renderStatus(`Could not compute obstruction (${err.message}). This can happen if the public Overpass/elevation APIs are rate-limited — try again shortly.`);
      results.classList.add("hidden");
    }
  }

  function renderStatus(text) {
    statusText.textContent = text;
  }

  function renderResult(sunPos, result) {
    results.classList.remove("hidden");
    headline.classList.remove("visible", "blocked");
    if (result.visible) {
      headline.textContent = `☀ Sun is visible (altitude ${result.sunAltitudeDeg.toFixed(1)}°, above horizon at ${result.horizonAngleDeg.toFixed(1)}°)`;
      headline.classList.add("visible");
    } else {
      const bp = result.blockingPoint;
      const what = bp && bp.isObstacle ? (bp.obstacleType === "tree" ? "a tree" : "a building") : "terrain";
      const estimate = bp && bp.estimated ? " (estimated height)" : "";
      headline.textContent = `✕ Sun is blocked by ${what}${estimate} ~${Math.round(bp ? bp.distance : 0)}m away`;
      headline.classList.add("blocked");
    }

    detail.innerHTML = `
      Azimuth: ${sunPos.azimuthDeg.toFixed(1)}° &nbsp; Sun altitude: ${sunPos.altitudeDeg.toFixed(1)}°<br/>
      Horizon/obstruction angle along this line: ${result.horizonAngleDeg.toFixed(1)}°<br/>
      Viewer ground elevation: ${result.viewerElevation.toFixed(0)}m<br/>
      Profile sampled to ${result.maxDistance}m. Building heights use OSM tags where available,
      otherwise a ${9}m default; tree heights are always estimated (~12m).
    `;

    drawChart(result);
  }

  function drawChart(result) {
    const ctx = chart.getContext("2d");
    const w = chart.width, h = chart.height;
    ctx.clearRect(0, 0, w, h);

    const profile = result.profile;
    const maxDist = result.maxDistance;
    const angles = profile.map((p) => p.angleDeg).concat([result.sunAltitudeDeg]);
    const minA = Math.min(-2, ...angles);
    const maxA = Math.max(5, ...angles);

    function xFor(d) { return (d / maxDist) * w; }
    function yFor(a) { return h - ((a - minA) / (maxA - minA)) * h; }

    // Ground/obstruction line
    ctx.strokeStyle = "#5b7a99";
    ctx.fillStyle = "rgba(91,122,153,0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xFor(0), h);
    profile.forEach((p) => ctx.lineTo(xFor(p.distance), yFor(p.angleDeg)));
    ctx.lineTo(xFor(maxDist), h);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    profile.forEach((p, i) => {
      if (i === 0) ctx.moveTo(xFor(p.distance), yFor(p.angleDeg));
      else ctx.lineTo(xFor(p.distance), yFor(p.angleDeg));
    });
    ctx.stroke();

    // Obstacle markers
    profile.filter((p) => p.isObstacle).forEach((p) => {
      ctx.fillStyle = p.obstacleType === "tree" ? "#2f8f4e" : "#8a5a2b";
      ctx.beginPath();
      ctx.arc(xFor(p.distance), yFor(p.angleDeg), 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // Sun altitude line
    ctx.strokeStyle = "#e08b1d";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yFor(result.sunAltitudeDeg));
    ctx.lineTo(w, yFor(result.sunAltitudeDeg));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function onLocationSelected(lat, lon) {
    currentLat = lat;
    currentLon = lon;
    updateTimelineDecoration();
    scheduleRecompute(true);
  }

  // --- Shade map (v2): render cast shadows of nearby buildings on the map ---

  async function updateShading() {
    if (!shadingEnabled) return;

    const bounds = MapModule.getBounds();
    const center = MapModule.getCenter();
    const lat = currentLat !== null ? currentLat : center.lat;
    const lon = currentLon !== null ? currentLon : center.lon;
    const date = getSelectedDate();
    const sunPos = SunModel.getPosition(date, lat, lon);

    // At/below the horizon everything is in shadow — shade the whole view
    // rather than clearing (no building data needed for this case).
    if (sunPos.altitudeDeg <= 0.5) {
      const opacity = sunPos.altitudeDeg <= -6 ? 0.65 : 0.35; // darker once past civil twilight
      MapModule.showFullShade(opacity);
      const when = sunPos.altitudeDeg <= -6 ? "Night" : "Twilight";
      shadingStatus.textContent = `${when}: sun altitude ${sunPos.altitudeDeg.toFixed(1)}° — everything here is in shadow.`;
      shadingStatus.classList.remove("hidden");
      return;
    }

    if (Shading.boundsAreaTooLarge(bounds)) {
      MapModule.clearShadows();
      shadingStatus.textContent = "Zoom in further to shade buildings — the current view is too large for the free map-data API.";
      shadingStatus.classList.remove("hidden");
      return;
    }

    try {
      const { buildings } = await Shading.loadBuildings(bounds);
      if (!shadingEnabled) return; // toggled off while this was in flight
      const polygons = Shading.computeShadowPolygons(buildings, sunPos.azimuthDeg, sunPos.altitudeDeg);
      MapModule.showShadows(polygons);
      shadingStatus.textContent = `Shading ${buildings.length} building${buildings.length === 1 ? "" : "s"} in view (sun altitude ${sunPos.altitudeDeg.toFixed(1)}°).`;
      shadingStatus.classList.remove("hidden");
    } catch (err) {
      shadingStatus.textContent = `Could not load building data for shading (${err.message}).`;
      shadingStatus.classList.remove("hidden");
    }
  }

  function toggleShading() {
    shadingEnabled = !shadingEnabled;
    shadeBtn.classList.toggle("active", shadingEnabled);
    if (shadingEnabled) {
      updateShading();
    } else {
      MapModule.clearShadows();
      shadingStatus.classList.add("hidden");
    }
  }

  // --- Wizard (v2): grid-search the current map view for the best sunset spot ---

  async function runWizard() {
    wizardPanel.classList.remove("hidden");
    wizardList.innerHTML = "";
    wizardStatus.textContent = "Starting search…";
    wizardBtn.disabled = true;
    MapModule.clearWizardResults();

    const bounds = MapModule.getBounds();
    const date = getSelectedDate();

    try {
      const results = await Wizard.run(bounds, date, (text) => { wizardStatus.textContent = text; });
      wizardStatus.textContent = `${results.length} points searched. Click a marker or list item to select it.`;
      renderWizardList(results);
      MapModule.showWizardResults(results, (lat, lon) => {
        MapModule.setLocation(lat, lon, true);
      });
    } catch (err) {
      wizardStatus.textContent = `Search failed (${err.message}). Public Overpass/elevation APIs may be rate-limited — try a smaller area or wait a moment.`;
    } finally {
      wizardBtn.disabled = false;
    }
  }

  function renderWizardList(results) {
    wizardList.innerHTML = "";
    results.slice(0, 10).forEach((r) => {
      const li = document.createElement("li");
      if (r.belowHorizon) {
        li.textContent = `(${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}) — sun below horizon`;
      } else {
        const span = document.createElement("span");
        span.className = r.visible ? "margin-visible" : "margin-blocked";
        span.textContent = r.visible ? "Visible" : "Blocked";
        li.appendChild(span);
        li.appendChild(document.createTextNode(
          ` (margin ${r.marginDeg.toFixed(1)}°) — ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`
        ));
      }
      li.addEventListener("click", () => MapModule.setLocation(r.lat, r.lon, true));
      wizardList.appendChild(li);
    });
  }

  timeSlider.addEventListener("input", () => {
    updateTimeLabel(parseInt(timeSlider.value, 10));
    scheduleRecompute(false);
  });
  dateInput.addEventListener("change", () => {
    updateTimelineDecoration();
    scheduleRecompute(true);
  });
  locateBtn.addEventListener("click", () => MapModule.tryGeolocate());
  wizardBtn.addEventListener("click", runWizard);
  wizardClose.addEventListener("click", () => {
    wizardPanel.classList.add("hidden");
    MapModule.clearWizardResults();
  });
  shadeBtn.addEventListener("click", toggleShading);
  helpBtn.addEventListener("click", () => helpOverlay.classList.remove("hidden"));
  helpClose.addEventListener("click", () => helpOverlay.classList.add("hidden"));
  helpOverlay.addEventListener("click", (e) => {
    if (e.target === helpOverlay) helpOverlay.classList.add("hidden");
  });

  initDateTime();
  MapModule.init(onLocationSelected);
  MapModule.onMoveEnd(() => {
    clearTimeout(shadeMoveTimer);
    shadeMoveTimer = setTimeout(updateShading, 500);
  });
})();
