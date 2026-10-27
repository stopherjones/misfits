/* Scheduler page logic. Shared state and parsing: common.js. Solver: solver.js. */
const weeks=()=>[...new Set(st.slots.map(s=>s.week))].sort((a,b)=>a-b);
const rounds=()=>[...new Set(st.slots.map(s=>s.round))].sort((a,b)=>a-b);
function awayRound(p,round){const s=st.slots.find(x=>x.round===round);return !!s&&(st.absent[p]||[]).includes(s.week)}
function opts(){
  return {players:st.players.map(p=>({name:p,absentWeeks:new Set(st.absent[p]||[]),cap:st.caps[p]??null})),
    slots:st.slots,score:(p,g)=>st.prefs[p]?.[g]};
}
function keyOf(p,g){const k=st.raw[p]?.[g];return k===undefined?null:KEY.find(x=>x.score===SCORE[k]&&(x.raw===undefined||x.raw===k))||null}
function colourFor(p,g){
  const v=st.prefs[p]?.[g];
  if(v===undefined)return {bg:'#eeeeee',fg:'#333',label:'No response'};
  const k=keyOf(p,g);return k||{bg:'#eeeeee',fg:'#333',label:'—'};
}
/* ---------- history: undo and revert ---------- */
function setAssign(map){
  st.history.push([...st.assign]);if(st.history.length>40)st.history.shift();
  st.assign=new Map(map);st.pending=null;save();renderAll();
}
function undo(){
  if(!st.history.length){status('genStatus','Nothing to undo.','warn');return}
  st.assign=new Map(st.history.pop());st.pending=null;save();status('genStatus','Undone.','ok');renderAll();
}
function saveBaseline(){
  st.baseline=[...st.assign];save();status('genStatus',`Saved ${st.assign.size} assignments as the baseline.`,'ok');
}
function revert(){
  if(!st.baseline){status('genStatus','No baseline saved yet. Use "Save as baseline" first.','warn');return}
  setAssign(new Map(st.baseline));status('genStatus','Reverted to the saved baseline. Use Undo to step back.','ok');
}

/* ---------- generate ---------- */
function generate(){
  if(!st.players.length||!st.slots.length){status('genStatus','Load preferences and a schedule first.','err');return}
  const fixed=new Map();for(const [sid,p] of st.assign)if(st.locks.has(sid))fixed.set(sid,p);
  const res=solveSchedule({...opts(),fixed,current:st.assign,changePenalty:SET.penalty});
  let msg=`Solved: ${res.assignment.size}/${st.slots.length} slots filled.`;
  if(res.favMissing.length)msg+=`\nNo favourite for: ${res.favMissing.join(', ')}.`;
  if(res.unfilled.length)msg+=`\n${res.unfilled.length} slot(s) could not be filled. Check absences and locks.`;
  if(res.issues.length)msg+='\n'+res.issues.join('\n');
  setAssign(res.assignment);
  status('genStatus',msg,res.unfilled.length||res.issues.length?'err':res.favMissing.length?'warn':'ok');
}

