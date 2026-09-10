/**
 * dsh-tradewatcher client styles — dark-saas (Linear-inspired) token system
 * from the dsh-design-skills pack, implemented symmetrically for light/dark:
 *   near-black canvas + surface-layered panels + hairline dividers (dark);
 *   near-white canvas + white cards + hairline dividers (light); one accent
 *   (#5e6ad2); semantic up/down colors only as 8–12% translucent chips;
 *   tabular/mono numerals for every figure; compact info-dense density.
 * Injected once as a <style> element; every class is scoped under `.tw-*`.
 */
export const TW_CSS = `
.tw-root{
--tw-bg:#f5f6f8;--tw-bg2:#eceef2;--tw-card:#ffffff;--tw-card2:#f2f4f7;--tw-hover:#eef0f5;
--tw-border:#e2e5ea;--tw-border-strong:#cfd3dc;
--tw-text:#16181d;--tw-dim:#4c535f;--tw-muted:#6f7787;
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
.tw-root input:focus,.tw-root select:focus{border-color:var(--tw-accent);box-shadow:var(--tw-focus)}
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
.tw-strip{display:flex;align-items:stretch;gap:8px;margin:6px 0}
.tw-strip-label{flex:none;width:56px;display:flex;align-items:center;color:var(--tw-muted);font-size:11px;letter-spacing:.02em;padding-right:2px}
.tw-strip-cards{flex:1;min-width:0;display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;scrollbar-width:thin;align-items:stretch}
.tw-strip-cards::-webkit-scrollbar{height:6px}
.tw-strip-cards::-webkit-scrollbar-thumb{background:var(--tw-border-strong);border-radius:4px}
.tw-strip-cards::-webkit-scrollbar-track{background:transparent}
.tw-qcard{flex:1 1 100px;min-width:100px;min-height:54px;background:var(--tw-card);border:1px solid var(--tw-border);border-radius:10px;padding:4px 9px 5px;position:relative;overflow:hidden;transition:border-color .12s,background .12s}
.tw-qcard:hover{border-color:var(--tw-accent);background:var(--tw-hover)}
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

/* position row: two-line layout (title/price line + aligned numeric grid) */
.tw-posrow{display:flex;flex-direction:column;gap:6px;padding:7px 10px 6px;border-top:1px solid var(--tw-border);transition:background .1s}
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
.tw-wrow{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--tw-border);transition:background .1s}
.tw-wrow:hover{background:var(--tw-card2)}
.tw-wrow .nm{flex:1;min-width:0}
.tw-wrow .nm b{font-size:12px;font-weight:600}
.tw-wrow .nm small{display:block;color:var(--tw-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw-wrow .wq{display:flex;gap:6px;align-items:baseline;font-variant-numeric:tabular-nums;flex:none;font-family:var(--tw-mono);font-size:12px}

/* ── hover popup ───────────────────────────────────────── */
.tw-pop{position:absolute;z-index:9999;width:330px;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:12px;box-shadow:var(--tw-shadow-lg);padding:9px 11px 7px;pointer-events:none;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--tw-text)}
.tw-pop .ph{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
.tw-pop .ph .nm{font-weight:650;font-size:13px}
.tw-pop .ph .px{font-family:var(--tw-mono);font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.tw-pop .ph .tag{color:var(--tw-dim);font-size:11px;font-family:var(--tw-mono)}
.tw-pop .pl{display:flex;gap:12px;color:var(--tw-muted);margin-top:3px;font-variant-numeric:tabular-nums;flex-wrap:wrap;font-size:11px;font-family:var(--tw-mono)}

/* ── modal ─────────────────────────────────────────────── */
.tw-mask{position:fixed;inset:0;background:var(--tw-mask);z-index:1200;display:flex;align-items:flex-start;justify-content:center;padding:56px 14px 20px;backdrop-filter:blur(2px)}
.tw-modal{width:min(560px,94vw);max-height:82vh;overflow:auto;background:var(--tw-card);border:1px solid var(--tw-border-strong);border-radius:12px;box-shadow:var(--tw-shadow-lg);padding:14px 16px}
.tw-modal h3{margin:0 0 11px;font-size:13px;font-weight:600;letter-spacing:-0.3px}
.tw-field{margin-bottom:10px}
.tw-field label{display:block;font-size:11px;color:var(--tw-muted);margin-bottom:4px}
.tw-err{color:var(--tw-up);background:var(--tw-up-bg);border-radius:8px;padding:5px 10px;margin:6px 0;font-size:12px}
.tw-hint{color:var(--tw-muted);font-size:11px;margin:2px 0 6px;line-height:1.55}

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
.tw-chartnote{display:flex;gap:12px;flex-wrap:wrap;color:var(--tw-muted);font-size:11px;margin:6px 0 2px;font-family:var(--tw-mono)}

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

`

let injected = false

export function ensureCss(): void {
  if (injected) return
  injected = true
  if (typeof document === 'undefined') return
  if (document.getElementById('dsh-tradewatcher-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-tradewatcher-style'
  style.textContent = TW_CSS
  document.head.appendChild(style)
}
