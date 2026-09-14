/** Row-major order in the portrait atlas: the original neutral pose plus 17 edits. */
export const RIVAL_EXPRESSIONS = [
  'neutral', 'happy', 'confident', 'surprised', 'frustrated', 'relieved',
  'anticipation', 'focused', 'tense', 'anxious', 'teasing', 'wink',
  'ecstatic', 'disappointed', 'stunned', 'wry-smile', 'thoughtful', 'shy-smile',
] as const;

export type RivalExpression = typeof RIVAL_EXPRESSIONS[number];

export const RIVAL_PORTRAIT_ATLAS = {
  url: '/art/rival-expressions-expanded.webp',
  columns: 3, rows: 6, portraitWidth: 512, portraitHeight: 384, gutter: 4,
} as const;

export const RIVAL_EXPRESSION_LABELS: Record<RivalExpression, string> = {
  neutral: '通常', happy: '大きな笑顔', confident: '得意げ', surprised: '驚き',
  frustrated: '悔しさ', relieved: 'ほっとした笑顔', anticipation: '期待',
  focused: '真剣・集中', tense: '緊張', anxious: '焦り', teasing: '挑発',
  wink: 'ウインク', ecstatic: '大喜び', disappointed: '落胆', stunned: '呆然',
  'wry-smile': '苦笑い', thoughtful: '思案', 'shy-smile': '照れ笑い',
};
