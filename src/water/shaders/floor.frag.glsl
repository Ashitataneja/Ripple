// Bakes a tileable pond floor: silt, gravel, pebbles and a few larger rocks.
// Rendered once into a texture. RGB = sqrt(lit albedo) (perceptual 8-bit encoding), A = relief height.
// Every noise function is periodic over the tile so the texture repeats without seams.
uniform float uSeed;
uniform vec2 uResolution;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.0173);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + uSeed * 0.0137);
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float pnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, period));
  float b = hash12(mod(i + vec2(1.0, 0.0), period));
  float c = hash12(mod(i + vec2(0.0, 1.0), period));
  float d = hash12(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float pfbm(vec2 uv, float period) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * pnoise(uv * period, period);
    period *= 2.0;
    a *= 0.5;
  }
  return s / 0.96875;
}

// One layer of scattered stones on a periodic grid of `cells` × `cells`.
// Returns the stone dome height (uv units, 0 if no stone) and that stone's random signature.
float stoneLayer(vec2 uv, float cells, float rMin, float rMax, float presence, float seed, float flatness, out vec4 sig) {
  vec2 p = uv * cells;
  vec2 ip = floor(p);
  vec2 fp = fract(p);
  float best = 0.0;
  sig = vec4(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(ip + g, cells) + seed * 17.0;
      vec3 r = hash32(cell);
      if (r.z > presence) continue;
      vec3 r2 = hash32(cell + 41.7);
      vec2 center = g + 0.25 + 0.5 * r2.xy;
      vec2 d = fp - center;
      float ang = r.x * 6.2831853;
      float ca = cos(ang), sa = sin(ang);
      d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
      float rad = mix(rMin, rMax, r.y);
      d.y /= mix(0.55, 0.95, r2.z);
      float a = atan(d.y, d.x);
      float wob = 1.0 + 0.07 * sin(a * 3.0 + r.x * 23.0) + 0.04 * sin(a * 5.0 + r.y * 17.0) + 0.025 * sin(a * 9.0 + r2.x * 11.0);
      float q = length(d) / (rad * wob);
      if (q < 1.0) {
        float h = pow(1.0 - q * q, 0.6) * rad / cells * flatness;
        if (h > best) {
          best = h;
          sig = vec4(r.x, r.y, r2.z, hash12(cell + 9.3));
        }
      }
    }
  }
  return best;
}

vec3 stoneColor(vec4 sig, vec2 uv) {
  vec3 slate = vec3(0.105, 0.112, 0.120);
  vec3 blue = vec3(0.088, 0.098, 0.112);
  vec3 warm = vec3(0.132, 0.122, 0.108);
  vec3 dark = vec3(0.050, 0.054, 0.058);
  vec3 pale = vec3(0.190, 0.186, 0.176);
  vec3 rust = vec3(0.118, 0.094, 0.076);
  float k = sig.w;
  vec3 c = k < 0.28 ? slate : k < 0.46 ? blue : k < 0.66 ? dark : k < 0.84 ? warm : k < 0.93 ? rust : pale;
  c *= 0.8 + 0.4 * sig.x;
  // Mottling, quartz veins and fine speckle.
  float m = pfbm(uv + sig.xy * 7.0, 64.0);
  c *= 0.8 + 0.4 * m;
  float vein = smoothstep(0.012, 0.0, abs(pnoise((uv + sig.yz) * 96.0, 96.0) - 0.5)) * step(0.72, sig.z);
  c = mix(c, c * 1.7 + 0.015, vein * 0.3);
  float speck = step(0.94, hash12(floor(uv * uResolution * 0.5) + sig.xy * 100.0));
  c *= 1.0 + speck * 0.2;
  return c;
}

vec3 siltColor(vec2 uv) {
  float s = pfbm(uv, 8.0);
  vec3 c = mix(vec3(0.050, 0.050, 0.047), vec3(0.092, 0.088, 0.078), s);
  c *= 0.85 + 0.3 * pnoise(uv * 512.0, 512.0);
  // Faint organic sediment and algae.
  c = mix(c, vec3(0.036, 0.046, 0.038), smoothstep(0.5, 0.8, pfbm(uv + 3.7, 4.0)) * 0.55);
  return c;
}

// Floor height (and colour when wanted) at uv. Stones gather in beds; elsewhere there is bare silt.
float floorField(vec2 uv, bool wantColor, out vec3 color) {
  float silt = 0.0022 * pfbm(uv, 12.0) + 0.0010 * pfbm(uv, 96.0);
  float h = silt;
  color = vec3(0.0);
  float bed = smoothstep(0.38, 0.7, pfbm(uv + 1.3, 3.0));
  vec3 base = wantColor ? siltColor(uv) : vec3(0.0);
  if (wantColor) color = base;

  vec4 sig;
  float g = stoneLayer(uv, 56.0, 0.2, 0.4, 0.15 + 0.6 * bed, 1.0, 0.45, sig);
  if (g > h) { h = g; if (wantColor) color = mix(stoneColor(sig, uv) * 0.85, base, 0.25); }
  float m = stoneLayer(uv, 18.0, 0.24, 0.44, 0.08 + 0.5 * bed, 2.0, 0.42, sig);
  if (m > h) { h = m; if (wantColor) color = mix(stoneColor(sig, uv), base, 0.18 + 0.2 * (1.0 - bed)); }
  float l = stoneLayer(uv, 5.0, 0.22, 0.4, 0.32, 3.0, 0.32, sig);
  if (l > h) { h = l; if (wantColor) color = mix(stoneColor(sig, uv) * 1.05, base, 0.12); }
  return h;
}

void main() {
  vec2 uv = vUv;
  vec3 albedo;
  float h = floorField(uv, true, albedo);

  vec3 dummy;
  vec2 e = 1.0 / uResolution;
  float hx = floorField(uv + vec2(e.x, 0.0), false, dummy);
  float hy = floorField(uv + vec2(0.0, e.y), false, dummy);
  vec3 n = normalize(vec3(-(hx - h) / e.x, 1.0, -(hy - h) / e.y));

  // Soft ambient occlusion from the surrounding relief: stones sit in, not on, the silt.
  float occ = 0.0;
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 1.0472 + 0.3;
    float rr = (i < 3 ? 6.0 : 14.0) * e.x;
    occ += max(0.0, floorField(uv + vec2(cos(a), sin(a)) * rr, false, dummy) - h);
  }
  float ao = clamp(1.0 - occ * 28.0, 0.55, 1.0);

  vec3 L = normalize(vec3(-0.35, 0.85, 0.40));
  float diff = 0.62 + 0.38 * max(dot(n, L), 0.0);
  vec3 lit = albedo * diff * ao;

  gl_FragColor = vec4(sqrt(max(lit, 0.0)), clamp(h / 0.05, 0.0, 1.0));
}
