// Resamples one simulation state into another (used when the grid is resized),
// so a change of quality or window size never wipes the existing waves.
uniform sampler2D uSource;
varying vec2 vUv;

void main() {
  gl_FragColor = vec4(texture(uSource, vUv).rg, 0.0, 1.0);
}
