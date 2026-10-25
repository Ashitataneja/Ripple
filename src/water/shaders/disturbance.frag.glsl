// Applies a batch of disturbances to the height field in a single pass.
// uA[i] = (u, v, radius, strength), uB[i] = (dirX, dirY, kind, unused).
// Mirrors evaluateDisturbance() in disturbance.ts.
#define MAX_DISTURBANCES 32

uniform sampler2D uState;
uniform vec2 uSize;
uniform vec2 uWorld;          // domain size in world units
uniform float uTravelShift;   // world distance a wave travels per simulation step
uniform float uMaxHeight;
uniform vec4 uA[MAX_DISTURBANCES];
uniform vec4 uB[MAX_DISTURBANCES];
uniform int uCount;

float pushProfile(vec2 d, vec2 dir, float r, float s) {
  float along = dot(d, dir) / r;
  float across = dot(d, vec2(-dir.y, dir.x)) / (r * 2.4);
  float q = along * along + across * across;
  if (q > 12.0) return 0.0;
  return s * exp(-q) * (0.65 + 0.5 * along);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 state = texelFetch(uState, p, 0);
  vec2 uv = (vec2(p) + 0.5) / uSize;
  vec2 acc = vec2(0.0);

  for (int i = 0; i < MAX_DISTURBANCES; i++) {
    if (i >= uCount) break;
    vec4 a = uA[i];
    vec4 b = uB[i];
    vec2 d = (uv - a.xy) * uWorld;
    float r = max(1e-4, a.z);
    float s = a.w;
    int kind = int(b.z + 0.5);

    if (kind == 0) {
      float q = dot(d, d) / (r * r);
      if (q < 9.0) { float v = s * exp(-q); acc += vec2(v, v); }
    } else if (kind == 1) {
      float q = dot(d, d) / (r * r);
      if (q < 9.0) {
        float along = dot(d, b.xy) / r;
        acc.x += s * exp(-q) * (0.9 * along - 0.45);
      }
    } else if (kind == 2) {
      acc.x += pushProfile(d, b.xy, r, s);
      acc.y += pushProfile(d + b.xy * uTravelShift, b.xy, r, s);
    } else {
      float rho2 = dot(d, d) / (r * r);
      if (rho2 < 16.0) {
        float rho = sqrt(rho2);
        float rim = exp(-((rho - 1.6) * (rho - 1.6)) / 0.36);
        acc.x += s * (-exp(-rho2) + 0.3 * rim);
      }
    }
  }

  state.rg = clamp(state.rg + acc, vec2(-uMaxHeight), vec2(uMaxHeight));
  gl_FragColor = state;
}
