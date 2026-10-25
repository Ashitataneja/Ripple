// A wet river pebble. Once submerged it takes on the water's absorption and fades with depth.
uniform vec3 uLightDir;
uniform vec3 uMoonDir;
uniform vec3 uTint;
uniform float uSubmerge; // 0 = in air, 1 = fully under water
uniform float uOpacity;
uniform float uSeed;

varying vec3 vNormalW;
varying vec3 vWorld;
varying vec3 vLocal;

float h13(vec3 p) {
  p = fract(p * 0.3183099 + 0.1 + uSeed);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float n3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

void main() {
  vec3 n = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorld);
  float mottle = n3(vLocal * 3.0) * 0.6 + n3(vLocal * 9.0) * 0.3 + n3(vLocal * 30.0) * 0.1;
  vec3 albedo = uTint * (0.7 + 0.6 * mottle);
  vec3 L = normalize(uLightDir);
  float diff = max(dot(n, L), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 color = albedo * (0.18 * sky + 0.55 * diff);
  vec3 H = normalize(normalize(uMoonDir) + V);
  color += vec3(0.75, 0.8, 0.85) * pow(max(dot(n, H), 0.0), 90.0) * 0.6 * (1.0 - uSubmerge);
  color += vec3(0.3, 0.35, 0.4) * pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.08;

  vec3 waterTint = vec3(0.012, 0.03, 0.042);
  color = mix(color, color * vec3(0.35, 0.6, 0.75) + waterTint, uSubmerge);

  color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
  gl_FragColor = vec4(pow(color, vec3(1.0 / 2.2)), uOpacity);
}
