/**
 * Shared constants for the height-field wave simulation.
 * The GPU shader and the CPU fallback both derive their per-step values from here,
 * so the two implementations behave identically (within floating-point precision).
 */

export const SIM = {
  /** Courant number squared (c²·dt²/dx²). Must stay below 0.5 for the 5-point stencil. */
  waveSpeedSquared: 0.3,
  /** Simulation steps per second at the reference resolution. Scaled with resolution so waves cross the screen at a constant speed. */
  referenceStepsPerSecond: 180,
  referenceResolution: 512,
  /** Velocity damping per second (converted to a per-step factor). */
  dampingPerSecond: 0.85,
  /** Extra damping of high-frequency detail (viscosity on the velocity Laplacian). */
  viscosity: 0.014,
  /** Weak spring towards zero that removes any mean offset so the pond always returns to rest. */
  restoringPerSecond: 0.06,
  /** Hard bound on the stored height so a stack of impulses can never explode. */
  maxHeight: 1.6,
  /** Width of the absorbing sponge layer, as a fraction of the shorter side. */
  spongeWidth: 0.06,
  /** Additional damping applied at the outermost edge of the sponge. */
  spongeStrength: 0.12,
  /** Max substeps per frame; any extra simulated time is dropped instead of spiralling. */
  maxStepsPerFrame: 8,
  /** Disturbances applied per GPU pass (uniform array size). */
  batchSize: 32,
} as const;

export type BoundaryMode = 'absorb' | 'reflect';

export interface StepCoefficients {
  c2: number;
  damping: number;
  viscosity: number;
  restoring: number;
}

export function stepsPerSecondFor(resolution: number): number {
  return SIM.referenceStepsPerSecond * (resolution / SIM.referenceResolution);
}

export function stepCoefficients(resolution: number): StepCoefficients {
  const sps = stepsPerSecondFor(resolution);
  return {
    c2: SIM.waveSpeedSquared,
    damping: Math.min(0.2, SIM.dampingPerSecond / sps),
    viscosity: SIM.viscosity,
    restoring: Math.min(0.05, SIM.restoringPerSecond / sps),
  };
}

/** Grid dimensions for a domain of the given world aspect (width / height); the long side gets `resolution` texels. */
export function gridSizeFor(resolution: number, aspect: number): { width: number; height: number } {
  const a = Math.max(0.2, Math.min(5, aspect));
  if (a >= 1) return { width: resolution, height: Math.max(64, Math.round(resolution / a)) };
  return { width: Math.max(64, Math.round(resolution * a)), height: resolution };
}
