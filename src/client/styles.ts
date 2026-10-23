/**
 */
/**
 * 宽屏断点（px）：**唯一的数字来源**，CSS 里的每个 `@media (min-width:…)` 必须等于它。
 *
 * 为什么放在这里：断言（`styles.test.ts`）直接读 CSS 文本比对，常量与样式同文件就不会漂。
 * v0.36.0 起列头排序已删除，这条断点只服务多列网格（`.tw-wlist`/`.tw-poslist`）。
 */
export const WIDE_MIN_PX = 1080

export const STYLE_ID = 'dsh-tradewatcher-style'

export const TW_CSS = `
.tw-root{
--tw-bg:#f5f6f8;--tw-bg2:#eceef2;--tw-card:#ffffff;--tw-card2:#f2f4f7;--tw-hover:#eef0f5;
--tw-border:#e2e5ea;--tw-border-strong:#cfd3dc;--tw-chip-avg:#c97a1c;--tw-chip-res:#7a5cc4;--tw-chip-sup:#2f74c0;--tw-chips-grid:rgba(0,0,0,.14);--tw-chip-profile:#9aa3b4;
--tw-text:#16181d;--tw-dim:#4c535f;--tw-muted:#6f7787;
/* 图表辅助线的两个 token：此前只在救援曲线/日历里被 var() 引用、**从未定义** ——
   无 fallback 的地方会因"无效值"退回初始色（浅色主题下出现一条近黑的轴线）。
   这里补成主题内已有的同义 token。 */
--tw-fg-dim:var(--tw-muted);--tw-line:var(--tw-border);
--tw-up:#e5484d;--tw-down:#0e8f5c;--tw-flat:#6f7787;
--tw-up-bg:rgba(229,72,77,.09);--tw-down-bg:rgba(12,154,99,.09);--tw-flat-bg:rgba(138,145,160,.10);
/* 语义色阶（P1-10）：重要性三档与护盘等级四档**不复用涨跌色相**，也**不跟 redUp 翻转**。
   颜色承载的只有「这件事有多需要注意」这一件语义；深浅两档都定义，隐身档统一灰化（见下方 data-view=incognito）。 */
--tw-imp-1:#5e6ad2;--tw-imp-2:#a16207;--tw-imp-3:#9a3412;
/* 警示琥珀（P3-1）：全项目此前引用一个从未定义的 token（带 #d97706 fallback），
   于是永远走 fallback、且不随主题；另有 #e0a94a / #e8a33d 两种琥珀散落 10 处。
   现在只有这一个来源（浅色档取更深的值，保证 12px 文字对白底 >= 4.5:1）。 */
--tw-warn:#b45309;
--tw-rescue-0:#8a8f98;--tw-rescue-1:#2f6fbf;--tw-rescue-2:#a16207;--tw-rescue-3:#9a3412;
--tw-accent:#5e6ad2;--tw-accent-hover:#4652c0;--tw-accent-soft:rgba(94,106,210,.10);--tw-ring:rgba(94,106,210,.38);
--tw-mask:rgba(15,17,20,.42);
--tw-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--tw-shadow-sm:0 1px 2px rgba(16,24,40,.05);
--tw-shadow-lg:0 1px 2px rgba(16,24,40,.05),0 14px 36px rgba(16,24,40,.13);
/* 玻璃浮层令牌（浅色档）：值与 toolDetailTheme.GLASS 一一对应（uiuxDiscipline.test.ts 核对） */
--tw-glass-bg:rgba(255,255,255,.86);--tw-glass-border:rgba(15,23,42,.08);--tw-glass-blur:20px;--tw-glass-saturate:1.4;
--tw-ease:cubic-bezier(.16,1,.3,1);
color-scheme:light;background:var(--tw-bg);color:var(--tw-text);
font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
letter-spacing:-0.006em}
.tw-root[data-theme=dark]{
--tw-bg:#010102;--tw-bg2:#0b0c0e;--tw-card:#0f1011;--tw-card2:#16181b;--tw-hover:#1b1d21;
--tw-border:#23252a;--tw-border-strong:#34343a;--tw-chip-avg:#e0913a;--tw-chip-res:#9b7bd6;--tw-chip-sup:#4a90d9;--tw-chips-grid:rgba(255,255,255,.16);--tw-chip-profile:#8f98a8;
--tw-text:#f7f8f8;--tw-dim:#c8ced8;--tw-muted:#8a8f98;
--tw-fg-dim:var(--tw-muted);--tw-line:var(--tw-border);
--tw-up:#ff5f6d;--tw-down:#27a644;--tw-flat:#8a8f98;
--tw-up-bg:rgba(255,95,109,.12);--tw-down-bg:rgba(47,191,131,.12);--tw-flat-bg:rgba(138,143,152,.12);
--tw-imp-1:#8b95ff;--tw-imp-2:#f0b429;--tw-imp-3:#ff8a4c;--tw-warn:#f0b429;
--tw-rescue-0:#8a8f98;--tw-rescue-1:#5da5ff;--tw-rescue-2:#f0a63a;--tw-rescue-3:#ff8a4c;
--tw-accent:#5e6ad2;--tw-accent-hover:#828fff;--tw-accent-soft:rgba(94,106,210,.16);--tw-ring:rgba(94,106,210,.45);
--tw-mask:rgba(0,0,0,.55);
--tw-shadow-sm:0 1px 0 rgba(255,255,255,.03);
--tw-shadow-lg:0 1px 0 rgba(255,255,255,.03),0 16px 44px rgba(0,0,0,.55);
/* 深色档 = 竞品「暗夜玻璃」实测值（rgba(13,17,25,.92) + blur(20px) saturate(1.5)），做法采纳、配色不抄 */
--tw-glass-bg:rgba(13,17,25,.92);--tw-glass-border:rgba(255,255,255,.09);--tw-glass-blur:20px;--tw-glass-saturate:1.5;
--tw-ease:cubic-bezier(.16,1,.3,1);
color-scheme:dark}
/* 页面切后台 ⇒ 根节点 data-idle=true：暂停全部动画（竞品 .ap-idle 约定；合成层不空跑） */
.tw-root[data-idle=true] *{animation-play-state:paused!important}
.tw-root *{box-sizing:border-box}
.tw-root button{font:inherit;color:inherit;background:none;border:none;padding:0;cursor:pointer}
.tw-root input,.tw-root select{font:inherit;color:var(--tw-text);background:var(--tw-card);border:1px solid var(--tw-border);border-radius:8px;padding:5px 9px;outline:none}
/* 焦点可见性：此前这里写的是 --tw-focus —— 该 token 全项目**没有定义**，
   等于输入框的焦点提示只剩 1px 边框由灰变紫（滑块还内联 border:none，连边框都没有）。
   改用已定义的 --tw-ring，并且只在键盘聚焦（:focus-visible）时画环：鼠标点击不画。 */
.tw-root input:focus,.tw-root select:focus{border-color:var(--tw-accent)}
.tw-root input:focus-visible,.tw-root select:focus-visible{border-color:var(--tw-accent);box-shadow:0 0 0 3px var(--tw-ring)}
/* 滑块是宽条元素，外阴影环不明显 → 用 outline（TopBar 的不透明度滑块也不再是"完全没有焦点提示"） */
.tw-root input[type=range]:focus-visible{outline:2px solid var(--tw-accent);outline-offset:2px;box-shadow:none}
.tw-root ::placeholder{color:var(--tw-muted)}
.tw-scroll::-webkit-scrollbar{height:8px;width:8px}
.tw-scroll::-webkit-scrollbar-thumb{background:var(--tw-border-strong);border-radius:4px}
.tw-scroll::-webkit-scrollbar-track{background:transparent}

/* ── topbar ─────────────────────────────────────────────── */
.tw-topbar{position:relative;background:var(--tw-bg);border-bottom:1px solid var(--tw-border);padding:7px 10px 9px}
.tw-topmeta{display:flex;align-items:center;gap:8px;margin-bottom:7px;min-height:22px}
.tw-topmeta .tw-title{font-weight:600;font-size:12px;color:var(--tw-text);letter-spacing:-0.2px}
.tw-topmeta .tw-uptime{color:var(--tw-muted);font-size:12px;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.tw-iconbtn{color:var(--tw-dim);border:1px solid var(--tw-border);border-radius:8px;padding:1px 8px;font-size:12px;line-height:19px;background:var(--tw-card);transition:color .12s,border-color .12s}
.tw-iconbtn:hover{color:var(--tw-text);border-color:var(--tw-border-strong)}
.tw-iconbtn:disabled{opacity:.5;cursor:default}
.tw-strip{display:flex;align-items:flex-start;gap:8px;margin:6px 0}
.tw-strip-label{flex:none;width:56px;display:flex;align-items:center;color:var(--tw-muted);font-size:12px;letter-spacing:.02em;padding-right:2px;padding-top:8px;align-self:flex-start}
/* 行情条：改为自动填充网格。
   之前是 flex + overflow-x:auto —— 在宽屏上卡片被拉成 300px+ 的"空壳"（内容只占左边一角），
   在窄屏上又把超出部分藏进横向滚动（要滚才知道还有几只）。
   自动填充两头都解决：宽屏多列、窄屏换行，**没有内容被藏起来**。 */
.tw-strip-cards{flex:1;min-width:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:6px;align-content:start}
.tw-strip-cards::-webkit-scrollbar{height:6px}
.tw-strip-cards::-webkit-scrollbar-thumb{background:var(--tw-border-strong);border-radius:4px}
.tw-strip-cards::-webkit-scrollbar-track{background:transparent}
.tw-qcard{min-width:0;min-height:54px;background:var(--tw-card);border:1px solid var(--tw-border);border-radius:10px;padding:4px 9px 5px;position:relative;overflow:hidden;transition:border-color .12s,background .12s;cursor:pointer}
.tw-qcard:hover{border-color:var(--tw-accent);background:var(--tw-hover)}
/* toast（P0-6/P0-8）：一次性动作的说明，贴在面板底部，不遮挡行情条 */
.tw-toast{position:absolute;left:10px;right:10px;bottom:10px;z-index:40;display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border:1px solid var(--tw-border-strong);border-radius:9px;background:var(--tw-card);box-shadow:var(--tw-shadow-lg);color:var(--tw-text);font-size:12px;line-height:1.5}
.tw-toast-x{flex:none;color:var(--tw-muted);font-size:14px;line-height:1;padding:0 2px}
/* 校验结论（P0-9 导入前的"通过/拒绝"） */
.tw-ok{color:var(--tw-down)}
.tw-err{color:var(--tw-up)}
.tw-toast-x:hover{color:var(--tw-text)}

/* 视图档位（P0-8）─────────────────────────────────────────
   紧凑：去掉说明文字与脚注（它们占的行多、信息密度低）
   隐身：金额由格式化出口模糊为 ¥••••，涨跌色转灰阶（色相也会泄露方向与幅度感） */
.tw-root[data-view=compact] .tw-hint,
.tw-root[data-view=compact] .tw-chartnote,
.tw-root[data-view=compact] .tw-drawer-foot,
.tw-root[data-view=compact] .tw-pop-hint,
.tw-root[data-view=compact] .tw-empty{display:none}
.tw-root[data-view=incognito] .tw-hint,
.tw-root[data-view=incognito] .tw-chartnote,
.tw-root[data-view=incognito] .tw-drawer-foot,
.tw-root[data-view=incognito] .tw-pop-hint{display:none}
.tw-root[data-view=incognito]{
--tw-up:#8a8f98;--tw-down:#8a8f98;--tw-up-bg:rgba(138,143,152,.12);--tw-down-bg:rgba(138,143,152,.12);
/* 语义色阶同样转灰阶：隐身视图里"高重要度/强护盘"不许是整屏最刺眼的一处颜色（P1-10 ③） */
--tw-imp-1:#8a8f98;--tw-imp-2:#8a8f98;--tw-imp-3:#8a8f98;--tw-warn:#8a8f98;
--tw-rescue-0:#8a8f98;--tw-rescue-1:#8a8f98;--tw-rescue-2:#8a8f98;--tw-rescue-3:#8a8f98}
/* 图表口径条（P0-5）：紧贴图上方一行，等宽字体便于对齐数字 */
.tw-caliber{flex:none;padding:5px 8px 4px;font-size:12px;color:var(--tw-dim);font-family:var(--tw-mono);border-bottom:1px dashed var(--tw-border);background:var(--tw-bg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 自选异动（P1-4）：呼吸高亮。用左边的竖条 + 缓慢呼吸的背景，
   而不是整行变红 —— 整行变红与"跌了"的语义冲突（红既是跌也是警示）。 */
/* 告警行的呼吸条：**只动 opacity**（原来动 background ⇒ 每帧 paint；纪律见 DESIGN-UIUX-ADOPT §3） */
@keyframes tw-breathe{0%,100%{opacity:.3}50%{opacity:1}}
.tw-wrow[data-alert]{box-shadow:inset 3px 0 0 var(--tw-up);position:relative}
.tw-wrow[data-alert]::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--tw-up);pointer-events:none;animation:tw-breathe 2.6s ease-in-out infinite}
.tw-wrow[data-alert][data-alert=price]{box-shadow:inset 3px 0 0 var(--tw-flat)}
.tw-wrow[data-alert][data-alert=price]::after{background:var(--tw-flat)}
@media (prefers-reduced-motion:reduce){.tw-wrow[data-alert]::after{animation:none;opacity:.75}}

/* 读屏专用文本（P2-3）：视觉上不可见，但读屏软件可朗读。
   用 clip 而不是 display:none —— 后者会让读屏软件也读不到。 */
.tw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* 宽屏利用率（布局优化）────────────────────────────────
   列表行按侧栏宽度设计（~360px），摊到 1080px+ 的面板上就是"名字在左、价格在右、中间一片空"。
   与其把行拉长，不如多铺几列 —— 同样的高度里能看到两倍的条目，滚动也更少。

   两条口径（都来自审计结论）：
   1. **按列填充**，不是按行填充：grid 的 auto-fill 会把"第 2 名"放到第 1 名右侧，
      顺左列往下读变成 1/3/5 名 —— 排序的全部意义就是名次，因此改用 CSS 多列（竖向填满）。
   2. **断点 1080px**（两列所需 520×2 + 16 间距 + 内边距），不是 1500px。
      ⚠ 断点必须与同文件的 WIDE_MIN_PX 一致（由 styles.test.ts 直接读 CSS 文本比对；
      写死在注释里的一致性迟早会漂）。v0.36.0 起列头排序已删除；client/wide.ts 已于 v0.39.0 删除，
      常量现在就在本文件，这条断点只服务多列网格。 */
@media (min-width:1080px){
  .tw-wlist,.tw-poslist{columns:520px;column-gap:16px}
  /* 多列下行不能被拦腰截断 */
  .tw-wlist>.tw-wrow,.tw-poslist>.tw-posrow{break-inside:avoid}
}
/* 行内数字面（额 / 市值 / α / YTD）：与其它数字面同一套等宽数字，并且**必须**出现在
   上面的模糊选择器清单里（漏一个就等于隐身不彻底）。 */
.tw-num,.tw-ytd{font-family:var(--tw-mono);font-variant-numeric:tabular-nums}

/* 数字模糊（P2-2, data-blur=1）────────────────────────────
   目标集合来自「所有使用 --tw-mono 的数字面」的证据清单（styles.ts 里逐条可查），
   而不是凭印象写：漏一个面就等于隐身不彻底。新增数字展示面时必须同时加进这两条规则。
   hover 所在行/卡会显形 —— 既能录进画面，又能在需要时读某一行的数。 */
.tw-root[data-blur=1] :is(.tw-qcard .px, .tw-qcard .chg, .tw-chg-chip,
  .tw-stat .v, .tw-pps .v, .tw-pps .meta, .tw-pos-price .px, .tw-pos-price .meta,
  .tw-pop .ph .px, .tw-pop .ph .tag, .tw-pop .pl,
  .tw-group-h .gsum, .tw-wrow .wq, .tw-wrow .tw-num, .tw-ytd, .tw-gh-metrics,
  .tw-dkv .v, .tw-rescue-card-grid .v, .tw-table td,
  .tw-chart-pct,
  .tw-chart-tip-v,
  .tw-tone,
  .tw-cfg-count,
  .tw-chips-nums, .tw-chips-date, .tw-chips-bar, .tw-chips-reflabel, .tw-chips-xaxis,
  .tw-review-bline, .tw-daytrade-table td, .tw-bulk-table td, .tw-bulk-sum,
  .tw-pos-title small,
  .tw-caliber, .tw-chartnote, .tw-zoom-bar, .tw-topmeta .tw-uptime){
  filter:blur(3.2px);transition:filter .12s}
.tw-root[data-blur=1] :is(.tw-qcard, .tw-wrow, .tw-posrow, tr, .tw-pop, .tw-stat, .tw-pps,
  .tw-dkv, .tw-rescue-card-grid, .tw-panel, .tw-cfg, .tw-chips):hover :is(.tw-qcard .px, .tw-qcard .chg, .tw-chg-chip,
  .tw-stat .v, .tw-pps .v, .tw-pps .meta, .tw-pos-price .px, .tw-pos-price .meta,
  .tw-pop .ph .px, .tw-pop .ph .tag, .tw-pop .pl,
  .tw-group-h .gsum, .tw-wrow .wq, .tw-wrow .tw-num, .tw-ytd, .tw-gh-metrics,
  .tw-dkv .v, .tw-rescue-card-grid .v, .tw-table td,
  .tw-chart-pct,
  .tw-chart-tip-v,
  .tw-tone,
  .tw-cfg-count,
  .tw-chips-nums, .tw-chips-date, .tw-chips-bar, .tw-chips-reflabel, .tw-chips-xaxis,
  .tw-review-bline, .tw-daytrade-table td, .tw-bulk-table td, .tw-bulk-sum,
  .tw-pos-title small,
  .tw-caliber, .tw-chartnote, .tw-zoom-bar){
  filter:none}

/* 三态降级占位（P0-10）：iframe 超时后不留空白 */
.tw-placeholder{flex:1;min-height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center;padding:24px 18px;color:var(--tw-dim);font-size:12px;background:var(--tw-card2);border-top:1px solid var(--tw-border)}
.tw-badge[data-state=timeout]{color:var(--tw-up);border-color:var(--tw-up)}
.tw-badge[data-state=loaded]{color:var(--tw-down);border-color:var(--tw-down)}
/* 五态色点（P0-2）：6px，绝对定位到右上角，不影响卡片高度 */
.tw-qdot{position:absolute;top:5px;right:5px;width:6px;height:6px;border-radius:50%;flex:none;pointer-events:none}
.tw-qdot::after{content:"";position:absolute;inset:-3px;border-radius:50%}
.tw-qcard .nm{font-size:12px;color:var(--tw-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}
.tw-qcard .px{font-family:var(--tw-mono);font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.35}
.tw-qcard .chg{display:flex;gap:6px;align-items:baseline;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;font-family:var(--tw-mono)}
.tw-qcard .chg b{font-weight:600}
.tw-chg-chip{display:inline-block;padding:0 6px;border-radius:10px;font-weight:600;font-size:12px}
.tw-up{color:var(--tw-up)} .tw-down{color:var(--tw-down)} .tw-flat{color:var(--tw-flat)}
.tw-chip-up{color:var(--tw-up);background:var(--tw-up-bg)}
.tw-chip-down{color:var(--tw-down);background:var(--tw-down-bg)}
.tw-chip-flat{color:var(--tw-flat);background:var(--tw-flat-bg)}

/* ── segmented page tabs (de-crowded) ──────────────────── */
/* 分段按钮式 tab：每个 tab 都是独立可点的胶囊（≥30px 高、≥58px 宽、6px 间隔），
   激活态用 accent 描边 + 柔色底；圆点占位对所有 tab 保留，切换时不产生位移。 */
.tw-tabs{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--tw-border);background:var(--tw-bg2);overflow-x:auto;scrollbar-width:none}
.tw-tabs::-webkit-scrollbar{display:none}
.tw-tab{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;min-width:58px;padding:0 12px;font-size:12px;color:var(--tw-dim);background:var(--tw-card);border:1px solid var(--tw-border);border-radius:8px;transition:background .12s,color .12s,border-color .12s;white-space:nowrap}
.tw-tab::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--tw-accent);opacity:0;transition:opacity .12s;flex:none}
.tw-tab:hover{color:var(--tw-text);background:var(--tw-hover);border-color:var(--tw-border-strong)}
.tw-tab[data-on=true]{color:var(--tw-text);font-weight:600;background:var(--tw-accent-soft);border-color:var(--tw-accent);letter-spacing:-0.15px}
.tw-tab[data-on=true]::before{opacity:1}

/* ── body & panels ─────────────────────────────────────── */
.tw-body{display:flex;flex-direction:column;gap:12px;padding:10px;overflow:auto;flex:1;min-height:0}
/* flex 纵向容器里子块默认会被压缩（overflow:hidden 的卡片尤其会"缩扁"导致内容裁切且无滚动条）：
   禁止压缩，超高内容自然溢出由 .tw-body 滚动。 */
.tw-body > *{flex-shrink:0}
.tw-body::-webkit-scrollbar{width:8px}
.tw-body::-webkit-scrollbar-thumb{background:var(--tw-border-strong);border-radius:4px}
.tw-body::-webkit-scrollbar-thumb:hover{background:var(--tw-muted)}
.tw-body::-webkit-scrollbar-track{background:transparent}
.tw-muted{color:var(--tw-muted)} .tw-dim{color:var(--tw-dim)}
.tw-panel{background:var(--tw-card);border:1px solid var(--tw-border);border-radius:10px;padding:10px 12px}
.tw-panel-h{display:flex;align-items:center;gap:8px;padding-bottom:7px;min-height:24px}
.tw-panel-h .t{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-0.2px}
.tw-statrow{display:flex;gap:8px;flex-wrap:wrap;padding:2px 0 8px}
/* 【涨跌分布】模块（v0.81.0 重排，对齐参考版 Arkvol）：
   左列三段紧凑内联行 + 右列两块；每段一个小色条 + 标题 */
.tw-dist-seg{display:flex;flex-direction:column;gap:5px;min-width:0}
.tw-dist-seg-h{display:flex;align-items:center;gap:6px;min-width:0}
.tw-dist-seg-bar{flex:none;width:3px;height:12px;border-radius:2px;background:var(--tw-accent, #5da5ff)}
.tw-dist-seg-t{font-size:12px;font-weight:600;color:var(--tw-dim);letter-spacing:.02em;white-space:nowrap}
.tw-dist-seg-sub{font-size:12px;color:var(--tw-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
/* 内联统计行：一行 5 个（或 4 个）紧凑项，不做磁贴 */
.tw-dist-inline{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}
.tw-dist-inline .it{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap}
.tw-dist-inline .it .k{font-size:12px;color:var(--tw-dim)}
.tw-dist-inline .it .v{font-size:12.5px;font-family:var(--tw-mono)}
.tw-dist-inline .it .v.tw-dim{font-size:12px}
/* 图例行（两融/日内）：序列名 + 未取到；有数据时是色点 + 名 */
.tw-dist-legend{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline}
.tw-dist-legend .lg{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--tw-dim)}
.tw-dist-legend .dot{width:7px;height:7px;border-radius:50%;flex:none}
/* 直方图：纵轴 + 网格线 + 柱（柱宽用百分比，窄面板也不会把某档挤成 0 宽） */
.tw-dist-chart{position:relative;padding-left:30px;min-width:0}
.tw-dist-axis{position:absolute;left:0;top:0;bottom:14px;width:28px}
.tw-dist-axis .tk{position:absolute;right:2px;font-size:12px;font-family:var(--tw-mono);color:var(--tw-muted);transform:translateY(-50%)}
.tw-dist-grid{position:absolute;left:30px;right:0;bottom:14px;top:0;pointer-events:none}
.tw-dist-grid .gl{position:absolute;left:0;right:0;border-top:1px dashed var(--tw-chips-grid, rgba(0,0,0,.14))}
/* 【涨跌分布】两列布局（task-14 ②）：左列三块（趋势/成交量/两融）、右列两块（分布/日内） */
.tw-dist-cols{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
.tw-dist-col{flex:1 1 260px;min-width:240px;display:flex;flex-direction:column;gap:10px}
.tw-dist-block{display:flex;flex-direction:column;gap:4px;min-width:0}
.tw-dist-h{font-size:12px;font-weight:600;color:var(--tw-dim);letter-spacing:.02em}
.tw-dist-kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:2px 0;border-bottom:1px solid var(--tw-border)}
.tw-dist-kv .k{color:var(--tw-dim);white-space:nowrap}
.tw-dist-kv .v{font-family:var(--tw-mono);text-align:right;min-width:0}
/* 直方图：柱用百分比宽度（窄面板也不会把某档挤成 0 宽） */
.tw-dist-hist{display:flex;align-items:flex-end;gap:2px;height:96px;padding-top:2px}
.tw-dist-bar-wrap{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;height:100%}
.tw-dist-count{font-size:12px;font-family:var(--tw-mono);color:var(--tw-dim);text-align:center;line-height:1.1;overflow:hidden}
.tw-dist-bar{display:flex;align-items:flex-end;height:64px;background:var(--tw-border);border-radius:2px 2px 0 0;overflow:hidden}
.tw-dist-bar.up .tw-dist-bar-fill{background:var(--tw-up)}
.tw-dist-bar.down .tw-dist-bar-fill{background:var(--tw-down)}
.tw-dist-bar.flat .tw-dist-bar-fill{background:var(--tw-muted)}
.tw-dist-bar-fill{width:100%;min-height:1px}
.tw-dist-label{font-size:12px;color:var(--tw-dim);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw-stat{flex:1 1 118px;min-width:96px;border-radius:10px;padding:6px 10px 7px;background:var(--tw-bg2);border:1px solid var(--tw-border);transition:background .12s,border-color .12s}
.tw-stat:hover{background:var(--tw-hover);border-color:var(--tw-border-strong)}
.tw-stat .k{font-size:12px;color:var(--tw-muted)}
.tw-stat .v{font-family:var(--tw-mono);font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.35}
.tw-btn{border:1px solid var(--tw-border);border-radius:8px;padding:1px 9px;font-size:12px;line-height:20px;color:var(--tw-dim);background:transparent;transition:color .12s,background .12s,border-color .12s;white-space:nowrap}
.tw-btn:hover{color:var(--tw-text);border-color:var(--tw-border-strong);background:var(--tw-hover)}
.tw-btn[data-primary=true]{border-color:var(--tw-accent);background:var(--tw-accent);color:#fff;font-weight:500}
.tw-btn[data-primary=true]:hover{background:var(--tw-accent-hover);border-color:var(--tw-accent-hover);color:#fff}
.tw-btn:disabled{opacity:.5;cursor:default}
.tw-input{width:100%}

/* ── tables ────────────────────────────────────────────── */
.tw-table{width:100%;border-collapse:collapse;font-size:12px}
.tw-table th{color:var(--tw-muted);font-weight:500;text-align:right;padding:3px 7px;border-bottom:1px solid var(--tw-border);white-space:nowrap;font-size:12px}
.tw-table th:first-child,.tw-table td:first-child{text-align:left}
.tw-table td{padding:4px 7px;text-align:right;font-variant-numeric:tabular-nums;border-bottom:1px solid var(--tw-border);white-space:nowrap;font-family:var(--tw-mono);font-size:12px}
.tw-table td.tl{font-family:inherit}
.tw-table tr:last-child td{border-bottom:none}
.tw-table .tl{text-align:left}
.tw-rowhover:hover{background:var(--tw-card2)}

/* ── group cards & rows ────────────────────────────────── */
/* 不能 overflow:hidden —— 行内 ⋯ 菜单是绝对定位，会被整块裁掉；
   改用「首尾子块各自圆角」维持胶囊外观。 */
.tw-group{background:var(--tw-card);border:1px solid var(--tw-border);border-radius:10px}
.tw-group > *:first-child{border-top-left-radius:10px;border-top-right-radius:10px}
.tw-group > *:last-child{border-bottom-left-radius:10px;border-bottom-right-radius:10px}
.tw-group-h{display:flex;flex-direction:column;gap:4px;padding:7px 10px;background:var(--tw-card);border-bottom:1px solid var(--tw-border)}
.tw-gh-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:20px}
.tw-gh-metrics{display:flex;gap:14px;flex-wrap:wrap;color:var(--tw-muted);font-size:12px;font-family:var(--tw-mono);padding-left:16px}
.tw-gh-metrics b{font-weight:600;color:var(--tw-text)}
.tw-group-h .gname{font-weight:650;font-size:13px;flex:none;letter-spacing:-0.2px}
.tw-group-h button.gname{color:var(--tw-dim);border-radius:8px;padding:0 3px}
.tw-group-h button.gname:hover{color:var(--tw-text);background:var(--tw-hover)}
.tw-group-h .gsum{display:flex;gap:12px;flex:1;min-width:60px;overflow:hidden;white-space:nowrap;color:var(--tw-muted);font-size:12px;font-family:var(--tw-mono)}
.tw-group-h .gsum b{font-weight:600;color:var(--tw-text)}

/* 宽屏多列下：组头不画分隔线，改由行自己的 border-top 充当那一条线。
   为什么不用 :nth-child(-n+2) 抹掉首行线：多列是按**高度均衡**竖向填充的，
   "每列第一行"是第几个子元素取决于条目数，无法用 nth-child 表达；
   组头画线 + 行画线会让除第一列外的每一列都出现双线。
   注意：必须写在这里（.tw-group-h 定义之后）—— 同优先级下 CSS 按出现顺序决胜。 */
@media (min-width:1080px){.tw-group-h{border-bottom:none}}

/* position row: two-line layout (title/price line + aligned numeric grid) */
.tw-posrow{display:flex;flex-direction:column;gap:6px;padding:7px 10px 6px;border-top:1px solid var(--tw-border);transition:background .1s;cursor:pointer}
.tw-posrow:hover{background:var(--tw-card2)}
.tw-pos-main{display:flex;align-items:center;gap:8px;min-width:0}
.tw-pos-title{display:flex;align-items:baseline;gap:6px;min-width:0;flex:1}
.tw-pos-title b{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw-pos-title small{color:var(--tw-muted);font-size:12px;font-family:var(--tw-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw-pos-price{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:1px;text-align:right}
.tw-pos-price .px{font-family:var(--tw-mono);font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.25}
.tw-pos-price .meta{font-size:12px;color:var(--tw-muted);font-family:var(--tw-mono);white-space:nowrap}
.tw-pos-grid{display:flex;flex-wrap:wrap;gap:4px 26px}
.tw-pps{flex:0 0 auto;min-width:92px}
.tw-pps .k{display:block;font-size:12px;color:var(--tw-muted);white-space:nowrap}
.tw-pps .v{display:block;font-family:var(--tw-mono);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw-pps .meta{display:block;font-size:12px;color:var(--tw-muted);font-family:var(--tw-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw-actions{display:flex;gap:4px;flex:none}
.tw-actions .tw-btn{padding:0 7px;line-height:18px}

/* overflow menu */
.tw-menu-wrap{position:relative;display:inline-flex}
.tw-iconbtn.tw-dots{line-height:16px;padding:0 6px;font-size:13px;letter-spacing:0}
.tw-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:1150;min-width:132px;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:10px;box-shadow:var(--tw-shadow-lg);padding:3px;display:flex;flex-direction:column}
.tw-menu button{display:block;width:100%;text-align:left;padding:5px 10px;font-size:12px;color:var(--tw-dim);border-radius:8px;white-space:nowrap}
.tw-menu button:hover{color:var(--tw-text);background:var(--tw-hover)}
.tw-menu button:disabled{opacity:.45;cursor:default}
.tw-menu button[data-danger=true]{color:var(--tw-up)}
.tw-menu button[data-danger=true]:hover{background:var(--tw-up-bg)}

/* watch rows */
.tw-wrow{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--tw-border);transition:background .1s;cursor:pointer}
.tw-wrow:hover{background:var(--tw-card2)}
/* 从复盘页点过来的那一笔：流水列表里的**静态**底色条（无动效、无闪烁；切页即消失） */
.tw-wrow[data-focus=true]{background:var(--tw-accent-soft);border-radius:6px}
.tw-wrow .nm{flex:1;min-width:0}
.tw-wrow .nm b{font-size:12px;font-weight:600}
.tw-wrow .nm small{display:block;color:var(--tw-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw-wrow .wq{display:flex;gap:6px;align-items:baseline;font-variant-numeric:tabular-nums;flex:none;font-family:var(--tw-mono);font-size:12px}

/* ── hover popup ───────────────────────────────────────── */
.tw-pop{position:absolute;z-index:9999;width:330px;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:12px;box-shadow:var(--tw-shadow-lg);padding:9px 11px 7px;pointer-events:auto;cursor:pointer;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--tw-text)}
.tw-pop .ph{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
.tw-pop .ph .nm{font-weight:650;font-size:13px}
.tw-pop .ph .px{font-family:var(--tw-mono);font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.tw-pop .ph .tag{color:var(--tw-dim);font-size:12px;font-family:var(--tw-mono)}
.tw-pop .tw-pop-hint{color:var(--tw-accent);font-family:inherit}
.tw-pop .pl{display:flex;gap:12px;color:var(--tw-muted);margin-top:3px;font-variant-numeric:tabular-nums;flex-wrap:wrap;font-size:12px;font-family:var(--tw-mono)}

/* ── modal ─────────────────────────────────────────────── */
.tw-mask{position:fixed;inset:0;background:var(--tw-mask);z-index:1200;display:flex;align-items:flex-start;justify-content:center;padding:56px 14px 20px;backdrop-filter:blur(2px)}
.tw-modal{width:min(560px,94vw);max-height:82vh;overflow:auto;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:12px;box-shadow:var(--tw-shadow-lg);padding:14px 16px}
.tw-modal h3{margin:0 0 11px;font-size:13px;font-weight:600;letter-spacing:-0.3px}
.tw-field{margin-bottom:10px}
.tw-field label{display:block;font-size:12px;color:var(--tw-muted);margin-bottom:4px}
.tw-err{color:var(--tw-up);background:var(--tw-up-bg);border-radius:8px;padding:5px 10px;margin:6px 0;font-size:12px}
.tw-hint{color:var(--tw-muted);font-size:12px;margin:2px 0 6px;line-height:1.55;max-width:96ch}

/* ── segmented controls / search ───────────────────────── */
.tw-seg{display:inline-flex;border:1px solid var(--tw-border);border-radius:8px;overflow:hidden;background:var(--tw-card)}
.tw-seg button{padding:3px 11px;font-size:12px;color:var(--tw-dim);border-right:1px solid var(--tw-border);transition:background .12s,color .12s}
.tw-seg button:last-child{border-right:none}
.tw-seg button:hover{color:var(--tw-text);background:var(--tw-hover)}
.tw-seg button[data-on=true]{background:var(--tw-accent-soft);color:var(--tw-accent);font-weight:600}
.tw-suggest{position:absolute;z-index:1100;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:10px;box-shadow:var(--tw-shadow-lg);overflow:auto;min-width:240px}
/* v0.96.2：高度不再写死（262px 曾把候选裁成一行）——由 suggestView.suggestDropdownBoxOf 按视口实测给 max-height */
.tw-suggest button{display:flex;justify-content:space-between;gap:12px;width:100%;text-align:left;padding:6px 11px;font-size:12px}
.tw-suggest button:hover{background:var(--tw-hover)}
/* 键盘高亮（P1-4）：与 hover 同一视觉（背景色，无动画、无闪烁）；读屏另有 aria-selected */
.tw-suggest button[data-active=true]{background:var(--tw-hover);box-shadow:inset 2px 0 0 var(--tw-accent)}
.tw-suggest .k{color:var(--tw-muted);font-size:12px;flex:none}
.tw-badge{font-size:12px;color:var(--tw-dim);border:1px solid var(--tw-border);border-radius:10px;padding:0 6px;white-space:nowrap}
.tw-loading{color:var(--tw-muted);text-align:center;padding:26px 0}
.tw-error{color:var(--tw-up);text-align:center;padding:14px}
/* row action buttons: tinted so they read as controls, not plain text */
.tw-actions .tw-btn{background:var(--tw-bg2);border-color:var(--tw-border)}
.tw-actions .tw-btn:hover{background:var(--tw-hover);border-color:var(--tw-accent);color:var(--tw-accent)}
/* narrow sidebar: keep only 买/卖 + ⋯ (调整 lives in the overflow menu) */
.tw-posrow{container-type:inline-size}
@container (max-width:430px){.tw-actions .tw-btn[data-verb=adjust]{display:none}}
/* keyboard focus */
.tw-qcard:focus-visible,.tw-wrow:focus-visible,.tw-posrow:focus-visible,.tw-table tr:focus-visible{outline:2px solid var(--tw-accent);outline-offset:-2px}
/* internal scroll + sticky header for long tables */
.tw-tablewrap{max-height:46vh;overflow:auto}
.tw-tablewrap .tw-table th{position:sticky;top:0;background:var(--tw-card);z-index:2;box-shadow:inset 0 -1px 0 var(--tw-border)}
/* inline code chip next to a watch name */
/* 非行情数字，豁免（不登记进模糊清单）：代码/ID 不是行情数字 */
.tw-code{color:var(--tw-muted);font-family:var(--tw-mono);font-size:12px;margin-left:6px}


/* ── skeleton & empty states ───────────────────────────── */
.tw-skel{position:relative;overflow:hidden;border-radius:8px;background:var(--tw-card2)}
.tw-skel::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,var(--tw-hover) 50%,transparent 70%);animation:twshimmer 1.5s infinite}
@keyframes twshimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.tw-skel-stack{display:flex;flex-direction:column;gap:8px;padding:8px 2px}
.tw-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 10px;color:var(--tw-muted);text-align:center}
.tw-kline{display:flex;flex-direction:column;gap:2px}
.tw-ma-legend{display:flex;gap:10px;flex-wrap:wrap}
.tw-zoom{margin-top:6px;display:flex;flex-direction:column;gap:5px}
.tw-zoom-track{position:relative;height:16px;border-radius:8px;background:var(--tw-card2);border:1px solid var(--tw-border);cursor:pointer}
.tw-zoom-sel{position:absolute;top:0;bottom:0;background:var(--tw-accent-soft);border-left:1px solid var(--tw-accent);border-right:1px solid var(--tw-accent);pointer-events:none;border-radius:2px}
.tw-zoom-h{position:absolute;top:-3px;width:12px;height:22px;border-radius:6px;background:var(--tw-card);border:1px solid var(--tw-border-strong);box-shadow:var(--tw-shadow-sm);cursor:ew-resize;touch-action:none}
.tw-zoom-h::after{content:"";position:absolute;left:4.5px;top:6px;width:2px;height:9px;background:var(--tw-muted);border-radius:1px}
.tw-cal-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0 8px}
.tw-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.tw-cal-dow{margin-bottom:2px}
.tw-cal-dowcell{text-align:center;font-size:12px;color:var(--tw-muted);padding:2px 0}
.tw-cal-cell{min-height:74px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-card);padding:3px 4px;display:flex;flex-direction:column;gap:2px;overflow:hidden;cursor:pointer;transition:border-color .12s,background .12s}
.tw-cal-cell:hover{border-color:var(--tw-accent);background:var(--tw-hover)}
.tw-cal-cell.is-out{opacity:.45}
.tw-cal-cell.is-today{border-color:var(--tw-accent);box-shadow:inset 0 0 0 1px var(--tw-accent-soft)}
/* 非行情数字，豁免（不登记进模糊清单）：日历格子里的日号 */
.tw-cal-day{display:flex;align-items:center;gap:4px;font-size:12px;font-family:var(--tw-mono);color:var(--tw-dim)}
.tw-cal-cell.is-today /* 非行情数字，豁免（不登记进模糊清单）：日历格子里的日号 */
.tw-cal-day{color:var(--tw-accent);font-weight:700}
.tw-cal-count{margin-left:auto;font-size:12px;color:var(--tw-muted);border:1px solid var(--tw-border);border-radius:8px;padding:0 4px}
.tw-cal-pill{font-size:12px;line-height:1.35;border:1px solid;border-radius:5px;padding:0 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.tw-cal-more{font-size:12px;color:var(--tw-muted);text-align:right;cursor:pointer}
.tw-cal-card{border-left:3px solid var(--tw-accent);background:var(--tw-card2);border-radius:6px;padding:7px 9px;margin-bottom:8px}
.tw-zoom-bar{display:flex;align-items:center;gap:6px;font-size:12px;font-family:var(--tw-mono)}
.tw-chartnote{display:flex;gap:12px;flex-wrap:wrap;color:var(--tw-muted);font-size:12px;margin:6px 0 2px;font-family:var(--tw-mono);flex:none}
/* 复权口径段控（详情图右上角）：默认前复权；指数/期货禁用并标"不适用" */
.tw-fq{flex:none;display:inline-flex;align-items:center;gap:3px;padding:2px 4px 2px 6px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-bg2)}
.tw-fq .k{font-size:12px;color:var(--tw-muted);margin-right:2px}
.tw-fq-btn{min-height:22px;padding:0 7px;font-size:12px;color:var(--tw-dim);background:transparent;border:1px solid transparent;border-radius:6px;transition:background .12s,color .12s,border-color .12s;white-space:nowrap}
.tw-fq-btn:hover:not(:disabled){color:var(--tw-text);background:var(--tw-hover)}
.tw-fq-btn[data-on=true]{color:var(--tw-text);font-weight:600;background:var(--tw-accent-soft);border-color:var(--tw-accent);letter-spacing:-0.15px}
.tw-fq-btn:disabled{opacity:.45;cursor:not-allowed}
.tw-fq-hint{font-size:12px;color:var(--tw-muted);padding:0 2px}

/* ── row mini trend + detail drawer ─────────────────────── */
.tw-mini{flex:none;border:1px solid var(--tw-border);border-radius:8px;padding:1px 3px;background:var(--tw-bg2);display:inline-flex;line-height:0;transition:border-color .12s,background .12s}
.tw-mini:hover{border-color:var(--tw-accent);background:var(--tw-card)}
.tw-mini svg{display:block}
.tw-drawer-mask{position:fixed;inset:0;background:var(--tw-mask);z-index:1300;display:flex;justify-content:flex-end;backdrop-filter:blur(2px)}
.tw-drawer{width:min(720px,96vw);height:100%;background:var(--tw-card);border-left:1px solid var(--tw-border-strong);box-shadow:var(--tw-shadow-lg);display:flex;flex-direction:column;animation:twslide .2s ease-out}
@keyframes twslide{from{transform:translateX(28px);opacity:.3}to{transform:translateX(0);opacity:1}}
.tw-drawer-head{padding:12px 14px 10px;border-bottom:1px solid var(--tw-border);flex:none}
.tw-drawer .tw-tabs{padding:6px;background:transparent;border-bottom:1px solid var(--tw-border);border-top:none;flex:none}
.tw-drawer-body{flex:1;overflow:auto;padding:10px 12px 8px;
  display:flex;flex-direction:column;min-height:0}
.tw-drawer-foot{flex:none;display:flex;gap:12px;padding:7px 14px;border-top:1px solid var(--tw-border);font-size:12px}
.tw-dkv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(98px,1fr));gap:2px 16px}
.tw-dkv .k{display:block;font-size:12px;color:var(--tw-muted);white-space:nowrap}
.tw-dkv .v{font-family:var(--tw-mono);font-size:12px;font-weight:550;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}


/* ── 护盘信号 ───────────────────────────────────────────────────────────── */
.tw-rescue{display:flex;flex-direction:column;gap:6px}
.tw-rescue-dot{width:9px;height:9px;border-radius:50%;flex:none;transition:background .2s}
.tw-rescue-resonance{display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 8px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-bg);flex-wrap:wrap}
.tw-rescue-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:8px}
.tw-rescue-card{border:1px solid var(--tw-border);border-radius:9px;padding:7px 9px;background:var(--tw-card);transition:border-color .15s}
.tw-rescue-card-h{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:5px}
.tw-rescue-card-h b{font-size:12px;font-weight:600;letter-spacing:-0.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw-rescue-card-h span{font-size:12px;flex:none;font-variant-numeric:tabular-nums}
.tw-rescue-card-grid{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:2px 8px;font-size:12px}
.tw-rescue-card-grid .k{color:var(--tw-muted);white-space:nowrap}
.tw-rescue-card-grid .v{font-family:var(--tw-mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tw-rescue-card-f{display:flex;align-items:center;gap:8px;margin-top:6px;padding-top:5px;border-top:1px solid var(--tw-border)}
.tw-rescue-bar{height:5px;border-radius:3px;background:var(--tw-border);overflow:hidden;display:inline-block;flex:none;vertical-align:middle}
/* P2-11：条长改 transform:scaleX()（原来动 width ⇒ 每帧 layout）。
   transform-origin:left + width:100% 等价于原来的 width:pct%，视觉不变。 */
.tw-rescue-bar i{display:block;height:100%;width:100%;border-radius:3px;transform-origin:left center;transition:transform .25s}
.tw-rescue-split{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px}
@media (max-width:900px){.tw-rescue-split{grid-template-columns:1fr}}
.tw-sub-h{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--tw-dim);text-transform:none;letter-spacing:0.2px;margin:2px 0 5px;padding-bottom:3px;border-bottom:1px solid var(--tw-border)}
.tw-chip{font-size:12px;color:var(--tw-muted);border:1px solid var(--tw-border);border-radius:9px;padding:0 6px;cursor:pointer;line-height:16px}
.tw-chip:hover{border-color:var(--tw-accent);color:var(--tw-text)}
.tw-chip[data-on=true]{color:#fff;background:var(--tw-accent);border-color:var(--tw-accent)}
.tw-rescue-svg{display:block;background:var(--tw-bg);border-radius:6px}
.tw-rescue-factor{width:100%;border-collapse:collapse;font-size:12px}
.tw-rescue-factor th{text-align:left;font-weight:500;color:var(--tw-dim);font-size:12px;padding:3px 4px;border-bottom:1px solid var(--tw-border);white-space:nowrap}
.tw-rescue-factor td{padding:4px;border-bottom:1px solid var(--tw-border);vertical-align:middle;line-height:1.45}
.tw-rescue-factor tr[data-hit=true] td{background:var(--tw-accent-soft)}
.tw-rescue-timeline{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto}
.tw-rescue-tl-row{display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0}
.tw-rescue-intraday{display:flex;flex-wrap:wrap;gap:2px}
.tw-rescue-ip{width:7px;height:14px;border-radius:2px;display:inline-block}
.tw-rescue-history{display:flex;flex-direction:column;gap:2px;max-height:186px;overflow:auto}
.tw-rescue-h-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 5px;border-radius:6px;cursor:pointer}
.tw-rescue-h-row:hover{background:var(--tw-hover)}
.tw-rescue-pool{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:3px 10px;font-size:12px}
.tw-rescue-pool-item{display:flex;align-items:center;gap:5px;color:var(--tw-muted);cursor:pointer}
.tw-rescue-pool-item[data-on=true]{color:var(--tw-text)}
/* 覆盖广度短标记（阶段一）：常驻只有「3 族 · 5/6」或「—」；口径全在 title/aria，不占版面 */
.tw-rescue-cov{font-size:12px;font-variant-numeric:tabular-nums;letter-spacing:0}

/* 右上角小圆形提示 icon（替代"详情不可用 + 重试"长条）：常驻只有一个字符 */
.tw-noteicon{position:absolute;top:6px;right:8px;width:18px;height:18px;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;
  border:1px solid var(--tw-border-strong);background:var(--tw-card);color:var(--tw-muted);cursor:default}
.tw-noteicon-btn{cursor:pointer}
.tw-noteicon:focus-visible{outline:2px solid var(--tw-border-strong);outline-offset:1px}
.tw-hint-icon{position:relative;padding-right:28px}

/* 筹码分布区块（抽屉内、图表下方）：**铺满剩余高度**（v0.55.0）。
   为什么：body 里只有它可伸缩 ⇒ 上窗（split.top）+ 分割线 + 筹码块 == body 内容高，空白恒 0。
   此前 ".tw-chips-body{max-height:160px}" + ".tw-chips-chart{max-height:140px}" 把这块钉死在 ~184px，
   抽屉越高、下方空白越大（用户报"筹码模块下方大片空白"）。 */

.tw-panes{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.tw-chart-pane{display:flex;flex-direction:column;flex:none;min-height:0}
.tw-split{position:relative;height:9px;cursor:row-resize;user-select:none;flex:0 0 auto}
.tw-split-line{position:absolute;left:0;right:0;top:4px;height:1px;background:var(--tw-border-strong)}
.tw-split:focus-visible .tw-split-line{background:var(--tw-text);height:2px}
.tw-chart-wrap{position:relative;flex:none}
.tw-chart-loading{position:absolute;inset:0;pointer-events:none;background:color-mix(in srgb,var(--tw-card) 42%,transparent)}
.tw-chart-loading-bar{height:2px;width:38%;margin:0 auto;background:var(--tw-muted);opacity:.75;
  animation:tw-indet 1.1s ease-in-out infinite}
.tw-chart-loading-text{position:absolute;right:6px;bottom:4px;font-size:12px;color:var(--tw-muted)}
@keyframes tw-indet{0%{transform:translateX(-40%)}50%{transform:translateX(120%)}100%{transform:translateX(-40%)}}
/* 筹码块：**唯一的伸缩项**（"flex:1 1 auto; min-height:0"）⇒ 剩余高度全归它（多显行），不留死空白 */
.tw-chips{border-top:1px solid var(--tw-border);margin-top:6px;padding:4px 2px 2px;
  flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
/* 折叠态：不伸缩（剩余高度交给上窗），否则收起来还占一大块 */
.tw-chips-collapsed{flex:none}
.tw-chips-off{color:var(--tw-muted);font-size:12px;padding:4px 2px}
.tw-chips-head{display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;flex:none}
.tw-chips-toggle{background:transparent;border:0;color:var(--tw-text);font-size:12px;cursor:pointer;padding:0}
.tw-chips-nums{display:flex;align-items:center;gap:6px;font-family:var(--tw-mono);font-size:12px;white-space:nowrap}
.tw-chips-sep{width:1px;height:10px;background:var(--tw-border-strong);display:inline-block}
.tw-chips-narrow{font-size:12px;color:var(--tw-muted);padding:2px 0;flex:none}
.tw-chips-body{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-height:0}
.tw-chips-slider{width:100%;margin:2px 0;flex:none}
.tw-chips-date{font-size:12px;font-family:var(--tw-mono);flex:none}
.tw-chips-chart{display:flex;gap:4px;align-items:stretch;overflow:hidden;flex:1 1 auto;min-height:0}
/* 左轴：价格列**固定不伸缩**（flex:none）—— 否则空间不足时它会被压缩，条列的宽度就不确定了。
   max-width 把"价格位数决定轴宽"这一步也钉住：轴宽在 [34, 60] 内由内容决定，超过就换行，
   于是条列宽度不会随价格位数（如 5.47 vs 1553.40）抖动。 */
.tw-chips-axis{display:flex;flex-direction:column;justify-content:space-between;font-size:12px;color:var(--tw-muted);
  font-family:var(--tw-mono);min-width:34px;max-width:60px;flex:none;text-align:right;line-height:1;overflow-wrap:anywhere}
/* 条列：条宽的 % 分母必须是"确定性的可用宽度"（旧名 .tw-chips-bars 已删，现名见下方 .tw-chips-plot） */
.tw-chips-xaxis{display:flex;justify-content:space-between;font-size:12px;color:var(--tw-muted);font-family:var(--tw-mono);padding-left:38px;flex:none}
/* 条列：**唯一的伸缩项**（flex:1）+ min-width:0（内容不许参与最小宽度计算）。
   这两条合起来保证：条列宽度 = 容器 − 左轴 − 间隙，与条宽写成多少 % 无关。
   反例：写成 flex:none（或忘了 min-width:0 又被内容顶住）⇒ 条列宽度归零/塌陷，
   同样 86% 的条会渲染成很小的像素数 —— 用户看到的"条被压到左侧"就是这个几何。 */
.tw-chips-plot{position:relative;flex:1 1 auto;min-width:0;overflow-x:hidden;
  display:flex;flex-direction:column;gap:1px}
/* 分布轮廓（v0.55.0）：把各桶**柱端**按桶顺序连成折线 —— 视觉引导，**不是新数据**
   （每个顶点都是同一个 bucket 经同一个 widthOf 换来；空桶照实经过 0）。 */
.tw-chips-profile{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.tw-chips-profile-line{fill:none;stroke:var(--tw-chip-profile);stroke-width:1;opacity:.72;
  stroke-linejoin:round}
.tw-chips-grid-v{position:absolute;top:0;bottom:0;width:1px;background:var(--tw-chips-grid);pointer-events:none}
.tw-chips-grid-h{position:absolute;left:0;right:0;height:1px;background:var(--tw-chips-grid);pointer-events:none}
.tw-chips-refline{position:absolute;left:0;right:44px;height:0;border-top:1px dashed currentColor;pointer-events:none;opacity:.9}
.tw-chips-reflabel{position:absolute;right:0;transform:translateY(-50%);font-size:12px;font-family:var(--tw-mono);pointer-events:none}
.tw-chips-bar{height:3px;border-radius:1px;background:currentColor;min-width:1px}

/* 复盘条（做T 收起态 + 分档卡）与批量录入模态（P2-9 / P1-3 / P2-1）*/
.tw-review{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 2px;border-top:1px solid var(--tw-border)}
.tw-review-toggle{background:transparent;border:1px solid var(--tw-border-strong);border-radius:999px;
  padding:2px 10px;font-size:12px;color:var(--tw-text);cursor:pointer}
.tw-review-toggle[aria-expanded=true]{background:var(--tw-hover)}
.tw-daytrade-table{margin:4px 0 0;font-size:12px;width:100%}
.tw-daytrade-table th{color:var(--tw-muted);font-weight:500;text-align:left}
.tw-review-note{font-size:12px;color:var(--tw-muted)}
.tw-review-buckets{display:flex;align-items:center;gap:6px;font-size:12px}
.tw-review-btitle{color:var(--tw-muted)}
.tw-review-bline{font-family:var(--tw-mono)}

.tw-bulk{position:fixed;z-index:1180;left:50%;top:8vh;transform:translateX(-50%);width:min(680px,calc(100vw - 24px));
  max-height:80vh;overflow:auto;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:12px;
  box-shadow:0 10px 34px rgba(0,0,0,.32);padding:0 0 10px}
.tw-bulk-h{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--tw-border);position:sticky;top:0;background:inherit}
.tw-bulk-title{font-weight:600;font-size:12.5px}
.tw-bulk-stage{flex:1;color:var(--tw-muted);font-size:12px}
.tw-bulk-body{padding:10px 12px}
.tw-bulk-tip{font-size:12px;color:var(--tw-muted);margin-bottom:6px}
.tw-bulk-text{width:100%;font-family:var(--tw-mono);font-size:12px;background:var(--tw-card);color:var(--tw-text);
  border:1px solid var(--tw-border-strong);border-radius:8px;padding:8px;resize:vertical}
.tw-bulk-tools{display:flex;align-items:center;gap:8px;margin-top:8px}
.tw-bulk-sum{font-size:12px;color:var(--tw-muted);font-family:var(--tw-mono)}
.tw-bulk-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.tw-bulk-table{width:100%;font-size:12px;margin-top:6px}
.tw-bulk-table th{color:var(--tw-muted);font-weight:500;text-align:left}
.tw-bulk-errors{margin-top:10px;border-top:1px dashed var(--tw-border);padding-top:6px}
.tw-bulk-errh{font-size:12px;color:var(--tw-muted);margin-bottom:4px}
.tw-bulk-err{font-size:12px;color:var(--tw-muted);display:flex;flex-direction:column;gap:2px;margin-bottom:4px}
.tw-bulk-raw{font-family:var(--tw-mono);font-size:12px;color:var(--tw-muted);white-space:pre-wrap;word-break:break-all}
.tw-bulk-ok{font-size:12px}

/* 行情卡片五档状态 badge（设计 §4）—— 独立色系（靛蓝→青→石板灰→紫→品红），不含红/绿/琥珀。
   底色＝档位色 12%（浅）/16%（深），文字与边框＝档位色本体；色盲兜底是**文字本身**。 */
.tw-tone{position:absolute;top:4px;right:4px;height:16px;line-height:16px;padding:0 5px;border-radius:7px;
  font-size:12px;border:1px solid currentColor;background:currentColor;background-clip:padding-box;
  pointer-events:none;white-space:nowrap}
/* 让位：只动名称行的内边距与延迟点位置，卡片外框尺寸逐像素不变（价格/涨跌行不被压） */
.tw-qcard[data-tone] .nm{padding-right:40px}
/* 延迟绿点左移让位（badge 占右 4..36px，点占 42..48px）；无 tone 时保持原位 */
.tw-qcard[data-tone] .tw-qdot{right:42px}
.tw-qcard .tw-kind{color:var(--tw-muted);font-size:12px;margin-left:3px}
/* 五档色（浅色主题） */
.tw-tone[data-tone=过冷]{color:#2B4C9B;background:#2B4C9B1f;border-color:#2B4C9B}
.tw-tone[data-tone=偏冷]{color:#176B87;background:#176B871f;border-color:#176B87}
.tw-tone[data-tone=适中]{color:#5A6270;background:#5A62701f;border-color:#5A6270}
.tw-tone[data-tone=偏热]{color:#7B3FA8;background:#7B3FA81f;border-color:#7B3FA8}
.tw-tone[data-tone=过热]{color:#A32C7A;background:#A32C7A1f;border-color:#A32C7A}
/* 深色主题：同色系更亮的一档（对比度 ≥4.5:1，见设计 §4 的实算） */
.tw-root[data-theme=dark] .tw-tone[data-tone=过冷]{color:#7EA6FF;background:#7EA6FF29;border-color:#7EA6FF}
.tw-root[data-theme=dark] .tw-tone[data-tone=偏冷]{color:#57C7E0;background:#57C7E029;border-color:#57C7E0}
.tw-root[data-theme=dark] .tw-tone[data-tone=适中]{color:#A7B0C0;background:#A7B0C029;border-color:#A7B0C0}
.tw-root[data-theme=dark] .tw-tone[data-tone=偏热]{color:#C4A2FF;background:#C4A2FF29;border-color:#C4A2FF}
.tw-root[data-theme=dark] .tw-tone[data-tone=过热]{color:#F08BC7;background:#F08BC729;border-color:#F08BC7}

/* 行情卡片配置窗（设计 §1）：z-index 1180 ⇒ 高于 .tw-menu(1150)/.tw-suggest(1100)，
   低于 .tw-mask(1200)；打开时父组件隐藏悬浮卡（.tw-pop 是 9999）。 */
.tw-cfg{position:fixed;z-index:1180;max-height:min(70vh,520px);overflow:auto;border-radius:12px;
  background:var(--tw-card);border:1px solid var(--tw-border-strong);box-shadow:0 8px 30px rgba(0,0,0,.28);
  backdrop-filter:blur(6px);padding:0 0 8px}
.tw-cfg-h{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;touch-action:none;
  border-bottom:1px solid var(--tw-border);position:sticky;top:0;background:inherit}
.tw-cfg-title{flex:1;font-weight:600;font-size:12px}
.tw-cfg-tools{display:flex;gap:6px;padding:8px 10px 4px}
.tw-cfg-group{padding:4px 10px}
.tw-cfg-grouphead{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;cursor:pointer}
.tw-cfg-groupt{flex:1}
.tw-cfg-sub{font-size:12px;color:var(--tw-muted);font-family:var(--tw-mono)}
.tw-cfg-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:2px 8px;
  max-height:220px;overflow:auto;padding:2px 0 2px 18px}
.tw-cfg-item{display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer}
.tw-cfg-foot{display:flex;align-items:center;gap:8px;padding:6px 10px 0;border-top:1px solid var(--tw-border)}
.tw-cfg-count{font-family:var(--tw-mono);font-size:12px}

/* 图表细节卡（跟随光标的半透明卡片）+ 光标层容器 —— task-28 */
.tw-cursorwrap{position:relative}
.tw-cursorwrap svg{outline:none}
.tw-cursorwrap svg:focus-visible{outline:2px solid var(--tw-accent);outline-offset:1px}
.tw-chart-tip{position:absolute;z-index:5;pointer-events:none;padding:6px 8px;border-radius:8px;
  border:1px solid var(--tw-border-strong);background:color-mix(in srgb, var(--tw-card) 82%, transparent);
  backdrop-filter:blur(3px);box-shadow:0 2px 10px rgba(0,0,0,.18)}
.tw-chart-tip-row{display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:16px;white-space:nowrap}
.tw-chart-tip-k{color:var(--tw-muted)}
.tw-chart-tip-v{font-family:var(--tw-mono);font-variant-numeric:tabular-nums;color:var(--tw-text)}
/* ⚠ 涨跌色必须**作用域提升**：tw-up/tw-down 是单类选择器（0,1,0），而上面的
   .tw-chart-tip-v{color:var(--tw-text)} 同为 0,1,0 且位置在后 ⇒ 会把涨跌色覆盖成中性色
   （实测：卡片里百分比挂上了 tw-up/tw-down 也不生效）。这里用 0,2,0 稳赢，不依赖规则顺序。 */
.tw-chart-tip .tw-up{color:var(--tw-up)}
.tw-chart-tip .tw-down{color:var(--tw-down)}
.tw-chart-tip .tw-muted{color:var(--tw-muted)}

/* ── 工具箱详情页：对齐 Arkvol 参考版（令牌与判据的唯一来源 = src/client/toolDetailTheme.ts） ──
   这里只放**必须由 CSS 承担**的部分：纵向节奏、边框分层、磁贴网格、Hero 分栏、范围控件，
   以及动效的 keyframes 与 reduced-motion 降级。尺寸/字号的数字都不写在这里（免得两处漂移）。 */
.tw-tool-detail{display:flex;flex-direction:column;gap:22px;padding:12px 16px 24px} /* 间距/内边距由 toolDetailTheme.TOOL_SPACE 内联给（单一来源） */
.tw-tool-card{border:1px solid var(--tw-border-strong);border-radius:14px;background:var(--tw-card);padding:18px;box-shadow:none}
.tw-tool-hero{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.tw-tool-hero-main{display:flex;flex-direction:column;gap:10px;min-width:260px;flex:1}
.tw-tool-range{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--tw-border);border-radius:10px;background:var(--tw-bg2);flex-shrink:0}
.tw-tool-range>button{padding:4px 10px;border-radius:8px;font-size:12.5px;color:var(--tw-muted);transition:background .15s,color .15s,border-color .15s}
.tw-tool-range>button[data-on=true]{background:var(--tw-card);border:1px solid var(--tw-border-strong);color:var(--tw-text);font-weight:600}
.tw-tool-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px}
/* 杠杆温度计：两行 × 四列卡片（窄侧栏折成两列，**不**折成纵向长列表；间距由内联令牌给） */
.tw-lev-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
@media (max-width:760px){.tw-lev-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
.tw-tool-plot{position:relative;width:100%}
.tw-tool-plot>svg{display:block;width:100%;height:100%}
.tw-tool-plot .tw-tool-cross{pointer-events:none}
@keyframes tw-tool-in{from{opacity:.35}to{opacity:1}}
/* reduced-motion：系统偏好 ⇒ 关键帧动画与过渡全部停用（图与交互仍可用） */
@media (prefers-reduced-motion:reduce){
  .tw-tool-line,.tw-tool-fade{animation:none!important}
  .tw-tool-plot *,.tw-tool-range>button{transition:none!important}
}
/* 页面开关（由 matchMedia 驱动）：与系统偏好等效，且**可断言** */
.tw-tool-plot[data-anim=off] *,.tw-tool-range[data-anim=off]>button{animation:none!important;transition:none!important}
/* 图表卡两列（用户第四批）：左 = 折线图，右 = 饼图 + 回放滑块。
   窄屏（移动/窄面板）回落为**上下堆叠**：单列时右列自然落到折线图下方。 */
.tw-tool-split{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(220px,1fr);align-items:start}
.tw-tool-pie-legend{display:flex;justify-content:center;flex-wrap:wrap;gap:6px 12px}
@media (max-width:900px){
  .tw-tool-split{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:760px){
  .tw-tool-hero{flex-direction:column}
}
/* ── 复盘页（第 7 个页签）：月历 + 当日笔记 ─────────────────────────────────
   只订 12/13 两档字号（密集阶梯），颜色全走既有 token（不硬编码色值，
   隐身档由 [data-view=incognito] 统一灰化）。状态只用 data-kind 区分：
   交易日 = 实线卡片；休市 = 暗底 + 灰字 + 「休市」；未知 = **虚线**（不许画成交易日）。
   ⚠ 这段必须写在玻璃浮层那段**之前**：.tw-glass 依赖"后写者胜"才盖得住浮层的底/描边。
   ⚠ 注释里不许出现反引号：这里是模板字面量内部，反引号会提前结束 TW_CSS。 */
.tw-fp-wrap{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
.tw-fp-cal{flex:1 1 460px;min-width:0}
.tw-fp-side{flex:1 1 340px;min-width:0}
.tw-fp-legend{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--tw-muted);padding:0 0 4px}
.tw-fp-legend-item[data-kind=trading]{color:var(--tw-text)}
.tw-fp-legend-item[data-kind=closed]{color:var(--tw-fg-dim)}
.tw-fp-legend-item[data-kind=unknown]{color:var(--tw-warn)}
.tw-fp-grid{display:flex;flex-direction:column;gap:4px}
.tw-fp-row{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.tw-fp-dow{text-align:center;font-size:12px;color:var(--tw-muted);padding:2px 0}
.tw-fp-cell{min-height:56px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-card);padding:3px 5px;display:flex;flex-direction:column;gap:2px;cursor:pointer;outline:none;transition:border-color .12s,background .12s}
.tw-fp-cell:hover{border-color:var(--tw-accent);background:var(--tw-hover)}
.tw-fp-cell:focus-visible{border-color:var(--tw-accent);box-shadow:0 0 0 3px var(--tw-ring)}
.tw-fp-cell[data-out=true]{opacity:.45}
.tw-fp-cell[data-on=true]{border-color:var(--tw-accent);box-shadow:inset 0 0 0 1px var(--tw-accent-soft)}
.tw-fp-cell[data-kind=closed]{background:var(--tw-bg2)}
.tw-fp-cell[data-kind=closed] .tw-fp-dom{color:var(--tw-muted)}
.tw-fp-cell[data-kind=unknown]{border-style:dashed}
.tw-fp-dom{display:flex;align-items:center;gap:4px;font-size:12px;font-family:var(--tw-mono);color:var(--tw-dim)}
/* 月历格子里的标记：笔记 = ●，交易 = ▲+笔数（只用形状；颜色留给涨跌，所以这里一律 var(--tw-text)） */
.tw-fp-marks{display:flex;align-items:center;gap:6px;font-size:12px;font-family:var(--tw-mono);color:var(--tw-text)}
.tw-fp-pinmark{font-size:12px;color:var(--tw-warn);border:1px solid var(--tw-warn);border-radius:6px;padding:0 3px;line-height:1.3}
.tw-fp-unknown{font-size:12px;color:var(--tw-warn)}
.tw-fp-closed{font-size:12px;color:var(--tw-muted)}
.tw-fp-meta{font-size:12px;color:var(--tw-muted);font-variant-numeric:tabular-nums}
.tw-fp-label{font-size:12px;color:var(--tw-dim)}
.tw-fp-notes{display:flex;flex-direction:column;gap:6px}
.tw-fp-note{border:1px solid var(--tw-border);border-left:3px solid var(--tw-accent);border-radius:8px;background:var(--tw-card2);padding:6px 8px;display:flex;flex-direction:column;gap:5px}
.tw-fp-note[data-foreign=true]{border-left-color:var(--tw-warn)}
.tw-fp-text{font-size:13px;line-height:1.6;color:var(--tw-text);white-space:pre-wrap;word-break:break-word}
.tw-fp-meta-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tw-fp-pinlabel{font-size:12px;color:var(--tw-warn);border:1px solid var(--tw-warn);border-radius:8px;padding:0 5px}
.tw-fp-pinlabel[data-kind=to]{color:var(--tw-fg-dim);border-color:var(--tw-border)}
.tw-fp-split{font-size:12px;color:var(--tw-muted);padding:5px 0 3px;border-top:1px dashed var(--tw-border)}
.tw-fp-editor{border-top:1px dashed var(--tw-border);padding-top:8px;display:flex;flex-direction:column;gap:6px}
.tw-fp-metarow{display:flex;align-items:center;gap:8px}
.tw-fp-editrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tw-fp-date{width:auto;font-size:12px}
.tw-fp-ok{font-size:12px;padding:2px 0}
.tw-fp-warn{font-size:12px;color:var(--tw-warn);background:var(--tw-bg2);border:1px solid var(--tw-warn);border-radius:8px;padding:4px 8px;margin:4px 0}
.tw-fp-fail{display:flex;flex-direction:column;gap:4px}
/* 当日交易（只读）：逐笔一行一个 button（键盘可达）；点一下切到持仓页的流水并静态高亮那一笔 */
.tw-fp-trades-block{border-top:1px dashed var(--tw-border);padding-top:8px;display:flex;flex-direction:column;gap:6px}
.tw-fp-trades{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}
.tw-fp-trade{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto auto;gap:8px;align-items:center;width:100%;font-size:12px;font-family:var(--tw-mono);color:var(--tw-text);background:none;border:1px solid transparent;border-radius:6px;padding:3px 5px;text-align:left;cursor:pointer;outline:none}
.tw-fp-trade:hover{background:var(--tw-hover);border-color:var(--tw-border)}
.tw-fp-trade:focus-visible{border-color:var(--tw-accent);box-shadow:0 0 0 3px var(--tw-ring)}
.tw-fp-trade-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw-fp-trade-fee{color:var(--tw-muted)}
@media (max-width:760px){
  .tw-fp-wrap{flex-direction:column}
  .tw-fp-cal,.tw-fp-side{flex:1 1 auto;width:100%}
}
@media (prefers-reduced-motion:reduce){
  .tw-fp-cell{transition:none!important}
}
/* ── 玻璃浮层（采纳竞品"半透明 + 背景模糊 + 饱和度"的做法；值来自本主题的 --tw-glass-*） ──
   ⚠ 这段必须放在**样式表末尾**：.tw-glass 与 .tw-pop / .tw-chart-tip 同特异性，
   靠"后写者胜"才能让玻璃的底/描边/模糊真正生效（判据见 toolDetailTheme.motionCssProblems + uiuxDiscipline.test.ts）。
   ⚠ 注释里**不许出现反引号**：这里是模板字面量内部，反引号会提前结束 TW_CSS（实测把 TW_CSS 变成了字符串片段）。 */
.tw-glass{background:var(--tw-glass-bg);border:1px solid var(--tw-glass-border);
  backdrop-filter:blur(var(--tw-glass-blur)) saturate(var(--tw-glass-saturate));
  -webkit-backdrop-filter:blur(var(--tw-glass-blur)) saturate(var(--tw-glass-saturate))}
/* 关闭态：不占图层、不吃点击（竞品约定） */
.tw-glass[data-open=false]{display:none}
@media (prefers-reduced-motion:reduce){
  .tw-glass,.tw-glass *{animation:none!important;transition:none!important}
}

/* ── 棱镜（hybrid：现有底色 token + MD 强调/tonal；elevation 0/1/3） ── */
.tw-root{--tw-elev-0:none;--tw-elev-1:0 1px 2px rgba(16,24,40,.05);--tw-prism-card-shadow:0 1px 2px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.04);--tw-elev-3:0 1px 3px rgba(16,24,40,.10),0 4px 8px rgba(16,24,40,.06);--tw-elev-6:0 2px 6px rgba(16,24,40,.10),0 8px 16px rgba(16,24,40,.08);--tw-elev-8:0 4px 8px rgba(16,24,40,.10),0 12px 24px rgba(16,24,40,.10);--tw-elev-12:0 8px 16px rgba(16,24,40,.12),0 20px 40px rgba(16,24,40,.14);--tw-state-hover:.08;--tw-state-press:.12;--tw-md-accent:#5e6ad2;--tw-md-accent-soft:rgba(94,106,210,.14);--tw-md-on-accent:#3a44a8;--tw-prism-series-1:#4C6EF5;--tw-prism-series-2:#E8590C;--tw-prism-series-3:#7048E8;--tw-prism-series-4:#0C8599;--tw-prism-series-5:#C2255C;--tw-prism-series-6:#2F9E44;--tw-prism-series-7:#F08C00;--tw-prism-series-8:#868E96;--tw-prism-surface-1:var(--tw-card);--tw-prism-surface-2:var(--tw-card2);--tw-prism-surface-3:var(--tw-hover)}
.tw-root[data-theme=dark]{--tw-elev-0:none;--tw-elev-1:0 1px 2px rgba(0,0,0,.24);--tw-prism-card-shadow:0 1px 2px rgba(0,0,0,.4);--tw-elev-3:0 1px 3px rgba(0,0,0,.28);--tw-elev-6:0 2px 6px rgba(0,0,0,.32);--tw-elev-8:0 4px 8px rgba(0,0,0,.36);--tw-elev-12:0 8px 16px rgba(0,0,0,.4);--tw-md-accent:#5e6ad2;--tw-md-accent-soft:rgba(94,106,210,.22);--tw-md-on-accent:#dde0ff;--tw-prism-surface-1:#16181b;--tw-prism-surface-2:#1b1d21;--tw-prism-surface-3:#23252a;--tw-prism-series-1:#91A7FF;--tw-prism-series-2:#FFA94D;--tw-prism-series-3:#B197FC;--tw-prism-series-4:#66D9E8;--tw-prism-series-5:#F783AC;--tw-prism-series-6:#8CE99A;--tw-prism-series-7:#FFD43B;--tw-prism-series-8:#ADB5BD}
.tw-prism{display:flex;flex:1 1 auto;flex-direction:column;gap:16px;padding:16px;box-shadow:var(--tw-elev-0);min-height:0;width:100%;overflow-y:auto;overflow-x:auto}
.tw-prism-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tw-prism-title{font-weight:650;color:var(--tw-text)}
.tw-prism-body{display:grid;grid-template-columns:minmax(0,62fr) 6px minmax(0,38fr);gap:0;align-items:stretch;min-width:0;min-height:0}
.tw-prism-col{display:flex;flex-direction:column;gap:16px;min-width:0}
.tw-prism-left{min-width:0}
.tw-prism-right{min-width:0}
.tw-prism-sep{position:relative;width:6px;align-self:stretch;cursor:col-resize;border:0;background:transparent;padding:0;border-radius:0;touch-action:none}
.tw-prism-sep::before{content:"";position:absolute;top:16px;bottom:16px;left:2px;width:2px;border-radius:2px;background:var(--tw-border-strong);transition:background .12s ease}
.tw-prism-sep:hover::before,.tw-prism-sep:focus-visible::before,.tw-prism-sep:active::before{background:var(--tw-md-accent)}
.tw-prism-sep:hover,.tw-prism-sep:focus-visible{outline:none}
.tw-prism-sep:focus-visible{box-shadow:0 0 0 2px var(--tw-ring)}
.tw-prism-card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--tw-border);border-radius:10px;background:var(--tw-prism-surface-1);box-shadow:0 1px 2px rgba(0,0,0,.06),0 1px 3px rgba(0,0,0,.04);min-width:0}
.tw-prism-card-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;font-weight:600;color:var(--tw-muted);line-height:1.3}
.tw-prism-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.tw-prism-metric{gap:8px;padding:12px}
.tw-prism-k{color:var(--tw-muted);font-size:12px;line-height:1.3}
.tw-prism-v{margin-top:4px;font:600 26px/1.15 var(--tw-mono);letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--tw-text)}
.tw-prism-sub{color:var(--tw-muted);font-size:12px;line-height:1.3;margin-left:auto;align-self:flex-end;text-align:right}
.tw-prism-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tw-prism-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tw-prism-times{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tw-prism-chip{display:inline-flex;gap:8px;align-items:center}
.tw-prism-time{font:12px/1.2 var(--tw-mono);border:1px solid var(--tw-border);border-radius:6px;background:var(--tw-bg);color:var(--tw-text);padding:4px 6px;min-width:0}
.tw-prism-skeleton{width:100%;border:1px solid var(--tw-border);border-radius:6px;background:var(--tw-bg);color:var(--tw-text);padding:8px;resize:vertical;font-size:12px;line-height:1.4}
.tw-prism-btn{position:relative;overflow:hidden;border:1px solid var(--tw-border);border-radius:6px;background:var(--tw-prism-surface-1);color:var(--tw-text);font-size:12px;line-height:1.2;padding:6px 8px;cursor:pointer;min-height:28px}
.tw-prism-btn::after{content:"";position:absolute;inset:0;background:currentColor;opacity:0;transition:opacity .12s;pointer-events:none}
.tw-prism-btn:hover::after{opacity:var(--tw-state-hover)}
.tw-prism-btn:active::after{opacity:var(--tw-state-press)}
.tw-prism-btn:disabled{opacity:.5;cursor:default}
.tw-prism-btn.primary{background:var(--tw-md-accent);border-color:var(--tw-md-accent);color:#fff}
.tw-prism-ripple{position:absolute;width:100px;height:100px;border-radius:50%;background:currentColor;pointer-events:none;animation:tw-ripple .55s ease-out forwards}
@keyframes tw-ripple{from{transform:scale(0);opacity:.22}to{transform:scale(1);opacity:0}}
@media (prefers-reduced-motion:reduce){.tw-prism-ripple{animation:none;display:none}}
.tw-prism-seg{display:inline-flex;align-items:stretch;gap:4px;padding:2px;border:1px solid var(--tw-border2);border-radius:8px;overflow:hidden;background:var(--tw-prism-surface-2);box-shadow:var(--tw-elev-3);width:max-content;max-width:100%}
.tw-prism-segbtn{position:relative;overflow:hidden;border:0;border-radius:6px;background:transparent;color:var(--tw-dim);font:12px/1.2 inherit;padding:0 12px;cursor:pointer;height:28px;min-height:28px}
.tw-prism-segbtn::after{content:"";position:absolute;inset:0;background:currentColor;opacity:0;transition:opacity .12s;pointer-events:none}
.tw-prism-segbtn:hover::after{opacity:var(--tw-state-hover)}
.tw-prism-segbtn:active::after{opacity:var(--tw-state-press)}
.tw-prism-segbtn.on{background:rgba(94,106,210,.18);color:#2f3aa0;font-weight:700;box-shadow:none}
.tw-root[data-theme=dark] .tw-prism-segbtn.on{background:rgba(138,180,248,.22);color:#dde0ff}
.tw-prism-table{width:100%;border-collapse:collapse;table-layout:auto}
.tw-prism-table th,.tw-prism-table td{border-bottom:1px solid var(--tw-border);padding:0 8px;text-align:left;font-size:12px;line-height:1.2;height:26px;white-space:nowrap;font-variant-numeric:tabular-nums}
.tw-prism-table th{height:24px;color:var(--tw-muted);font-weight:500;background:var(--tw-prism-surface-2)}
.tw-prism-table tr:last-child td{border-bottom:0}
.tw-prism-table .up{color:var(--tw-up)}
.tw-prism-table .down{color:var(--tw-down)}
.tw-prism-table .muted{color:var(--tw-muted)}
.tw-prism-num{text-align:right;font-variant-numeric:tabular-nums}
.tw-prism-mono{font-family:var(--tw-mono);font-variant-numeric:tabular-nums}
.tw-prism-stack{display:flex;flex-direction:column;gap:8px;min-width:0}
.tw-prism-chart{position:relative;display:flex;flex-direction:column;gap:8px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-prism-surface-1);padding:8px}
.tw-prism-chart svg{display:block;width:100%;height:128px}
.tw-prism-gridline{stroke:var(--tw-border);stroke-width:1;opacity:.7}
.tw-prism-dot{fill:var(--tw-prism-series-1)}
.tw-prism-chart-label{font:10px/1 var(--tw-mono);fill:var(--tw-text)}
.tw-prism-legend{position:absolute;top:8px;right:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--tw-prism-surface-1);border:1px solid var(--tw-border);border-radius:6px;padding:4px 6px;box-shadow:var(--tw-elev-3);z-index:1}
.tw-prism-legend span{display:inline-flex;align-items:center;gap:8px;color:var(--tw-muted);font-size:12px;line-height:1.2}
.tw-prism-legend i{display:inline-block;width:8px;height:8px;border-radius:2px}
.tw-prism-bar{display:flex;height:12px;overflow:hidden;background:var(--tw-prism-surface-2);border-radius:0}
.tw-prism-bar span{display:block;height:100%}
.tw-prism-composition{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.tw-prism-composition-legend{display:flex;flex-wrap:wrap;gap:8px;color:var(--tw-muted);font-size:12px;line-height:1.3}
.tw-prism-composition-legend span{display:inline-flex;align-items:center;gap:8px}
.tw-prism-composition-legend i{display:inline-block;width:8px;height:8px;border-radius:2px}
.tw-prism-analysis{border:1px solid var(--tw-border);border-left:3px solid var(--tw-prism-series-1);border-radius:6px;background:var(--tw-prism-surface-1);padding:8px}
.tw-prism-analysis:nth-of-type(2){border-left-color:var(--tw-prism-series-2)}
.tw-prism-analysis:nth-of-type(3){border-left-color:var(--tw-prism-series-3)}
.tw-prism-analysis:nth-of-type(4){border-left-color:var(--tw-prism-series-4)}
.tw-prism-analysis summary{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:600;line-height:1.3;list-style:none}
.tw-prism-analysis summary::-webkit-details-marker{display:none}
.tw-prism-analysis-body,.tw-prism-summary{white-space:pre-wrap;line-height:1.5;font-size:12px;color:var(--tw-dim)}
.tw-prism-summary{border-top:1px solid var(--tw-border);padding-top:8px}
.tw-prism-points{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.tw-prism-points li{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:1.45;color:var(--tw-dim);padding-left:12px;position:relative}
.tw-prism-points li::before{content:"·";position:absolute;left:2px;color:var(--tw-md-accent);font-weight:700}
.tw-prism-decision td:last-child{font-weight:600;font-variant-numeric:tabular-nums}
.tw-prism-decision td.zero{color:var(--tw-muted);font-weight:400}
.tw-prism-error{color:var(--tw-up);font-size:12px;line-height:1.4}
.tw-prism-muted{color:var(--tw-muted);font-size:12px;line-height:1.4}
.tw-prism-field{display:flex;align-items:center;gap:8px;min-width:0}
.tw-prism-field label{width:64px;flex:none;color:var(--tw-muted);font-size:12px}
.tw-prism-input{flex:1;min-width:0;border:1px solid var(--tw-border);border-radius:6px;background:var(--tw-bg);color:var(--tw-text);font:12px/1.2 var(--tw-mono);padding:5px 6px}
@media (max-width:1099px){.tw-prism-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:899px){.tw-prism-body{display:flex;flex-direction:column;gap:16px;min-height:0}.tw-prism-sep{display:none}.tw-prism-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.tw-prism-left{display:flex;flex-direction:column;gap:16px}.tw-prism-left>.tw-prism-cards{order:1}.tw-prism-left>.tw-prism-toolbar{order:2}.tw-prism-left>.tw-prism-seg{order:3}.tw-prism-left>.tw-prism-tablecard{order:4}.tw-prism-left>.tw-prism-equitycard{order:5}}

@media (max-width:639px){.tw-prism-cards{grid-template-columns:minmax(0,1fr)}}
`

let injected = false

/**
 * 注入决策（纯函数，可测）。
 *
 * 为什么要按**内容**而不是"元素在不在"来判：客户端插件会被宿主**热重载**（不刷新页面）。
 * 重载后新模块实例调用 ensureCss 时，文档里那份 `<style>` 属于**上一个版本**的代码 ——
 * 旧规则里没有新类名，于是新 DOM 配上旧 CSS，界面会呈现成"没有样式的纯文本"。
 * 实测踩到过：新版大盘页整块失去样式，被误以为"新布局不如旧版"。
 */
export function cssInjectAction(current: string | null, next: string): 'append' | 'replace' | 'skip' {
  if (current === null) return 'append'
  return current === next ? 'skip' : 'replace'
}

export function ensureCss(): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ID)
  const action = cssInjectAction(existing === null ? null : existing.textContent ?? '', TW_CSS)
  if (action === 'skip') {
    injected = true
    return
  }
  if (action === 'replace' && existing !== null) {
    // 样式表换了内容 ⇒ 就地替换（保留同一个元素，避免闪烁与重复节点）
    existing.textContent = TW_CSS
    injected = true
    return
  }
  if (injected) return
  injected = true
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = TW_CSS
  document.head.appendChild(style)
}
