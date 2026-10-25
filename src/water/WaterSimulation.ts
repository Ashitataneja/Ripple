import * as THREE from 'three';
import type { DisturbanceQueue } from '../interaction/DisturbanceQueue';
import { CpuWaveSolver } from './CpuWaveSolver';
import type { Disturbance } from './disturbance';
import { gridSizeFor, SIM, stepCoefficients, stepsPerSecondFor, type BoundaryMode } from './simulationParams';
import fullscreenVert from './shaders/fullscreen.vert.glsl?raw';
import waveStepFrag from './shaders/waveStep.frag.glsl?raw';
import disturbanceFrag from './shaders/disturbance.frag.glsl?raw';
import copyFrag from './shaders/copy.frag.glsl?raw';

export type SimulationKind = 'gpu-float' | 'gpu-half' | 'cpu';

interface SimulationBackend {
  readonly kind: SimulationKind;
  readonly width: number;
  readonly height: number;
  readonly texture: THREE.Texture;
  resize(width: number, height: number, worldWidth: number, worldHeight: number): void;
  setBoundary(mode: BoundaryMode): void;
  apply(list: readonly Disturbance[], count: number): void;
  step(): void;
  /** Called once per frame after stepping (CPU backend uploads here). */
  commit(): void;
  reset(): void;
  dispose(): void;
}

export interface SimulationOptions {
  resolution: number;
  boundary: BoundaryMode;
  forceCpu?: boolean;
}

/** Picks the best render-target type for the simulation on this GPU. */
export function detectGpuSimulationType(renderer: THREE.WebGLRenderer): { kind: SimulationKind; type: THREE.TextureDataType | null } {
  const ext = renderer.extensions;
  const floatRenderable = ext.has('EXT_color_buffer_float');
  if (floatRenderable && ext.has('OES_texture_float_linear')) return { kind: 'gpu-float', type: THREE.FloatType };
  if (floatRenderable || ext.has('EXT_color_buffer_half_float')) return { kind: 'gpu-half', type: THREE.HalfFloatType };
  return { kind: 'cpu', type: null };
}

/**
 * Height-field water simulation with a fixed timestep.
 * GPU path: ping-pong float render targets driven by fragment shaders.
 * Fallback: the same equations on the CPU at reduced resolution.
 */
export class WaterSimulation {
  private backend: SimulationBackend;
  private resolution: number;
  private boundary: BoundaryMode;
  private worldWidth = 1;
  private worldHeight = 1;
  private accumulator = 0;
  readonly texelSize = new THREE.Vector2(1, 1);
  stepsLastFrame = 0;

  constructor(renderer: THREE.WebGLRenderer, options: SimulationOptions) {
    this.resolution = options.resolution;
    this.boundary = options.boundary;
    const detected = options.forceCpu ? { kind: 'cpu' as const, type: null } : detectGpuSimulationType(renderer);
    let backend: SimulationBackend | null = null;
    if (detected.kind !== 'cpu' && detected.type !== null) {
      try {
        const gpu = new GpuBackend(renderer, detected.kind, detected.type, this.boundary);
        if (gpu.selfTest()) backend = gpu;
        else {
          console.warn('[ripple] GPU simulation self-test failed; falling back to CPU simulation.');
          gpu.dispose();
        }
      } catch (err) {
        console.warn('[ripple] GPU simulation unavailable; falling back to CPU simulation.', err);
      }
    }
    this.backend = backend ?? new CpuBackend(renderer, this.boundary);
    this.applyGrid();
  }

  get kind(): SimulationKind {
    return this.backend.kind;
  }

  get texture(): THREE.Texture {
    return this.backend.texture;
  }

  get gridWidth(): number {
    return this.backend.width;
  }

  get gridHeight(): number {
    return this.backend.height;
  }

  /** World distance one texel covers along the domain height. */
  get texelWorld(): number {
    return this.worldHeight / this.backend.height;
  }

  setDomain(worldWidth: number, worldHeight: number): void {
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
    this.applyGrid();
  }

  setResolution(resolution: number): void {
    if (resolution === this.resolution) return;
    this.resolution = resolution;
    this.applyGrid();
  }

  setBoundary(mode: BoundaryMode): void {
    this.boundary = mode;
    this.backend.setBoundary(mode);
  }

  /** Apply all queued disturbances, then advance the simulation by `dt` seconds of fixed steps. */
  update(dt: number, queue: DisturbanceQueue): void {
    if (queue.count > 0) {
      this.backend.apply(queue.items, queue.count);
      queue.clear();
    }
    const sps = stepsPerSecondFor(Math.max(this.backend.width, this.backend.height));
    this.accumulator += Math.max(0, Math.min(dt, 0.1));
    let steps = Math.floor(this.accumulator * sps);
    this.accumulator -= steps / sps;
    if (steps > SIM.maxStepsPerFrame) {
      steps = SIM.maxStepsPerFrame;
      this.accumulator = 0;
    }
    for (let i = 0; i < steps; i++) this.backend.step();
    this.stepsLastFrame = steps;
    this.backend.commit();
  }

  reset(): void {
    this.accumulator = 0;
    this.backend.reset();
  }

