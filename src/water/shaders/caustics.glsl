// Procedural caustic web (after Dave Hoskins' tileable water caustic). Period: 1 world unit.
float causticPattern(vec2 p, float time) {
  vec2 q = mod(p * 6.2831853, 6.2831853) - 250.0;
  vec2 i = q;
  float c = 1.0;
  const float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = q + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(q.x / (sin(i.x + t) / inten), q.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
