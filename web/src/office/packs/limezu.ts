// LimeZu "Modern Office" pack adapter. The pack is paid and may not be
// redistributed, so it is never bundled: it lives in the gitignored /packs
// folder, is served at /packs by the daemon (or the Vite dev server), and is
// fetched at runtime. If it isn't there, the app falls back to the CC0 art.
//
// Cells are 16px-aligned boxes on the 16x16 sheets; the loader trims each to
// its opaque pixels, so a cell only has to contain the whole object.

const BASE = '/packs/limezu-modern-office/';
export const PACK = {
  id: 'limezu-modern-office',
  credit: 'Modern Office by LimeZu (limezu.itch.io)',
  sheets: {
    obj: BASE + '2_Modern_Office_Black_Shadow/Modern_Office_Black_Shadow.png',
    room: BASE + '1_Room_Builder_Office/Room_Builder_Office_16x16.png',
  },
};

type Cell = [number, number, number, number];

// Furniture and props: [x, y, w, h] cells on the "obj" sheet.
const OBJ = {
  // Desks (top-down, with legs/shadow).
  deskWoodBig: [16, 0, 48, 48], deskTanBig: [96, 0, 48, 48], deskGreyBig: [176, 0, 48, 48],
  deskLightBig: [16, 64, 48, 48], deskWhiteBig: [96, 64, 48, 48],
  deskWoodV: [0, 0, 16, 64], deskTanV: [144, 0, 16, 64], deskGreyV: [160, 0, 16, 64], deskWhiteV: [144, 64, 16, 56],
  // Chairs: back = seen from behind (sitter faces up), front = sitter faces down.
  chairBack: [0, 128, 16, 32], chairFront: [32, 128, 16, 32], chairSideR: [64, 128, 16, 32], chairSideL: [80, 128, 16, 32],
  chairOrangeBack: [0, 160, 16, 32], chairOrangeFront: [32, 160, 16, 32],
  // Screens.
  monitorFront: [224, 192, 16, 16], monitorDual: [208, 192, 16, 16], monitorBack: [224, 128, 16, 32], monitorBackWhite: [224, 160, 16, 32],
  laptopFront: [224, 240, 16, 16], laptopSide: [208, 240, 16, 16],
  // Decor.
  plantBig: [96, 128, 16, 32], plantSmall: [96, 160, 16, 32], plantTall: [96, 192, 16, 48],
  whiteboard: [144, 160, 32, 32], chartBoard: [144, 192, 32, 32], pieBoard: [144, 224, 32, 32],
  bookshelf: [112, 192, 32, 48], shelfWhite: [112, 240, 32, 32],
  artFaces: [0, 192, 32, 32], certificate: [112, 128, 16, 32], notice: [128, 128, 32, 32],
  podBlue: [48, 240, 16, 32], podGrey: [64, 240, 16, 32], podLilac: [80, 240, 16, 32], podGold: [96, 240, 16, 32],
  waterCooler: [192, 240, 16, 48], lamp: [176, 240, 16, 16],
  printer: [176, 176, 32, 16], server: [176, 192, 32, 16], paperStack: [32, 224, 16, 32], fax: [0, 224, 16, 32],
  // Lounge and kitchen.
  sofa: [0, 272, 32, 32], sofaL: [32, 272, 48, 48], sofaSmall: [0, 336, 16, 32],
  vending: [0, 368, 32, 48], fridge: [32, 368, 32, 48], snacks: [64, 384, 32, 32],
  tableSq: [64, 288, 16, 16], tableRect: [80, 288, 32, 16], tableYellow: [80, 320, 32, 16], tableOrange: [80, 352, 32, 16],
  copier: [112, 288, 32, 48], cabinetWood: [224, 304, 32, 32],
  partition: [0, 416, 96, 32],
} satisfies Record<string, Cell>;

// Room builder: floors (32x32 repeating blocks) and wall faces.
const ROOM = {
  floorGreyTile: [160, 80, 32, 32], floorWhiteWood: [208, 80, 32, 32],
  carpetDark: [160, 112, 32, 32], carpetBrown: [208, 112, 32, 32],
  carpetGrey: [160, 144, 32, 32], carpetTan: [208, 144, 32, 32],
  carpetMauve: [160, 176, 32, 32], carpetPink: [208, 176, 32, 32],
  // Wall faces: one 16px-wide middle slice, including the top trim.
  faceMarble: [16, 80, 16, 32], faceStone: [16, 112, 16, 32], faceBrick: [16, 144, 16, 32], facePlain: [16, 176, 16, 32],
} satisfies Record<string, Cell>;

export type PackSprite = keyof typeof OBJ | keyof typeof ROOM;
export type Trimmed = HTMLCanvasElement;
export interface Pack {
  id: string;
  credit: string;
  sprites: Record<PackSprite, Trimmed>;
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => fail(new Error('missing ' + src));
    i.src = src;
  });
}
function trimmed(img: HTMLImageElement, [x, y, w, h]: Cell, keep = false): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!; g.drawImage(img, x, y, w, h, 0, 0, w, h);
  if (keep) return c;
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (d[(yy * w + xx) * 4 + 3] > 0) { x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); y0 = Math.min(y0, yy); y1 = Math.max(y1, yy); }
  if (x1 < 0) return c;
  const t = document.createElement('canvas'); t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
  t.getContext('2d')!.drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
  return t;
}

/** Loads the pack, or resolves null if it isn't installed. */
export async function loadPack(): Promise<Pack | null> {
  let obj: HTMLImageElement, room: HTMLImageElement;
  try { [obj, room] = await Promise.all([load(PACK.sheets.obj), load(PACK.sheets.room)]); } catch { return null; }
  const sprites = {} as Record<PackSprite, Trimmed>;
  for (const [k, r] of Object.entries(OBJ)) sprites[k as PackSprite] = trimmed(obj, r as Cell);
  for (const [k, r] of Object.entries(ROOM)) sprites[k as PackSprite] = trimmed(room, r as Cell, true);
  return { id: PACK.id, credit: PACK.credit, sprites };
}