  dispose(): void {
    this.backend.dispose();
  }

  private applyGrid(): void {
    const cpu = this.backend.kind === 'cpu';
    const res = cpu ? Math.min(this.resolution, 200) : this.resolution;
    const { width, height } = gridSizeFor(res, this.worldWidth / this.worldHeight);
    this.backend.resize(width, height, this.worldWidth, this.worldHeight);
    this.texelSize.set(1 / width, 1 / height);
  }
}

// ---------------------------------------------------------------------------------------------
// GPU backend
// ---------------------------------------------------------------------------------------------

class GpuBackend implements SimulationBackend {
  width = 0;
  height = 0;
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private read = 0;
  private worldWidth = 1;
  private worldHeight = 1;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly stepMaterial: THREE.ShaderMaterial;
  private readonly splatMaterial: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly uA: THREE.Vector4[] = Array.from({ length: SIM.batchSize }, () => new THREE.Vector4());
  private readonly uB: THREE.Vector4[] = Array.from({ length: SIM.batchSize }, () => new THREE.Vector4());
  private readonly clearColor = new THREE.Color();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    readonly kind: SimulationKind,
    private readonly type: THREE.TextureDataType,
    private boundary: BoundaryMode,
  ) {
    const common = { vertexShader: fullscreenVert, depthTest: false, depthWrite: false };
    this.stepMaterial = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: waveStepFrag,
      uniforms: {
        uState: { value: null },
        uSize: { value: new THREE.Vector2(1, 1) },
        uC2: { value: 0 },
        uDamping: { value: 0 },
        uViscosity: { value: 0 },
        uRestoring: { value: 0 },
        uMaxHeight: { value: SIM.maxHeight },
        uSpongeTexels: { value: 8 },
        uSpongeStrength: { value: SIM.spongeStrength },
        uAbsorb: { value: boundary === 'absorb' ? 1 : 0 },
      },
    });
    this.splatMaterial = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: disturbanceFrag,
      uniforms: {
        uState: { value: null },
        uSize: { value: new THREE.Vector2(1, 1) },
        uWorld: { value: new THREE.Vector2(1, 1) },
        uTravelShift: { value: 0 },
        uMaxHeight: { value: SIM.maxHeight },
        uA: { value: this.uA },
        uB: { value: this.uB },
        uCount: { value: 0 },
      },
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      ...common,
      fragmentShader: copyFrag,
      uniforms: { uSource: { value: null } },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.stepMaterial);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get texture(): THREE.Texture {
    return this.targets ? this.targets[this.read].texture : nullTexture();
  }

  resize(width: number, height: number, worldWidth: number, worldHeight: number): void {
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
    if (width !== this.width || height !== this.height || !this.targets) {
      const next: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] = [this.createTarget(width, height), this.createTarget(width, height)];
      if (this.targets) {
        // Carry the existing waves over to the new grid.
        this.copyMaterial.uniforms.uSource.value = this.targets[this.read].texture;
        this.renderPass(this.copyMaterial, next[0]);
        this.targets[0].dispose();
        this.targets[1].dispose();
      } else {
        this.clearTarget(next[0]);
      }
      this.clearTarget(next[1]);
      this.targets = next;
      this.read = 0;
      this.width = width;
      this.height = height;
    }
    this.updateUniforms();
  }

  setBoundary(mode: BoundaryMode): void {
    this.boundary = mode;
    this.stepMaterial.uniforms.uAbsorb.value = mode === 'absorb' ? 1 : 0;
  }

  apply(list: readonly Disturbance[], count: number): void {
    if (!this.targets) return;
    for (let start = 0; start < count; start += SIM.batchSize) {
      const n = Math.min(SIM.batchSize, count - start);
      for (let i = 0; i < n; i++) {
        const d = list[start + i];
        this.uA[i].set(d.x, d.y, d.radius, d.strength);
        this.uB[i].set(d.dirX, d.dirY, d.kind, d.velocity);
      }
      this.splatMaterial.uniforms.uCount.value = n;
      this.splatMaterial.uniforms.uState.value = this.targets[this.read].texture;
      this.renderPass(this.splatMaterial, this.targets[1 - this.read]);
      this.read = 1 - this.read;
    }
  }

  step(): void {
    if (!this.targets) return;
    this.stepMaterial.uniforms.uState.value = this.targets[this.read].texture;
    this.renderPass(this.stepMaterial, this.targets[1 - this.read]);
    this.read = 1 - this.read;
  }

  commit(): void {
    // Nothing to upload: the state already lives on the GPU.
  }

  reset(): void {
    if (!this.targets) return;
    this.clearTarget(this.targets[0]);
    this.clearTarget(this.targets[1]);
  }

  /**
   * Some drivers advertise float render targets but produce garbage. Inject a disturbance,
   * step, and read the centre back through an 8-bit probe to confirm the pipeline works.
   */
  selfTest(): boolean {
    this.resize(64, 64, 1, 1);
    const probeTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    const probe = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: `uniform sampler2D uSource;
        void main() {
          float h = texture(uSource, vec2(0.5)).r;
          bool bad = isnan(h) || isinf(h);
          gl_FragColor = vec4(bad ? 0.0 : clamp(h * 0.5 + 0.5, 0.0, 1.0), bad ? 1.0 : 0.0, 0.0, 1.0);
        }`,
      uniforms: { uSource: { value: null } },
    });
    try {
      const d = { id: 0, x: 0.5, y: 0.5, radius: 0.08, strength: 0.6, dirX: 1, dirY: 0, kind: 0 as const, velocity: 0 };
      this.apply([d], 1);
      this.step();
      this.step();
      probe.uniforms.uSource.value = this.texture;
      this.renderPass(probe, probeTarget);
      const px = new Uint8Array(4);
      this.renderer.readRenderTargetPixels(probeTarget, 0, 0, 1, 1, px);
      const h = (px[0] / 255) * 2 - 1;
      const ok = px[1] < 128 && h > 0.2;
      this.reset();
      return ok;
    } finally {
      probe.dispose();
      probeTarget.dispose();
    }
  }

  dispose(): void {
    this.targets?.[0].dispose();
    this.targets?.[1].dispose();
    this.targets = null;
    this.stepMaterial.dispose();
    this.splatMaterial.dispose();
    this.copyMaterial.dispose();
    this.quad.geometry.dispose();
  }

  private updateUniforms(): void {
    const res = Math.max(this.width, this.height);
    const c = stepCoefficients(res);
    const su = this.stepMaterial.uniforms;
    su.uSize.value.set(this.width, this.height);
    su.uC2.value = c.c2;
    su.uDamping.value = c.damping;
    su.uViscosity.value = c.viscosity;
    su.uRestoring.value = c.restoring;
    su.uSpongeTexels.value = Math.max(2, SIM.spongeWidth * Math.min(this.width, this.height));
    su.uAbsorb.value = this.boundary === 'absorb' ? 1 : 0;
    const pu = this.splatMaterial.uniforms;
    pu.uSize.value.set(this.width, this.height);
    pu.uWorld.value.set(this.worldWidth, this.worldHeight);
    pu.uTravelShift.value = Math.sqrt(c.c2) * (this.worldHeight / this.height);
  }

  private createTarget(width: number, height: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(width, height, {
      type: this.type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  }

  private renderPass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    const previous = this.renderer.getRenderTarget();
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(previous);
  }

  private clearTarget(target: THREE.WebGLRenderTarget): void {
    const previous = this.renderer.getRenderTarget();
    this.renderer.getClearColor(this.clearColor);
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
    this.renderer.setClearColor(this.clearColor, alpha);
    this.renderer.setRenderTarget(previous);
  }
}

