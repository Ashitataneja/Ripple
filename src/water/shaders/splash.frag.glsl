// Droplets: bright wet beads with a small specular core. Bubbles: faint rings.
varying float vAlpha;
varying float vType;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0 || vAlpha <= 0.001) discard;
  vec3 color;
  float a;
  if (vType < 0.5) {
    float body = smoothstep(1.0, 0.55, r);
    float core = smoothstep(0.45, 0.0, length(p - vec2(-0.25, 0.3)));
    color = vec3(0.28, 0.33, 0.38) * body + vec3(0.9, 0.95, 1.0) * core;
    a = max(body * 0.55, core);
  } else {
    float ring = smoothstep(0.55, 0.8, r) * smoothstep(1.0, 0.85, r);
    float glint = smoothstep(0.35, 0.0, length(p - vec2(-0.35, 0.35)));
    color = vec3(0.35, 0.42, 0.48) * ring + vec3(0.6, 0.68, 0.75) * glint;
    a = ring * 0.6 + glint * 0.5;
  }
  gl_FragColor = vec4(color, a * vAlpha);
}
