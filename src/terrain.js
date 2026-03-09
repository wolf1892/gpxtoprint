import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';

const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111320;
const SQRT3 = Math.sqrt(3);
const FONT_URL = 'https://threejs.org/examples/fonts/helvetiker_regular.typeface.json';

const COLOR_STOPS = [
  [0.00, [0.18, 0.50, 0.12]],
  [0.08, [0.28, 0.56, 0.15]],
  [0.18, [0.38, 0.58, 0.17]],
  [0.30, [0.48, 0.56, 0.19]],
  [0.42, [0.55, 0.52, 0.25]],
  [0.55, [0.54, 0.47, 0.33]],
  [0.68, [0.52, 0.48, 0.42]],
  [0.80, [0.58, 0.56, 0.52]],
  [0.90, [0.68, 0.66, 0.62]],
  [1.00, [0.82, 0.80, 0.78]],
];

export class TerrainBuilder {
  constructor(gpxData, settings, stats) {
    this.tracks = gpxData.tracks;
    this.stats = stats || {};
    this.settings = {
      gridSize: settings.gridResolution ?? 100,
      exaggeration: settings.exaggeration ?? 2,
      trackWidth: settings.trackWidth ?? 2,
      trackHeight: settings.trackHeight ?? 1.5,
      baseHeight: settings.baseHeight ?? 5,
      modelSize: settings.modelSize ?? 150,
      frameBorder: 12,
      frameHeight: 7,
    };
    this.group = null;
    this.bbox = null;
    this.elevationGrid = null;
    this.font = null;
  }

  async build(onProgress) {
    const allPoints = this.tracks.flatMap(t => t.segments.flat());
    if (!allPoints.length) throw new Error('No track points found');
    this.bbox = this._calcBBox(allPoints, 0.15);

    this.elevationGrid = await this._fetchTerrainTiles(onProgress);

    try { this.font = await loadFont(); } catch { console.warn('[terrain] font load failed, skipping text'); }

    this.group = this._buildGroup(allPoints);
  }

  getGroup() { return this.group; }

  exportSTL() {
    const exporter = new STLExporter();
    return exporter.parse(this.group, { binary: true });
  }

  // ── Square bounding box (required for regular hexagon) ──

  _calcBBox(points, padding) {
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (const p of points) {
      s = Math.min(s, p.lat); n = Math.max(n, p.lat);
      w = Math.min(w, p.lon); e = Math.max(e, p.lon);
    }
    const latPad = (n - s) * padding;
    const lonPad = (e - w) * padding;
    const cLat = (s + n) / 2;
    const cLon = (w + e) / 2;
    const mPerDegLon = METERS_PER_DEG_LAT * Math.cos(cLat * DEG2RAD);

    let widthM = Math.max((e - w + 2 * lonPad) * mPerDegLon, 500);
    let heightM = Math.max((n - s + 2 * latPad) * METERS_PER_DEG_LAT, 500);
    const maxM = Math.max(widthM, heightM);

    let halfLat = (maxM / METERS_PER_DEG_LAT) / 2;
    let halfLon = (maxM / mPerDegLon) / 2;
    let bbox = { south: cLat - halfLat, north: cLat + halfLat, west: cLon - halfLon, east: cLon + halfLon };

    // Expand bbox so every track point maps inside the hexagonal shape.
    // The hex is inscribed in the square model; corners of the square are outside.
    // For each point, compute the minimum hex circumradius that contains it,
    // then expand the bbox by the worst-case factor.
    let hexExpand = 1;
    for (const p of points) {
      const u = (p.lon - bbox.west) / (bbox.east - bbox.west);
      const v = (p.lat - bbox.south) / (bbox.north - bbox.south);
      const ax = Math.abs(2 * u - 1);
      const az = Math.abs(2 * v - 1);
      hexExpand = Math.max(hexExpand, 2 * az / SQRT3, ax + az / SQRT3);
    }
    if (hexExpand > 1) {
      hexExpand *= 1.08;
      halfLat *= hexExpand;
      halfLon *= hexExpand;
      bbox = { south: cLat - halfLat, north: cLat + halfLat, west: cLon - halfLon, east: cLon + halfLon };
    }

    return bbox;
  }