/* ---------- proposals: any change goes through the solver ---------- */
function requestMoves(moves,label,displaced=null){
  const state={opts:opts(),current:st.assign,locks:st.locks,changePenalty:SET.penalty};
  const {res,changes}=proposeMoves(state,moves);
  st.pending={moves,label,res,changes,displaced};renderProposal();
}
function acceptPending(){
  if(!st.pending)return;
  const used=new Set(st.pending.moves.map(m=>m[0]));
  st.tray=st.tray.filter(t=>!used.has(t.sid)); 
  setAssign(st.pending.res.assignment);status('genStatus','Move applied.','ok');
}
function renderProposal(){
  const box=$('proposal');
  if(!st.pending){box.innerHTML='';return}
  const {moves,label,res,changes}=st.pending;
  const before=new Map(st.players.map(p=>[p,0])),after=new Map(st.players.map(p=>[p,0]));
  for(const [,p] of st.assign)if(before.has(p))before.set(p,before.get(p)+1);
  for(const [,p] of res.assignment)if(after.has(p))after.set(p,after.get(p)+1);
  const diffs=st.players.filter(p=>before.get(p)!==after.get(p)).map(p=>`${esc(p)} ${before.get(p)}→${after.get(p)}`);
  const warn=[];
  for(const [sid,p] of moves){const s=st.slots.find(x=>x.id===sid);if(typeof st.prefs[p]?.[s.game]!=='number')warn.push(`${esc(p)} has said they don't want to play ${esc(s.game)}`)}
  if(res.favMissing.length)warn.push(`Would leave without a favourite: ${res.favMissing.map(esc).join(', ')}`);
  if(res.unfilled.length)warn.push(`${res.unfilled.length} slot(s) would be unfilled`);
  if(res.issues.length)warn.push(res.issues.map(esc).join('; '));
  const lines=changes.map(c=>{
    const b=c.before?esc(c.before):'<i>empty</i>',a=c.after?esc(c.after):'<i>empty</i>';
    return `<li>Round ${esc(c.slot.round)} (wk ${esc(c.slot.week)}) <b>${esc(c.slot.game)}</b>: ${b} → <b>${a}</b></li>`}).join('');
  const dn=st.pending.displaced?(()=>{const d=st.slots.find(x=>x.id===st.pending.displaced);return `<p class="small">Holding: <b>${esc(d.game)}</b> (Round ${esc(d.round)}, was ${esc(st.assign.get(d.id))}) needs a new player. The path below shows where it goes.</p>`})():'';
  box.innerHTML=`<div class="prop"><h3>${esc(label)}</h3>${dn}
   <p class="small">${changes.length} slot(s) change. Totals: ${diffs.length?diffs.join(', '):'unchanged'}.</p>
   ${warn.length?`<div class="status warn">${warn.join('<br>')}</div>`:''}
   <ul>${lines||'<li>No changes needed.</li>'}</ul>
   <div class="buttons"><button id="acceptMove">Apply</button><button class="bad" id="cancelMove">Cancel</button></div></div>`;
  $('acceptMove').onclick=acceptPending;$('cancelMove').onclick=()=>{st.pending=null;renderProposal()};
}

