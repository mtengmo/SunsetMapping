// Thin wrapper around SunCalc for the app's needs.
const SunModel = (() => {
  function getPosition(date, lat, lon) {
    const pos = SunCalc.getPosition(date, lat, lon);
    return {
      azimuthDeg: (pos.azimuth * 180 / Math.PI + 180) % 360, // SunCalc: 0 = south, convert to 0 = north/compass
      altitudeDeg: pos.altitude * 180 / Math.PI,
    };
  }

  function getTimes(date, lat, lon) {
    return SunCalc.getTimes(date, lat, lon);
  }

  return { getPosition, getTimes };
})();
