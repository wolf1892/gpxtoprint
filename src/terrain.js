import * as THREE from 'three';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';

const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111320;
const SQRT3 = Math.sqrt(3);
const FONT_URL = 'https://threejs.org/examples/fonts/helvetiker_regular.typeface.json';

// TrailPrint3D zone colors (matching the Blender plugin)
const Z_BASE = 0, Z_FOREST = 1, Z_MOUNTAIN = 2, Z_WATER = 3;
const ZONE_RGB = [
  [0.05, 0.70, 0.05],  // BASE — green
  [0.05, 0.25, 0.05],  // FOREST — dark green
  [0.50, 0.50, 0.50],  // MOUNTAIN — grey
  [0.00, 0.00, 0.80],  // WATER — blue
];
const MOUNTAIN_THRESHOLD = 0.60;

const OBJ_MATERIALS = [
  { name: 'BASE',     kd: [0.05, 0.70, 0.05] },
  { name: 'FOREST',   kd: [0.05, 0.25, 0.05] },
  { name: 'MOUNTAIN', kd: [0.50, 0.50, 0.50] },
  { name: 'WATER',    kd: [0.00, 0.00, 0.80] },
  { name: 'TRAIL',    kd: [1.00, 0.00, 0.00] },
  { name: 'FRAME',    kd: [0.00, 0.00, 0.00] },
  { name: 'TEXT',     kd: [1.00, 1.00, 1.00] },
];

export class TerrainBuilder {
  constructor(gpxData, settings, stats) {
    this.tracks = gpxData.tracks;
    this.stats = stats || {};
    this.settings = {
      gridSize: settings.gridResolution ?? 200,
      exaggeration: settings.exaggeration ?? 2,
      trackWidth: settings.trackWidth ?? 2,
      trackHeight: settings.trackHeight ?? 1.5,
      baseHeight: settings.baseHeight ?? 5,
      modelSize: settings.modelSize ?? 150,
      frameBorder: 12,
      frameHeight: 7,
      customLabels: settings.customLabels || null,
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

    const osmPromise = fetchOSMFeatures(this.bbox);
    this.elevationGrid = await this._fetchTerrainTiles(onProgress);
    this.osmFeatures = await osmPromise;

    try { this.font = await loadFont(); } catch { console.warn('[terrain] font load failed, skipping text'); }

    this.group = this._buildGroup(allPoints);
  }

  getGroup() { return this.group; }

  exportOBJ() {
    this.group.updateMatrixWorld(true);
    const mtl = buildMTL();
    const obj = buildOBJ(this.group, this._terrainZoneIds);
    return { obj, mtl };
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
    const { elevations, lats, lons } = this.elevationGrid;
    const osm = this.osmFeatures || { water: [], forest: [] };

    const modelW = modelSize;
    const modelD = modelSize;
    const hexR = modelSize / 2;
    const outerR = hexR + frameBorder;
    const baseY = -baseHeight;
    const frameBottom = -baseHeight - frameHeight;

    const centerLat = (this.bbox.south + this.bbox.north) / 2;
    const mPerDegLon = METERS_PER_DEG_LAT * Math.cos(centerLat * DEG2RAD);
    const realW = (this.bbox.east - this.bbox.west) * mPerDegLon;
    const hScale = modelSize / realW;
    const vScale = hScale * exaggeration;

    let minElev = Infinity, maxElev = -Infinity;
    for (const e of elevations) if (isFinite(e)) { minElev = Math.min(minElev, e); maxElev = Math.max(maxElev, e); }
    if (!isFinite(minElev)) { minElev = 0; maxElev = 1; }

    const total = gridSize * gridSize;
    const terrainY = new Float32Array(total);
    const inside = new Uint8Array(total);
    const zoneIds = new Uint8Array(total);
    const gridX = new Float32Array(total);
    const gridZ = new Float32Array(total);

    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const idx = r * gridSize + c;
        const elev = isFinite(elevations[idx]) ? elevations[idx] : minElev;
        const x = (c / (gridSize - 1) - 0.5) * modelW;
        const z = -((r / (gridSize - 1) - 0.5) * modelD);
        const y = (elev - minElev) * vScale;

        gridX[idx] = x;
        gridZ[idx] = z;
        terrainY[idx] = y;
        inside[idx] = insideHex(x, z, hexR) ? 1 : 0;

        const lat = lats[idx], lon = lons[idx];
        const t = (elev - minElev) / (maxElev - minElev || 1);

        if (isInAnyPolygon(lat, lon, osm.water)) zoneIds[idx] = Z_WATER;
        else if (isInAnyPolygon(lat, lon, osm.forest)) zoneIds[idx] = Z_FOREST;
        else if (t >= MOUNTAIN_THRESHOLD) zoneIds[idx] = Z_MOUNTAIN;
        else zoneIds[idx] = Z_BASE;
      }
    }
    this._terrainZoneIds = zoneIds;