/* ---------- grid: tap to lock, long-press to drag ---------- */
function renderGrid(){
  if(!st.slots.length){$('view').innerHTML='';return}
  const preview=st.pending?st.pending.res.assignment:null;
  const view=preview||st.assign;
  const n=st.players.length;
  const at=(map,p,r)=>st.slots.find(s=>s.round===r&&map.get(s.id)===p);
  const weekNums=st.slots.map(s=>Number(s.week));
  const lo=Math.min(...weekNums),hi=Math.max(...weekNums);
  const interactive=!preview;
  let html=`<div class="tablewrap"><table class="grid"><thead><tr>${st.players.map(p=>`<th title="${esc(p)}">${esc(p)}${st.country[p]?`<div class="small" style="font-weight:400">${esc(st.country[p])}</div>`:''}</th>`).join('')}</tr></thead><tbody>`;
  for(let w=lo;w<=hi;w++){
    const ws=String(w);
    const rs=rounds().filter(r=>st.slots.some(s=>s.round===r&&s.week===ws));
    if(!rs.length){html+=`<tr class="restweek"><td colspan="${n}">Week ${w} · no games</td></tr>`;continue}
    html+=`<tr class="weekhead"><td colspan="${n}">Week ${w}</td></tr>`;
    for(const r of rs){
      html+='<tr>';
      for(const p of st.players){
        const s=at(view,p,r), base=at(st.assign,p,r);
        const changed=!!preview&&((s?s.id:'')!==(base?base.id:''));
        const was=changed&&base?`<span class="was">was ${esc(base.game)}</span>`:(changed?'<span class="was">was empty</span>':'');
        const dataAttrs=interactive?`data-cell data-drop="cell" data-player="${esc(p)}" data-round="${esc(r)}"`:'';
        const rn=`<span class="rn">R${esc(r)}</span>`;
        if(s){
          const c=colourFor(p,s.game);
          const cls=changed?(base?'chg-in':'chg-new'):'';
          const more=interactive?`<button class="more" data-more="${s.id}" aria-label="Game actions">⋯</button>`:'';
          html+=`<td><div class="cell ${cls}" ${dataAttrs} data-slot="${s.id}" style="background:${c.bg};color:${c.fg}">${rn}${esc(s.game)}${st.locks.has(s.id)?' 🔒':''}${was}${more}</div></td>`;
        }else if(awayRound(p,r)){
          html+=`<td><div class="cell away" ${dataAttrs}>${rn}away</div></td>`;
        }else{
          html+=`<td><div class="cell rest ${changed?'chg-out':''}" ${dataAttrs}>${rn}rest${was}</div></td>`;
        }
      }
      html+='</tr>';
    }
  }
  html+='<tr class="totals">'+st.players.map(p=>`<td><b>${view.size?[...view.values()].filter(x=>x===p).length:0}</b> games</td>`).join('')+'</tr>';
  const note=preview
    ? '<div class="status warn">Preview: highlighted cells would change. Apply or cancel the change above the grid. Grid actions are paused while previewing.</div>'
    : '<p class="small">Use the ⋯ on a game to lock it or see alternative paths. Press and hold to drag: onto a rest cell in the same round to move it, onto another player\'s game to displace that game (it goes to the holding area for a fill path), or onto the holding area for a different round. Right-click a game for alternative paths.</p>';
  $('view').innerHTML=html+'</tbody></table></div>'+legendHTML()+note;
  if(interactive)bindGrid();
}
function legendHTML(){
  return '<div class="legend">'+KEY.map(k=>`<span class="chip" style="background:${k.bg};color:${k.fg}">${esc(k.label)}</span>`).join('')+'</div>';
}
let press=null,ghost=null;
function startGhost(text){
  ghost=document.createElement('div');ghost.className='ghost';ghost.textContent=text;document.body.appendChild(ghost);
}
function stopGhost(){if(ghost){ghost.remove();ghost=null}}
function bindGrid(){
  document.querySelectorAll('[data-more]').forEach(b=>b.onclick=e=>{e.stopPropagation();openMenu(b.dataset.more,b)});
  document.querySelectorAll('[data-cell]').forEach(el=>{
    el.addEventListener('pointerdown',e=>{
      if(e.button>0||e.target.closest('.more'))return;
      const d=el.dataset;
      press={sid:d.slot||null,p:d.player,r:d.round,x:e.clientX,y:e.clientY,drag:false,moved:false,text:el.textContent.trim()};
      press.timer=setTimeout(()=>{
        if(!press||press.moved||!press.sid)return;
        press.drag=true;startGhost(press.text);
        if(navigator.vibrate)navigator.vibrate(15);
      },350);
    });
    el.addEventListener('contextmenu',e=>{e.preventDefault();if(el.dataset.slot)showAlternatives(el.dataset.slot)});
  });
}
window.addEventListener('pointermove',e=>{
  if(!press)return;
  if(!press.drag&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>10){press.moved=true;clearTimeout(press.timer)}
  if(press.drag&&ghost){ghost.style.left=(e.clientX+12)+'px';ghost.style.top=(e.clientY+12)+'px'}
});
document.addEventListener('touchmove',e=>{if(press&&press.drag)e.preventDefault()},{passive:false});
window.addEventListener('pointerup',e=>{
  if(!press)return;
  clearTimeout(press.timer);const pr=press;press=null;stopGhost();
  if(pr.drag){
    const t=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-drop]');
    if(t)handleDrop(t.dataset,pr);else status('genStatus','Drop cancelled.','');
    return;
  }
});
window.addEventListener('pointercancel',()=>{clearTimeout(press?.timer);press=null;stopGhost()});
function toggleLock(sid){
  st.locks.has(sid)?st.locks.delete(sid):st.locks.add(sid);save();renderAll();
}
function handleDrop(d,from){
  if(d.drop==='tray'){
    if(!st.tray.some(t=>t.sid===from.sid))st.tray.push({sid:from.sid,to:''});
    save();renderTray();status('genStatus','Added to the holding area. Choose a player for it, then propose.','');return;
  }
  if(d.drop!=='cell')return;
  const src=st.slots.find(s=>s.id===from.sid);if(!src)return;
  if(st.locks.has(from.sid)){status('genStatus','That game is locked. Tap it to unlock first.','warn');return}
  if(d.round!==src.round){status('genStatus','Games move within a round. Drop on the holding area to queue a move to another round.','warn');return}
  if(d.player===from.p)return;
  if(awayRound(d.player,src.round)){status('genStatus',`${d.player} is away that week.`,'err');return}
  let moves,label,displaced=null;
  if(d.slot){
    if(st.locks.has(d.slot)){status('genStatus','The target game is locked. Unlock it first.','warn');return}
    moves=[[from.sid,d.player]];label=`${d.player} takes ${src.game}; ${from.p}'s game is displaced`;displaced=d.slot;
  }else{moves=[[from.sid,d.player]];label=`Move ${src.game} to ${d.player} in Round ${src.round}`}
  requestMoves(moves,label,displaced);
}