  // ── Elevation via AWS Terrarium tiles ──

  async _fetchTerrainTiles(onProgress) {
    const { gridSize } = this.settings;
    const { south, north, west, east } = this.bbox;
    const total = gridSize * gridSize;
    const lats = new Float64Array(total);
    const lons = new Float64Array(total);

    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const idx = r * gridSize + c;
        lats[idx] = south + (north - south) * r / (gridSize - 1);
        lons[idx] = west + (east - west) * c / (gridSize - 1);
      }
    }

    const zoom = this._calcZoom();
    const elevations = new Float32Array(total);
    const tileMap = new Map();
    for (let i = 0; i < total; i++) {
      const [tx, ty] = lonlatToTile(lons[i], lats[i], zoom);
      const key = `${tx},${ty}`;
      if (!tileMap.has(key)) tileMap.set(key, { tx, ty, indices: [] });
      tileMap.get(key).indices.push(i);
    }

    const tiles = Array.from(tileMap.values());
    let done = 0;
    for (let i = 0; i < tiles.length; i += 6) {
      const batch = tiles.slice(i, i + 6);
      const results = await Promise.allSettled(
        batch.map(async (t) => {
          const imgData = await fetchTerrariumTile(zoom, t.tx, t.ty);
          for (const idx of t.indices) {
            const [px, py] = lonlatToPixel(lons[idx], lats[idx], zoom);
            const off = (py * 256 + px) * 4;
            elevations[idx] = (imgData.data[off] * 256 + imgData.data[off + 1] + imgData.data[off + 2] / 256) - 32768;
          }
          done++;
          onProgress?.(done / tiles.length);
        })
      );
      for (const r of results) if (r.status === 'rejected') console.error('[terrain] tile fail:', r.reason);
    }

    for (let i = 0; i < total; i++) {
      if (!isFinite(elevations[i]) || elevations[i] < -500) elevations[i] = 0;
    }
    return { lats, lons, elevations, gridSize };
  }

  _calcZoom() {
    const { gridSize } = this.settings;
    const { south, north, west, east } = this.bbox;
    const cLat = (south + north) / 2;
    const mPerDegLon = METERS_PER_DEG_LAT * Math.cos(cLat * DEG2RAD);
    const realW = (east - west) * mPerDegLon;
    const vertDist = realW / gridSize;
    let zoom = 2, mPerPx = 156543 * Math.cos(cLat * DEG2RAD);
    while (mPerPx > vertDist && zoom < 15) { zoom++; mPerPx /= 2; }
    return Math.min(zoom, 15);
  }

  // ── Build group ──

  _buildGroup(allPoints) {
    const { gridSize, exaggeration, baseHeight, modelSize, frameBorder, frameHeight } = this.settings;
    const { elevations } = this.elevationGrid;

    const modelW = modelSize;
    const modelD = modelSize;
    const hexR = modelSize / 2;

    const centerLat = (this.bbox.south + this.bbox.north) / 2;
    const mPerDegLon = METERS_PER_DEG_LAT * Math.cos(centerLat * DEG2RAD);
    const realW = (this.bbox.east - this.bbox.west) * mPerDegLon;
    const hScale = modelSize / realW;
    const vScale = hScale * exaggeration;

    let minElev = Infinity, maxElev = -Infinity;
    for (const e of elevations) if (isFinite(e)) { minElev = Math.min(minElev, e); maxElev = Math.max(maxElev, e); }
    if (!isFinite(minElev)) { minElev = 0; maxElev = 1; }

    // ── Terrain surface (hex-clipped) ──
    const terrainY = new Float32Array(gridSize * gridSize);
    const positions = new Float32Array(gridSize * gridSize * 3);
    const colors = new Float32Array(gridSize * gridSize * 3);
    const inside = new Uint8Array(gridSize * gridSize);

    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const idx = r * gridSize + c;
        const elev = isFinite(elevations[idx]) ? elevations[idx] : minElev;
        const x = (c / (gridSize - 1) - 0.5) * modelW;
        const z = -((r / (gridSize - 1) - 0.5) * modelD);
        const y = (elev - minElev) * vScale;

        positions[idx * 3] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = z;
        terrainY[idx] = y;
        inside[idx] = insideHex(x, z, hexR) ? 1 : 0;

        const t = (elev - minElev) / (maxElev - minElev || 1);
        elevToColor(t, colors, idx * 3);
      }
    }

    const indices = [];
    for (let r = 0; r < gridSize - 1; r++) {
      for (let c = 0; c < gridSize - 1; c++) {
        const tl = r * gridSize + c, tr = tl + 1, bl = tl + gridSize, br = bl + 1;
        if (inside[tl] && inside[bl] && inside[tr]) indices.push(tl, bl, tr);
        if (inside[tr] && inside[bl] && inside[br]) indices.push(tr, bl, br);
      }
    }

    const terrainGeo = new THREE.BufferGeometry();
    terrainGeo.setIndex(indices);
    terrainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();
    const terrainMesh = new THREE.Mesh(terrainGeo, new THREE.MeshPhongMaterial({ vertexColors: true, side: THREE.DoubleSide, shininess: 15 }));

    const outerR = hexR + frameBorder;
    const frameBottom = -baseHeight - frameHeight;

    // ── Track tubes (clipped to hex) ──
    const trackMeshes = [];
    try {
      const segments = this._projectTrack(allPoints, terrainY, gridSize, modelW, modelD, hexR);
      for (const seg of segments) {
        const m = this._buildTrackTube(seg);
        if (m) trackMeshes.push(m);
      }
    } catch (e) { console.warn('[terrain] track tube error:', e.message); }

    // ── Solid watertight shell ──
    // Inner hex walls: terrain edge → frame bottom (full depth)
    const innerWalls = this._buildHexWalls(terrainY, gridSize, modelW, modelD, hexR, baseHeight + frameHeight);
    // Frame top annulus at y = -baseHeight bridging hexR → outerR
    const frameAnnulus = buildHexAnnulus(hexR, outerR, -baseHeight, FRAME_MAT());
    // Frame outer walls: -baseHeight → frameBottom
    const outerWalls = buildHexRing(outerR, -baseHeight, frameBottom, FRAME_MAT(), false);
    // Single bottom plate covering full outerR at frameBottom
    const bottomPlate = buildHexPlate(outerR, frameBottom, null, true, FRAME_MAT());

    // ── Text ──
    const textMeshes = this._buildTextLabels(hexR, frameBorder, frameHeight, baseHeight);

    const group = new THREE.Group();
    group.add(terrainMesh, innerWalls, frameAnnulus, outerWalls, bottomPlate);
    for (const m of textMeshes) group.add(m);
    for (const m of trackMeshes) group.add(m);
    return group;
  }

  // ── Track projection (clipped to hex, returns array of segments) ──

  _projectTrack(points, terrainY, gridSize, modelW, modelD, hexR) {
    const { south, north, west, east } = this.bbox;
    const { trackHeight } = this.settings;
    const clipR = hexR;
    const segments = [];
    let current = [];

    for (const p of points) {
      const u = (p.lon - west) / (east - west);
      const v = (p.lat - south) / (north - south);
      const x = (u - 0.5) * modelW, z = -((v - 0.5) * modelD);

      if (!insideHex(x, z, clipR)) {
        if (current.length >= 2) segments.push(current);
        current = [];
        continue;
      }

      const uC = Math.max(0, Math.min(1, u)), vC = Math.max(0, Math.min(1, v));
      const col = uC * (gridSize - 1), row = vC * (gridSize - 1);
      const c0 = Math.max(0, Math.min(gridSize - 2, Math.floor(col)));
      const r0 = Math.max(0, Math.min(gridSize - 2, Math.floor(row)));
      const ct = Math.max(0, Math.min(1, col - c0)), rt = Math.max(0, Math.min(1, row - r0));
      const h = (1 - ct) * (1 - rt) * terrainY[r0 * gridSize + c0]
        + ct * (1 - rt) * terrainY[r0 * gridSize + c0 + 1]
        + (1 - ct) * rt * terrainY[(r0 + 1) * gridSize + c0]
        + ct * rt * terrainY[(r0 + 1) * gridSize + c0 + 1];
      current.push(new THREE.Vector3(x, h + trackHeight, z));
    }
    if (current.length >= 2) segments.push(current);
    return segments;
  }

  _buildTrackTube(pts) {
    if (pts.length < 2) return null;
    const radius = this.settings.trackWidth / 2;
    const minD = radius * 0.1;
    let deduped = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(deduped[deduped.length - 1]) > minD) deduped.push(pts[i]);
    if (deduped.length > 800) {
      const step = Math.ceil(deduped.length / 800);
      const s = [deduped[0]];
      for (let i = step; i < deduped.length - 1; i += step) s.push(deduped[i]);
      s.push(deduped[deduped.length - 1]);
      deduped = s;
    }
    if (deduped.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(deduped, false, 'centripetal', 0.5);
    const geo = new THREE.TubeGeometry(curve, Math.max(deduped.length * 3, 64), radius, 6, false);
    return new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: 0xe53020, shininess: 40, side: THREE.DoubleSide }));
  }

  // ── Hex walls (terrain edge → full bottom depth) ──

  _buildHexWalls(terrainY, gridSize, modelW, modelD, hexR, totalDepth) {
    const hexV = hexVertices(hexR);
    const verts = [];
    const baseY = -totalDepth;
    const N = 60;

    for (let e = 0; e < 6; e++) {
      const [ax, az] = hexV[e], [bx, bz] = hexV[(e + 1) % 6];
      for (let s = 0; s < N; s++) {
        const t1 = s / N, t2 = (s + 1) / N;
        const x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
        const x2 = ax + (bx - ax) * t2, z2 = az + (bz - az) * t2;
        const y1 = sampleTerrain(x1, z1, terrainY, gridSize, modelW, modelD);
        const y2 = sampleTerrain(x2, z2, terrainY, gridSize, modelW, modelD);
        verts.push(x1, y1, z1, x2, baseY, z2, x2, y2, z2, x1, y1, z1, x1, baseY, z1, x2, baseY, z2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: 0x3a3a50, side: THREE.DoubleSide, flatShading: true }));
  }

  // _buildFrame removed — frame is now built as part of the unified solid shell

  // ── Text labels flat on frame top surface ──

  _buildTextLabels(hexR, border, fH, baseH) {
    if (!this.font) return [];
    const innerR = hexR, outerR = hexR + border;
    const innerV = hexVertices(innerR), outerV = hexVertices(outerR);
    const topY = -baseH + 0.15;
    const textMat = new THREE.MeshPhongMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
    const meshes = [];

    const labels = this._getFrameLabels(this.stats);

    for (let e = 0; e < 6; e++) {
      const text = labels[e];
      if (!text) continue;

      const n = (e + 1) % 6;
      const imx = (innerV[e][0] + innerV[n][0]) / 2;
      const imz = (innerV[e][1] + innerV[n][1]) / 2;
      const omx = (outerV[e][0] + outerV[n][0]) / 2;
      const omz = (outerV[e][1] + outerV[n][1]) / 2;
      const px = (imx + omx) / 2, pz = (imz + omz) / 2;

      const dx = outerV[n][0] - outerV[e][0];
      const dz = outerV[n][1] - outerV[e][1];
      const edgeLen = Math.sqrt(dx * dx + dz * dz);
      let tx = dx / edgeLen, tz = dz / edgeLen;

      let nx = -tz, nz = tx;
      if (nx * omx + nz * omz < 0) { nx = -nx; nz = -nz; }

      const vrx = nz, vrz = -nx;
      if (tx * vrx + tz * vrz < 0) { tx = -tx; tz = -tz; }

      const fontSize = Math.min(border * 0.5, edgeLen * 0.065);
      try {
        const geo = new TextGeometry(text, {
          font: this.font, size: fontSize, depth: 0.4,
          curveSegments: 3, bevelEnabled: false,
        });
        geo.computeBoundingBox();
        const tw = geo.boundingBox.max.x - geo.boundingBox.min.x;
        const th = geo.boundingBox.max.y - geo.boundingBox.min.y;

        const inner = new THREE.Mesh(geo, textMat);
        inner.position.set(-tw / 2, -th / 2, 0);

        const pivot = new THREE.Group();
        pivot.add(inner);

        const m = new THREE.Matrix4();
        m.set(
          tx,  -nx, 0, px,
          0,   0,   1, topY,
          tz,  -nz, 0, pz,
          0,   0,   0, 1
        );
        pivot.applyMatrix4(m);
        meshes.push(pivot);
      } catch { /* skip label */ }
    }
    return meshes;
  }

  _getFrameLabels(st) {
    const dist = st.distance ? `${(st.distance / 1000).toFixed(2)} km` : '';
    const gain = st.elevGain != null ? `${Math.round(st.elevGain)} m` : '';
    const loss = st.elevLoss != null ? `${Math.round(st.elevLoss)} m` : '';
    const speed = st.avgSpeed && st.movingSpeed
      ? `${st.avgSpeed.toFixed(2)} / ${st.movingSpeed.toFixed(2)} km/h` : '';
    const time = st.totalTimeSec && st.movingTimeSec
      ? `${fmtTime(st.movingTimeSec)} / ${fmtTime(st.totalTimeSec)}` : '';
    const name = st.trackName || '';
    return [name, gain, speed, time, dist, loss];
  }
}

