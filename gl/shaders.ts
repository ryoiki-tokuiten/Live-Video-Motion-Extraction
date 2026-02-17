export const vertexShaderSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0, 1);
  v_texCoord = a_texCoord;
}
`;

// ─────────────────────────────────────────────────────────────
// Background Subtraction — outputs a SOFT mask via smoothstep
// ─────────────────────────────────────────────────────────────
export const backgroundSubtractionFragmentSource = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform sampler2D u_backgroundMean;
uniform sampler2D u_backgroundVariance;

uniform float u_adaptationRate;
uniform float u_threshold;
uniform bool u_isColorMode;
uniform float u_minVariance;

in vec2 v_texCoord;

layout(location = 0) out vec4 o_newMean;
layout(location = 1) out vec4 o_newVariance;
layout(location = 2) out vec4 o_motionMask;

void main() {
  vec4 current = texture(u_image, v_texCoord);
  vec4 mean    = texture(u_backgroundMean, v_texCoord);
  vec4 variance = texture(u_backgroundVariance, v_texCoord);

  float dist = 0.0;
  float var  = 0.0;

  if (u_isColorMode) {
    vec3 diff = current.rgb - mean.rgb;
    dist = length(diff);
    var  = max(variance.r, u_minVariance);
  } else {
    float curLum  = dot(current.rgb, vec3(0.299, 0.587, 0.114));
    float meanLum = mean.r;
    dist = abs(curLum - meanLum);
    var  = max(variance.r, u_minVariance);
  }

  // ── Soft mask with smoothstep (anti-aliased edge) ──
  float edge   = u_threshold * sqrt(var);
  float soft   = smoothstep(edge * 0.6, edge * 1.4, dist);
  // soft is 0.0 = background, 1.0 = definite motion, smooth transition in between

  // ── Update background model only for background pixels ──
  vec4 newMean     = mean;
  vec4 newVariance = variance;

  float bgWeight = 1.0 - soft; // How "background-ish" this pixel is
  float alpha    = u_adaptationRate * bgWeight; // Only adapt background regions

  if (u_isColorMode) {
    newMean = mix(mean, current, alpha);
    float lumDiff = dot(current.rgb, vec3(0.333)) - dot(mean.rgb, vec3(0.333));
    newVariance.r = mix(variance.r, lumDiff * lumDiff, alpha);
  } else {
    float curLum = dot(current.rgb, vec3(0.299, 0.587, 0.114));
    newMean.r    = mix(mean.r, curLum, alpha);
    float d      = curLum - newMean.r;
    newVariance.r = mix(variance.r, d * d, alpha);
  }

  o_newMean     = vec4(newMean.rgb, 1.0);
  o_newVariance = vec4(newVariance.rgb, 1.0);
  o_motionMask  = vec4(soft, soft, soft, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────
// Morphology — Erosion / Dilation on soft mask
// ─────────────────────────────────────────────────────────────
export const morphologyFragmentSource = `#version 300 es
precision highp float;

uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform int u_type; // 0 = erode, 1 = dilate

in vec2 v_texCoord;
out vec4 o_color;

void main() {
  vec2 px = 1.0 / u_resolution;
  float val = texture(u_image, v_texCoord).r;

  for (int i = -1; i <= 1; i++) {
    for (int j = -1; j <= 1; j++) {
      float n = texture(u_image, v_texCoord + vec2(float(i), float(j)) * px).r;
      if (u_type == 0) val = min(val, n);
      else             val = max(val, n);
    }
  }

  o_color = vec4(vec3(val), 1.0);
}
`;

// ─────────────────────────────────────────────────────────────
// Output — All visual effects, properly composited
// ─────────────────────────────────────────────────────────────
export const outputFragmentSource = `#version 300 es
precision highp float;

uniform sampler2D u_video;
uniform sampler2D u_mask;
uniform int  u_effect;   // 0=classic, 1=colorBurn, 2=trails, 3=heatmap, 4=chromatic
uniform bool u_invert;
uniform vec2 u_resolution;

in vec2 v_texCoord;
out vec4 o_color;

// ── Utility: 5-stop heatmap palette ──
vec3 heatPalette(float t) {
  t = clamp(t, 0.0, 1.0);
  // Dark → Deep Blue → Cyan → Green/Yellow → Orange → White-hot
  vec3 a = vec3(0.0, 0.0, 0.15);
  vec3 b = vec3(0.0, 0.3, 1.0);
  vec3 c = vec3(0.0, 1.0, 0.6);
  vec3 d = vec3(1.0, 0.8, 0.0);
  vec3 e = vec3(1.0, 0.2, 0.05);
  vec3 f = vec3(1.0, 1.0, 0.9);

  if (t < 0.2) return mix(a, b, t / 0.2);
  if (t < 0.4) return mix(b, c, (t - 0.2) / 0.2);
  if (t < 0.6) return mix(c, d, (t - 0.4) / 0.2);
  if (t < 0.8) return mix(d, e, (t - 0.6) / 0.2);
  return mix(e, f, (t - 0.8) / 0.2);
}