/* ---------- holding area ---------- */
function renderTray(){
  const box=$('tray');
  const items=st.tray.filter(t=>st.assign.has(t.sid)||st.slots.some(s=>s.id===t.sid));
  st.tray=items;
  if(!items.length){box.innerHTML='<div class="tray-empty">Holding area: drag a game here to queue a move to another round. Choose a player for each, then propose the set as one solved change.</div>';return}
  box.innerHTML='<h3>Holding area</h3>'+items.map(t=>{
    const s=st.slots.find(x=>x.id===t.sid);const cur=st.assign.get(t.sid)||'empty';
    const options=st.players.filter(p=>typeof st.prefs[p]?.[s.game]==='number'&&!awayRound(p,s.round)&&p!==cur);
    return `<div class="trayrow"><span><b>${esc(s.game)}</b> · R${esc(s.round)} · now ${esc(cur)}</span>
      <select data-tray="${t.sid}"><option value="">— choose player —</option>${options.map(p=>`<option value="${esc(p)}" ${p===t.to?'selected':''}>${esc(p)}</option>`).join('')}</select>
      <button class="sec" data-trayremove="${t.sid}">Remove</button></div>`}).join('')+
    '<div class="buttons"><button id="proposeTray">Propose these moves</button><button class="sec" id="clearTray">Clear holding area</button></div>';
  box.querySelectorAll('select').forEach(el=>el.onchange=()=>{const t=st.tray.find(x=>x.sid===el.dataset.tray);t.to=el.value;save()});
  box.querySelectorAll('[data-trayremove]').forEach(el=>el.onclick=()=>{st.tray=st.tray.filter(x=>x.sid!==el.dataset.trayremove);save();renderTray()});
  $('proposeTray').onclick=()=>{
    const moves=st.tray.filter(t=>t.to).map(t=>[t.sid,t.to]);
    if(!moves.length){status('genStatus','Choose a player for at least one queued game.','warn');return}
    requestMoves(moves,`Queued moves (${moves.length})`);
  };
  $('clearTray').onclick=()=>{st.tray=[];save();renderTray()};
}

