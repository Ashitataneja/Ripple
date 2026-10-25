// Displaces the subdivided water plane by the simulated height field.
uniform sampler2D uHeight;
uniform float uHeightScale;

varying vec3 vWorld;
varying vec2 vUv;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec2 suv = worldToUv(world.xz);
  float h = textureLod(uHeight, suv, 0.0).r;
  world.y += h * uHeightScale;
  vWorld = world.xyz;
  vUv = suv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