// ── Utility: Soft glow around motion edges ──
float edgeGlow(float mask, float radius) {
  // Approximate glow by sampling neighbors
  vec2 px = radius / u_resolution;
  float sum = 0.0;
  sum += texture(u_mask, v_texCoord + vec2(-px.x, 0.0)).r;
  sum += texture(u_mask, v_texCoord + vec2( px.x, 0.0)).r;
  sum += texture(u_mask, v_texCoord + vec2(0.0, -px.y)).r;
  sum += texture(u_mask, v_texCoord + vec2(0.0,  px.y)).r;
  sum += texture(u_mask, v_texCoord + vec2(-px.x, -px.y)).r;
  sum += texture(u_mask, v_texCoord + vec2( px.x, -px.y)).r;
  sum += texture(u_mask, v_texCoord + vec2(-px.x,  px.y)).r;
  sum += texture(u_mask, v_texCoord + vec2( px.x,  px.y)).r;
  float avg = sum / 8.0;
  // Glow is strongest at edges (where avg differs from center)
  return smoothstep(0.0, 0.5, avg) * (1.0 - mask * 0.5);
}

void main() {
  vec4  video = texture(u_video, v_texCoord);
  float mask  = texture(u_mask, v_texCoord).r;
  
  if (u_invert) mask = 1.0 - mask;

  vec3 result = vec3(0.0);

  // ════════════════════════════════════════════════════════════
  // CLASSIC — Pure motion extraction (video colors on black)
  // ════════════════════════════════════════════════════════════
  if (u_effect == 0) {
    result = video.rgb * mask;
  }

  // ════════════════════════════════════════════════════════════
  // COLOR BURN — Neon edge glow + video composite 
  // ════════════════════════════════════════════════════════════
  else if (u_effect == 1) {
    vec3 neonCyan   = vec3(0.0, 0.95, 0.85);
    vec3 neonPurple = vec3(0.6, 0.1, 0.95);
    
    // Edge detection from mask gradient
    float glow = edgeGlow(mask, 2.0);
    
    // Mix cyan/purple based on vertical position for visual interest
    vec3 edgeColor = mix(neonCyan, neonPurple, v_texCoord.y * 0.8 + 0.1);
    
    // Compose: dark background + video in motion areas + neon edge glow
    vec3 base = video.rgb * mask * 0.85;
    vec3 glowLayer = edgeColor * glow * 1.5;
    
    result = base + glowLayer;
    
    // Subtle vignette for cinematic feel
    float vig = 1.0 - smoothstep(0.3, 0.9, length(v_texCoord - 0.5) * 1.2);
    result *= mix(0.7, 1.0, vig);
  }

  // ════════════════════════════════════════════════════════════
  // ELECTRIC TRAILS — Persistence + glow (blending handled by engine)
  // ════════════════════════════════════════════════════════════
  else if (u_effect == 2) {
    vec3 trailColor = vec3(0.1, 0.6, 1.0); // Electric blue base
    vec3 hotColor   = vec3(1.0, 0.9, 0.7); // White-hot core
    
    // Core: video color where mask is strong
    vec3 core = mix(trailColor, hotColor, mask * mask) * mask;
    
    // Outer glow
    float glow = edgeGlow(mask, 3.0);
    vec3 glowColor = trailColor * glow * 0.8;
    
    result = core + glowColor;
  }

  // ════════════════════════════════════════════════════════════
  // MOTION HEATMAP — Accumulated heat visualization
  // ════════════════════════════════════════════════════════════
  else if (u_effect == 3) {
    vec3 heat = heatPalette(mask);
    
    // Add subtle glow for high-intensity areas
    float glow = edgeGlow(mask, 2.5);
    heat += vec3(1.0, 0.5, 0.1) * glow * 0.4;
    
    // Darken background, keep heat vivid
    float bgDim = smoothstep(0.0, 0.05, mask);
    result = mix(vec3(0.02, 0.01, 0.05), heat, bgDim);
  }

  // ════════════════════════════════════════════════════════════
  // CHROMATIC ABERRATION — RGB channel split on motion
  // ════════════════════════════════════════════════════════════
  else if (u_effect == 4) {
    // Shift amount scales with motion intensity
    float shift = mask * 0.015;
    
    // Directional shift based on position relative to center
    vec2 dir = normalize(v_texCoord - 0.5 + 0.001);
    
    float r = texture(u_video, v_texCoord + dir * shift).r;
    float g = video.g;
    float b = texture(u_video, v_texCoord - dir * shift).b;
    
    vec3 aberrated = vec3(r, g, b);
    
    // Blend: show full video with aberration overlay in motion areas
    result = mix(video.rgb, aberrated, smoothstep(0.05, 0.3, mask));
    
    // Subtle scanline effect in motion areas for style
    float scanline = sin(v_texCoord.y * u_resolution.y * 1.5) * 0.5 + 0.5;
    result -= vec3(0.03) * scanline * mask;
  }

  o_color = vec4(result, mask);
}
`;
