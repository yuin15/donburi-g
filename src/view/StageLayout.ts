export const STAGE_WIDTH = 1672;
export const STAGE_HEIGHT = 941;
export type Rect = { x: number; y: number; w: number; h: number };
export const REEL_RECTS: Rect[] = [0, 1, 2].map(i => ({ x: 248 + i * 189, y: 273, w: 178, h: 371 }));
export const PORTRAIT: Rect = { x: 997, y: 177, w: 583, h: 435 };
export const MINI_RECTS: Rect[] = [0, 1, 2].map(i => ({ x: 1045 + i * 139, y: 698, w: 133, h: 83 }));

export const OVERLAYS: Record<string, Rect> = {
  timer: { x: 725, y: 22, w: 222, h: 108 },
  status: { x: 1030, y: 904, w: 530, h: 30 },
  playerScore: { x: 56, y: 22, w: 649, h: 108 },
  rivalScore: { x: 966, y: 22, w: 649, h: 108 },
  machineTitle: { x: 336, y: 185, w: 435, h: 49 },
  scoreGap: { x: 365, y: 842, w: 338, h: 35 },
  eventCue: { x: 275, y: 249, w: 528, h: 87 },
  winBurst: { x: 304, y: 638, w: 460, h: 91 },
  line: { x: 1200, y: 147, w: 403, h: 111 },
  heard: { x: 1030, y: 580, w: 510, h: 31 },
  rivalMood: { x: 1020, y: 559, w: 530, h: 35 },
  miniLabel: { x: 1030, y: 631, w: 495, h: 55 },
  start: { x: 402, y: 742, w: 247, h: 76 },
  spinHint: { x: 394, y: 820, w: 265, h: 20 },
  paytable: { x: 201, y: 729, w: 130, h: 90 },
  betControls: { x: 205, y: 650, w: 565, h: 74 },
  lineOverlay: { x: 245, y: 270, w: 570, h: 375 },
  roundStatus: { x: 1052, y: 872, w: 484, h: 22 },
  duelRules: { x: 1030, y: 797, w: 500, h: 83 },
  voicePanel: { x: 1030, y: 807, w: 500, h: 76 },
  connection: { x: 1025, y: 884, w: 515, h: 18 },
  machineTrim: { x: 265, y: 899, w: 532, h: 28 },
  avatar: PORTRAIT,
};
