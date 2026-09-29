// Sprite loading and character composition for the pixel office.
// Art: 2dPig "Pixel Office" (CC0) and JIK-A-4 "MetroCity" (CC0).

const V = '../../vendor/pixel/';
export const SRC = {
  office: V + 'office/x/PixelOfficeAssets.png',
  body: V + 'metrocity/MetroCity/CharacterModel/Character Model.png',
  shadow: V + 'metrocity/MetroCity/CharacterModel/Shadow.png',
  hairs: V + 'metrocity/MetroCity/Hair/Hairs.png',
  outfit: (n) => V + `metrocity/MetroCity/Outfits/Outfit${n}.png`,
  suit: V + 'metrocity/v2/MetroCity 2.0/Suit.png',
};

// Office sprites: [x, y, w, h] in PixelOfficeAssets.png (measured by bounds).
export const OFFICE = {
  chairOrange: [6, 41, 11, 22], chairYellow: [19, 41, 11, 22], chairGreen: [32, 41, 11, 22],
  chairBlue: [45, 41, 11, 22], chairWhite: [58, 41, 11, 22], chairGrey: [71, 41, 11, 22],
  tableSmall: [85, 47, 26, 16], tableLong: [115, 47, 40, 16],
  cubicle: [171, 44, 79, 17], deskYellowL: [188, 63, 17, 19], divider: [207, 63, 4, 27], deskYellowR: [213, 63, 17, 19],
  plant: [170, 65, 14, 19], sofaGrey: [119, 66, 33, 15], sofaBlue: [120, 83, 33, 16], sofaGreen: [120, 102, 33, 16], sofaOrange: [120, 121, 33, 16],
  floor: [3, 68, 73, 24], whiteboard: [84, 70, 26, 20], calendar: [234, 81, 17, 11],
  coffeeMaker: [159, 91, 7, 11], mug: [169, 95, 8, 7],
  flagIndia: [179, 94, 12, 9], flagUK: [193, 94, 12, 9], flagUS: [207, 94, 12, 9],
  bookA: [222, 94, 6, 8], bookB: [230, 94, 6, 8], picture: [239, 94, 11, 8],
  window: [59, 96, 26, 21], windowNote: [88, 96, 26, 21],
  monitor: [233, 106, 15, 19], clock: [159, 108, 19, 6],
  memoA: [183, 107, 6, 8], memoB: [192, 107, 6, 9], printer: [200, 107, 9, 9],
  door: [98, 120, 16, 31], vending: [159, 123, 24, 34], fridge: [184, 126, 24, 31],
  towerRed: [211, 119, 11, 8], towerBlue: [211, 129, 11, 8], towerGreen: [211, 140, 11, 8], socket: [211, 151, 10, 6],
  pcSide: [240, 128, 6, 19], keyboard: [233, 135, 5, 12],
  cat: [65, 129, 16, 13], corgi: [59, 146, 24, 11],
  binGreen: [116, 143, 9, 14], binRed: [126, 143, 9, 14], binBlue: [136, 143, 9, 14], cooler: [147, 140, 9, 17],
};

export function loadImage(src) {
  return new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = encodeURI(src); });
}

// MetroCity frames: 32x32, 24 per row: 0-5 down, 6-11 right, 12-17 up, 18-23 left.
export const DIR = { down: 0, right: 6, up: 12, left: 18 };
const FS = 32;

const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/**
 * A character is layers stacked per frame: body (skin row) + outfit + hair.
 * Returns an object that yields 32x32 canvases for run frames plus derived
 * sit / type / idle-sit poses that MetroCity doesn't ship.
 */
export async function makeCharacter(imgs, spec) {
  const layers = [
    [imgs.body, spec.skin],
    ...(spec.suit != null ? [[imgs.suit, spec.suit]] : spec.outfit ? [[imgs.outfits[spec.outfit], 0]] : []),
    ...(spec.hair != null ? [[imgs.hairs, spec.hair]] : []),
  ];
  const frames = [];
  for (let f = 0; f < 24; f++) {
    const c = canvasOf(FS, FS), g = c.getContext('2d');
    for (const [img, row] of layers) g.drawImage(img, f * FS, row * FS, FS, FS, 0, 0, FS, FS);
    if (spec.tint) tint(c, spec.tint);
    frames.push(c);
  }
  return { spec, frames, sit: deriveSit(frames), ...deriveFront(frames) };
}

