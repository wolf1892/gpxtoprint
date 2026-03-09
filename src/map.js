import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const STYLE = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    },
  },
  layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
};

let map = null;
let loaded = false;
let pendingTrack = null;

export function initMap(containerId) {
  map = new maplibregl.Map({
    container: containerId,
    style: STYLE,
    center: [10, 45],
    zoom: 3,
    maxZoom: 18,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-left');
  map.on('load', () => {
    loaded = true;
    map.resize();
    if (pendingTrack) {
      _addTrackLayers(pendingTrack);
      pendingTrack = null;
    }
  });
  // Also handle late-arriving styles
  map.on('style.load', () => map.resize());
  return map;
}

export function displayTrack(gpxData) {
  if (!map) return;
  clearTrack();
  if (loaded) {
    _addTrackLayers(gpxData);
  } else {
    pendingTrack = gpxData;
  }
}

function _addTrackLayers(gpxData) {
  const coords = [];
  const features = gpxData.tracks.map(track => {
    const lineCoords = track.segments.flatMap(seg =>
      seg.map(p => {
        coords.push(p);
        return [p.lon, p.lat];
      })
    );
    return {
      type: 'Feature',
      properties: { name: track.name },
      geometry: { type: 'LineString', coordinates: lineCoords },
    };
  });

  map.addSource('track', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features },
  });

  map.addLayer({
    id: 'track-outline',
    type: 'line',
    source: 'track',
    paint: { 'line-color': '#000', 'line-width': 6, 'line-opacity': 0.4 },
  });

  map.addLayer({
    id: 'track-line',
    type: 'line',
    source: 'track',
    paint: { 'line-color': '#ff5722', 'line-width': 3.5, 'line-opacity': 0.95 },
  });

  if (coords.length) {
    const lngs = coords.map(c => c.lon);
    const lats = coords.map(c => c.lat);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, duration: 800 }
    );
  }
}

export function clearTrack() {
  if (!map) return;
  if (map.getLayer('track-line')) map.removeLayer('track-line');
  if (map.getLayer('track-outline')) map.removeLayer('track-outline');
  if (map.getSource('track')) map.removeSource('track');
}

export function getMap() { return map; }
