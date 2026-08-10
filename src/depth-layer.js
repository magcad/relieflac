// Couche MapLibre personnalisée qui colorise les fonds.
//
// La grille d'altitude est envoyée une fois au GPU ; la profondeur et la couleur sont
// recalculées à chaque image dans le fragment shader. Changer de cote, de préréglage ou
// de tirant d'eau ne coûte donc qu'une mise à jour d'uniforme — rien n'est retéléchargé
// ni recalculé côté processeur.
//
// Le filtrage de la texture d'altitude est en NEAREST : interpoler des octets encodés
// en Terrain-RGB donnerait des altitudes absurdes.

import { MAX_BANDS } from './palette.js';

const EARTH_CIRCUMFERENCE = 40075016.685578488;
const ORIGIN_SHIFT = EARTH_CIRCUMFERENCE / 2;

/** EPSG:3857 → coordonnées mercator [0,1] attendues par la matrice de MapLibre. */
function toUnitMercator(x, y) {
  return [(x + ORIGIN_SHIFT) / EARTH_CIRCUMFERENCE, (ORIGIN_SHIFT - y) / EARTH_CIRCUMFERENCE];
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform mat4 u_matrix;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_bed;
uniform sampler2D u_lut;
uniform vec2 u_texel;
uniform float u_base;
uniform float u_interval;
uniform float u_level;
uniform float u_offset;
uniform float u_waterPlane;
uniform float u_lutMax;
uniform float u_safe;
uniform float u_opacity;
uniform vec4 u_emerged;
uniform vec4 u_outline;
uniform vec4 u_safetyColor;
uniform int u_bandCount;
uniform float u_bands[${MAX_BANDS}];
uniform bool u_showOutlines;
uniform bool u_showSafety;

in vec2 v_uv;
out vec4 fragColor;

// Profondeur d'eau au texel visé. Le décalage d'étalonnage ne s'applique qu'aux
// altitudes issues du levé de 2009 : au-dessus du plan d'eau LiDAR, la grille vient
// du MNT ou de la contrainte de bord et ce sont des altitudes absolues.
float depthAt(vec2 uv, out bool inside) {
  vec4 t = texture(u_bed, uv);
  inside = t.a > 0.5;
  float raw = u_base + (t.r * 255.0 * 65536.0 + t.g * 255.0 * 256.0 + t.b * 255.0) * u_interval;
  float z = raw < u_waterPlane ? raw + u_offset : raw;
  return u_level - z;
}

// -2 hors du lac · -1 émergé · sinon indice de bande
int classify(float depth, bool inside) {
  if (!inside) return -2;
  if (depth <= 0.0) return -1;
  for (int i = 0; i < ${MAX_BANDS}; i++) {
    if (i >= u_bandCount) break;
    if (depth <= u_bands[i]) return i;
  }
  return max(u_bandCount - 1, 0);
}

void main() {
  bool inside;
  float depth = depthAt(v_uv, inside);
  if (!inside) { fragColor = vec4(0.0); return; }

  vec4 colour = depth <= 0.0
    ? u_emerged
    : texture(u_lut, vec2(clamp(depth / u_lutMax, 0.0, 1.0), 0.5));

  vec2 offsets[4] = vec2[4](
    vec2(u_texel.x, 0.0), vec2(-u_texel.x, 0.0),
    vec2(0.0, u_texel.y), vec2(0.0, -u_texel.y)
  );

  // Contour de bande : l'œil lit un bord, pas un dégradé. C'est ce qui rend les
  // paliers de profondeur lisibles d'un coup d'œil.
  if (u_showOutlines && u_bandCount > 0) {
    int here = classify(depth, true);
    for (int i = 0; i < 4; i++) {
      bool near;
      int there = classify(depthAt(v_uv + offsets[i], near), near);
      if (there != here) { colour = u_outline; break; }
    }
  }

  // Contour de sécurité : limite *interne* de la zone peu profonde, jamais le rivage.
  // Tracé depuis le côté profond, il sépare vraiment le navigable du reste.
  if (u_showSafety && depth > u_safe) {
    bool found = false;
    for (int i = 0; i < 4 && !found; i++) {
      for (int step = 1; step <= 2; step++) {
        bool near;
        float d = depthAt(v_uv + offsets[i] * float(step), near);
        if (near && d > 0.0 && d <= u_safe) { found = true; break; }
      }
    }
    if (found) colour = u_safetyColor;
  }

  fragColor = vec4(colour.rgb, colour.a * u_opacity);
}`;

function compile(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader ${label} : ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

const UNIFORMS = [
  'u_matrix', 'u_bed', 'u_lut', 'u_texel', 'u_base', 'u_interval', 'u_level',
  'u_offset', 'u_waterPlane', 'u_lutMax', 'u_safe', 'u_opacity', 'u_emerged',
  'u_outline', 'u_safetyColor', 'u_bandCount', 'u_bands', 'u_showOutlines', 'u_showSafety',
];

export class DepthLayer {
  constructor(bed, style) {
    this.id = 'profondeurs';
    this.type = 'custom';
    this.renderingMode = '2d';
    this.bed = bed;
    this.style = style; // voir setStyle()
    this.ready = false;
  }

  /**
   * @param {object} style
   *   level, offset, waterPlane, lutMax, safe, opacity : nombres
   *   emerged, outline, safetyColor : vec4
   *   bands : tableau de bornes supérieures
   *   showOutlines, showSafety : booléens
   *   lut : Uint8Array de 1024 octets
   */
  setStyle(style) {
    this.style = { ...this.style, ...style };
    if (this.ready && style.lut) this.#uploadLut();
    this.map?.triggerRepaint();
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER, 'sommet'));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER, 'fragment'));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`liaison du programme : ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;

    this.attributes = {
      pos: gl.getAttribLocation(program, 'a_pos'),
      uv: gl.getAttribLocation(program, 'a_uv'),
    };
    this.locations = Object.fromEntries(
      UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]),
    );

    // Rectangle de l'emprise de la grille, en mercator unitaire. Ligne 0 de l'image
    // = bord nord, d'où v = 0 en haut.
    const [ax, ay] = toUnitMercator(this.bed.x0, this.bed.y1);
    const [bx, by] = toUnitMercator(this.bed.x1, this.bed.y0);
    const vertices = new Float32Array([
      ax, ay, 0, 0,
      bx, ay, 1, 0,
      ax, by, 0, 1,
      bx, by, 1, 1,
    ]);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    this.bedTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bedTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.bed.bitmap);

    this.lutTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.ready = true;
    this.#uploadLut();
  }

  #uploadLut() {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.style.lut);
  }

  render(gl, options) {
    if (!this.ready) return;
    const matrix = options.defaultProjectionData.mainMatrix;
    const s = this.style;
    const u = this.locations;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.u_matrix, false, matrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bedTexture);
    gl.uniform1i(u.u_bed, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(u.u_lut, 1);

    gl.uniform2f(u.u_texel, 1 / this.bed.width, 1 / this.bed.height);
    gl.uniform1f(u.u_base, this.bed.meta.encoding.base);
    gl.uniform1f(u.u_interval, this.bed.meta.encoding.interval);
    gl.uniform1f(u.u_level, s.level);
    gl.uniform1f(u.u_offset, s.offset);
    gl.uniform1f(u.u_waterPlane, s.waterPlane);
    gl.uniform1f(u.u_lutMax, s.lutMax);
    gl.uniform1f(u.u_safe, s.safe);
    gl.uniform1f(u.u_opacity, s.opacity);
    gl.uniform4fv(u.u_emerged, s.emerged);
    gl.uniform4fv(u.u_outline, s.outline);
    gl.uniform4fv(u.u_safetyColor, s.safetyColor);

    const bands = new Float32Array(MAX_BANDS);
    s.bands.slice(0, MAX_BANDS).forEach((limit, i) => { bands[i] = limit; });
    gl.uniform1fv(u.u_bands, bands);
    gl.uniform1i(u.u_bandCount, Math.min(s.bands.length, MAX_BANDS));
    gl.uniform1i(u.u_showOutlines, s.showOutlines ? 1 : 0);
    gl.uniform1i(u.u_showSafety, s.showSafety ? 1 : 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.attributes.pos);
    gl.vertexAttribPointer(this.attributes.pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.attributes.uv);
    gl.vertexAttribPointer(this.attributes.uv, 2, gl.FLOAT, false, 16, 8);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  onRemove(map, gl) {
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.buffer);
    gl.deleteTexture(this.bedTexture);
    gl.deleteTexture(this.lutTexture);
    this.ready = false;
  }
}
