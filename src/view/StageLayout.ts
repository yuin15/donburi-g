export const STAGE_WIDTH = 1672;
export const STAGE_HEIGHT = 941;
export const MOBILE_WIDTH = 1000;
export const MOBILE_HEIGHT = 1950;
export type Rect = { x: number; y: number; w: number; h: number };
export const REEL_RECTS: Rect[] = [
  { x: 272, y: 253, w: 163, h: 299 },
  { x: 447, y: 253, w: 178, h: 299 },
  { x: 639, y: 253, w: 156, h: 299 },
];
export const PORTRAIT: Rect = { x: 997, y: 177, w: 583, h: 435 };
export const MINI_RECTS: Rect[] = [0, 1, 2].map(i => ({ x: 1045 + i * 139, y: 698, w: 133, h: 83 }));

export const OVERLAYS: Record<string, Rect> = {
  brand: { x: 80, y: 5, w: 385, h: 60 },
  timer: { x: 721, y: 14, w: 230, h: 84 },
  status: { x: 1070, y: 18, w: 532, h: 46 },
  playerScore: { x: 247, y: 87, w: 505, h: 66 },
  rivalScore: { x: 1045, y: 86, w: 486, h: 65 },
  machineTitle: { x: 347, y: 179, w: 385, h: 49 },
  scoreGap: { x: 343, y: 589, w: 400, h: 43 },
  pay: { x: 693, y: 337, w: 293, h: 108 },
  eventCue: { x: 274, y: 476, w: 534, h: 82 },
  line: { x: 1030, y: 522, w: 510, h: 74 },
  heard: { x: 1020, y: 610, w: 536, h: 24 },
  rivalMood: { x: 1030, y: 181, w: 530, h: 35 },
  miniLabel: { x: 1030, y: 636, w: 495, h: 37 },
  start: { x: 364, y: 686, w: 247, h: 104 },
  paytable: { x: 122, y: 721, w: 194, h: 63 },
  upgradeProgress: { x: 655, y: 717, w: 253, h: 72 },
  builds: { x: 1030, y: 813, w: 475, h: 64 },
  connection: { x: 1025, y: 881, w: 515, h: 28 },
  machineTrim: { x: 233, y: 858, w: 600, h: 37 },
};

export const MOBILE_MACHINE = { source: { x: 70, y: 0, w: 920, h: 941 }, target: { x: 0, y: 0, w: 1000, h: 941 * 1000 / 920 } };
export const MOBILE_RIVAL = { source: { x: 980, y: 160, w: 640, h: 755 }, target: { x: 110, y: 970, w: 780, h: 755 * 780 / 640 } };

export function fitRect(rect: Rect, part: typeof MOBILE_MACHINE): Rect {
  const scale = part.target.w / part.source.w;
  return { x: part.target.x + (rect.x - part.source.x) * scale, y: part.target.y + (rect.y - part.source.y) * scale, w: rect.w * scale, h: rect.h * scale };
}

export function overlayRects(mobile: boolean): Record<string, Rect> {
  const all = { ...OVERLAYS, avatar: PORTRAIT };
  if (!mobile) return all;
  const rival = new Set(['avatar', 'rivalMood', 'line', 'heard', 'miniLabel', 'builds', 'connection', 'rivalScore']);
  const mapped = Object.fromEntries(Object.entries(all).map(([id, rect]) => [id, fitRect(rect, rival.has(id) ? MOBILE_RIVAL : MOBILE_MACHINE)]));
  return { ...mapped,
    brand: { x: 25, y: 4, w: 465, h: 62 },
    status: { x: 500, y: 4, w: 470, h: 58 },
    timer: { x: 740, y: 70, w: 228, h: 95 },
    playerScore: { x: 150, y: 77, w: 540, h: 84 },
    rivalScore: { x: 175, y: 895, w: 690, h: 65 },
    machineTrim: { x: 100, y: 1020, w: 800, h: 30 },
    connection: { x: 75, y: 1880, w: 850, h: 45 },
  };
}