function renderChecks(){
  if(!st.slots.length||!st.players.length){$('checks').innerHTML='';return}
  const counts=Object.fromEntries(st.players.map(p=>[p,0]));
  const dup=[],absent=[],inel=[];const roundFill={};
  for(const s of st.slots){const p=st.assign.get(s.id);if(!p)continue;
    counts[p]++;const k=s.round+'|'+p;if(roundFill[k])dup.push(`${p} twice in round ${s.round}`);roundFill[k]=1;
    if(awayRound(p,s.round))absent.push(`${p} in round ${s.round}`);
    if(typeof st.prefs[p]?.[s.game]!=='number')inel.push(`${p} on ${s.game}`);}
  const unfilled=st.slots.filter(s=>!st.assign.get(s.id)).length;
  const vals=Object.values(counts),spread=Math.max(...vals)-Math.min(...vals);
  const perRound=rounds().map(r=>({r,n:st.slots.filter(s=>s.round===r&&st.assign.get(s.id)).length,total:st.slots.filter(s=>s.round===r).length}));
  const gpr=SET.gpr,ts=SET.teamSize;
  const issues=[];
  if(dup.length)issues.push('Duplicate rounds: '+dup.join('; '));
  if(absent.length)issues.push('Scheduled while away: '+absent.join('; '));
  if(inel.length)issues.push('Ineligible assignments: '+inel.join('; '));
  if(unfilled)issues.push(unfilled+' unfilled slot(s).');
  if(spread>1)issues.push('Games spread is '+spread+' (rule: max − min ≤ 1 unless caps or away weeks force it).');
  if(perRound.some(x=>x.total!==gpr))issues.push('Some rounds do not have '+gpr+' games.');
  if(ts!==st.players.length)issues.push(`Squad has ${st.players.length} players, expected ${ts}.`);
  $('checks').innerHTML=`<h3>Checks</h3><p>${st.players.map(p=>`<span class="pill">${esc(p)}: <b>${counts[p]}</b>${st.caps[p]!=null?' (cap '+st.caps[p]+')':''}</span>`).join('')}</p>
   <p class="small">Games spread ${spread} · rests per round ${st.players.length-gpr} · ${unfilled} unfilled · ${st.locks.size} locked</p>
   ${issues.length?`<div class="status warn">${issues.map(esc).join('<br>')}</div>`:'<div class="status ok">No rule breaches.</div>'}`;
}
function renderAll(){
  renderChecks();
  renderGrid();
  renderTray();renderProposal();
}
function status(id,msg,kind=''){const el=$(id)||$('genStatus');if(!el)return;el.textContent=msg;el.className='status '+kind}
/* ---------- season persistence and boot ---------- */
function save(){clearTimeout(storeTimer);storeTimer=setTimeout(()=>{try{localStorage.setItem('misfits-season',JSON.stringify({sig:seasonSig(),assign:[...st.assign],locks:[...st.locks],baseline:st.baseline,tray:st.tray}))}catch(e){}},200)}
function restoreSeason(){
  try{const d=JSON.parse(localStorage.getItem('misfits-season')||'null');if(!d||d.sig!==seasonSig())return;
    st.assign=new Map(d.assign||[]);st.locks=new Set(d.locks||[]);st.baseline=d.baseline||null;st.tray=d.tray||[];
  }catch(e){}
}
async function boot(){
  loadSettings();st.absent=SET.absent;st.caps=SET.caps;st.country=SET.country;
  try{
    const src=await loadSources();
    const [p,s]=await Promise.all([fetchText(src.preferences),fetchText(src.schedule)]);
    const a=parsePrefs(p),b=parseSched(s);
    restoreSeason();
    status('genStatus',a+' '+b,'ok');
  }catch(e){
    status('genStatus','Could not load the sheets: '+e.message+'. Check data/sources.json and that both sheets are published as CSV.','err');
  }
  renderAll();
}
$('generate').onclick=generate;
$('undo').onclick=undo;$('revert').onclick=revert;$('saveBaseline').onclick=saveBaseline;
$('clearAll').onclick=()=>{setAssign(new Map());status('genStatus','Assignments cleared (locks kept). Undo to restore.','');};
$('exportCsv').onclick=()=>{
  const rows=[['Week','Round','Game','Player','Preference']];
  st.slots.forEach(s=>{const p=st.assign.get(s.id)||'';const k=p?keyOf(p,s.game):null;rows.push([s.week,s.round,s.game,p,k?k.label:''])});
  const csv=rows.map(r=>r.map(c=>/[",\n]/.test(String(c))?'"'+String(c).replace(/"/g,'""')+'"':c).join(',')).join('\r\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='misfits-schedule.csv';a.click();
};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='z'&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){e.preventDefault();undo()}});
boot();

