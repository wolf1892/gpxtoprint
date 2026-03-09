import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Preview3D {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 2000;

    // Hemisphere light for sky/ground ambient
    const hemi = new THREE.HemisphereLight(0xb0d0ff, 0x404030, 0.6);
    this.scene.add(hemi);

    // Main directional light (sun)
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.0);
    sun.position.set(1, 2.5, 1.5);
    this.scene.add(sun);

    // Fill light from opposite side
    const fill = new THREE.DirectionalLight(0x8899bb, 0.35);
    fill.position.set(-1, 0.5, -1);
    this.scene.add(fill);

    this.terrainGroup = null;
    this._raf = null;
    this._resizeObserver = new ResizeObserver(() => this._handleResize());
    this._resizeObserver.observe(this.container);
    this._handleResize();
    this._animate();
  }

  setTerrain(terrainBuilder) {
    if (this.terrainGroup) {
      this.scene.remove(this.terrainGroup);
      disposeMeshes(this.terrainGroup);
    }
    this.terrainGroup = terrainBuilder.getGroup();
    if (this.terrainGroup) {
      this.scene.add(this.terrainGroup);
      this._fitCamera();
    }
  }

  _fitCamera() {
    const box = new THREE.Box3().setFromObject(this.terrainGroup);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.8;

    this.camera.position.set(
      center.x + dist * 0.5,
      center.y + dist * 0.85,
      center.z + dist * 0.65,
    );
    this.controls.target.copy(center);
    this.camera.near = dist * 0.005;
    this.camera.far = dist * 15;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  _handleResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._resizeObserver.disconnect();
    this.renderer.dispose();
    if (this.terrainGroup) disposeMeshes(this.terrainGroup);
  }
}

function disposeMeshes(obj) {
  obj.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material.dispose();
    }
  });
}
