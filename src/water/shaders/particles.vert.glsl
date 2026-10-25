// Splash droplets (above the surface) and bubbles (below it).
attribute float aSize;
attribute float aAlpha;
attribute float aType; // 0 = droplet, 1 = bubble

uniform float uPixelScale;

varying float vAlpha;
varying float vType;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPixelScale / max(0.1, -mv.z), 0.0, 48.0);
  vAlpha = aAlpha;
  vType = aType;
  gl_Position = projectionMatrix * mv;
}