    const maxTerrainY = (maxElev - minElev) * vScale;

    const terrainSolid = this._buildTerrainSolid(
      gridX, gridZ, terrainY, inside, zoneIds,
      gridSize, modelW, modelD, hexR, frameBottom
    );
    terrainSolid.userData.role = 'terrain';
    terrainSolid.userData.maxTerrainY = maxTerrainY;

    const frameSolid = this._buildFrameSolid(hexR, outerR, baseY, frameBottom);
    frameSolid.userData = { role: 'frame' };

    const trackMeshes = [];
    try {
      const segments = this._projectTrack(allPoints, terrainY, gridSize, modelW, modelD, hexR);
      for (const seg of segments) {
        const m = this._buildTrackTube(seg);
        if (m) trackMeshes.push(m);
      }
    } catch (e) { console.warn('[terrain] track tube error:', e.message); }

    const textMeshes = this._buildTextLabels(hexR, frameBorder, frameHeight, baseHeight);

    const group = new THREE.Group();
    group.add(terrainSolid, frameSolid);
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
    const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: 0xe53020, shininess: 40, side: THREE.DoubleSide }));
    mesh.userData = { role: 'track' };
    return mesh;
  }

  // ── Watertight terrain solid (top surface + hex walls + bottom plate) ──

  _buildTerrainSolid(gridX, gridZ, terrainY, inside, zoneIds, gridSize, modelW, modelD, hexR, bottomY) {
    const total = gridSize * gridSize;
    const WALL_N = 80;
    const hexV = hexVertices(hexR);
    const wallCount = 6 * (WALL_N + 1);
    const vertCount = total + wallCount * 2 + 1;

    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);

    for (let i = 0; i < total; i++) {
      positions[i * 3] = gridX[i];
      positions[i * 3 + 1] = terrainY[i];
      positions[i * 3 + 2] = gridZ[i];
      const rgb = ZONE_RGB[zoneIds[i]];
      colors[i * 3] = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
    }

    const wallTopStart = total;
    const wallBotStart = total + wallCount;
    let wi = 0;
    for (let e = 0; e < 6; e++) {
      const [ax, az] = hexV[e], [bx, bz] = hexV[(e + 1) % 6];
      for (let s = 0; s <= WALL_N; s++) {
        const t = s / WALL_N;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const topH = sampleTerrain(x, z, terrainY, gridSize, modelW, modelD);

        const ti = (wallTopStart + wi) * 3;
        positions[ti] = x; positions[ti + 1] = topH; positions[ti + 2] = z;
        colors[ti] = 0.1; colors[ti + 1] = 0.1; colors[ti + 2] = 0.1;

        const bi = (wallBotStart + wi) * 3;
        positions[bi] = x; positions[bi + 1] = bottomY; positions[bi + 2] = z;
        colors[bi] = 0.05; colors[bi + 1] = 0.05; colors[bi + 2] = 0.05;
        wi++;
      }
    }

    const ci = (total + wallCount * 2) * 3;
    positions[ci] = 0; positions[ci + 1] = bottomY; positions[ci + 2] = 0;
    colors[ci] = 0.05; colors[ci + 1] = 0.05; colors[ci + 2] = 0.05;

    const indices = [];

    for (let r = 0; r < gridSize - 1; r++) {
      for (let c = 0; c < gridSize - 1; c++) {
        const tl = r * gridSize + c, tr = tl + 1, bl = tl + gridSize, br = bl + 1;
        if (inside[tl] && inside[bl] && inside[tr]) indices.push(tl, bl, tr);
        if (inside[tr] && inside[bl] && inside[br]) indices.push(tr, bl, br);
      }
    }
    const topFaceCount = indices.length / 3;

    wi = 0;
    for (let e = 0; e < 6; e++) {
      for (let s = 0; s < WALL_N; s++) {
        const tl = wallTopStart + wi + s;
        const tr = wallTopStart + wi + s + 1;
        const bl = wallBotStart + wi + s;
        const br = wallBotStart + wi + s + 1;
        indices.push(tl, tr, bl);
        indices.push(bl, tr, br);
      }
      wi += WALL_N + 1;
    }

    const centerIdx = total + wallCount * 2;
    wi = 0;
    for (let e = 0; e < 6; e++) {
      for (let s = 0; s < WALL_N; s++) {
        const a = wallBotStart + wi + s;
        const b = wallBotStart + wi + s + 1;
        indices.push(centerIdx, a, b);
      }
      wi += WALL_N + 1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setIndex(indices);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      vertexColors: true, side: THREE.DoubleSide, shininess: 15
    }));
    mesh.userData.topFaceCount = topFaceCount;
    return mesh;
  }

  // ── Watertight frame solid (annulus + inner/outer walls + bottom ring) ──

  _buildFrameSolid(innerR, outerR, topY, bottomY) {
    const iv = hexVertices(innerR);
    const ov = hexVertices(outerR);
    const verts = [];

    for (let i = 0; i < 6; i++) {
      const n = (i + 1) % 6;
      verts.push(
        iv[i][0], topY, iv[i][1], ov[i][0], topY, ov[i][1], iv[n][0], topY, iv[n][1],
        iv[n][0], topY, iv[n][1], ov[i][0], topY, ov[i][1], ov[n][0], topY, ov[n][1]
      );
      verts.push(
        iv[i][0], bottomY, iv[i][1], iv[n][0], bottomY, iv[n][1], ov[i][0], bottomY, ov[i][1],
        iv[n][0], bottomY, iv[n][1], ov[n][0], bottomY, ov[n][1], ov[i][0], bottomY, ov[i][1]
      );
      verts.push(
        iv[i][0], topY, iv[i][1], iv[n][0], topY, iv[n][1], iv[i][0], bottomY, iv[i][1],
        iv[n][0], topY, iv[n][1], iv[n][0], bottomY, iv[n][1], iv[i][0], bottomY, iv[i][1]
      );
      verts.push(
        ov[i][0], topY, ov[i][1], ov[i][0], bottomY, ov[i][1], ov[n][0], topY, ov[n][1],
        ov[n][0], topY, ov[n][1], ov[i][0], bottomY, ov[i][1], ov[n][0], bottomY, ov[n][1]
      );
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, FRAME_MAT());
  }

  // ── Text labels flat on frame top surface ──

  _buildTextLabels(hexR, border, fH, baseH) {
    if (!this.font) return [];
    const innerR = hexR, outerR = hexR + border;
    const innerV = hexVertices(innerR), outerV = hexVertices(outerR);
    const topY = -baseH + 0.15;
    const textMat = new THREE.MeshPhongMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
    const meshes = [];

    const labels = this.settings.customLabels && this.settings.customLabels.some(l => l)
      ? this.settings.customLabels
      : this._getFrameLabels(this.stats);

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
        inner.userData = { role: 'text' };
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

// ═══════════ OBJ + MTL export ═══════════

function buildMTL() {
  const lines = ['# TrailPrint3D Materials'];
  for (const m of OBJ_MATERIALS) {
    lines.push('', `newmtl ${m.name}`, `Kd ${m.kd[0]} ${m.kd[1]} ${m.kd[2]}`, 'Ka 0.1 0.1 0.1', 'd 1.0');
  }
  return lines.join('\n');
}

function buildOBJ(group, terrainZoneIds) {
  const vertLines = [];
  const matFaces = Object.create(null);
  let vOff = 0;

  group.traverse(obj => {
    if (!obj.isMesh) return;
    const geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    const role = obj.userData.role || 'frame';

    for (let i = 0; i < pos.count; i++) {
      vertLines.push(`v ${pos.getX(i).toFixed(2)} ${pos.getY(i).toFixed(2)} ${pos.getZ(i).toFixed(2)}`);
    }

    const triCount = idx ? idx.count / 3 : pos.count / 3;

    const pushFace = (name, a, b, c) => {
      (matFaces[name] || (matFaces[name] = [])).push(`f ${a + vOff + 1} ${b + vOff + 1} ${c + vOff + 1}`);
    };

    if (role === 'terrain' && terrainZoneIds) {
      const topN = obj.userData.topFaceCount || triCount;
      for (let i = 0; i < triCount; i++) {
        let a, b, c;
        if (idx) { a = idx.getX(i * 3); b = idx.getX(i * 3 + 1); c = idx.getX(i * 3 + 2); }
        else { a = i * 3; b = i * 3 + 1; c = i * 3 + 2; }
        if (i < topN) {
          pushFace(OBJ_MATERIALS[terrainZoneIds[a] ?? Z_BASE].name, a, b, c);
        } else {
          pushFace('FRAME', a, b, c);
        }
      }
    } else {
      const matName = role === 'track' ? 'TRAIL' : role === 'text' ? 'TEXT' : 'FRAME';
      for (let i = 0; i < triCount; i++) {
        let a, b, c;
        if (idx) { a = idx.getX(i * 3); b = idx.getX(i * 3 + 1); c = idx.getX(i * 3 + 2); }
        else { a = i * 3; b = i * 3 + 1; c = i * 3 + 2; }
        pushFace(matName, a, b, c);
      }
    }

    vOff += pos.count;
    geo.dispose();
  });

  const lines = ['# TrailPrint3D OBJ Export', 'mtllib track-terrain.mtl', ''];
  lines.push(...vertLines, '');
  for (const name of ['BASE', 'FOREST', 'MOUNTAIN', 'WATER', 'FRAME', 'TRAIL', 'TEXT']) {
    if (!matFaces[name]?.length) continue;
    lines.push(`usemtl ${name}`);
    lines.push(...matFaces[name]);
  }
  return lines.join('\n');
}

// ═══════════ OSM feature fetching (water / forest) ═══════════

async function fetchOSMFeatures(bbox) {
  const { south, north, west, east } = bbox;
  const query = `[out:json][timeout:25];(
way["natural"="water"](${south},${west},${north},${east});
way["water"="lake"](${south},${west},${north},${east});
way["water"="river"](${south},${west},${north},${east});
way["natural"="wood"](${south},${west},${north},${east});
way["landuse"="forest"](${south},${west},${north},${east});
);out body;>;out skel qt;`;

  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
    const data = await resp.json();

    const nodes = new Map();
    for (const el of data.elements) {
      if (el.type === 'node') nodes.set(el.id, [el.lat, el.lon]);
    }

    const water = [], forest = [];
    for (const el of data.elements) {
      if (el.type !== 'way' || !el.nodes || el.nodes.length < 4) continue;
      if (el.nodes[0] !== el.nodes[el.nodes.length - 1]) continue;

      const coords = [];
      for (const nid of el.nodes) {
        const n = nodes.get(nid);
        if (n) coords.push(n);
      }
      if (coords.length < 4) continue;

      let sLat = Infinity, nLat = -Infinity, wLon = Infinity, eLon = -Infinity;
      for (const [la, lo] of coords) {
        if (la < sLat) sLat = la; if (la > nLat) nLat = la;
        if (lo < wLon) wLon = lo; if (lo > eLon) eLon = lo;
      }
      const poly = { coords, bbox: [sLat, nLat, wLon, eLon] };

      const tags = el.tags || {};
      if (tags.natural === 'water' || tags.water || tags.waterway) water.push(poly);
      else if (tags.natural === 'wood' || tags.landuse === 'forest') forest.push(poly);
    }

    console.log(`[terrain] OSM: ${water.length} water, ${forest.length} forest polygons`);
    return { water, forest };
  } catch (err) {
    console.warn('[terrain] OSM fetch failed, using elevation-only coloring:', err.message);
    return { water: [], forest: [] };
  }
}

function pointInPolygon(lat, lon, coords) {
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [yi, xi] = coords[i], [yj, xj] = coords[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

function isInAnyPolygon(lat, lon, polys) {
  for (const p of polys) {
    if (lat < p.bbox[0] || lat > p.bbox[1] || lon < p.bbox[2] || lon > p.bbox[3]) continue;
    if (pointInPolygon(lat, lon, p.coords)) return true;
  }
  return false;
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
