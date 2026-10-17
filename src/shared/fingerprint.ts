/**
 * 便宜的内容指纹（FNV-1a 变体 + 长度）：判断"这份载荷与上次落盘的是否逐字节相同"。
 *
 * 为什么单独一个共享模块：两个落盘点都要用它（`trends-lkg.json` 的整份重写守卫、`trends/<secid>/<day>.json`
 * 的归档去重）。放在 `host/em.ts` 会让 `trendArchive.ts` 与 `em.ts` 形成**循环 import**
 * （em 已经在 import trendArchive），所以下沉到 `shared/`：两端都能用、且没有环。
 *
 * 判别性：短文本逐字符（小改动也要变）；>400KB 的长文本抽样（每 97 字符）+ 末尾 4KB 密扫
 * —— 大文件的重写成本远高于一次字符串扫描，抽样是"便宜且够用"的那一档，不做加密级摘要。
 */
export function payloadFingerprint(text: string): number {
  let h = 2166136261
  const stride = text.length > 400_000 ? 97 : 1
  for (let i = 0; i < text.length; i += stride) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // 末尾 4KB 再密扫一遍：`ts` 与"最新分时"都在尾部，抽样最容易漏掉这里的改动
  for (let i = Math.max(0, text.length - 4096); i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h ^ text.length) >>> 0
}
