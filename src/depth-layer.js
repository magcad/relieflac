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

/**
 * Matrice de MapLibre ramenée à une origine locale, en simple précision.
 *
 * Sans cela, la carte des fonds tremble dès que la carte tourne — alors que les sondes,
 * couche MapLibre native, restent parfaitement fixes. La raison est une annulation
 * catastrophique dans le vertex shader. Nos sommets étaient en mercator absolu (~0,505) et
 * la matrice, au zoom de navigation, porte des coefficients énormes : le shader calculait
 *
 *     277 414 379 × 0,5052  −  140 156 818  =  −8 627
 *
 * soit une différence de 8,6×10³ obtenue en soustrayant deux nombres de 1,4×10⁸. En float32
 * l'ULP y vaut 16, ce qui, divisé par w ≈ 1545, donne 0,010 NDC — environ **cinq pixels**
 * d'erreur, qui changent à chaque image puisque la matrice change. D'où le sautillement.
 *
 * On décale donc l'origine : les sommets deviennent de petits écarts au centre de la grille
 * (~2×10⁻⁴), et la translation correspondante est recalculée ici en double précision, que
 * MapLibre nous fournit bien (`mainMatrix` est un Float64Array — vérifié, ne pas le
 * supposer). Les grands coefficients ne multiplient plus qu'un écart minuscule : l'erreur
 * résiduelle tombe sous le centième de pixel.
 *
 * `M' = M · T(origine)` : seule la quatrième colonne change, les trois autres étant
 * inchangées par une translation.
 */
