// One step of the damped 2D wave equation on a height field.
// State texture: R = current height, G = previous height.
//
//   next = 2c - p + c² ∇²c - damping (c - p) + viscosity ∇²(c - p)
//
// Neighbour fetches are clamped to the grid (Neumann boundary = reflection);
// an optional sponge layer adds damping near the edges to absorb outgoing waves.
// Mirrors CpuWaveSolver.step().
uniform sampler2D uState;
uniform vec2 uSize;
uniform float uC2;
uniform float uDamping;
uniform float uViscosity;
uniform float uRestoring;
uniform float uMaxHeight;
uniform float uSpongeTexels;
uniform float uSpongeStrength;
uniform float uAbsorb;

void main() {
  ivec2 size = ivec2(uSize);
  ivec2 hi = size - 1;
  ivec2 p = ivec2(gl_FragCoord.xy);

  vec2 s  = texelFetch(uState, p, 0).rg;
  vec2 sl = texelFetch(uState, clamp(p + ivec2(-1, 0), ivec2(0), hi), 0).rg;
  vec2 sr = texelFetch(uState, clamp(p + ivec2( 1, 0), ivec2(0), hi), 0).rg;
  vec2 sd = texelFetch(uState, clamp(p + ivec2( 0,-1), ivec2(0), hi), 0).rg;
  vec2 su = texelFetch(uState, clamp(p + ivec2( 0, 1), ivec2(0), hi), 0).rg;

  float lapC = sl.r + sr.r + sd.r + su.r - 4.0 * s.r;
  float lapP = sl.g + sr.g + sd.g + su.g - 4.0 * s.g;

  float edge = float(min(min(p.x, hi.x - p.x), min(p.y, hi.y - p.y)));
  float t = 1.0 - min(1.0, edge / max(2.0, uSpongeTexels));
  float damp = uDamping + uAbsorb * uSpongeStrength * t * t;

  float next = s.r + (s.r - s.g) * (1.0 - damp) + uC2 * lapC + uViscosity * (lapC - lapP);
  next *= 1.0 - uRestoring;
  if (isnan(next) || isinf(next)) next = 0.0;
  next = clamp(next, -uMaxHeight, uMaxHeight);

  gl_FragColor = vec4(next, s.r, 0.0, 1.0);
}
