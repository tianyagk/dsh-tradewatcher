/**
 * `trends-lkg`（分时兜底库）的**保留口径**——宿主与客户端共用一份常量。
 *
 * 为什么放在 `shared/`：客户端要在图表悬停的"上次成功数据"里**写明**这份兜底库保留多少、
 * 超了怎么丢（`AUDIT-IMPL76` ③：不得静默截断）。宿主按同一组常量执行裁剪 ⇒ 文案里的数字
 * 不可能与真实行为分叉（两处各写一个字面量就会漂）。
 */
/** 最多保留多少条（每条形如 `secid|ndays`） */
export const TREND_LKG_MAX = 400
/** 这份兜底库**总**字节上限（所有分片之和） */
export const TREND_LKG_MAX_BYTES = 4 * 1024 * 1024
/** 单次写盘上限（一条分片；分片制下每条 ≈ 20 KB，留足余量） */
export const TREND_LKG_MAX_SHARD_WRITE_BYTES = 512 * 1024
/**
 * **热条**内联进清单的条数上限（AUDIT-IMPL77 第 1 项）。
 *
 * 装载时只读清单 ⇒ 热条越多、启动越快、但清单（每次 persist 都要写）越大。
 * 8 条 × 约 18 KB ≈ 150 KB：装载从 60–65 ms 降到 ~5 ms，单次写仍远低于 512 KB。
 */
export const TREND_LKG_HOT_MAX = 8
/** 清单体积硬上限（热条按预算裁剪；保证"单次写 ≤ 512 KB"这条红线不被 N 调大破坏） */
export const TREND_LKG_MANIFEST_MAX_BYTES = 512 * 1024

/**
 * 悬停里那一行（`· 上次成功数据` 后接）。**别把数字写死**：全部来自上面的常量。
 * 位置：`chartNote.lastSuccessNote()` 在**分时**走兜底时追加（K 线不走这份库）。
 */
export const TREND_LKG_RETENTION_NOTE =
  `本地兜底（trends-lkg.d/ 按标的拆分）：最多 ${TREND_LKG_MAX} 条 / ${Math.round(TREND_LKG_MAX_BYTES / 1024 / 1024)} MB，` +
  '超出按最旧丢弃并在 trends-lkg.json 的 dropped 里留痕'
