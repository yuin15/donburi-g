export const STAGE_WIDTH = 1672;
export const STAGE_HEIGHT = 941;
export type Rect = { x: number; y: number; w: number; h: number };
export const REEL_RECTS: Rect[] = [0, 1, 2].map(i => ({ x: 257 + i * 185, y: 256, w: 173, h: 308 }));
export const PORTRAIT: Rect = { x: 997, y: 177, w: 583, h: 435 };
export const MINI_RECTS: Rect[] = [0, 1, 2].map(i => ({ x: 1045 + i * 139, y: 698, w: 133, h: 83 }));

export const OVERLAYS: Record<string, Rect> = {
  timer: { x: 725, y: 22, w: 222, h: 108 },
  status: { x: 1030, y: 904, w: 530, h: 30 },
  playerScore: { x: 56, y: 22, w: 649, h: 108 },
  rivalScore: { x: 966, y: 22, w: 649, h: 108 },
  machineTitle: { x: 336, y: 185, w: 435, h: 49 },
  scoreGap: { x: 343, y: 601, w: 400, h: 43 },
  eventCue: { x: 275, y: 249, w: 528, h: 87 },
  winBurst: { x: 254, y: 574, w: 570, h: 101 },
  line: { x: 1030, y: 500, w: 510, h: 72 },
  heard: { x: 1030, y: 580, w: 510, h: 31 },
  rivalMood: { x: 1030, y: 181, w: 530, h: 35 },
  miniLabel: { x: 1030, y: 631, w: 495, h: 55 },
  start: { x: 364, y: 711, w: 247, h: 104 },
  spinHint: { x: 301, y: 828, w: 377, h: 28 },
  paytable: { x: 122, y: 739, w: 194, h: 63 },
  roundStatus: { x: 655, y: 735, w: 253, h: 72 },
  duelRules: { x: 1030, y: 797, w: 500, h: 83 },
  voicePanel: { x: 1030, y: 807, w: 500, h: 76 },
  connection: { x: 1025, y: 884, w: 515, h: 18 },
  machineTrim: { x: 265, y: 899, w: 532, h: 28 },
  avatar: PORTRAIT,
};
