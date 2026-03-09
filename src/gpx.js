export function parseGPX(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  const tracks = [];

  function parsePoint(pt) {
    const ele = pt.querySelector('ele');
    const time = pt.querySelector('time');
    return {
      lat: parseFloat(pt.getAttribute('lat')),
      lon: parseFloat(pt.getAttribute('lon')),
      ele: ele ? parseFloat(ele.textContent) : null,
      time: time ? time.textContent : null,
    };
  }

  for (const trk of doc.querySelectorAll('trk')) {
    const segments = [];
    for (const seg of trk.querySelectorAll('trkseg')) {
      const points = [];
      for (const pt of seg.querySelectorAll('trkpt')) points.push(parsePoint(pt));
      if (points.length) segments.push(points);
    }
    tracks.push({ name: trk.querySelector('name')?.textContent || 'Unnamed', segments });
  }

  for (const rte of doc.querySelectorAll('rte')) {
    const points = [];
    for (const pt of rte.querySelectorAll('rtept')) points.push(parsePoint(pt));
    if (points.length) {
      tracks.push({ name: rte.querySelector('name')?.textContent || 'Unnamed Route', segments: [points] });
    }
  }

  if (!tracks.length) {
    const wpts = doc.querySelectorAll('wpt');
    if (wpts.length >= 2) {
      const points = [];
      for (const pt of wpts) points.push(parsePoint(pt));
      tracks.push({ name: doc.querySelector('name')?.textContent || 'Waypoints', segments: [points] });
    }
  }

  return { tracks };
}

export function flattenPoints(gpxData) {
  return gpxData.tracks.flatMap(t => t.segments.flat());
}

export function computeStats(points) {
  let distance = 0;
  let elevGain = 0;
  let elevLoss = 0;
  let minElev = Infinity;
  let maxElev = -Infinity;
  let totalTimeSec = 0;
  let movingTimeSec = 0;

  const firstTime = points[0]?.time ? new Date(points[0].time) : null;
  const lastTime = points[points.length - 1]?.time ? new Date(points[points.length - 1].time) : null;

  if (firstTime && lastTime) {
    totalTimeSec = (lastTime - firstTime) / 1000;
  }

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.ele != null) {
      minElev = Math.min(minElev, p.ele);
      maxElev = Math.max(maxElev, p.ele);
    }
    if (i > 0) {
      const seg = haversine(points[i - 1], p);
      distance += seg;
      if (p.ele != null && points[i - 1].ele != null) {
        const d = p.ele - points[i - 1].ele;
        if (d > 0) elevGain += d;
        else elevLoss -= d;
      }
      if (p.time && points[i - 1].time) {
        const dt = (new Date(p.time) - new Date(points[i - 1].time)) / 1000;
        if (dt > 0 && dt < 300) {
          const speed = seg / dt;
          if (speed > 0.15) movingTimeSec += dt;
        }
      }
    }
  }

  const avgSpeed = totalTimeSec > 0 ? (distance / 1000) / (totalTimeSec / 3600) : 0;
  const movingSpeed = movingTimeSec > 0 ? (distance / 1000) / (movingTimeSec / 3600) : 0;

  return {
    distance,
    elevGain,
    elevLoss,
    minElev: isFinite(minElev) ? minElev : 0,
    maxElev: isFinite(maxElev) ? maxElev : 0,
    totalTimeSec,
    movingTimeSec,
    avgSpeed,
    movingSpeed,
    trackName: '',
  };
}

export function formatTime(sec) {
  if (!sec || sec <= 0) return '--:--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function cumulativeDistances(points) {
  const dists = [0];
  for (let i = 1; i < points.length; i++) {
    dists.push(dists[i - 1] + haversine(points[i - 1], points[i]));
  }
  return dists;
}

function haversine(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRad(deg) { return deg * Math.PI / 180; }
