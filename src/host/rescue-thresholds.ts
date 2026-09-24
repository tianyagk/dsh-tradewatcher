/**
 * 【护盘信号】默认阈值与基准 —— 由 scripts/calibrate-rescue.mjs 生成，请勿手改。
 * 标定日 2026-09-24；方法：F1: Tencent daily kline (vol×100×close ≈ amount), 20-day rolling ratio percentiles; progress: Sina 5-min cumulative volume share
 *   F1 量能倍数：2886 个样本（6 只宽基 ETF × 约 481 个交易日的 20 日滚动量比）
 *   日内进度曲线：126 个交易日（新浪 5 分钟线）
 *   F2 超大单强度：免费源已无日频资金流历史 → 经验锚点，由 host 采样器自建样本满 20 交易日后重算
 */
export interface RescueCalibration {
  generatedAt: string
  /** F1 量能倍数锚点（对应 40/70/100 分） */
  f1: { mid: number; high: number; extreme: number }
  /** F2 超大单净额/20日均额 锚点（经验值） */
  f2: { watch: number; mid: number; strong: number }
  /** 日内累计成交占比曲线，索引 i = 开盘后 i*5 分钟（0..48） */
  progressCurve: number[]
  /** 脉冲锚点按时段分档（P75/P90/P95 → 40/70/100 分） */
  pulseBands: Array<{ key: string; label: string; from: number; to: number; samples: number; p75: number; p90: number; p95: number }>
  progressDays: number
  pooled: { p50: number; p75: number; p90: number; p95: number; p99: number }
  universe: Array<{ secid: string; name: string; avgAmt20: number }>
}

export const RESCUE_CALIBRATION: RescueCalibration = {
  "generatedAt": "2026-09-24",
  "f1": {
    "mid": 1.19,
    "high": 1.57,
    "extreme": 1.92
  },
  "f2": {
    "watch": 0.2,
    "mid": 0.5,
    "strong": 1
  },
  "progressCurve": [
    0,
    0.0898,
    0.1477,
    0.1929,
    0.2302,
    0.2647,
    0.2938,
    0.325,
    0.3503,
    0.3731,
    0.3934,
    0.4119,
    0.4303,
    0.451,
    0.4695,
    0.4832,
    0.4965,
    0.5109,
    0.5234,
    0.5372,
    0.5483,
    0.5603,
    0.5713,
    0.5846,
    0.5988,
    0.6222,
    0.6364,
    0.649,
    0.663,
    0.6765,
    0.6916,
    0.7071,
    0.7216,
    0.7331,
    0.7455,
    0.7578,
    0.7711,
    0.7884,
    0.8007,
    0.8119,
    0.8248,
    0.8384,
    0.853,
    0.8708,
    0.8885,
    0.9126,
    0.943,
    0.9766,
    1
  ],
  "progressDays": 126,
  "pulseBands": [
    {
      "key": "09:30-10:00",
      "label": "早盘",
      "from": 5,
      "to": 30,
      "samples": 756,
      "p75": 1.2310249111669977,
      "p90": 1.7301063159871124,
      "p95": 2.0257270418315816
    },
    {
      "key": "10:00-10:30",
      "label": "上午前段",
      "from": 35,
      "to": 60,
      "samples": 756,
      "p75": 1.2599257769947505,
      "p90": 1.8331920667600017,
      "p95": 2.152002179865451
    },
    {
      "key": "10:30-11:30",
      "label": "上午后段",
      "from": 65,
      "to": 120,
      "samples": 1512,
      "p75": 1.2272110580906146,
      "p90": 1.9790460577973001,
      "p95": 2.600001180204515
    },
    {
      "key": "13:00-14:00",
      "label": "午后",
      "from": 125,
      "to": 180,
      "samples": 1512,
      "p75": 1.2296262745595898,
      "p90": 1.7702602338408941,
      "p95": 2.201855313440909
    },
    {
      "key": "14:00-14:30",
      "label": "尾盘前",
      "from": 185,
      "to": 210,
      "samples": 756,
      "p75": 1.2426047119519725,
      "p90": 1.8554820988678722,
      "p95": 2.2215872891194475
    },
    {
      "key": "14:30-15:00",
      "label": "尾盘",
      "from": 215,
      "to": 240,
      "samples": 738,
      "p75": 1.2622650487923437,
      "p90": 1.9111220538281424,
      "p95": 2.434731264116938
    }
  ],
  "pooled": {
    "p50": 0.9039494568347829,
    "p75": 1.19130747731396,
    "p90": 1.5729996757096938,
    "p95": 1.9207672081980967,
    "p99": 3.1328704973348147
  },
  "universe": [
    {
      "secid": "1.510300",
      "name": "沪深300ETF华泰柏瑞",
      "avgAmt20": 3131620643
    },
    {
      "secid": "1.510050",
      "name": "上证50ETF华夏",
      "avgAmt20": 1424845422
    },
    {
      "secid": "1.510500",
      "name": "中证500ETF南方",
      "avgAmt20": 3091124869
    },
    {
      "secid": "1.512100",
      "name": "中证1000ETF华夏",
      "avgAmt20": 2603368825
    },
    {
      "secid": "1.588000",
      "name": "科创50ETF华夏",
      "avgAmt20": 5664154410
    },
    {
      "secid": "0.159915",
      "name": "创业板ETF易方达",
      "avgAmt20": 5162046130
    }
  ]
} as unknown as RescueCalibration
