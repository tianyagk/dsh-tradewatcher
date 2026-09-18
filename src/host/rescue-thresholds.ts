/**
 * 【护盘信号】默认阈值与基准 —— 由 scripts/calibrate-rescue.mjs 生成，请勿手改。
 * 标定日 2026-09-18；方法：F1: Tencent daily kline (vol×100×close ≈ amount), 20-day rolling ratio percentiles; progress: Sina 5-min cumulative volume share
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
  progressDays: number
  pooled: { p50: number; p75: number; p90: number; p95: number; p99: number }
  universe: Array<{ secid: string; name: string; avgAmt20: number }>
}

export const RESCUE_CALIBRATION: RescueCalibration = {
  "generatedAt": "2026-09-18",
  "f1": {
    "mid": 1.2,
    "high": 1.63,
    "extreme": 1.98
  },
  "f2": {
    "watch": 0.2,
    "mid": 0.5,
    "strong": 1
  },
  "progressCurve": [
    0,
    0.0858,
    0.1424,
    0.1887,
    0.2282,
    0.2647,
    0.2959,
    0.3282,
    0.3528,
    0.3746,
    0.3954,
    0.4139,
    0.4328,
    0.4543,
    0.4736,
    0.4895,
    0.5035,
    0.5192,
    0.5326,
    0.5471,
    0.5592,
    0.5721,
    0.5832,
    0.5961,
    0.6091,
    0.6327,
    0.6482,
    0.6619,
    0.6768,
    0.6908,
    0.7047,
    0.7193,
    0.7335,
    0.7444,
    0.7565,
    0.7685,
    0.7816,
    0.7973,
    0.8092,
    0.8209,
    0.8332,
    0.8462,
    0.8601,
    0.8763,
    0.8927,
    0.9143,
    0.943,
    0.9765,
    1
  ],
  "progressDays": 126,
  "pooled": {
    "p50": 0.9086515202305797,
    "p75": 1.199953849615267,
    "p90": 1.6292360100954524,
    "p95": 1.979043692287434,
    "p99": 3.9561943299744478
  },
  "universe": [
    {
      "secid": "1.510300",
      "name": "沪深300ETF华泰柏瑞",
      "avgAmt20": 3294526835
    },
    {
      "secid": "1.510050",
      "name": "上证50ETF华夏",
      "avgAmt20": 1451186858
    },
    {
      "secid": "1.510500",
      "name": "中证500ETF南方",
      "avgAmt20": 3130383358
    },
    {
      "secid": "1.512100",
      "name": "中证1000ETF华夏",
      "avgAmt20": 2824263095
    },
    {
      "secid": "1.588000",
      "name": "科创50ETF华夏",
      "avgAmt20": 5791630276
    },
    {
      "secid": "0.159915",
      "name": "创业板ETF易方达",
      "avgAmt20": 5421510517
    }
  ]
} as unknown as RescueCalibration
