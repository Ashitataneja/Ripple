import * as THREE from 'three';
import particlesVert from './shaders/particles.vert.glsl?raw';
import splashFrag from './shaders/splash.frag.glsl?raw';

const GRAVITY = 5.2;

/**
 * Pooled particles for splash droplets (arcing above the water, rippling it again on landing)
 * and bubbles (rising after a pebble enters). All buffers are allocated once.
 */
export class SplashParticles {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly type: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;
  private alive = 0;
  enabled = true;
  /** Called when a droplet lands on, or a bubble pops at, the surface. */
  onSurface: ((x: number, z: number, size: number) => void) | null = null;

  constructor(capacity = 640) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.type = new Float32Array(capacity);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aType', new THREE.BufferAttribute(this.type, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: particlesVert,
      fragmentShader: splashFrag,
      uniforms: { uPixelScale: { value: 600 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  setPixelScale(heightPx: number, fovDeg: number): void {
    this.material.uniforms.uPixelScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  splash(x: number, z: number, strength: number, dirX: number, dirZ: number): void {
    if (!this.enabled) return;
    const s = Math.max(0, Math.min(1.6, strength));
    const count = Math.round(6 + s * 34);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const crown = 0.35 + Math.random() * 0.75;
      const h = (0.18 + Math.random() * 0.45) * crown * (0.6 + s * 0.55);
      const up = (0.55 + Math.random() * 0.95) * Math.sqrt(0.25 + s) * (1.25 - crown * 0.4);
      const r = 0.01 + Math.random() * 0.02;
      this.spawn(
        x + Math.cos(a) * r,
        0.004,
        z + Math.sin(a) * r,
        Math.cos(a) * h + dirX * 0.4 * s,
        up,
        Math.sin(a) * h + dirZ * 0.4 * s,
        0.006 + Math.random() * 0.012 * (0.5 + s * 0.5),
        0,
        2.5,
      );
    }
  }

  bubble(x: number, y: number, z: number): void {
    if (!this.enabled) return;
    this.spawn(x + (Math.random() - 0.5) * 0.02, y, z + (Math.random() - 0.5) * 0.02, 0, 0.06 + Math.random() * 0.08, 0, 0.005 + Math.random() * 0.008, 1, 0.8 + Math.random() * 0.9);
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
    this.alive = 0;
    this.markDirty();
  }

  update(dt: number, time: number): void {
    if (this.alive === 0) return;
    let alive = 0;
    const { pos, vel, life, maxLife, alpha, size, baseSize, type } = this;
    for (let i = 0; i < this.capacity; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const j = i * 3;
      if (type[i] < 0.5) {
        // Droplet: ballistic arc with a little air drag.
        vel[j + 1] -= GRAVITY * dt;
        const drag = Math.exp(-0.6 * dt);
        vel[j] *= drag;
        vel[j + 2] *= drag;
        pos[j] += vel[j] * dt;
        pos[j + 1] += vel[j + 1] * dt;
        pos[j + 2] += vel[j + 2] * dt;
        if (pos[j + 1] <= 0 && vel[j + 1] < 0) {
          this.onSurface?.(pos[j], pos[j + 2], baseSize[i] * 60);
          life[i] = 0;
        }
        alpha[i] = life[i] > 0 ? Math.min(1, life[i] * 4) : 0;
        size[i] = baseSize[i];
      } else {
        // Bubble: rises with a wobble, pops at the surface.
        pos[j] += Math.sin(time * 9 + i) * 0.02 * dt;
        pos[j + 1] += vel[j + 1] * dt;
        if (pos[j + 1] >= -0.004) {
          if (Math.random() < 0.5) this.onSurface?.(pos[j], pos[j + 2], baseSize[i] * 25);
          life[i] = 0;
        }
        const t = life[i] / maxLife[i];
        alpha[i] = life[i] > 0 ? Math.min(1, (1 - t) * 6) * Math.min(1, t * 4) * 0.7 : 0;
        size[i] = baseSize[i] * (1 + (1 - t) * 0.4);
      }
      if (life[i] > 0) alive++;
      else alpha[i] = 0;
    }
    this.alive = alive;
    this.markDirty();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, type: number, lifetime: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const j = i * 3;
    if (this.life[i] <= 0) this.alive++;
    this.pos[j] = x;
    this.pos[j + 1] = y;
    this.pos[j + 2] = z;
    this.vel[j] = vx;
    this.vel[j + 1] = vy;
    this.vel[j + 2] = vz;
    this.life[i] = lifetime;
    this.maxLife[i] = lifetime;
    this.baseSize[i] = size;
    this.size[i] = size;
    this.alpha[i] = type < 0.5 ? 1 : 0;
    this.type[i] = type;
  }

  private markDirty(): void {
    const g = this.geometry.attributes;
    g.position.needsUpdate = true;
    g.aSize.needsUpdate = true;
    g.aAlpha.needsUpdate = true;
    g.aType.needsUpdate = true;
  }
}
