/**
 */
export const STYLE_ID = 'dsh-tradewatcher-style'

export const TW_CSS = `
.tw-root{
--tw-bg:#f5f6f8;--tw-bg2:#eceef2;--tw-card:#ffffff;--tw-card2:#f2f4f7;--tw-hover:#eef0f5;
--tw-border:#e2e5ea;--tw-border-strong:#cfd3dc;
--tw-text:#16181d;--tw-dim:#4c535f;--tw-muted:#6f7787;
/* 图表辅助线的两个 token：此前只在救援曲线/日历里被 var() 引用、**从未定义** ——
   无 fallback 的地方会因"无效值"退回初始色（浅色主题下出现一条近黑的轴线）。
   这里补成主题内已有的同义 token。 */
--tw-fg-dim:var(--tw-muted);--tw-line:var(--tw-border);
--tw-up:#e5484d;--tw-down:#0e8f5c;--tw-flat:#6f7787;
--tw-up-bg:rgba(229,72,77,.09);--tw-down-bg:rgba(12,154,99,.09);--tw-flat-bg:rgba(138,145,160,.10);
--tw-accent:#5e6ad2;--tw-accent-hover:#4652c0;--tw-accent-soft:rgba(94,106,210,.10);--tw-ring:rgba(94,106,210,.38);
--tw-mask:rgba(15,17,20,.42);
--tw-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--tw-shadow-sm:0 1px 2px rgba(16,24,40,.05);
--tw-shadow-lg:0 1px 2px rgba(16,24,40,.05),0 14px 36px rgba(16,24,40,.13);
color-scheme:light;background:var(--tw-bg);color:var(--tw-text);
font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Inter","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
letter-spacing:-0.006em}
.tw-root[data-theme=dark]{
--tw-bg:#010102;--tw-bg2:#0b0c0e;--tw-card:#0f1011;--tw-card2:#16181b;--tw-hover:#1b1d21;
--tw-border:#23252a;--tw-border-strong:#34343a;
--tw-text:#f7f8f8;--tw-dim:#c8ced8;--tw-muted:#8a8f98;
--tw-fg-dim:var(--tw-muted);--tw-line:var(--tw-border);
--tw-up:#ff5f6d;--tw-down:#27a644;--tw-flat:#8a8f98;
--tw-up-bg:rgba(255,95,109,.12);--tw-down-bg:rgba(47,191,131,.12);--tw-flat-bg:rgba(138,143,152,.12);
--tw-accent:#5e6ad2;--tw-accent-hover:#828fff;--tw-accent-soft:rgba(94,106,210,.16);--tw-ring:rgba(94,106,210,.45);
--tw-mask:rgba(0,0,0,.55);
--tw-shadow-sm:0 1px 0 rgba(255,255,255,.03);
--tw-shadow-lg:0 1px 0 rgba(255,255,255,.03),0 16px 44px rgba(0,0,0,.55);
color-scheme:dark}
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
.tw-topmeta .tw-uptime{color:var(--tw-muted);font-size:11px;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.tw-iconbtn{color:var(--tw-dim);border:1px solid var(--tw-border);border-radius:8px;padding:1px 8px;font-size:11px;line-height:19px;background:var(--tw-card);transition:color .12s,border-color .12s}
.tw-iconbtn:hover{color:var(--tw-text);border-color:var(--tw-border-strong)}
.tw-iconbtn:disabled{opacity:.5;cursor:default}
.tw-strip{display:flex;align-items:flex-start;gap:8px;margin:6px 0}
.tw-strip-label{flex:none;width:56px;display:flex;align-items:center;color:var(--tw-muted);font-size:11px;letter-spacing:.02em;padding-right:2px;padding-top:8px;align-self:flex-start}
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
.tw-toast{position:absolute;left:10px;right:10px;bottom:10px;z-index:40;display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border:1px solid var(--tw-border-strong);border-radius:9px;background:var(--tw-card);box-shadow:var(--tw-shadow-lg);color:var(--tw-text);font-size:11.5px;line-height:1.5}
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
--tw-up:#8a8f98;--tw-down:#8a8f98;--tw-up-bg:rgba(138,143,152,.12);--tw-down-bg:rgba(138,143,152,.12)}
/* 图表口径条（P0-5）：紧贴图上方一行，等宽字体便于对齐数字 */
.tw-caliber{padding:5px 8px 4px;font-size:10.5px;color:var(--tw-dim);font-family:var(--tw-mono);border-bottom:1px dashed var(--tw-border);background:var(--tw-bg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 自选异动（P1-4）：呼吸高亮。用左边的竖条 + 缓慢呼吸的背景，
   而不是整行变红 —— 整行变红与"跌了"的语义冲突（红既是跌也是警示）。 */
@keyframes tw-breathe{0%,100%{background:transparent}50%{background:rgba(229,72,77,.10)}}
.tw-wrow[data-alert]{box-shadow:inset 3px 0 0 var(--tw-up);animation:tw-breathe 2.6s ease-in-out infinite}
.tw-wrow[data-alert][data-alert=price]{box-shadow:inset 3px 0 0 var(--tw-flat)}
@media (prefers-reduced-motion:reduce){.tw-wrow[data-alert]{animation:none;background:rgba(229,72,77,.08)}}

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
      ⚠ 断点必须与 client/wide.ts 的 WIDE_MIN_PX 一致（由 styles.test.ts 直接读 CSS 文本比对；
      写死在注释里的一致性迟早会漂）。v0.36.0 起列头排序已删除，这条断点只服务多列网格。 */
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
  .tw-caliber, .tw-chartnote, .tw-zoom-bar, .tw-topmeta .tw-uptime){
  filter:blur(3.2px);transition:filter .12s}
.tw-root[data-blur=1] :is(.tw-qcard, .tw-wrow, .tw-posrow, tr, .tw-pop, .tw-stat, .tw-pps,
  .tw-dkv, .tw-rescue-card-grid, .tw-panel):hover :is(.tw-qcard .px, .tw-qcard .chg, .tw-chg-chip,
  .tw-stat .v, .tw-pps .v, .tw-pps .meta, .tw-pos-price .px, .tw-pos-price .meta,
  .tw-pop .ph .px, .tw-pop .ph .tag, .tw-pop .pl,
  .tw-group-h .gsum, .tw-wrow .wq, .tw-wrow .tw-num, .tw-ytd, .tw-gh-metrics,
  .tw-dkv .v, .tw-rescue-card-grid .v, .tw-table td,
  .tw-chart-pct,
  .tw-chart-tip-v,
  .tw-caliber, .tw-chartnote, .tw-zoom-bar){
  filter:none}

/* 三态降级占位（P0-10）：iframe 超时后不留空白 */
.tw-placeholder{flex:1;min-height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center;padding:24px 18px;color:var(--tw-dim);font-size:12px;background:var(--tw-card2);border-top:1px solid var(--tw-border)}
.tw-badge[data-state=timeout]{color:var(--tw-up);border-color:var(--tw-up)}
.tw-badge[data-state=loaded]{color:var(--tw-down);border-color:var(--tw-down)}
/* 四态色点（P0-2）：6px，绝对定位到右上角，不影响卡片高度 */
.tw-qdot{position:absolute;top:5px;right:5px;width:6px;height:6px;border-radius:50%;flex:none;pointer-events:none}
.tw-qdot::after{content:"";position:absolute;inset:-3px;border-radius:50%}
.tw-qcard .nm{font-size:11px;color:var(--tw-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}
.tw-qcard .px{font-family:var(--tw-mono);font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.35}
.tw-qcard .chg{display:flex;gap:6px;align-items:baseline;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;font-family:var(--tw-mono)}
.tw-qcard .chg b{font-weight:600}
.tw-chg-chip{display:inline-block;padding:0 6px;border-radius:10px;font-weight:600;font-size:11px}
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
.tw-muted{color:var(--tw-muted)} .tw-dim{color:var(--tw-dim)} .tw-right{text-align:right}
.tw-panel{background:var(--tw-card);border:1px solid var(--tw-border);border-radius:10px;padding:10px 12px}
.tw-panel-h{display:flex;align-items:center;gap:8px;padding-bottom:7px;min-height:24px}
.tw-panel-h .t{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-0.2px}
.tw-statrow{display:flex;gap:8px;flex-wrap:wrap;padding:2px 0 8px}
.tw-stat{flex:1 1 118px;min-width:96px;border-radius:10px;padding:6px 10px 7px;background:var(--tw-bg2);border:1px solid var(--tw-border);transition:background .12s,border-color .12s}
.tw-stat:hover{background:var(--tw-hover);border-color:var(--tw-border-strong)}
.tw-stat .k{font-size:11px;color:var(--tw-muted)}
.tw-stat .v{font-family:var(--tw-mono);font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.35}
.tw-btn{border:1px solid var(--tw-border);border-radius:8px;padding:1px 9px;font-size:12px;line-height:20px;color:var(--tw-dim);background:transparent;transition:color .12s,background .12s,border-color .12s;white-space:nowrap}
.tw-btn:hover{color:var(--tw-text);border-color:var(--tw-border-strong);background:var(--tw-hover)}
.tw-btn[data-primary=true]{border-color:var(--tw-accent);background:var(--tw-accent);color:#fff;font-weight:500}
.tw-btn[data-primary=true]:hover{background:var(--tw-accent-hover);border-color:var(--tw-accent-hover);color:#fff}
.tw-btn:disabled{opacity:.5;cursor:default}
.tw-input{width:100%}

/* ── tables ────────────────────────────────────────────── */
.tw-table{width:100%;border-collapse:collapse;font-size:12px}
.tw-table th{color:var(--tw-muted);font-weight:500;text-align:right;padding:3px 7px;border-bottom:1px solid var(--tw-border);white-space:nowrap;font-size:11px}
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
.tw-gh-metrics{display:flex;gap:14px;flex-wrap:wrap;color:var(--tw-muted);font-size:11px;font-family:var(--tw-mono);padding-left:16px}
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
.tw-pos-title small{color:var(--tw-muted);font-size:10px;font-family:var(--tw-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw-pos-price{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:1px;text-align:right}
.tw-pos-price .px{font-family:var(--tw-mono);font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.25}
.tw-pos-price .meta{font-size:10px;color:var(--tw-muted);font-family:var(--tw-mono);white-space:nowrap}
.tw-pos-grid{display:flex;flex-wrap:wrap;gap:4px 26px}
.tw-pps{flex:0 0 auto;min-width:92px}
.tw-pps .k{display:block;font-size:10px;color:var(--tw-muted);white-space:nowrap}
.tw-pps .v{display:block;font-family:var(--tw-mono);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tw-pps .meta{display:block;font-size:10px;color:var(--tw-muted);font-family:var(--tw-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
.tw-wrow .nm{flex:1;min-width:0}
.tw-wrow .nm b{font-size:12px;font-weight:600}
.tw-wrow .nm small{display:block;color:var(--tw-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw-wrow .wq{display:flex;gap:6px;align-items:baseline;font-variant-numeric:tabular-nums;flex:none;font-family:var(--tw-mono);font-size:12px}

/* ── hover popup ───────────────────────────────────────── */
.tw-pop{position:absolute;z-index:9999;width:330px;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:12px;box-shadow:var(--tw-shadow-lg);padding:9px 11px 7px;pointer-events:auto;cursor:pointer;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--tw-text)}
.tw-pop .ph{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
.tw-pop .ph .nm{font-weight:650;font-size:13px}
.tw-pop .ph .px{font-family:var(--tw-mono);font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.tw-pop .ph .tag{color:var(--tw-dim);font-size:11px;font-family:var(--tw-mono)}
.tw-pop .tw-pop-hint{color:var(--tw-accent);font-family:inherit}
.tw-pop .pl{display:flex;gap:12px;color:var(--tw-muted);margin-top:3px;font-variant-numeric:tabular-nums;flex-wrap:wrap;font-size:11px;font-family:var(--tw-mono)}

/* ── modal ─────────────────────────────────────────────── */
.tw-mask{position:fixed;inset:0;background:var(--tw-mask);z-index:1200;display:flex;align-items:flex-start;justify-content:center;padding:56px 14px 20px;backdrop-filter:blur(2px)}
.tw-modal{width:min(560px,94vw);max-height:82vh;overflow:auto;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:12px;box-shadow:var(--tw-shadow-lg);padding:14px 16px}
.tw-modal h3{margin:0 0 11px;font-size:13px;font-weight:600;letter-spacing:-0.3px}
.tw-field{margin-bottom:10px}
.tw-field label{display:block;font-size:11px;color:var(--tw-muted);margin-bottom:4px}
.tw-err{color:var(--tw-up);background:var(--tw-up-bg);border-radius:8px;padding:5px 10px;margin:6px 0;font-size:12px}
.tw-hint{color:var(--tw-muted);font-size:11px;margin:2px 0 6px;line-height:1.55;max-width:96ch}

/* ── segmented controls / search ───────────────────────── */
.tw-seg{display:inline-flex;border:1px solid var(--tw-border);border-radius:8px;overflow:hidden;background:var(--tw-card)}
.tw-seg button{padding:3px 11px;font-size:12px;color:var(--tw-dim);border-right:1px solid var(--tw-border);transition:background .12s,color .12s}
.tw-seg button:last-child{border-right:none}
.tw-seg button:hover{color:var(--tw-text);background:var(--tw-hover)}
.tw-seg button[data-on=true]{background:var(--tw-accent-soft);color:var(--tw-accent);font-weight:600}
.tw-suggest{position:absolute;z-index:1100;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:10px;box-shadow:var(--tw-shadow-lg);max-height:262px;overflow:auto;min-width:240px}
.tw-suggest button{display:flex;justify-content:space-between;gap:12px;width:100%;text-align:left;padding:6px 11px;font-size:12px}
.tw-suggest button:hover{background:var(--tw-hover)}
.tw-suggest .k{color:var(--tw-muted);font-size:11px;flex:none}
.tw-badge{font-size:10px;color:var(--tw-dim);border:1px solid var(--tw-border);border-radius:10px;padding:0 6px;white-space:nowrap}
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
/* stat group divider */
.tw-stat-sep{flex:none;width:1px;align-self:stretch;background:var(--tw-border);margin:2px 6px}
/* inline code chip next to a watch name */
.tw-code{color:var(--tw-muted);font-family:var(--tw-mono);font-size:11px;margin-left:6px}


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
.tw-cal-dowcell{text-align:center;font-size:10.5px;color:var(--tw-muted);padding:2px 0}
.tw-cal-cell{min-height:74px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-card);padding:3px 4px;display:flex;flex-direction:column;gap:2px;overflow:hidden;cursor:pointer;transition:border-color .12s,background .12s}
.tw-cal-cell:hover{border-color:var(--tw-accent);background:var(--tw-hover)}
.tw-cal-cell.is-out{opacity:.45}
.tw-cal-cell.is-today{border-color:var(--tw-accent);box-shadow:inset 0 0 0 1px var(--tw-accent-soft)}
.tw-cal-day{display:flex;align-items:center;gap:4px;font-size:10.5px;font-family:var(--tw-mono);color:var(--tw-dim)}
.tw-cal-cell.is-today .tw-cal-day{color:var(--tw-accent);font-weight:700}
.tw-cal-count{margin-left:auto;font-size:9px;color:var(--tw-muted);border:1px solid var(--tw-border);border-radius:8px;padding:0 4px}
.tw-cal-pill{font-size:10px;line-height:1.35;border:1px solid;border-radius:5px;padding:0 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.tw-cal-more{font-size:9.5px;color:var(--tw-muted);text-align:right;cursor:pointer}
.tw-cal-card{border-left:3px solid var(--tw-accent);background:var(--tw-card2);border-radius:6px;padding:7px 9px;margin-bottom:8px}
.tw-zoom-bar{display:flex;align-items:center;gap:6px;font-size:10.5px;font-family:var(--tw-mono)}
.tw-chartnote{display:flex;gap:12px;flex-wrap:wrap;color:var(--tw-muted);font-size:11px;margin:6px 0 2px;font-family:var(--tw-mono)}
/* 复权口径段控（详情图右上角）：默认前复权；指数/期货禁用并标"不适用" */
.tw-fq{flex:none;display:inline-flex;align-items:center;gap:3px;padding:2px 4px 2px 6px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-bg2)}
.tw-fq .k{font-size:10px;color:var(--tw-muted);margin-right:2px}
.tw-fq-btn{min-height:22px;padding:0 7px;font-size:11px;color:var(--tw-dim);background:transparent;border:1px solid transparent;border-radius:6px;transition:background .12s,color .12s,border-color .12s;white-space:nowrap}
.tw-fq-btn:hover:not(:disabled){color:var(--tw-text);background:var(--tw-hover)}
.tw-fq-btn[data-on=true]{color:var(--tw-text);font-weight:600;background:var(--tw-accent-soft);border-color:var(--tw-accent);letter-spacing:-0.15px}
.tw-fq-btn:disabled{opacity:.45;cursor:not-allowed}
.tw-fq-hint{font-size:10px;color:var(--tw-muted);padding:0 2px}

/* ── row mini trend + detail drawer ─────────────────────── */
.tw-mini{flex:none;border:1px solid var(--tw-border);border-radius:8px;padding:1px 3px;background:var(--tw-bg2);display:inline-flex;line-height:0;transition:border-color .12s,background .12s}
.tw-mini:hover{border-color:var(--tw-accent);background:var(--tw-card)}
.tw-mini svg{display:block}
.tw-drawer-mask{position:fixed;inset:0;background:var(--tw-mask);z-index:1300;display:flex;justify-content:flex-end;backdrop-filter:blur(2px)}
.tw-drawer{width:min(720px,96vw);height:100%;background:var(--tw-card);border-left:1px solid var(--tw-border-strong);box-shadow:var(--tw-shadow-lg);display:flex;flex-direction:column;animation:twslide .2s ease-out}
@keyframes twslide{from{transform:translateX(28px);opacity:.3}to{transform:translateX(0);opacity:1}}
.tw-drawer-head{padding:12px 14px 10px;border-bottom:1px solid var(--tw-border);flex:none}
.tw-drawer .tw-tabs{padding:6px;background:transparent;border-bottom:1px solid var(--tw-border);border-top:none;flex:none}
.tw-drawer-body{flex:1;overflow:auto;padding:10px 12px 8px}
.tw-drawer-foot{flex:none;display:flex;gap:12px;padding:7px 14px;border-top:1px solid var(--tw-border);font-size:11px}
.tw-dkv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(98px,1fr));gap:2px 16px}
.tw-dkv .k{display:block;font-size:10px;color:var(--tw-muted);white-space:nowrap}
.tw-dkv .v{font-family:var(--tw-mono);font-size:12px;font-weight:550;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}


/* ── 护盘信号 ───────────────────────────────────────────────────────────── */
.tw-rescue{display:flex;flex-direction:column;gap:6px}
.tw-rescue-dot{width:9px;height:9px;border-radius:50%;flex:none;transition:background .2s}
.tw-rescue-summary{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-bg);font-size:12px;flex-wrap:wrap}
.tw-rescue-resonance{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:4px 8px;border:1px solid var(--tw-border);border-radius:8px;background:var(--tw-bg);flex-wrap:wrap}
.tw-rescue-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:8px}
.tw-rescue-card{border:1px solid var(--tw-border);border-radius:9px;padding:7px 9px;background:var(--tw-card);transition:border-color .15s}
.tw-rescue-card-h{display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:5px}
.tw-rescue-card-h b{font-size:12px;font-weight:600;letter-spacing:-0.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw-rescue-card-h span{font-size:12px;flex:none;font-variant-numeric:tabular-nums}
.tw-rescue-card-grid{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:2px 8px;font-size:11px}
.tw-rescue-card-grid .k{color:var(--tw-muted);white-space:nowrap}
.tw-rescue-card-grid .v{font-family:var(--tw-mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tw-rescue-card-f{display:flex;align-items:center;gap:8px;margin-top:6px;padding-top:5px;border-top:1px solid var(--tw-border)}
.tw-rescue-bar{height:5px;border-radius:3px;background:var(--tw-border);overflow:hidden;display:inline-block;flex:none;vertical-align:middle}
.tw-rescue-bar i{display:block;height:100%;border-radius:3px;transition:width .25s}
.tw-rescue-split{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px}
@media (max-width:900px){.tw-rescue-split{grid-template-columns:1fr}}
.tw-sub-h{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--tw-dim);text-transform:none;letter-spacing:0.2px;margin:2px 0 5px;padding-bottom:3px;border-bottom:1px solid var(--tw-border)}
.tw-chip{font-size:10.5px;color:var(--tw-muted);border:1px solid var(--tw-border);border-radius:9px;padding:0 6px;cursor:pointer;line-height:16px}
.tw-chip:hover{border-color:var(--tw-accent);color:var(--tw-text)}
.tw-chip[data-on=true]{color:#fff;background:var(--tw-accent);border-color:var(--tw-accent)}
.tw-rescue-svg{display:block;background:var(--tw-bg);border-radius:6px}
.tw-rescue-factor{width:100%;border-collapse:collapse;font-size:11px}
.tw-rescue-factor th{text-align:left;font-weight:500;color:var(--tw-dim);font-size:10px;padding:3px 4px;border-bottom:1px solid var(--tw-border);white-space:nowrap}
.tw-rescue-factor td{padding:4px;border-bottom:1px solid var(--tw-border);vertical-align:middle;line-height:1.45}
.tw-rescue-factor tr[data-hit=true] td{background:var(--tw-accent-soft)}
.tw-rescue-timeline{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto}
.tw-rescue-tl-row{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0}
.tw-rescue-intraday{display:flex;flex-wrap:wrap;gap:2px}
.tw-rescue-ip{width:7px;height:14px;border-radius:2px;display:inline-block}
.tw-rescue-history{display:flex;flex-direction:column;gap:2px;max-height:186px;overflow:auto}
.tw-rescue-h-row{display:flex;align-items:center;gap:8px;font-size:11px;padding:3px 5px;border-radius:6px;cursor:pointer}
.tw-rescue-h-row:hover{background:var(--tw-hover)}
.tw-rescue-pool{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:3px 10px;font-size:11.5px}
.tw-rescue-pool-item{display:flex;align-items:center;gap:5px;color:var(--tw-muted);cursor:pointer}
.tw-rescue-pool-item[data-on=true]{color:var(--tw-text)}

/* 图表细节卡（跟随光标的半透明卡片）+ 光标层容器 —— task-28 */
.tw-cursorwrap{position:relative}
.tw-cursorwrap svg{outline:none}
.tw-cursorwrap svg:focus-visible{outline:2px solid var(--tw-accent);outline-offset:1px}
.tw-chart-tip{position:absolute;z-index:5;pointer-events:none;padding:6px 8px;border-radius:8px;
  border:1px solid var(--tw-border-strong);background:color-mix(in srgb, var(--tw-card) 82%, transparent);
  backdrop-filter:blur(3px);box-shadow:0 2px 10px rgba(0,0,0,.18)}
.tw-chart-tip-row{display:flex;justify-content:space-between;gap:10px;font-size:11px;line-height:16px;white-space:nowrap}
.tw-chart-tip-k{color:var(--tw-muted)}
.tw-chart-tip-v{font-family:var(--tw-mono);font-variant-numeric:tabular-nums;color:var(--tw-text)}
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