// ---------------------------------------------------------------------------------------------
// CPU fallback backend
// ---------------------------------------------------------------------------------------------

class CpuBackend implements SimulationBackend {
  readonly kind = 'cpu' as const;
  private readonly solver: CpuWaveSolver;
  private dataTexture: THREE.DataTexture | null = null;
  private readonly useFloat: boolean;

  constructor(renderer: THREE.WebGLRenderer, boundary: BoundaryMode) {
    this.useFloat = renderer.extensions.has('OES_texture_float_linear');
    this.solver = new CpuWaveSolver(64, 64, 1, 1, boundary);
  }

  get width(): number {
    return this.solver.width;
  }

  get height(): number {
    return this.solver.height;
  }

  get texture(): THREE.Texture {
    return this.dataTexture ?? nullTexture();
  }

  resize(width: number, height: number, worldWidth: number, worldHeight: number): void {
    const changed = width !== this.solver.width || height !== this.solver.height || !this.dataTexture;
    this.solver.resize(width, height, worldWidth, worldHeight);
    if (changed) {
      this.dataTexture?.dispose();
      const n = width * height;
      const data = this.useFloat ? new Float32Array(n) : new Uint16Array(n);
      const tex = new THREE.DataTexture(data, width, height, THREE.RedFormat, this.useFloat ? THREE.FloatType : THREE.HalfFloatType);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      this.dataTexture = tex;
    }
  }

  setBoundary(mode: BoundaryMode): void {
    this.solver.setBoundary(mode);
  }

  apply(list: readonly Disturbance[], count: number): void {
    this.solver.apply(list, count);
  }

  step(): void {
    this.solver.step();
  }

  commit(): void {
    const tex = this.dataTexture;
    if (!tex) return;
    const src = this.solver.current;
    const dst = tex.image.data as unknown as Float32Array | Uint16Array;
    if (dst instanceof Float32Array) dst.set(src);
    else for (let i = 0; i < src.length; i++) dst[i] = THREE.DataUtils.toHalfFloat(src[i]);
    tex.needsUpdate = true;
  }

  reset(): void {
    this.solver.reset();
    this.commit();
  }

  dispose(): void {
    this.dataTexture?.dispose();
    this.dataTexture = null;
  }
}

let sharedNullTexture: THREE.DataTexture | null = null;
function nullTexture(): THREE.Texture {
  if (!sharedNullTexture) {
    sharedNullTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    sharedNullTexture.needsUpdate = true;
  }
  return sharedNullTexture;
}
