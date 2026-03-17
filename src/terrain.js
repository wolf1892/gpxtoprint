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
      gridSize: settings.gridResolution ?? 350,
      exaggeration: settings.exaggeration ?? 2,
      trackWidth: settings.trackWidth ?? 2,
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

  async export3MF() {
    this.group.updateMatrixWorld(true);
    return build3MF(this.group, this._terrainZoneIds);
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
      console.log('[terrain] track segments:', segments.length, 'points:', segments.map(s => s.length));
      for (const seg of segments) {
        const m = this._buildTrackTube(seg, terrainY, gridSize, modelW, modelD);
        if (m) trackMeshes.push(m);
      }
      console.log('[terrain] track meshes built:', trackMeshes.length);
    } catch (e) { console.error('[terrain] track tube FAILED:', e); }

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

      const h = sampleTerrain(x, z, terrainY, gridSize, modelW, modelD);
      current.push(new THREE.Vector3(x, h, z));
    }
    if (current.length >= 2) segments.push(current);
    return segments;
  }

  _buildTrackTube(pts, terrainY, gridSize, modelW, modelD) {
    if (pts.length < 2) return null;
    const radius = this.settings.trackWidth / 2;
    const minD = radius * 0.1;
    let deduped = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (pts[i].distanceTo(deduped[deduped.length - 1]) > minD) deduped.push(pts[i]);
    if (deduped.length > 2000) {
      const step = Math.ceil(deduped.length / 2000);
      const s = [deduped[0]];
      for (let i = step; i < deduped.length - 1; i += step) s.push(deduped[i]);
      s.push(deduped[deduped.length - 1]);
      deduped = s;
    }
    if (deduped.length < 2) return null;

    const roughCurve = new THREE.CatmullRomCurve3(deduped, false, 'centripetal', 0.5);
    const sampleCount = Math.max(deduped.length * 6, 400);
    const snapped = [];
    for (let i = 0; i <= sampleCount; i++) {
      const p = roughCurve.getPoint(i / sampleCount);
      const terrainH = sampleTerrain(p.x, p.z, terrainY, gridSize, modelW, modelD);
      p.y = terrainH + radius * 1.2;
      snapped.push(p);
    }

    const curve = new THREE.CatmullRomCurve3(snapped, false, 'centripetal', 0.1);
    const radSeg = 8;
    const geo = new THREE.TubeGeometry(curve, sampleCount, radius, radSeg, false);

    const tubePos = geo.getAttribute('position');
    const tubeIdx = Array.from(geo.getIndex().array);
    const vc = tubePos.count;
    const ringSize = radSeg + 1;
    const newPos = new Float32Array((vc + 2) * 3);
    newPos.set(tubePos.array);
    for (let cap = 0; cap < 2; cap++) {
      const ringStart = cap === 0 ? 0 : sampleCount * ringSize;
      let cx = 0, cy = 0, cz = 0;
      for (let j = 0; j < radSeg; j++) {
        cx += tubePos.getX(ringStart + j);
        cy += tubePos.getY(ringStart + j);
        cz += tubePos.getZ(ringStart + j);
      }
      const ci = vc + cap;
      newPos[ci * 3] = cx / radSeg;
      newPos[ci * 3 + 1] = cy / radSeg;
      newPos[ci * 3 + 2] = cz / radSeg;
      for (let j = 0; j < radSeg; j++) {
        const a = ringStart + j, b = ringStart + j + 1;
        if (cap === 0) tubeIdx.push(ci, b, a);
        else tubeIdx.push(ci, a, b);
      }
    }
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    geo.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tubeIdx), 1));
    geo.computeVertexNormals();

    const box = new THREE.Box3();
    const tmpPos = geo.getAttribute('position');
    for (let i = 0; i < tmpPos.count; i++) {
      box.expandByPoint(new THREE.Vector3(tmpPos.getX(i), tmpPos.getY(i), tmpPos.getZ(i)));
    }
    console.log('[terrain] track tube bbox:', box.min.toArray().map(v => v.toFixed(2)), box.max.toArray().map(v => v.toFixed(2)),
      'verts:', tmpPos.count, 'indices:', tubeIdx.length);

    const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: 0xe53020, shininess: 40, side: THREE.DoubleSide }));
    mesh.userData = { role: 'track' };
    mesh.renderOrder = 1;
    return mesh;
  }

  // ── Watertight terrain solid (top + boundary walls + bottom) ──

  _buildTerrainSolid(gridX, gridZ, terrainY, inside, zoneIds, gridSize, modelW, modelD, hexR, bottomY) {
    const total = gridSize * gridSize;

    const posArr = [];
    const colArr = [];
    for (let i = 0; i < total; i++) {
      posArr.push(gridX[i], terrainY[i], gridZ[i]);
      const rgb = ZONE_RGB[zoneIds[i]];
      colArr.push(rgb[0], rgb[1], rgb[2]);
    }

    // ── Top surface (CCW winding → normals up) ──
    const indices = [];
    for (let r = 0; r < gridSize - 1; r++) {
      for (let c = 0; c < gridSize - 1; c++) {
        const tl = r * gridSize + c, tr = tl + 1, bl = tl + gridSize, br = bl + 1;
        if (inside[tl] && inside[tr] && inside[bl]) indices.push(tl, tr, bl);
        if (inside[tr] && inside[br] && inside[bl]) indices.push(tr, br, bl);
      }
    }
    const topFaceCount = indices.length / 3;

    // ── Find boundary edges (edges appearing in exactly 1 face) ──
    const edgeCount = new Map();
    const edgeDir = new Map();
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      for (const [v1, v2] of [[a, b], [b, c], [c, a]]) {
        const key = Math.min(v1, v2) + '_' + Math.max(v1, v2);
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        edgeDir.set(key, [v1, v2]);
      }
    }

    // Build directed adjacency for boundary loop
    const bNext = new Map();
    for (const [key, count] of edgeCount) {
      if (count !== 1) continue;
      const [v1, v2] = edgeDir.get(key);
      bNext.set(v1, v2);
    }

    // Walk boundary loop (solid on left → direction matches face edge)
    const boundaryLoop = [];
    if (bNext.size > 0) {
      const start = bNext.keys().next().value;
      let cur = start;
      do {
        boundaryLoop.push(cur);
        cur = bNext.get(cur);
      } while (cur !== start && cur !== undefined);
    }
    console.log('[terrain] boundary: edges', bNext.size, 'loop', boundaryLoop.length, 'top faces', topFaceCount);

    // ── Add bottom ring + center vertex ──
    const botStart = total;
    const centerIdx = total + boundaryLoop.length;
    for (const vi of boundaryLoop) {
      posArr.push(gridX[vi], bottomY, gridZ[vi]);
      colArr.push(0.05, 0.05, 0.05);
    }
    posArr.push(0, bottomY, 0);
    colArr.push(0.05, 0.05, 0.05);

    // ── Wall faces (outward normals: boundary is CW from +Y) ──
    for (let i = 0; i < boundaryLoop.length; i++) {
      const a = boundaryLoop[i];
      const b = boundaryLoop[(i + 1) % boundaryLoop.length];
      const aBot = botStart + i;
      const bBot = botStart + (i + 1) % boundaryLoop.length;
      indices.push(a, bBot, b);
      indices.push(a, aBot, bBot);
    }

    // ── Bottom plate (normals down) ──
    for (let i = 0; i < boundaryLoop.length; i++) {
      const aBot = botStart + i;
      const bBot = botStart + (i + 1) % boundaryLoop.length;
      indices.push(centerIdx, bBot, aBot);
    }

    const vertCount = posArr.length / 3;
    let maxIdx = 0;
    for (let i = 0; i < indices.length; i++) { if (indices[i] > maxIdx) maxIdx = indices[i]; }
    console.log('[terrain] mesh: verts', vertCount, 'indices', indices.length, 'maxIdx', maxIdx,
      maxIdx >= vertCount ? 'INDEX OUT OF BOUNDS!' : 'OK');

    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colArr), 3));
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
      // Top annulus (CCW from +Y → normals up)
      verts.push(
        iv[i][0], topY, iv[i][1], iv[n][0], topY, iv[n][1], ov[i][0], topY, ov[i][1],
        iv[n][0], topY, iv[n][1], ov[n][0], topY, ov[n][1], ov[i][0], topY, ov[i][1]
      );
      // Bottom annulus (CW from +Y → normals down)
      verts.push(
        iv[i][0], bottomY, iv[i][1], ov[i][0], bottomY, ov[i][1], iv[n][0], bottomY, iv[n][1],
        ov[i][0], bottomY, ov[i][1], ov[n][0], bottomY, ov[n][1], iv[n][0], bottomY, iv[n][1]
      );
      // Inner wall (normals toward center)
      verts.push(
        iv[i][0], topY, iv[i][1], iv[i][0], bottomY, iv[i][1], iv[n][0], topY, iv[n][1],
        iv[i][0], bottomY, iv[i][1], iv[n][0], bottomY, iv[n][1], iv[n][0], topY, iv[n][1]
      );
      // Outer wall (normals away from center)
      verts.push(
        ov[i][0], topY, ov[i][1], ov[n][0], topY, ov[n][1], ov[i][0], bottomY, ov[i][1],
        ov[n][0], topY, ov[n][1], ov[n][0], bottomY, ov[n][1], ov[i][0], bottomY, ov[i][1]
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
    const topY = -baseH - 0.5;
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
          font: this.font, size: fontSize, depth: 1.5,
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
  const rawPos = [];
  const rawFaces = [];
  let vOff = 0;

  group.traverse(obj => {
    if (!obj.isMesh) return;
    const geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    const role = obj.userData.role || 'frame';

    for (let i = 0; i < pos.count; i++) {
      rawPos.push(pos.getX(i).toFixed(2), pos.getY(i).toFixed(2), pos.getZ(i).toFixed(2));
    }

    const triCount = idx ? idx.count / 3 : pos.count / 3;

    if (role === 'terrain' && terrainZoneIds) {
      const topN = obj.userData.topFaceCount || triCount;
      for (let i = 0; i < triCount; i++) {
        let a, b, c;
        if (idx) { a = idx.getX(i * 3); b = idx.getX(i * 3 + 1); c = idx.getX(i * 3 + 2); }
        else { a = i * 3; b = i * 3 + 1; c = i * 3 + 2; }
        const mat = i < topN ? OBJ_MATERIALS[terrainZoneIds[a] ?? Z_BASE].name : 'FRAME';
        rawFaces.push(mat, a + vOff, b + vOff, c + vOff);
      }
    } else {
      const matName = role === 'track' ? 'TRAIL' : role === 'text' ? 'TEXT' : 'FRAME';
      for (let i = 0; i < triCount; i++) {
        let a, b, c;
        if (idx) { a = idx.getX(i * 3); b = idx.getX(i * 3 + 1); c = idx.getX(i * 3 + 2); }
        else { a = i * 3; b = i * 3 + 1; c = i * 3 + 2; }
        rawFaces.push(matName, a + vOff, b + vOff, c + vOff);
      }
    }

    vOff += pos.count;
    geo.dispose();
  });

  // Weld coincident vertices by quantized position
  const posMap = new Map();
  const weld = new Uint32Array(vOff);
  const vertLines = [];
  let wCount = 0;
  for (let i = 0; i < vOff; i++) {
    const key = rawPos[i * 3] + ' ' + rawPos[i * 3 + 1] + ' ' + rawPos[i * 3 + 2];
    const existing = posMap.get(key);
    if (existing !== undefined) {
      weld[i] = existing;
    } else {
      posMap.set(key, wCount);
      weld[i] = wCount;
      vertLines.push('v ' + key);
      wCount++;
    }
  }

  const matFaces = Object.create(null);
  for (let i = 0; i < rawFaces.length; i += 4) {
    const wa = weld[rawFaces[i + 1]] + 1;
    const wb = weld[rawFaces[i + 2]] + 1;
    const wc = weld[rawFaces[i + 3]] + 1;
    if (wa === wb || wb === wc || wa === wc) continue;
    const mat = rawFaces[i];
    (matFaces[mat] || (matFaces[mat] = [])).push(`f ${wa} ${wb} ${wc}`);
  }

  let lines = ['# TrailPrint3D OBJ Export', 'mtllib track-terrain.mtl', ''];
  lines = lines.concat(vertLines, ['']);
  for (const name of ['BASE', 'FOREST', 'MOUNTAIN', 'WATER', 'FRAME', 'TRAIL', 'TEXT']) {
    if (!matFaces[name]?.length) continue;
    lines.push(`usemtl ${name}`);
    lines = lines.concat(matFaces[name]);
  }
  return lines.join('\n');
}

