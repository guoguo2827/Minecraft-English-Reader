"use strict";
const lucide = require("lucide");
const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = name => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${lucide[name].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${escape(v)}"`).join(" ")}/>`).join("")}</svg>`;

function renderReview(catalog) {
  const data = JSON.stringify(catalog.units).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KET1500 内容审核</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f7f8;color:#1e3038;font-family:Arial,"Microsoft YaHei",sans-serif;font-size:16px;letter-spacing:0}header{background:#fff;border-bottom:1px solid #dce4e5;padding:22px max(16px,calc((100% - 1240px)/2))}h1{font-size:24px;margin:0 0 10px}header p{font-size:14px;color:#53646a;margin:0;line-height:1.7}strong{color:#186e53}main{max-width:1272px;padding:0 16px 36px;margin:auto}.toolbar{display:flex;align-items:end;gap:12px;flex-wrap:wrap;padding:20px 0 12px}.field{display:grid;gap:6px;flex:1 1 240px}.field span{font-size:13px;color:#53646a}input,select{font:inherit;min-height:44px;padding:9px 12px;border:1px solid #b7c8cb;background:white;border-radius:6px;width:100%;min-width:0}button{min-width:44px;min-height:44px;border:1px solid #b7c8cb;background:#fff;color:#254750;border-radius:6px;display:inline-grid;place-items:center;cursor:pointer}button:hover:not(:disabled){background:#e5f5ee}button:disabled{opacity:.4;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #28846a;outline-offset:2px}.controls{display:flex;gap:8px}#count{color:#53646a;font-size:14px;min-height:24px;margin:0 0 12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.word{background:#fff;border:1px solid #dce4e5;border-radius:8px;overflow:hidden;min-width:0}.word img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:contain;background:#f4faf7}.word.pilot img{padding:35px}.copy{padding:18px}.word h2{font-size:24px;line-height:1.2;margin:7px 0 10px;overflow-wrap:anywhere}.meta{font-size:12px;color:#65777b;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.pending{color:#9b590b}.meaning{font-size:16px;color:#186e53;margin:0 0 14px}.example{font-size:18px;line-height:1.5;margin:0 0 8px;overflow-wrap:anywhere}.translation{font-size:15px;color:#53646a;line-height:1.5;margin:0}.review-note{font-size:12px;line-height:1.6;border-top:1px solid #edf0f1;padding-top:10px;margin:14px 0 0;color:#65777b}footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:24px 0 0;flex-wrap:wrap;font-size:13px;color:#53646a}footer a{color:#186e53}.pagination{display:flex;gap:12px;align-items:center}#empty{padding:30px 0}@media(min-width:1200px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:620px){.grid{grid-template-columns:minmax(0,1fr)}header{padding:18px 16px}.toolbar{gap:10px}.field{flex-basis:100%}h1{font-size:22px}.copy{padding:16px}.word h2{font-size:23px}footer{padding-bottom:env(safe-area-inset-bottom)}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style></head><body><header><h1>KET1500 内容审核</h1><p><strong>1500 条例句与翻译</strong> · 100 条现有课程 · 1400 条新增内容初稿</p><p>新增配图：情境联想图，含例句文字，不能直接用于听音选图判分。教师、图义与真实发音审核尚未完成。</p></header>
<main><div class="toolbar"><label class="field"><span>单元</span><select id="unit"><option value="all">全部单元</option>${catalog.units.map(u => `<option value="${escape(u.id)}">${String(u.number).padStart(3, "0")} · ${escape(u.title)}</option>`).join("")}</select></label><label class="field"><span>查找词条</span><input id="search" type="search" placeholder="英文、中文或例句" autocomplete="off"></label><div class="controls"><button id="prevUnit" title="上一单元" aria-label="上一单元">${icon("ArrowLeft")}</button><button id="nextUnit" title="下一单元" aria-label="下一单元">${icon("ArrowRight")}</button></div></div><p id="count" role="status"></p><div id="words" class="grid"></div><p id="empty" hidden>没有匹配的词条。</p><footer><a href="../../outputs/ket-assets/expanded/ATTRIBUTION.md">配图来源与授权</a><div class="pagination"><button id="prevPage" title="上一页" aria-label="上一页">${icon("ChevronLeft")}</button><span id="page"></span><button id="nextPage" title="下一页" aria-label="下一页">${icon("ChevronRight")}</button></div></footer></main>
<script type="application/json" id="content">${data}</script>
<script>
"use strict";
const units=JSON.parse(document.getElementById("content").textContent);
const all=units.flatMap(u=>u.words.map(w=>({...w,unitTitle:u.title,unitNumber:u.number})));
const select=document.getElementById("unit"), search=document.getElementById("search");
const pageSize=18; let page=0;
const esc=v=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function render(){
 const query=search.value.trim().toLowerCase();
 const matches=all.filter(w=>(select.value==="all"||w.unitId===select.value)&&[w.word,w.meaning,w.example,w.translation,...w.variants].join(" ").toLowerCase().includes(query));
 const pages=Math.max(1,Math.ceil(matches.length/pageSize));page=Math.min(page,pages-1);
 document.getElementById("words").innerHTML=matches.slice(page*pageSize,(page+1)*pageSize).map(w=>'<article class="word '+(w.published?'pilot':'draft')+'" data-word="'+esc(w.word)+'"><img loading="lazy" decoding="async" src="../../outputs'+esc(w.image)+'" alt="'+esc(w.published?w.meaning:'例句情境辅助图：'+w.translation)+'" width="640" height="360"><div class="copy"><div class="meta"><span>'+esc(String(w.unitNumber).padStart(3,'0')+' · '+w.unitTitle)+'</span><span class="'+(w.published?'':'pending')+'">'+(w.published?'现有课程':'待内容审核')+'</span></div><h2>'+esc(w.word)+'</h2><p class="meaning">'+esc(w.pos+' '+w.meaning)+'</p><p class="example">'+esc(w.example)+'</p><p class="translation">'+esc(w.translation)+'</p>'+(w.published?'':'<p class="review-note">配图为联想辅助，不保证独立表达词义；未接入正式学习与测验。</p>')+'</div></article>').join("");
 document.getElementById("count").textContent=matches.length+' 条结果';
 document.getElementById("empty").hidden=matches.length>0;
 document.getElementById("page").textContent=(page+1)+' / '+pages;
 document.getElementById("prevPage").disabled=page===0;
 document.getElementById("nextPage").disabled=page+1>=pages;
 const i=units.findIndex(u=>u.id===select.value);
 document.getElementById("prevUnit").disabled=i<=0;
 document.getElementById("nextUnit").disabled=i<0||i===units.length-1;
}
function choose(){const id=decodeURIComponent(location.hash.slice(1));select.value=units.some(u=>u.id===id)?id:'ket-u011';page=0;render();}
select.addEventListener('change',()=>{page=0;if(select.value!=='all')history.replaceState(null,'','#'+select.value);render();});
search.addEventListener('input',()=>{select.value='all';page=0;render();});
for(const [id,delta] of [['prevUnit',-1],['nextUnit',1]])document.getElementById(id).addEventListener('click',()=>{const i=units.findIndex(u=>u.id===select.value);const u=units[i+delta];if(u){search.value='';location.hash=u.id;}});
for(const [id,delta] of [['prevPage',-1],['nextPage',1]])document.getElementById(id).addEventListener('click',()=>{page+=delta;render();window.scrollTo(0,0);});
window.addEventListener('hashchange',()=>{search.value='';choose();});choose();
</script></body></html>\n`;
}
module.exports = { renderReview };
