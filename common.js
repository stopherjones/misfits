const SCORE={"It's a favourite of mine":100,"I know it, I like it, I'm pretty good at it":60,"I know it, I like it, I'm just not that good at it":35,"I know it, it's OK, I'll play it if needs be":10,"I don't know it, I'm happy to learn it and play it":5,"No opinion given":0,"I know it, I don't like it, I'd rather avoid it":null,"I don't know it, I don't want to learn it or play it":null};
// Colours and labels taken from the preferences sheet key.
const KEY=[
 {score:100,label:'Favourite',bg:'#6fa8dc',fg:'#000'},
 {score:60,label:'Like, pretty good',bg:'#93c47d',fg:'#000'},
 {score:35,label:'Like, not that good',bg:'#ffffff',fg:'#000'},
 {score:10,label:'OK if needed',bg:'#ffd966',fg:'#000'},
 {score:5,label:'Will learn',bg:'#f6b26b',fg:'#000'},
 {score:0,label:'No opinion',bg:'#d9d9d9',fg:'#000'},
 {score:null,raw:"I know it, I don't like it, I'd rather avoid it",label:'Avoid',bg:'#ff0000',fg:'#fff'},
 {score:null,raw:"I don't know it, I don't want to learn it or play it",label:'Will not learn',bg:'#990000',fg:'#fff'},
];
const KEYBY=s=>KEY.find(k=>k.score===s&&k.raw===undefined)||KEY.find(k=>k.score===s);
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s||'').trim().replace(/\s+/g,' ').toLowerCase();
const st={prefText:'',schedText:'',prefs:{},raw:{},players:[],games:[],slots:[],assign:new Map(),locks:new Set(),absent:{},caps:{},country:{},view:'grid',pending:null,history:[],baseline:null,tray:[]};
let storeTimer;


function parseCSV(text,keepBlank=false){
  const rows=[];let row=[],f='',q=false;text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];
    if(c==='"'&&q&&n==='"'){f+='"';i++}else if(c==='"')q=!q;
    else if(c===','&&!q){row.push(f);f=''}
    else if((c==='\n'||c==='\r')&&!q){if(c==='\r'&&n==='\n')i++;row.push(f);if(keepBlank||row.some(x=>x.trim()))rows.push(row);row=[];f=''}
    else f+=c;}
  if(f.length||row.length){row.push(f);if(keepBlank||row.some(x=>x.trim()))rows.push(row)}
  return rows;
}
function keyFor(raw){
  const r=norm(raw);if(!r)return undefined;
  return Object.keys(SCORE).find(k=>norm(k)===r)||Object.keys(SCORE).find(k=>r===norm(k.slice(0,45)));
}
function parsePrefs(text){
  const rows=parseCSV(text);if(rows.length<2)throw Error('No data rows in preferences CSV.');
  const header=rows[0].map(x=>x.trim());
  const cols=header.map((h,i)=>({h,i})).filter(({h,i})=>i>0&&h&&!h.startsWith('#')&&!/players?\s+(like|dislike|love)/i.test(h));
  if(!cols.length)throw Error('No player columns found after the game column.');
  const prefs={},raw={};cols.forEach(({h})=>{prefs[h]={};raw[h]={}});const games=[];
  for(let r=1;r<rows.length;r++){
    const game=(rows[r][0]||'').trim();if(!game)continue;games.push(game);
    cols.forEach(({h,i})=>{const k=keyFor(rows[r][i]);raw[h][game]=k;prefs[h][game]=k===undefined?undefined:SCORE[k]});
  }
  st.prefs=prefs;st.raw=raw;st.players=cols.map(c=>c.h);st.games=[...new Set(games)];
  return `Loaded ${st.players.length} players and ${st.games.length} games.`;
}
function parseSched(text){
  const rows=parseCSV(text,true);
  if(rows.filter(r=>r.some(c=>String(c).trim())).length<2)throw Error('No data rows in schedule CSV.');
  const h=(rows[0]||[]).map(norm);
  const wi=h.indexOf('week'),ri=h.indexOf('round'),gi=h.indexOf('game');
  const slots=[];
  if(wi>=0&&ri>=0&&gi>=0){
    for(let i=1;i<rows.length;i++){const g=(rows[i][gi]||'').trim();if(!g)continue;
      slots.push({id:'s'+slots.length,week:String(rows[i][wi]||'1').trim(),round:String(rows[i][ri]||'').trim(),game:g});}
  }else{
    // Stage A layout: Round column, game titles across the row, a 'Rest' column.
    // The round number sits on the first row of each block; blank rows separate game weeks.
    const roundCol=h.indexOf('round');
    if(roundCol<0)throw Error('Could not find a Round column. Use Week,Round,Game headers or the Stage A layout.');
    let gameStart=h.indexOf('games / players');if(gameStart<0)gameStart=roundCol+2;
    let restCol=h.indexOf('rest');if(restCol<0)restCol=rows.reduce((m,r)=>Math.max(m,r.length),0);
    let week=1,blankSince=false,lastRound='';
    for(let i=1;i<rows.length;i++){
      const row=rows[i];
      if(!row.some(c=>String(c||'').trim())){if(lastRound)blankSince=true;continue}
      const round=String(row[roundCol]||'').trim();if(!round)continue;
      if(blankSince&&lastRound&&round!==lastRound){week++;blankSince=false}
      lastRound=round;
      for(let c=gameStart;c<Math.min(restCol,row.length);c++){
        const game=String(row[c]||'').trim();
        if(!game||/^games\s*\/\s*players$/i.test(game)||/^rest$/i.test(game))continue;
        slots.push({id:'s'+slots.length,week:String(week),round,game});
      }
    }
  }
  if(!slots.length)throw Error('No game slots found in the schedule.');
  st.slots=slots;st.assign=new Map();st.locks=new Set();st.history=[];st.tray=[];
  return `Loaded ${slots.length} slots across ${new Set(slots.map(s=>s.round)).size} rounds and ${new Set(slots.map(s=>s.week)).size} weeks.`;
}

/* ---------- shared settings (rules, players) ---------- */
const SET={gpr:6,teamSize:9,penalty:20,absent:{},caps:{},country:{}};
function loadSettings(){
  try{const d=JSON.parse(localStorage.getItem('misfits-settings')||'null');if(d)Object.assign(SET,d)}catch(e){}
  SET.absent=SET.absent||{};SET.caps=SET.caps||{};SET.country=SET.country||{};
}
function saveSettings(){try{localStorage.setItem('misfits-settings',JSON.stringify(SET))}catch(e){}}
/* ---------- data sources (data/sources.json) ---------- */
async function loadSources(){
  const r=await fetch('data/sources.json',{cache:'no-cache'});
  if(!r.ok)throw Error('data/sources.json HTTP '+r.status);
  const j=await r.json();
  if(!j.preferences||!j.schedule)throw Error('sources.json needs "preferences" and "schedule" URLs');
  return j;
}
async function fetchText(url){
  const r=await fetch(url);
  if(!r.ok)throw Error('HTTP '+r.status+' loading a sheet');
  return r.text();
}
/* ---------- season state (assignments, locks, baseline, holding area) ---------- */
function seasonSig(){
  let h=0;const s=st.slots.map(x=>x.round+'|'+x.week+'|'+x.game).join(';');
  for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;
  return st.slots.length+':'+h;
}