/* ---------- objective options ---------- */
function penalty(){return SET.penalty}
function metrics(map){
  let sum=0,n=0,favs=0,likes=0,ok=0,learn=0;const pairs={};
  for(const [sid,p] of map){
    const s=st.slots.find(x=>x.id===sid);if(!s)continue;
    const v=st.prefs[p]?.[s.game];if(typeof v!=='number')continue;
    n++;sum+=v;
    if(v===100)favs++;else if(v===60||v===35)likes++;else if(v===10)ok++;else if(v===5)learn++;
    const k=p+'|'+s.game;pairs[k]=(pairs[k]||0)+1;
  }
  const repeats=Object.values(pairs).reduce((a,c)=>a+Math.max(0,c-1),0);
  const counts=st.players.map(p=>[...map.values()].filter(x=>x===p).length);
  return {happy:n?sum/n:0,favs,likes,ok,learn,repeats,spread:counts.length?Math.max(...counts)-Math.min(...counts):0,filled:map.size,total:st.slots.length};
}
const MODES=[
  {m:'happy',title:'Maximise favourites and likes',blurb:'Highest happiness. May include games people need to learn.'},
  {m:'nolearn',title:'Avoid learning new games',blurb:'Players mostly play games they already know, even if that lowers happiness.'},
  {m:'norepeat',title:'Avoid repeat games',blurb:'Each player plays a given title at most once where possible.'},
];
function compareOptions(){
  if(!st.players.length||!st.slots.length){status('genStatus','Load preferences and a schedule first.','err');return}
  const fixed=new Map();for(const [sid,p] of st.assign)if(st.locks.has(sid))fixed.set(sid,p);
  st.options=MODES.map(o=>{const res=solveMode({...opts(),fixed,current:new Map(),changePenalty:0},o.m);return {...o,res,met:metrics(res.assignment)}});
  renderOptions();status('genStatus','Compared three objectives. Locked games were kept in each.','ok');
}
function renderOptions(){
  const box=$('options');
  if(!st.options||!st.options.length){box.innerHTML='';return}
  box.innerHTML='<h3>Solution options</h3><div class="optgrid">'+st.options.map((o,i)=>{const m=o.met;
    return `<div class="optcard"><h4>${esc(o.title)}</h4><p class="small">${esc(o.blurb)}</p>
    <div class="score">${m.happy.toFixed(0)}<span class="small"> / 100 avg happiness</span></div>
    <ul class="small"><li>Favourites: ${m.favs}</li><li>Likes: ${m.likes}</li><li>OK if needed: ${m.ok}</li><li>Learning new: ${m.learn}</li><li>Repeat games: ${m.repeats}</li><li>Games spread: ${m.spread}</li><li>Filled: ${m.filled}/${m.total}</li></ul>
    <button data-opt="${i}">Use this</button></div>`}).join('')+'</div>';
  box.querySelectorAll('[data-opt]').forEach(b=>b.onclick=()=>{
    const o=st.options[Number(b.dataset.opt)];
    setAssign(o.res.assignment);
    status('genStatus',`Using: ${o.title}. Undo to go back.`,o.res.unfilled.length?'err':'ok');
  });
}

