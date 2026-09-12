export const STAGE_WIDTH = 1672;
export const STAGE_HEIGHT = 941;
export type Rect = { x: number; y: number; w: number; h: number };
export const REEL_RECTS: Rect[] = [
  { x: 272, y: 253, w: 163, h: 299 },
  { x: 447, y: 253, w: 178, h: 299 },
  { x: 639, y: 253, w: 156, h: 299 },
];
export const PORTRAIT: Rect = { x: 997, y: 177, w: 583, h: 435 };
export const MINI_RECTS: Rect[] = [0, 1, 2].map(i => ({ x: 1045 + i * 139, y: 698, w: 133, h: 83 }));

export const OVERLAYS: Record<string, Rect> = {
  timer: { x: 725, y: 16, w: 222, h: 130 },
  status: { x: 1030, y: 904, w: 530, h: 30 },
  playerScore: { x: 56, y: 16, w: 649, h: 130 },
  rivalScore: { x: 966, y: 16, w: 649, h: 130 },
  machineTitle: { x: 336, y: 179, w: 435, h: 49 },
  scoreGap: { x: 343, y: 589, w: 400, h: 43 },
  eventCue: { x: 275, y: 249, w: 528, h: 87 },
  line: { x: 1030, y: 522, w: 510, h: 74 },
  heard: { x: 1020, y: 610, w: 536, h: 24 },
  rivalMood: { x: 1030, y: 181, w: 530, h: 35 },
  miniLabel: { x: 1030, y: 631, w: 495, h: 55 },
  start: { x: 364, y: 686, w: 247, h: 104 },
  spinHint: { x: 301, y: 812, w: 377, h: 28 },
  paytable: { x: 122, y: 721, w: 194, h: 63 },
  roundStatus: { x: 655, y: 717, w: 253, h: 72 },
  duelRules: { x: 1030, y: 797, w: 500, h: 93 },
  connection: { x: 1025, y: 904, w: 515, h: 25 },
  machineTrim: { x: 233, y: 858, w: 600, h: 37 },
  avatar: PORTRAIT,
};
