// Water surface shading: per-pixel normals from the height field, Fresnel-balanced
// reflection of a procedural night sky, refraction onto a textured pond floor with
// absorption, restrained caustics (procedural + focused by the simulated ripples).
#define MAX_CURSORS 10
#define MAX_SHADOWS 4

uniform sampler2D uHeight;
uniform vec2 uSimTexel;
uniform float uHeightScale;
uniform sampler2D uFloor;
uniform float uFloorTile;
uniform float uStoneRelief;
uniform float uDepth;
uniform float uTime;
uniform vec3 uLightDir;
uniform vec3 uMoonDir;
uniform float uCaustics;
uniform float uExposure;
uniform vec2 uResolution;
uniform vec4 uCursors[MAX_CURSORS];
uniform int uCursorCount;
uniform vec4 uShadows[MAX_SHADOWS];
uniform int uShadowCount;

varying vec3 vWorld;
varying vec2 vUv;

float heightAt(vec2 uv) {
  return texture(uHeight, uv).r;
}

vec3 sky(vec3 r) {
  float el = clamp(r.y, 0.0, 1.0);
  float m = max(dot(r, uMoonDir), 0.0);
  // Night sky: brighter towards the horizon and around the (cloud-veiled) moon.
  vec3 zenith = vec3(0.016, 0.024, 0.042);
  vec3 horizon = vec3(0.150, 0.180, 0.220);
  vec3 c = mix(horizon, zenith, pow(el, 0.7));
  c += vec3(0.10, 0.12, 0.15) * pow(m, 5.0);

  // Thin, slow cloud cover lit by the moon.
  vec2 sp = r.xz / (r.y + 0.35);
  float cl = fbm3(sp * 1.6 + vec2(uTime * 0.008, uTime * 0.003));
  c += vec3(0.05, 0.06, 0.075) * smoothstep(0.45, 0.85, cl) * (0.4 + 1.6 * pow(m, 6.0));

  // Moon: a small bright disc with a faint halo.
  c += vec3(0.95, 0.97, 1.0) * 9.0 * smoothstep(0.99975, 0.99986, m);
  c += vec3(0.30, 0.36, 0.45) * pow(m, 220.0) * 0.4;

  // Overhanging foliage silhouettes towards the horizon.
  float az = atan(r.z, r.x);
  float leaves = fbm3(vec2(az * 5.0, el * 9.0) + 11.0) + fbm3(vec2(az * 17.0, el * 26.0)) * 0.35;
  float canopy = smoothstep(0.62, 0.78, leaves + (0.55 - el) * 0.9);
  c *= 1.0 - 0.9 * canopy;
  return c;
}

vec4 floorSample(vec2 xz) {
  vec4 f = texture(uFloor, xz / uFloorTile);
  return vec4(f.rgb * f.rgb, f.a);
}

float depthAt(vec2 xz) {
  return uDepth * (0.7 + 0.75 * fbm3(xz * 0.45 + 7.0));
}

vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 tx = uSimTexel;
  vec2 texelWorld = vec2(uDomain.z * tx.x, uDomain.w * tx.y);

  // --- Surface normal from the height field ------------------------------------------------
  float hL = heightAt(uv - vec2(tx.x, 0.0));
  float hR = heightAt(uv + vec2(tx.x, 0.0));
  float hD = heightAt(uv - vec2(0.0, tx.y));
  float hU = heightAt(uv + vec2(0.0, tx.y));
  float dhdx = (hR - hL) / (2.0 * texelWorld.x) * uHeightScale;
  float dhdz = -(hU - hD) / (2.0 * texelWorld.y) * uHeightScale; // v grows towards -z

  // A barely-there breeze so the untouched surface is not a perfect mirror.
  vec2 xz = vWorld.xz;
  float breeze = 0.35 + 0.65 * smoothstep(0.35, 0.8, vnoise(xz * 0.7 + vec2(uTime * 0.05, -uTime * 0.03)));
  vec2 micro = vec2(0.0);
  micro += vec2(0.83, 0.55) * cos(dot(xz, vec2(0.83, 0.55)) * 31.0 + uTime * 1.30);
  micro += vec2(-0.42, 0.91) * cos(dot(xz, vec2(-0.42, 0.91)) * 47.0 + uTime * 1.70);
  micro += vec2(0.97, -0.24) * cos(dot(xz, vec2(0.97, -0.24)) * 23.0 - uTime * 1.05);
  micro *= 0.0035 * breeze;

  vec3 n = normalize(vec3(-dhdx + micro.x, 1.0, -dhdz + micro.y));

  // --- View-dependent terms ----------------------------------------------------------------
  vec3 V = normalize(cameraPosition - vWorld);
  float cosV = max(dot(n, V), 0.0);
  float fresnel = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);

  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 env = sky(R);

  // --- Refraction onto the pond floor ------------------------------------------------------
  vec3 T = refract(-V, n, 1.0 / 1.333);
  float ty = max(-T.y, 0.08);
  float d0 = depthAt(xz);
  float t = (vWorld.y + d0) / ty;
  vec3 hit = vWorld + T * t;
  vec4 fl = floorSample(hit.xz);
  float d1 = depthAt(hit.xz) - fl.a * uStoneRelief;
  t = max(0.0, (vWorld.y + d1) / ty);
  hit = vWorld + T * t;
  fl = floorSample(hit.xz);

  // Caustics: a slow ambient web plus light focused by the simulated surface curvature.
  vec3 L = normalize(uLightDir);
  vec2 entry = hit.xz + L.xz / max(L.y, 0.2) * d1;
  vec2 euv = worldToUv(entry);
  vec2 s2 = tx * 2.0;
  float hc = heightAt(euv);
  float lap = heightAt(euv + vec2(s2.x, 0.0)) + heightAt(euv - vec2(s2.x, 0.0))
            + heightAt(euv + vec2(0.0, s2.y)) + heightAt(euv - vec2(0.0, s2.y)) - 4.0 * hc;
  float focus = clamp(-lap * 7.0, -0.3, 2.4);
  float web = causticPattern(hit.xz * 0.8, uTime * 0.32) * (0.4 + 0.6 * vnoise(hit.xz * 1.3 + uTime * 0.05));
  float light = 0.5 + uCaustics * (0.26 * web + focus);
  vec3 floorLit = fl.rgb * light * vec3(0.92, 0.97, 1.0);

  // Beer–Lambert absorption along the refracted path and the incoming light path.
  float path = t + d1 / max(L.y, 0.3);
  vec3 trans = exp(-vec3(2.3, 1.15, 0.78) * path);
  vec3 scatter = vec3(0.0035, 0.0085, 0.0135);
  vec3 under = floorLit * trans + scatter * (1.0 - trans);

  // Shadows of held pebbles on the water.
  float shade = 1.0;
  for (int i = 0; i < MAX_SHADOWS; i++) {
    if (i >= uShadowCount) break;
    vec4 s = uShadows[i];
    float d = length(xz - s.xy);
    shade -= s.w * (1.0 - smoothstep(s.z * 0.3, s.z, d));
  }
  under *= clamp(shade, 0.35, 1.0);

  vec3 color = mix(under, env, fresnel);

  // Moon glitter: ripples tilt facets towards the moon and break its reflection into glints.
  vec3 Hm = normalize(uMoonDir + V);
  float nh = max(dot(n, Hm), 0.0);
  color += vec3(0.85, 0.9, 0.95) * pow(nh, 6000.0) * 0.5;
  // Wave crests catching the soft key light.
  vec3 Hk = normalize(L + V);
  color += vec3(0.55, 0.62, 0.70) * pow(max(dot(n, Hk), 0.0), 300.0) * 0.25;

  // Subtle glow where tracked fingertips hover over the water.
  for (int i = 0; i < MAX_CURSORS; i++) {
    if (i >= uCursorCount) break;
    vec4 c = uCursors[i];
    float d = length(xz - c.xy);
    float ring = exp(-pow((d - c.z) / (c.z * 0.35), 2.0));
    color += vec3(0.40, 0.48, 0.56) * ring * c.w * 0.06;
  }

  // Cinematic vignette, tone mapping and dithering against banding.
  vec2 sp = gl_FragCoord.xy / uResolution;
  float vig = smoothstep(1.05, 0.25, length((sp - 0.5) * vec2(1.1, 1.25)));
  color *= mix(0.55, 1.0, vig);
  color = acesFilm(color * uExposure);
  color = pow(color, vec3(1.0 / 2.2));
  color += (hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0;
  gl_FragColor = vec4(color, 1.0);
}
