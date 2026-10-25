import * as THREE from 'three';
import type { InteractionState } from '../app/interactionState';
import { PEBBLE } from '../interaction/PebbleSystem';
import type { WaterDomain, WaterMapping, WorldPoint } from '../interaction/types';
import { bakeFloorTexture } from './FloorGenerator';
import { SplashParticles } from './SplashParticles';
import { createPebbleMaterial, createWaterMaterial, LIGHTING, MAX_CURSORS, MAX_SHADOWS } from './WaterMaterial';
import type { WaterSimulation } from './WaterSimulation';

export const VIEW = {
  fov: 38,
  /** Camera tilt away from straight down, in degrees. */
  tilt: 27,
  distance: 3.2,
  /** Extra simulated margin around the visible area. */
  margin: 0.04,
  waterDepth: 0.34,
  floorTile: 1.7,
  heightScale: 0.022,
} as const;

export interface WaterCursor {
  x: number;
  z: number;
  radius: number;
  intensity: number;
}

/**
 * Renders the water: a perspective camera looking down into the pond, a displaced surface mesh
 * covering the view, held/sinking pebbles and splash particles. Also provides the screen → water
 * mapping used by every input source.
 */
export class WaterRenderer implements WaterMapping {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.05, 50);
  readonly domain: WaterDomain = { xmin: -1, zmin: -1, width: 2, height: 2 };
  readonly particles: SplashParticles;
  screenAspect = 1;

  private readonly material: THREE.ShaderMaterial;
  private surface: THREE.Mesh;
  private readonly floorTarget: THREE.WebGLRenderTarget;
  private readonly pebbleMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  private meshDivisor = 2;
  private width = 1;
  private height = 1;
  // Scratch objects reused every frame / call.
  private readonly ndc = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly sim: WaterSimulation,
  ) {
    const t = THREE.MathUtils.degToRad(VIEW.tilt);
    this.camera.position.set(0, VIEW.distance * Math.cos(t), VIEW.distance * Math.sin(t));
    this.camera.lookAt(0, 0, 0);

    const floorSize = renderer.capabilities.maxTextureSize >= 2048 ? 1024 : 512;
    this.floorTarget = bakeFloorTexture(renderer, floorSize);
    this.material = createWaterMaterial({ floor: this.floorTarget.texture, floorTile: VIEW.floorTile, depth: VIEW.waterDepth, heightScale: VIEW.heightScale });
    this.surface = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.surface.frustumCulled = false;
    this.scene.add(this.surface);

    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(makePebbleGeometry(i * 13.37 + 1), createPebbleMaterial(i / 4 + 0.05));
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      this.pebbleMeshes.push(mesh);
      this.scene.add(mesh);
    }

    this.particles = new SplashParticles();
    this.scene.add(this.particles.points);
  }

  get floorTexture(): THREE.Texture {
    return this.floorTarget.texture;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.screenAspect = this.height / this.width;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.updateDomain();
  }

  setMeshDivisor(divisor: number): void {
    if (divisor === this.meshDivisor) return;
    this.meshDivisor = divisor;
    this.rebuildSurface();
  }

  /** Called when the simulation grid changes size. */
  rebuildSurface(): void {
    const d = this.domain;
    const segX = Math.max(16, Math.round(this.sim.gridWidth / this.meshDivisor));
    const segY = Math.max(16, Math.round(this.sim.gridHeight / this.meshDivisor));
    const geometry = new THREE.PlaneGeometry(d.width, d.height, segX, segY);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(d.xmin + d.width / 2, 0, d.zmin + d.height / 2);
    this.surface.geometry.dispose();
    this.surface.geometry = geometry;
  }

  // ------------------------------------------------------------------ WaterMapping

  screenToWorld(sx: number, sy: number, out: WorldPoint): boolean {
    return this.rayAtHeight(sx, sy, 0, out);
  }

  screenToHover(sx: number, sy: number, height: number, out: WorldPoint): boolean {
    return this.rayAtHeight(sx, sy, height, out);
  }

  // ------------------------------------------------------------------ frame

  update(time: number, dt: number, state: InteractionState, cursors: readonly WaterCursor[], cursorCount: number): void {
    const u = this.material.uniforms;
    u.uHeight.value = this.sim.texture;
    u.uSimTexel.value.copy(this.sim.texelSize);
    u.uTime.value = time;
    const size = this.renderer.getDrawingBufferSize(TMP_V2);
    u.uResolution.value.set(size.x, size.y);

    const n = Math.min(MAX_CURSORS, cursorCount);
    for (let i = 0; i < n; i++) {
      const c = cursors[i];
      u.uCursors.value[i].set(c.x, c.z, c.radius, c.intensity);
    }
    u.uCursorCount.value = n;

    this.particles.update(dt, time);
    this.syncPebbles(state, time);
  }

  render(): void {
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.surface.geometry.dispose();
    this.material.dispose();
    this.floorTarget.dispose();
    for (const m of this.pebbleMeshes) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.particles.dispose();
    this.scene.clear();
  }

  // ------------------------------------------------------------------ internals

  private syncPebbles(state: InteractionState, time: number): void {
    const u = this.material.uniforms;
    let shadows = 0;
    const L = LIGHTING.light;
    for (let i = 0; i < this.pebbleMeshes.length; i++) {
      const mesh = this.pebbleMeshes[i];
      const p = state.pebbles[i];
      if (!p || p.phase === 'idle') {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(p.x, p.y, p.z);
      const s = PEBBLE.radius * Math.max(0.001, p.scale);
      mesh.scale.set(s, s * 0.62, s * 0.85);
      if (p.phase === 'falling' || p.phase === 'sinking') {
        mesh.rotation.x += 0.05;
        mesh.rotation.z += 0.03;
      } else {
        mesh.rotation.set(Math.sin(time * 1.3 + i) * 0.15, p.seed * 6.28, Math.cos(time * 1.1 + i) * 0.12);
      }
      mesh.material.uniforms.uSubmerge.value = p.submerge;
      mesh.material.uniforms.uOpacity.value = p.opacity;

      if (p.y > 0.002 && shadows < MAX_SHADOWS) {
        // Soft shadow on the water, cast along the key light.
        const sx = p.x - (L.x / L.y) * p.y;
        const sz = p.z - (L.z / L.y) * p.y;
        const height = Math.min(1, p.y / 0.35);
        u.uShadows.value[shadows++].set(sx, sz, 0.035 + height * 0.06, 0.4 * (1 - height * 0.6) * p.scale);
      }
    }
    u.uShadowCount.value = shadows;
  }

  private rayAtHeight(sx: number, sy: number, height: number, out: WorldPoint): boolean {
    this.ndc.set(sx * 2 - 1, 1 - sy * 2, 0.5).unproject(this.camera);
    const o = this.camera.position;
    this.dir.copy(this.ndc).sub(o);
    if (this.dir.y > -1e-5) return false;
    const t = (height - o.y) / this.dir.y;
    if (!(t > 0)) return false;
    out.x = o.x + this.dir.x * t;
    out.y = height;
    out.z = o.z + this.dir.z * t;
    return true;
  }

  private updateDomain(): void {
    const p: WorldPoint = { x: 0, y: 0, z: 0 };
    let xmin = Infinity;
    let xmax = -Infinity;
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const [sx, sy] of CORNERS) {
      if (!this.rayAtHeight(sx, sy, 0, p)) continue;
      xmin = Math.min(xmin, p.x);
      xmax = Math.max(xmax, p.x);
      zmin = Math.min(zmin, p.z);
      zmax = Math.max(zmax, p.z);
    }
    if (!Number.isFinite(xmin)) return;
    const w = xmax - xmin;
    const h = zmax - zmin;
    const m = VIEW.margin * Math.max(w, h);
    const d = this.domain;
    d.xmin = xmin - m;
    d.zmin = zmin - m;
    d.width = w + 2 * m;
    d.height = h + 2 * m;
    this.material.uniforms.uDomain.value.set(d.xmin, d.zmin, d.width, d.height);
    this.sim.setDomain(d.width, d.height);
    this.particles.setPixelScale(this.renderer.getDrawingBufferSize(TMP_V2).y, VIEW.fov);
    this.rebuildSurface();
  }
}

const TMP_V2 = new THREE.Vector2();
const CORNERS: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/** A slightly irregular river pebble, made once per pool slot. */
function makePebbleGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 4);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n =
      0.06 * Math.sin(v.x * 2.1 + seed) * Math.cos(v.y * 1.7 + seed * 0.7) +
      0.035 * Math.sin(v.z * 4.3 + seed * 1.3) +
      0.015 * Math.sin((v.x + v.y) * 9.0 + seed);
    v.multiplyScalar(1 + n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