// ═══════════ 3MF export (per-material parts for Bambu Studio) ═══════════

const MAT_NAMES  = ['BASE',    'FOREST',  'MOUNTAIN','WATER',   'TRAIL',   'FRAME',   'TEXT'];
const MAT_COLORS = ['#0DB30D', '#0D400D', '#808080', '#0000CC', '#FF0000', '#1A1A1A', '#CCCCCC'];
const MI_TRAIL = 4, MI_FRAME = 5, MI_TEXT = 6;

async function build3MF(group, terrainZoneIds) {
  const { default: JSZip } = await import('jszip');

  const rawPos = [];
  const rawFaces = [];
  let vOff = 0;

  group.traverse(obj => {
    if (!obj.isMesh) return;
    const geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex();
    const role = obj.userData.role || 'frame';

    for (let i = 0; i < pos.count; i++)
      rawPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));

    const triCount = idx ? idx.count / 3 : pos.count / 3;

    if (role === 'terrain' && terrainZoneIds) {
      const topN = obj.userData.topFaceCount || triCount;
      for (let i = 0; i < triCount; i++) {
        let a, b, c;
        if (idx) { a = idx.getX(i * 3); b = idx.getX(i * 3 + 1); c = idx.getX(i * 3 + 2); }
        else { a = i * 3; b = i * 3 + 1; c = i * 3 + 2; }
        const mi = i < topN ? (terrainZoneIds[a] ?? 0) : MI_FRAME;
        rawFaces.push(a + vOff, b + vOff, c + vOff, mi);
      }
    } else {
      const mi = role === 'track' ? MI_TRAIL : role === 'text' ? MI_TEXT : MI_FRAME;
      for (let i = 0; i < triCount; i++) {
        let a, b, c;
        if (idx) { a = idx.getX(i * 3); b = idx.getX(i * 3 + 1); c = idx.getX(i * 3 + 2); }
        else { a = i * 3; b = i * 3 + 1; c = i * 3 + 2; }
        rawFaces.push(a + vOff, b + vOff, c + vOff, mi);
      }
    }

    vOff += pos.count;
    geo.dispose();
  });

  // Split faces by material, weld vertices per-part
  const partsByMat = MAT_NAMES.map(() => ({ faces: [] }));
  for (let i = 0; i < rawFaces.length; i += 4)
    partsByMat[rawFaces[i + 3]].faces.push(rawFaces[i], rawFaces[i + 1], rawFaces[i + 2]);

  function weldPart(faces) {
    const posMap = new Map();
    const verts = [];
    const tris = [];
    let n = 0;
    for (let i = 0; i < faces.length; i += 3) {
      const wi = [];
      for (let k = 0; k < 3; k++) {
        const oi = faces[i + k];
        const key = rawPos[oi * 3].toFixed(2) + ' ' + rawPos[oi * 3 + 1].toFixed(2) + ' ' + rawPos[oi * 3 + 2].toFixed(2);
        let vi = posMap.get(key);
        if (vi === undefined) {
          vi = n++;
          posMap.set(key, vi);
          verts.push(rawPos[oi * 3].toFixed(4), rawPos[oi * 3 + 1].toFixed(4), rawPos[oi * 3 + 2].toFixed(4));
        }
        wi.push(vi);
      }
      if (wi[0] !== wi[1] && wi[1] !== wi[2] && wi[0] !== wi[2])
        tris.push(wi[0], wi[1], wi[2]);
    }
    return { verts, tris };
  }

  const parts = partsByMat.map(p => p.faces.length > 0 ? weldPart(p.faces) : null);
  const activeParts = [];
  for (let mi = 0; mi < parts.length; mi++)
    if (parts[mi] && parts[mi].tris.length > 0) activeParts.push(mi);

  // Object IDs: 1..N for mesh parts, N+1 for assembly
  const asmId = activeParts.length + 1;

  // Build object model file (contains all mesh parts)
  const obj = ['<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" ',
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ',
    'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" ',
    'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ',
    'requiredextensions="p">\n',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n',
    ' <resources>\n'];

  const uuidBase = 'a0010000-b206-40ff-9872-83e8017abed';
  activeParts.forEach((mi, idx) => {
    const id = idx + 1;
    const { verts, tris } = parts[mi];
    obj.push(`  <object id="${id}" p:UUID="${uuidBase}${id}" type="model">\n   <mesh>\n    <vertices>\n`);
    for (let i = 0; i < verts.length; i += 3)
      obj.push(`     <vertex x="${verts[i]}" y="${verts[i + 1]}" z="${verts[i + 2]}"/>\n`);
    obj.push('    </vertices>\n    <triangles>\n');
    for (let i = 0; i < tris.length; i += 3)
      obj.push(`     <triangle v1="${tris[i]}" v2="${tris[i + 1]}" v3="${tris[i + 2]}"/>\n`);
    obj.push('    </triangles>\n   </mesh>\n  </object>\n');
  });
  obj.push(' </resources>\n</model>\n');

  // Main model file (assembly referencing parts)
  const main = ['<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ',
    'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" ',
    'unit="millimeter" xml:lang="en-US" requiredextensions="p" ',
    'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n',
    ' <resources>\n',
    `  <object id="${asmId}" p:UUID="00000001-61cb-4c03-9d28-80fed5dfa1dc" type="model">\n`,
    '   <components>\n'];
  activeParts.forEach((mi, idx) => {
    const id = idx + 1;
    main.push(`    <component p:path="/3D/Objects/object_1.model" objectid="${id}" p:UUID="${uuidBase}${id}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`);
  });
  main.push('   </components>\n  </object>\n </resources>\n',
    ' <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">\n',
    `  <item objectid="${asmId}" p:UUID="00000003-b1ec-4553-aec9-835e5b724bb4" printable="1"/>\n`,
    ' </build>\n</model>\n');

  // model_settings.config — per-part extruder assignments
  let totalFaces = 0;
  activeParts.forEach(mi => { totalFaces += parts[mi].tris.length / 3; });

  const cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n',
    `  <object id="${asmId}">\n`,
    '    <metadata key="name" value="TrailPrint3D"/>\n',
    '    <metadata key="extruder" value="1"/>\n',
    `    <metadata face_count="${totalFaces}"/>\n`];
  activeParts.forEach((mi, idx) => {
    const id = idx + 1;
    const fc = parts[mi].tris.length / 3;
    cfg.push(`    <part id="${id}" subtype="normal_part">\n`);
    cfg.push(`      <metadata key="name" value="${MAT_NAMES[mi]}"/>\n`);
    cfg.push('      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n');
    cfg.push(`      <metadata key="source_object_id" value="0"/>\n`);
    cfg.push(`      <metadata key="source_volume_id" value="${idx}"/>\n`);
    cfg.push(`      <metadata key="extruder" value="${mi + 1}"/>\n`);
    cfg.push(`      <mesh_stat face_count="${fc}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n`);
    cfg.push('    </part>\n');
  });
  cfg.push('  </object>\n',
    '  <plate>\n',
    '    <metadata key="plater_id" value="1"/>\n',
    '    <metadata key="plater_name" value=""/>\n',
    '    <metadata key="locked" value="false"/>\n',
    '    <model_instance>\n',
    `      <metadata key="object_id" value="${asmId}"/>\n`,
    '      <metadata key="instance_id" value="0"/>\n',
    '    </model_instance>\n',
    '  </plate>\n</config>\n');

  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  zip.file('3D/3dmodel.model', main.join(''));
  zip.file('3D/_rels/3dmodel.model.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
  zip.file('3D/Objects/object_1.model', obj.join(''));
  zip.file('Metadata/model_settings.config', cfg.join(''));

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
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
