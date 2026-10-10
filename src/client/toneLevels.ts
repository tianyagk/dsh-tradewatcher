/** 五档词表（客户端与宿主的唯一副本；宿主侧同一套在 `src/host/tones.ts`） */
export const TONE_LEVELS = ['过冷', '偏冷', '适中', '偏热', '过热'] as const
export type ToneLevel = (typeof TONE_LEVELS)[number]