export function anchoredMatrix(matrix, anchorX, anchorY, out) {
  for (let i = 0; i < 12; i += 1) out[i] = matrix[i];
  // Sommes évaluées en double précision — c'est tout l'intérêt — puis arrondies une seule
  // fois à l'écriture dans `out`, qui est en simple précision.
  out[12] = matrix[0] * anchorX + matrix[4] * anchorY + matrix[12];
  out[13] = matrix[1] * anchorX + matrix[5] * anchorY + matrix[13];
  out[14] = matrix[2] * anchorX + matrix[6] * anchorY + matrix[14];
  out[15] = matrix[3] * anchorX + matrix[7] * anchorY + matrix[15];
  return out;
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
uniform sampler2D u_coverage;
uniform vec2 u_texSize;
uniform float u_voidRadius;
uniform bool u_showVoids;
uniform bool u_hasCoverage;
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
uniform vec4 u_bandColors[${MAX_BANDS}];
uniform bool u_showOutlines;
uniform bool u_showSafety;

in vec2 v_uv;
out vec4 fragColor;

// Altitude d'un texel. Le décalage d'étalonnage ne s'applique qu'aux altitudes issues
// du levé de 2009 : au-dessus du plan d'eau LiDAR, la grille vient du MNT ou de la
// contrainte de bord, et ce sont des altitudes absolues.
float decode(vec4 t) {
  float raw = u_base + (t.r * 255.0 * 65536.0 + t.g * 255.0 * 256.0 + t.b * 255.0) * u_interval;
  return raw < u_waterPlane ? raw + u_offset : raw;
}

// Altitude interpolée bilinéairement, à partir des altitudes *décodées*.
//
// L'échantillonnage matériel est en NEAREST et doit le rester : interpoler les octets
// d'un encodage Terrain-RGB donnerait des altitudes absurdes. On décode donc les quatre
// texels voisins avant de les mélanger — d'où un champ de profondeur continu, sans les
// carrés de 5 m qui rendaient la carte illisible au zoom de navigation.
//
// La pondération exclut les texels hors du lac : sans cela, le fond se mettrait à
// plonger le long des rives en se mélangeant à des cellules sans donnée. Le paramètre
// de sortie vaut la somme des poids retenus, ce qui antialiase le bord au passage.
float bedAltitude(vec2 uv, out float coverage) {
  vec2 pos = uv * u_texSize - 0.5;
  vec2 base = floor(pos);
  vec2 f = pos - base;

  float weights[4] = float[4](
    (1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y),
    (1.0 - f.x) * f.y,         f.x * f.y
  );
  vec2 corners[4] = vec2[4](vec2(0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(1.0));

  float sum = 0.0;
  float total = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 t = texture(u_bed, (base + corners[i] + 0.5) / u_texSize);
    float w = weights[i] * step(0.5, t.a);
    sum += decode(t) * w;
    total += w;
  }
  coverage = total;
  return total > 0.001 ? sum / total : 0.0;
}

// Trait d'épaisseur constante à l'écran, quel que soit le zoom.
//
// fwidth(value) donne la variation de la profondeur d'un pixel écran au suivant :
// diviser l'écart au seuil par cette pente convertit une distance en mètres d'eau en
// une distance en pixels. C'est ce qui remplace le contour vectoriel — le trait reste
// fin et net en zoomant, au lieu de s'épaissir avec les cellules de la grille.
float contourLine(float value, float target, float widthPx) {
  float slope = max(fwidth(value), 1e-7);
  float distancePx = abs(value - target) / slope;
  return 1.0 - smoothstep(widthPx * 0.5 - 0.5, widthPx * 0.5 + 0.5, distancePx);
}

void main() {
  float coverage;
  float bed = bedAltitude(v_uv, coverage);
  if (coverage <= 0.001) { fragColor = vec4(0.0); return; }
  float depth = u_level - bed;

  // Les dérivées doivent être évaluées hors de tout branchement.
  float slopePx = max(fwidth(depth), 1e-7);

  vec4 colour;
  if (u_bandCount > 0) {
    // Choix analytique de la bande : les aplats et les traits partagent exactement les
    // mêmes bornes, sans le décalage qu'introduirait la quantification de la table.
    colour = u_bandColors[u_bandCount - 1];
    for (int i = 0; i < ${MAX_BANDS}; i++) {
      if (i >= u_bandCount) break;
      if (depth <= u_bands[i]) { colour = u_bandColors[i]; break; }
    }
  } else {
    colour = texture(u_lut, vec2(clamp(depth / u_lutMax, 0.0, 1.0), 0.5));
  }
  if (depth <= 0.0) colour = u_emerged;

  if (u_showOutlines) {
    // Trait de rive à la limite d'eau, puis un trait par palier de profondeur.
    float line = contourLine(depth, 0.0, 1.6);
    for (int i = 0; i < ${MAX_BANDS}; i++) {
      if (i >= u_bandCount - 1) break;
      line = max(line, contourLine(depth, u_bands[i], 1.2));
    }
    colour = mix(colour, u_outline, line * u_outline.a);
  }

  // Contour de sécurité : tracé uniquement du côté profond, il marque la limite interne
  // de la zone peu profonde et non le rivage — où la profondeur passe de toute façon
  // sous le seuil, ce qui en ferait un simple liseré décoratif.
  if (u_showSafety && depth > 0.0) {
    colour = mix(colour, u_safetyColor, contourLine(depth, u_safe, 2.4) * u_safetyColor.a);
  }

  // Zones non sondées, hachurées à la manière des cartes marines.
  //
  // Le levé de 2009 suit des traces distantes de plus de 150 m dans les grands bassins.
  // Entre elles, la couleur affichée est une interpolation entre des sondes éloignées :
  // un haut-fond y est invisible et hérite de la profondeur des fosses voisines. Le
  // hachurage dit où le modèle cesse de reposer sur une mesure — il ne corrige rien,
  // mais il empêche de faire confiance à ce qui n'est pas mesuré.
  //
  // Les hachures sont calculées en coordonnées écran : leur pas reste constant quel que
  // soit le zoom, ce qui les distingue nettement du dessin des fonds.
  if (u_showVoids && u_hasCoverage) {
    float distance = texture(u_coverage, v_uv).r * 255.0;
    float strength = smoothstep(u_voidRadius, u_voidRadius * 2.5, distance);
    if (strength > 0.01) {
      // Voile magenta « carto » sur toute la zone non sondée : visible même à distance,
      // il signale d'un coup d'œil que le fond n'y est pas mesuré. Par-dessus, des
      // hachures blanches plus denses et plus contrastées qu'auparavant.
      vec3 caution = vec3(0.86, 0.16, 0.52);
      colour.rgb = mix(colour.rgb, caution, strength * 0.22);
      float stripe = fract((gl_FragCoord.x + gl_FragCoord.y) * 0.11);
      float hatch = 1.0 - smoothstep(0.22, 0.34, abs(stripe - 0.5) * 2.0);
      colour.rgb = mix(colour.rgb, vec3(1.0), hatch * strength * 0.8);
    }
  }

  fragColor = vec4(colour.rgb, colour.a * u_opacity * clamp(coverage, 0.0, 1.0));
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
  'u_matrix', 'u_bed', 'u_lut', 'u_coverage', 'u_texSize', 'u_base', 'u_interval',
  'u_level', 'u_offset', 'u_waterPlane', 'u_lutMax', 'u_safe', 'u_opacity', 'u_emerged',
  'u_outline', 'u_safetyColor', 'u_bandCount', 'u_bands', 'u_bandColors',
  'u_showOutlines', 'u_showSafety', 'u_voidRadius', 'u_showVoids', 'u_hasCoverage',
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
    //
    // Les sommets sont stockés **relativement au centre de la grille**, et non en mercator
    // absolu : voir `anchoredMatrix`, qui reprend la translation. En absolu, la simple
    // précision du tampon suffisait déjà à décaler chaque coin de près de deux mètres.
    const [ax, ay] = toUnitMercator(this.bed.x0, this.bed.y1);
    const [bx, by] = toUnitMercator(this.bed.x1, this.bed.y0);
    this.anchorX = (ax + bx) / 2;
    this.anchorY = (ay + by) / 2;
    this.matrix = new Float32Array(16);
    const vertices = new Float32Array([
      ax - this.anchorX, ay - this.anchorY, 0, 0,
      bx - this.anchorX, ay - this.anchorY, 1, 0,
      ax - this.anchorX, by - this.anchorY, 0, 1,
      bx - this.anchorX, by - this.anchorY, 1, 1,
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

    // La carte de couverture est linéaire : c'est une distance, pas un code.
    this.hasCoverage = Boolean(this.bed.coverageBitmap);
    if (this.hasCoverage) {
      this.coverageTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.coverageTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.bed.coverageBitmap);
    }

    this.ready = true;
    this.#uploadLut();
  }

  #uploadLut() {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.style.lut);
  }

  /**
   * Ré-encode la grille d'altitude de travail (2009 + corrections) en Terrain-RGB et la
   * renvoie au GPU. Appelée quand les relevés manuels changent : le shader recolore alors
   * la « carte courante » corrigée à n'importe quelle cote, sans autre traitement.
   */
  updateBed() {
    if (!this.ready) return;
    const { gl } = this;
    const { width, height, altitudes, alpha, meta } = this.bed;
    const { base, interval } = meta.encoding;
    const count = width * height;
    const buf = this._bedBuffer ?? (this._bedBuffer = new Uint8Array(count * 4));
    for (let i = 0; i < count; i += 1) {
      const o = i * 4;
      const a = alpha[i];
      if (!a || !Number.isFinite(altitudes[i])) { buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0; continue; }
      let v = Math.round((altitudes[i] - base) / interval);
      v = Math.max(0, Math.min(0xffffff, v));
      buf[o] = (v >> 16) & 255; buf[o + 1] = (v >> 8) & 255; buf[o + 2] = v & 255; buf[o + 3] = a;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.bedTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    this.#uploadCoverage();
    this.map?.triggerRepaint();
  }

  #uploadCoverage() {
    if (!this.hasCoverage || !this.bed.coverage) return;
    const { gl } = this;
    const { width, height, coverage } = this.bed;
    const count = width * height;
    const buf = this._covBuffer ?? (this._covBuffer = new Uint8Array(count * 4));
    for (let i = 0; i < count; i += 1) {
      const o = i * 4;
      buf[o] = buf[o + 1] = buf[o + 2] = coverage[i]; buf[o + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.coverageTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  }

  render(gl, options) {
    if (!this.ready) return;
    const s = this.style;
    const u = this.locations;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.u_matrix, false, anchoredMatrix(
      options.defaultProjectionData.mainMatrix, this.anchorX, this.anchorY, this.matrix,
    ));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bedTexture);
    gl.uniform1i(u.u_bed, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(u.u_lut, 1);

    if (this.hasCoverage) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.coverageTexture);
      gl.uniform1i(u.u_coverage, 2);
    }
    gl.uniform1i(u.u_hasCoverage, this.hasCoverage ? 1 : 0);
    gl.uniform1f(u.u_voidRadius, s.voidRadius ?? 60);
    gl.uniform1i(u.u_showVoids, s.showVoids ? 1 : 0);

    gl.uniform2f(u.u_texSize, this.bed.width, this.bed.height);
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

    const colours = new Float32Array(MAX_BANDS * 4);
    (s.bandColors ?? []).slice(0, MAX_BANDS).forEach((rgba, i) => colours.set(rgba, i * 4));
    gl.uniform4fv(u.u_bandColors, colours);

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

    // On rend l'état d'attributs à MapLibre : laisser ces tableaux activés et ce tampon lié
    // peut brouiller le tracé des couches dessinées juste au-dessus (sondes, trace, repères).
    gl.disableVertexAttribArray(this.attributes.pos);
    gl.disableVertexAttribArray(this.attributes.uv);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  onRemove(map, gl) {
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.buffer);
    gl.deleteTexture(this.bedTexture);
    gl.deleteTexture(this.lutTexture);
    if (this.coverageTexture) gl.deleteTexture(this.coverageTexture);
    this.ready = false;
  }
}