/* ---------- alternative paths for one game (right-click) ---------- */
function showAlternatives(sid){
  const s=st.slots.find(x=>x.id===sid);if(!s)return;
  const cur=st.assign.get(sid);
  const list=st.players.filter(p=>p!==cur&&typeof st.prefs[p]?.[s.game]==='number'&&!awayRound(p,s.round)).map(q=>{
    const {res,changes}=proposeMoves({opts:opts(),current:st.assign,locks:st.locks,changePenalty:penalty()},[[sid,q]]);
    return {q,res,changes,met:metrics(res.assignment),moves:[[sid,q]]};
  }).filter(x=>x.res.unfilled.length===0&&x.res.issues.length===0);
  list.sort((a,b)=>(b.met.happy-a.met.happy)||(a.changes.length-b.changes.length));
  st.alts={sid,list:list.slice(0,6)};renderAlts();
}
function renderAlts(){
  const box=$('alts');
  if(!st.alts){box.innerHTML='';return}
  const s=st.slots.find(x=>x.id===st.alts.sid);
  if(!st.alts.list.length){
    box.innerHTML=`<div class="prop"><h3>Alternative paths: ${esc(s.game)}</h3><p class="small">No other player can take this game without breaking a rule.</p><button class="sec" id="closeAlts">Close</button></div>`;
    $('closeAlts').onclick=()=>{st.alts=null;renderAlts()};return;
  }
  box.innerHTML=`<div class="prop"><h3>Alternative paths: ${esc(s.game)} (Round ${esc(s.round)}, now ${esc(st.assign.get(s.id)||'empty')})</h3>
  <p class="small">Each option gives this game to a different player and re-solves the rest. Sorted by happiness, then by how many slots change.</p>
  <table><thead><tr><th>Give to</th><th>Slots changed</th><th>Happiness</th><th>Favourites</th><th>Repeats</th><th></th></tr></thead><tbody>`+
  st.alts.list.map((x,i)=>`<tr><td><b>${esc(x.q)}</b></td><td>${x.changes.length}</td><td>${x.met.happy.toFixed(0)}</td><td>${x.met.favs}</td><td>${x.met.repeats}</td><td><button data-alt="${i}">Preview</button></td></tr>`).join('')+
  '</tbody></table><div class="buttons"><button class="sec" id="closeAlts">Close</button></div></div>';
  box.querySelectorAll('[data-alt]').forEach(b=>b.onclick=()=>{
    const x=st.alts.list[Number(b.dataset.alt)];
    st.pending={moves:x.moves,label:`Give ${s.game} to ${x.q}`,res:x.res,changes:x.changes,displaced:null};
    renderProposal();window.scrollTo({top:0,behavior:'smooth'});
  });
  $('closeAlts').onclick=()=>{st.alts=null;renderAlts()};
}
$('compareOptions').onclick=compareOptions;

/* ---------- game actions menu (⋯) ---------- */
let menuSid=null;
function openMenu(sid,anchor){
  const s=st.slots.find(x=>x.id===sid);if(!s)return;
  menuSid=sid;
  const m=$('menu'), r=anchor.getBoundingClientRect();
  const locked=st.locks.has(sid);
  m.innerHTML=`<div class="menuhead">${esc(s.game)} · R${esc(s.round)} · ${esc(st.assign.get(sid)||'empty')}</div>
    <button data-act="alts">Alternative paths</button>
    <button data-act="lock">${locked?'Unlock':'Lock'} this game</button>`;
  m.style.display='block';
  const w=200;m.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
  m.style.top=Math.min(r.bottom+4,innerHeight-120)+'px';
  m.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{
    const act=b.dataset.act;closeMenu();
    if(act==='alts')showAlternatives(sid);else toggleLock(sid);
  });
}
function closeMenu(){const m=$('menu');m.style.display='none';menuSid=null}
document.addEventListener('pointerdown',e=>{if(menuSid&&!e.target.closest('#menu')&&!e.target.closest('.more'))closeMenu()});