function FRAME_MAT() {
  return new THREE.MeshPhongMaterial({ color: 0x1a1a1a, side: THREE.DoubleSide, shininess: 5 });
}

// ═══════════ Hex geometry helpers ═══════════

function hexVertices(R) {
  const v = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 3 * i;
    v.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return v;
}

function insideHex(x, z, R) {
  const ax = Math.abs(x), az = Math.abs(z);
  const apothem = R * SQRT3 / 2;
  return az <= apothem && (SQRT3 * ax + az) <= 2 * apothem;
}

function sampleTerrain(x, z, terrainY, gridSize, modelW, modelD) {
  const u = x / modelW + 0.5, v = -z / modelD + 0.5;
  const col = u * (gridSize - 1), row = v * (gridSize - 1);
  const c0 = Math.max(0, Math.min(gridSize - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(gridSize - 2, Math.floor(row)));
  const ct = Math.max(0, Math.min(1, col - c0)), rt = Math.max(0, Math.min(1, row - r0));
  return (1 - ct) * (1 - rt) * terrainY[r0 * gridSize + c0]
    + ct * (1 - rt) * terrainY[r0 * gridSize + c0 + 1]
    + (1 - ct) * rt * terrainY[(r0 + 1) * gridSize + c0]
    + ct * rt * terrainY[(r0 + 1) * gridSize + c0 + 1];
}

function buildHexPlate(R, y, colorHex, flipNormal, existingMat) {
  const hv = hexVertices(R);
  const verts = [];
  for (let i = 0; i < 6; i++) {
    const [ax, az] = hv[i], [bx, bz] = hv[(i + 1) % 6];
    if (flipNormal) verts.push(0, y, 0, bx, y, bz, ax, y, az);
    else verts.push(0, y, 0, ax, y, az, bx, y, bz);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  const mat = existingMat || new THREE.MeshPhongMaterial({ color: colorHex, side: THREE.DoubleSide });
  return new THREE.Mesh(geo, mat);
}

function buildHexAnnulus(innerR, outerR, y, mat) {
  const iv = hexVertices(innerR), ov = hexVertices(outerR);
  const verts = [];
  for (let i = 0; i < 6; i++) {
    const n = (i + 1) % 6;
    const [ia, iz] = iv[i], [ib, ibz] = iv[n];
    const [oa, oz] = ov[i], [ob, obz] = ov[n];
    // Two triangles per edge segment
    verts.push(ia, y, iz, oa, y, oz, ib, y, ibz);
    verts.push(ib, y, ibz, oa, y, oz, ob, y, obz);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

function buildHexRing(R, topY, botY, mat, flipNormal) {
  const hv = hexVertices(R);
  const verts = [];
  const N = 1; // 1 quad per edge is enough for flat hex sides
  for (let e = 0; e < 6; e++) {
    const [ax, az] = hv[e], [bx, bz] = hv[(e + 1) % 6];
    for (let s = 0; s < N; s++) {
      const t1 = s / N, t2 = (s + 1) / N;
      const x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      const x2 = ax + (bx - ax) * t2, z2 = az + (bz - az) * t2;
      if (flipNormal) {
        verts.push(x1, topY, z1, x2, topY, z2, x1, botY, z1, x2, topY, z2, x2, botY, z2, x1, botY, z1);
      } else {
        verts.push(x1, topY, z1, x1, botY, z1, x2, topY, z2, x2, topY, z2, x1, botY, z1, x2, botY, z2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

// ═══════════ Terrarium tile helpers ═══════════

function lonlatToTile(lon, lat, zoom) {
  const n = 2 ** zoom, latRad = lat * DEG2RAD;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)];
}
function lonlatToPixel(lon, lat, zoom) {
  const n = 2 ** zoom, latRad = lat * DEG2RAD;
  const x = (lon + 180) / 360 * n * 256;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n * 256;
  return [Math.min(Math.max(Math.floor(x % 256), 0), 255), Math.min(Math.max(Math.floor(y % 256), 0), 255)];
}

const _tileCache = new Map();
async function fetchTerrariumTile(zoom, xtile, ytile) {
  const key = `${zoom}/${xtile}/${ytile}`;
  if (_tileCache.has(key)) return _tileCache.get(key);
  const resp = await fetch(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${key}.png`);
  if (!resp.ok) throw new Error(`Tile ${key}: HTTP ${resp.status}`);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  const cvs = document.createElement('canvas');
  cvs.width = 256; cvs.height = 256;
  const ctx = cvs.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const imgData = ctx.getImageData(0, 0, 256, 256);
  _tileCache.set(key, imgData);
  return imgData;
}

let _fontPromise = null;
function loadFont() {
  if (_fontPromise) return _fontPromise;
  _fontPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('font timeout')), 8000);
    new FontLoader().load(FONT_URL, (font) => { clearTimeout(timeout); resolve(font); }, undefined, (err) => { clearTimeout(timeout); reject(err); });
  });
  return _fontPromise;
}

function elevToColor(t, arr, off) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [t0, c0] = COLOR_STOPS[i], [t1, c1] = COLOR_STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const s = (t - t0) / (t1 - t0);
      arr[off] = c0[0] + (c1[0] - c0[0]) * s;
      arr[off + 1] = c0[1] + (c1[1] - c0[1]) * s;
      arr[off + 2] = c0[2] + (c1[2] - c0[2]) * s;
      return;
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1][1];
  arr[off] = last[0]; arr[off + 1] = last[1]; arr[off + 2] = last[2];
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