/** Recolour gold-tinted MetroCity 2.0 layers (they are designed for this). */
function tint(c, rgb) {
  const g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const r = d.data[i], gg = d.data[i + 1], b = d.data[i + 2];
    if (d.data[i + 3] && r > 150 && gg > 100 && b < 90 && r - b > 90) {
      const l = (r + gg + b) / 3 / 200;
      d.data[i] = rgb[0] * l; d.data[i + 1] = rgb[1] * l; d.data[i + 2] = rgb[2] * l;
    }
  }
  g.putImageData(d, 0, 0);
}

/** Opaque bounds and row analysis of a frame. */
function rows(c) {
  const d = c.getContext('2d').getImageData(0, 0, FS, FS).data;
  const px = (x, y) => [d[(y * FS + x) * 4], d[(y * FS + x) * 4 + 1], d[(y * FS + x) * 4 + 2], d[(y * FS + x) * 4 + 3]];
  let top = FS, bottom = 0, left = FS, right = 0;
  for (let y = 0; y < FS; y++) for (let x = 0; x < FS; x++) if (px(x, y)[3]) { top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); }
  return { px, top, bottom, left, right };
}

/**
 * Sitting, facing right, derived from the right-facing stand frame: keep head
 * and torso, replace the legs with thighs bent forward onto the seat and
 * shins hanging down.
 */
function deriveSit(frames) {
  const src = frames[DIR.right];
  const { px, top, bottom, left, right } = rows(src);
  const h = bottom - top + 1;
  const hip = top + Math.round(h * 0.72);            // where the legs start
  const c = canvasOf(FS, FS), g = c.getContext('2d');
  g.drawImage(src, 0, 0, FS, hip, 0, 0, FS, hip);
  // Sample trouser and shoe colours from the original legs.
  const cx = Math.round((left + right) / 2);
  const col = (y) => { for (let x = left; x <= right; x++) { const p = px(x, y); if (p[3]) return `rgb(${p[0]},${p[1]},${p[2]})`; } return '#333'; };
  const pants = col(hip + 1), shoe = col(bottom);
  const x0 = cx - 3;
  g.fillStyle = pants; g.fillRect(x0, hip, 9, 3);             // thighs forward
  g.fillStyle = pants; g.fillRect(x0 + 6, hip + 3, 3, 3);     // shins down
  g.fillStyle = shoe; g.fillRect(x0 + 6, hip + 6, 4, 1);      // shoes
  c.hip = hip;
  // Skin and sleeve colours for procedural typing hands.
  const shoulder = top + Math.round(h * 0.45);
  const skinAt = () => { for (let y = top + 2; y < hip; y++) for (let x = left; x <= right; x++) { const p = px(x, y); if (p[3] && p[0] > 180 && p[1] > 120 && p[1] < 215 && p[2] < 190 && p[0] > p[2] + 25) return `rgb(${p[0]},${p[1]},${p[2]})`; } return '#f1c27d'; };
  c.skin = skinAt();
  c.sleeve = col(shoulder);
  c.shoulder = shoulder;
  c.front = cx + 3;
  return c;
}

/** Front-facing sitting (turned towards the viewer) for "waiting" state. */
function deriveFront(frames) {
  const src = frames[DIR.down];
  const { px, top, bottom, left, right } = rows(src);
  const h = bottom - top + 1, hip = top + Math.round(h * 0.72);
  const c = canvasOf(FS, FS), g = c.getContext('2d');
  g.drawImage(src, 0, 0, FS, hip, 0, 1, FS, hip); // slump 1px
  const col = (y) => { for (let x = left; x <= right; x++) { const p = px(x, y); if (p[3]) return `rgb(${p[0]},${p[1]},${p[2]})`; } return '#333'; };
  const cx = Math.round((left + right) / 2);
  g.fillStyle = col(hip + 1); g.fillRect(cx - 4, hip + 1, 8, 3);
  g.fillStyle = col(bottom); g.fillRect(cx - 4, hip + 4, 3, 1); g.fillRect(cx + 1, hip + 4, 3, 1);
  c.hip = hip + 1;
  return { front: c };
}

export async function loadAll() {
  const [office, body, shadow, hairs, suit, ...outfits] = await Promise.all([
    loadImage(SRC.office), loadImage(SRC.body), loadImage(SRC.shadow), loadImage(SRC.hairs), loadImage(SRC.suit),
    ...[1, 2, 3, 4, 5, 6].map((n) => loadImage(SRC.outfit(n))),
  ]);
  return { office, body, shadow, hairs, suit, outfits: [null, ...outfits] };
}
