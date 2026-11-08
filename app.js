
/** Namma Paalu arithmetic engine. Monetary values always integer paise. */
function assertMinor(value, label='amount') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be nonnegative safe integer paise`);
}
function assertUnique(xs, what) {if(new Set(xs).size!==xs.length)throw new Error(`Duplicate ${what}`);}
/** Deterministic largest-remainder split with lexical id tie breaks. */
function allocate(amount, weights) {
  assertMinor(amount);
  const entries=Object.entries(weights).sort(([a],[b])=>a.localeCompare(b));
  if(!entries.length||entries.some(([,w])=>!Number.isSafeInteger(w)||w<0)) throw new Error('Invalid allocation weights');
  const sum=entries.reduce((s,[,w])=>s+BigInt(w),0n);
  if(sum<=0n)throw new Error('Allocation weight total must be positive');
  const num=BigInt(amount);
  const parts=entries.map(([id,w])=>{const numerator=num*BigInt(w);return {id,share:Number(numerator/sum),rem:numerator%sum};});
  let left=amount-parts.reduce((s,p)=>s+p.share,0);
  const ranked=[...parts].sort((a,b)=>a.rem===b.rem?a.id.localeCompare(b.id):(a.rem>b.rem?-1:1));
  for(let i=0;i<left;i++)ranked[i].share++;
  return Object.fromEntries(parts.map(p=>[p.id,p.share]));
}
function validate(trip) {
  if(!Array.isArray(trip.households)||!Array.isArray(trip.travellers)||!Array.isArray(trip.expenses))throw new Error('Invalid trip');
  const ids=trip.households.map(x=>x.id), tids=trip.travellers.map(x=>x.id);
  assertUnique(ids,'household IDs');assertUnique(tids,'traveller IDs');
  if((!ids.length||!tids.length)&&(trip.expenses.length||(trip.confirmedPayments||[]).length))throw new Error('Add travellers before recording expenses or payments');
  for(const tr of trip.travellers)if(!ids.includes(tr.householdId))throw new Error('Traveller has invalid household');
  assertUnique(trip.expenses.map(x=>x.id),'expense IDs');
}
function calculateTrip(trip) {
  validate(trip);
  const hids=trip.households.map(x=>x.id), people=Object.fromEntries(trip.travellers.map(x=>[x.id,x]));
  const balances=Object.fromEntries(hids.map(id=>[id,0]));
  const paid=Object.fromEntries(hids.map(id=>[id,0]));
  const owed=Object.fromEntries(hids.map(id=>[id,0]));
  const allocations=[];
  let total=0;
  for(const exp of trip.expenses){
    assertMinor(exp.amount,exp.id);
    if(!hids.includes(exp.payerHouseholdId))throw new Error('Unknown payer household');
    if(exp.payerTravellerId && (!people[exp.payerTravellerId]||people[exp.payerTravellerId].householdId!==exp.payerHouseholdId))throw new Error('Payer must belong to the selected family');
    const participants=exp.participants;
    if(!Array.isArray(participants)||!participants.length)throw new Error('Expense has no participants');
    assertUnique(participants,'expense participants');
    if(participants.some(id=>!people[id]))throw new Error('Unknown participant');
    const method=exp.method||'equal';
    let portions;
    if(method==='equal')portions=allocate(exp.amount,Object.fromEntries(participants.map(id=>[id,1])));
    else if(method==='weighted'||method==='percentage'){
      if(Object.keys(exp.weights||{}).length!==participants.length || participants.some(id=>!(id in exp.weights)))throw new Error('Incomplete weights');
      if(method==='percentage'&&Object.values(exp.weights).reduce((a,b)=>a+b,0)!==10000)throw new Error('Percentages must total 100%');
      portions=allocate(exp.amount,exp.weights);
    } else if(method==='exact'){
      if(participants.some(id=>!Object.hasOwn(exp.amounts||{},id))||Object.keys(exp.amounts||{}).length!==participants.length)throw new Error('Incomplete exact shares');
      for(const amt of Object.values(exp.amounts))assertMinor(amt,'Exact share');
      if(Object.values(exp.amounts).reduce((s,x)=>s+x,0)!==exp.amount)throw new Error('Exact shares must sum to expense');
      portions={...exp.amounts};
    }else throw new Error('Unknown split method');
    total+=exp.amount;
    if(!Number.isSafeInteger(total))throw new Error('Trip total too large');
    paid[exp.payerHouseholdId]+=exp.amount;
    for(const [personId,amount] of Object.entries(portions)){
      const hid=people[personId].householdId;
      owed[hid]+=amount;
      allocations.push({expenseId:exp.id,travellerId:personId,householdId:hid,amount});
    }
  }
  for(const hid of hids) balances[hid]=paid[hid]-owed[hid];
  // Only confirmed payments affect the ledger. Claims do not.
  for(const p of trip.confirmedPayments||[]){
    assertMinor(p.amount);
    if(!p.amount||!hids.includes(p.from)||!hids.includes(p.to)||p.from===p.to)throw new Error('Invalid confirmed payment');
    balances[p.from]+=p.amount;
    balances[p.to]-=p.amount;
  }
  if(Object.values(balances).reduce((s,n)=>s+n,0)!==0)throw new Error('Unbalanced ledger');
  const transfers=settle(balances);
  return {total,paid,owed,balances,allocations,transfers,remaining:transfers.reduce((s,t)=>s+t.amount,0)};
}
/** Car costs have independent ledgers per paying car; general trip costs are separate. */
function originalCarPayer(t){
 const original=t.expenses.find(e=>e.id==='petrol')||t.expenses.find(e=>/\b(petrol|fuel|toll)\b/i.test(e.name));
 return original?.payerHouseholdId||null;
}
/** Independent settlement ledger: main = original shared trip + first car. */
function expenseBucket(t,e){
 if(e.ledgerId==='main'||e.splitGroup==='shared')return 'main';
 if(typeof e.ledgerId==='string'&&e.ledgerId.startsWith('car:')&&e.ledgerId.length>4)return e.ledgerId;
 if(e.splitGroup==='car')return 'car:'+e.payerHouseholdId;
 const original=originalCarPayer(t);
 // Migrate previously added second-car petrol/tolls without altering existing local records.
 if(original&&/\b(petrol|fuel|toll)\b/i.test(e.name)&&e.payerHouseholdId!==original)return 'car:'+e.payerHouseholdId;
 return 'main';
}
function expenseBuckets(t){
 const groups=new Map();
 const mainPayer=originalCarPayer(t);
 const initialLabel=mainPayer?(t.households.find(h=>h.id===mainPayer)?.name||'First car')+'’s car + shared trip':'Original trip settlement';
 groups.set('main',{id:'main',kind:'main',label:initialLabel,expenses:[],total:0});
 for(const e of t.expenses){
  const id=expenseBucket(t,e);
  if(!groups.has(id)){
   const payerId=id.slice(4),payer=t.households.find(h=>h.id===payerId);
   groups.set(id,{id,kind:'car',label:(payer?.name||'Another family')+'’s car',expenses:[],total:0});
  }
  const g=groups.get(id);g.expenses.push(e);g.total+=e.amount;
 }
 return [...groups.values()].filter(g=>g.expenses.length||g.kind==='main');
}
function scopedTrip(t,group){
 return {...t,expenses:group.expenses,confirmedPayments:(t.confirmedPayments||[]).filter(p=>(p.ledgerId||'main')===group.id)};
}
function settlementLedgers(t){
 return expenseBuckets(t).map(g=>({...g,calc:calculateTrip(scopedTrip(t,g))}));
}

function directExpenseCharges(t,c){
 const members=Object.fromEntries(t.travellers.map(p=>[p.id,p]));
 const charges=new Map();
 for(const expense of t.expenses){
  const selected=new Map();
  for(const a of c.allocations){
   if(a.expenseId!==expense.id||a.householdId===expense.payerHouseholdId||a.amount===0)continue;
   if(!selected.has(a.householdId))selected.set(a.householdId,[]);
   selected.get(a.householdId).push({id:a.travellerId,name:members[a.travellerId]?.name||'Traveller '+(t.travellers.findIndex(p=>p.id===a.travellerId)+1),amount:a.amount});
  }
  for(const [from,people] of selected){
   const to=expense.payerHouseholdId,payeeId=expense.payerTravellerId||null,bucket=expenseBucket(t,expense),key=JSON.stringify([bucket,from,to,payeeId]);
   if(!charges.has(key))charges.set(key,{bucket,from,to,payeeId,payeeName:payeeId?(members[payeeId]?.name||'Traveller '+(t.travellers.findIndex(p=>p.id===payeeId)+1)):null,amount:0,expenses:[]});
   const charge=charges.get(key),amount=people.reduce((n,p)=>n+p.amount,0);
   charge.amount+=amount;
   charge.expenses.push({id:expense.id,name:expense.name,amount,passengers:people.length,totalPassengers:expense.participants.length,method:expense.method||'equal',people});
  }
 }
 return [...charges.values()].sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to));
}

/** Debtor -> creditor; consistently sorted by id. */
function settle(balances){
  const ds=Object.entries(balances).filter(([,v])=>v<0).sort(([a],[b])=>a.localeCompare(b)).map(([id,v])=>({id,left:-v}));
  const cs=Object.entries(balances).filter(([,v])=>v>0).sort(([a],[b])=>a.localeCompare(b)).map(([id,v])=>({id,left:v}));
  const out=[];let i=0,j=0;
  while(i<ds.length&&j<cs.length){const amount=Math.min(ds[i].left,cs[j].left);out.push({from:ds[i].id,to:cs[j].id,amount});ds[i].left-=amount;cs[j].left-=amount;if(ds[i].left===0)i++;if(cs[j].left===0)j++;}
  return out;
}
function formatRupees(paise){return '₹'+(paise/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});}

const SAMPLE={"id": "outing", "name": "Family Outing", "date": "2026-11-07", "households": [{"id": "familya", "name": "Family A"}, {"id": "familyb", "name": "Family B"}, {"id": "familyc", "name": "Family C"}, {"id": "familyd", "name": "Family D"}, {"id": "familye", "name": "Family E"}], "travellers": [{"id": "familya-1", "name": null, "householdId": "familya"}, {"id": "familya-2", "name": null, "householdId": "familya"}, {"id": "familya-3", "name": null, "householdId": "familya"}, {"id": "familyb-1", "name": null, "householdId": "familyb"}, {"id": "familyb-2", "name": null, "householdId": "familyb"}, {"id": "familyb-3", "name": null, "householdId": "familyb"}, {"id": "familyc-1", "name": null, "householdId": "familyc"}, {"id": "familyc-2", "name": null, "householdId": "familyc"}, {"id": "familyc-3", "name": null, "householdId": "familyc"}, {"id": "familyc-4", "name": null, "householdId": "familyc"}, {"id": "familyd-1", "name": null, "householdId": "familyd"}, {"id": "familyd-2", "name": null, "householdId": "familyd"}, {"id": "familyd-3", "name": null, "householdId": "familyd"}, {"id": "familye-1", "name": null, "householdId": "familye"}], "expenses": [{"id": "petrol", "name": "Petrol", "amount": 350000, "payerHouseholdId": "familya", "participants": ["familya-1", "familya-2", "familya-3", "familyd-1", "familye-1"]}, {"id": "toll", "name": "Toll", "amount": 70000, "payerHouseholdId": "familya", "participants": ["familya-1", "familya-2", "familya-3", "familyd-1", "familye-1"]}, {"id": "coffee", "name": "Morning coffee", "amount": 49000, "payerHouseholdId": "familyc", "participants": ["familya-1", "familya-2", "familya-3", "familyb-1", "familyb-2", "familyb-3", "familyc-1", "familyc-2", "familyc-3", "familyc-4", "familyd-1", "familyd-2", "familyd-3", "familye-1"]}, {"id": "breakfast", "name": "Breakfast · Cafe", "amount": 234000, "payerHouseholdId": "familya", "participants": ["familya-1", "familya-2", "familya-3", "familyb-1", "familyb-2", "familyb-3", "familyc-1", "familyc-2", "familyc-3", "familyc-4", "familyd-1", "familyd-2", "familyd-3", "familye-1"]}, {"id": "evening", "name": "Evening coffee & chats · Evening stop", "amount": 260000, "payerHouseholdId": "familya", "participants": ["familya-1", "familya-2", "familya-3", "familyb-1", "familyb-2", "familyb-3", "familyc-1", "familyc-2", "familyc-3", "familyc-4", "familyd-1", "familyd-2", "familyd-3", "familye-1"]}, {"id": "outing", "name": "Group tickets", "amount": 1400000, "payerHouseholdId": "familya", "participants": ["familya-1", "familya-2", "familya-3", "familyb-1", "familyb-2", "familyb-3", "familyc-1", "familyc-2", "familyc-3", "familyc-4", "familyd-1", "familyd-2", "familyd-3", "familye-1"]}], "confirmedPayments": [], "claims": []};
const KEY='namma-paalu-premium-v7';const OLDKEY='namma-paalu-premium-v6';const OLDERKEY='namma-paalu-premium-v4';const OLDESTKEY='namma-paalu-premium-v2';
const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const money=formatRupees;const uid=()=>('id-'+Date.now().toString(36)+Math.random().toString(36).slice(2,7));const deep=x=>JSON.parse(JSON.stringify(x));
let trips,active,tab='overview',toastTimer,splitView='family',splitFamily='all',expandedExpense=null,expenseQuery='',expenseFilter='all',undoRecord=null,undoTimer=null;try{const st=JSON.parse(localStorage.getItem(KEY)||localStorage.getItem(OLDKEY)||localStorage.getItem(OLDERKEY)||localStorage.getItem(OLDESTKEY));if(!Array.isArray(st?.trips)||!st.trips.length)throw Error('fresh');trips=st.trips;active=st.active}catch(e){trips=[deep(SAMPLE)];active=SAMPLE.id}
for(const item of trips){if(item?.id==='outing' && item.name==='Family Outing Demo')item.name='Family Outing';}

/* Shareable, read-only trip snapshot. Encoded in the URL; never sent to the public repository. */
let sharedView=false;
function npBase64Url(bytes){let binary='';for(let i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function npDecodeBytes(value){const normalized=value.replace(/-/g,'+').replace(/_/g,'/');const binary=atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'='));return Uint8Array.from(binary,c=>c.charCodeAt(0))}
async function npEncodeSnapshot(data){
 const input=new TextEncoder().encode(JSON.stringify(data));
 if(typeof CompressionStream==='function'){
   const stream=new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
   return 'g'+npBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
 }
 return 'u'+npBase64Url(input);
}
async function npDecodeSnapshot(encoded){
 if(typeof encoded!=='string'||encoded.length>120000||encoded.length<12)throw Error('Invalid link');
 const kind=encoded[0],raw=npDecodeBytes(encoded.slice(1));
 if(raw.length>150000)throw Error('Link exceeds size limit');
 let text;
 if(kind==='g'){
   if(typeof DecompressionStream!=='function')throw Error('Browser does not support this snapshot format');
   text=await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
 }else if(kind==='u'){text=new TextDecoder().decode(raw)}
 else throw Error('Unknown snapshot format');
 if(text.length>300000)throw Error('Trip is too large');
 const packet=JSON.parse(text);
 if(packet?.v!==1 || !packet.trip || !Array.isArray(packet.trip.households) || !Array.isArray(packet.trip.travellers) || !Array.isArray(packet.trip.expenses))throw Error('Invalid snapshot data');
 // The existing arithmetic engine validates IDs, participants and allocations.
 calculateTrip(packet.trip);
 return packet.trip;
}
async function npShareTrip(){
 if(sharedView){showToast('This is a shared, view-only snapshot');return}
 const t=trip();
 const names=t.households.map(h=>h.name);
 const placeholders=names.filter(n=>/^Family [A-Z]$/.test(n));
 if(placeholders.length){
  openModal('Name your families before sharing','<p class="note">Some families still have placeholder names: <strong>'+esc(placeholders.join(', '))+'</strong>.</p><p class="note">Rename them so relatives know who owes whom.</p><div class="actions"><button class="btn sun" type="button" id="npGoPeople">Edit family names</button><button class="btn ghost" type="button" id="npShareAnyway">Share as-is</button></div>');
  $('npGoPeople').onclick=()=>{closeModal();go('travellers')};
  $('npShareAnyway').onclick=()=>{closeModal();npShareTripPrepared()};
  return;
 }
 await npShareTripPrepared();
}
async function npShareTripPrepared(){
 const t=trip();
 if(!confirm('Share this trip’s family names, traveller names and expense amounts with anyone holding the link? It is a fixed snapshot, not live data.'))return;
 try{
  const view={id:t.id,name:t.name,date:t.date,households:deep(t.households),travellers:deep(t.travellers),expenses:deep(t.expenses),confirmedPayments:deep(t.confirmedPayments||[])};
  const payload=await npEncodeSnapshot({v:1,trip:view});
  const url=new URL(location.href);
  url.searchParams.delete('snapshot');
  url.hash='#/overview?share='+payload;
  if(url.href.length>16000)throw Error('The trip is too large for a reliable link. Use a shorter summary or cloud sharing.');
  const labelList=t.households.map(h=>esc(h.name)+' ('+t.travellers.filter(p=>p.householdId===h.id).length+')').join(' · ');
  const content='<p class="note">These are the family names recipients will see:</p><p class="np-share-names">'+labelList+'</p><p class="note">View only. This link contains names and amounts; share it only with people you trust.</p><label class="field wide">Special viewing link<textarea class="input np-share-url" id="npSharedUrl" readonly rows="3" aria-label="Viewing link"></textarea></label><div class="actions"><button class="btn sun" type="button" id="npCopyLink">Copy viewing link</button><button class="btn ghost" type="button" id="npPreviewLink">Open recipient preview ↗</button></div><p class="note">Share this complete link, not the ordinary homepage address.</p>';
  openModal('Your trip viewing link',content);
  const field=$('npSharedUrl');field.value=url.href;
  $('npCopyLink').onclick=async()=>{try{await navigator.clipboard.writeText(url.href);showToast('Complete trip link copied')}catch(e){field.focus();field.select();showToast('Select and copy the entire link')}};
  $('npPreviewLink').onclick=()=>window.open(url.href,'_blank','noopener,noreferrer');
 }catch(e){showToast('Could not create viewing link: '+e.message)}
}
async function npLoadSharedTrip(){
 const payload=new URLSearchParams(location.hash.split('?')[1]||'').get('share');
 if(!payload)return false;
 try{
   const t=await npDecodeSnapshot(payload);
   // Sharing must never overwrite the owner's local saved trips.
   sharedView=true;
   trips=[t];active=t.id;
   document.body.classList.add('np-shared-view');
   const notice=document.getElementById('npSnapshotNotice');
   if(notice){notice.hidden=false;notice.textContent='Shared trip snapshot · View only · Changes made by the owner after sharing are not included.'}
   return true;
 }catch(e){
   showToast('Could not open shared trip: '+e.message);
   return false;
 }
}
document.addEventListener('click',event=>{
 if(!sharedView)return;
 const blocked=event.target.closest('#addExpenseHero,#newTrip,#addExpenseInlin,#addFamily,#switchTrip,#switchTripTop,#pageAction,#exportData,#importData,[data-edit],[data-delete],[data-newperson],[data-rename-family],[data-claim],#saveNames,#shareTripLink,[data-pick],#modalNewTrip');
 if(blocked){event.preventDefault();event.stopImmediatePropagation();showToast('View only — ask the trip owner for a new snapshot to see updates')}
},true);

const trip=()=>trips.find(t=>t.id===active)||trips[0];const save=()=>{try{localStorage.setItem(KEY,JSON.stringify({trips,active}))}catch(e){showToast('Storage is full; export a backup.')}};
const nm=(t,id)=>t.households.find(x=>x.id===id)?.name||'Unknown';const pn=p=>p.name||'Traveller '+p.id.split('-').pop();const calc=()=>calculateTrip(trip());
function logAction(t,action,detail){(t.history??=[]).unshift({id:uid(),at:new Date().toISOString(),action,detail});t.history=t.history.slice(0,200)}
const payerLabel=(t,e)=>e.payerTravellerId?(personLabel(t,e.payerTravellerId)+' · '+nm(t,e.payerHouseholdId)):nm(t,e.payerHouseholdId);
function showToast(s){const e=$('toast');e.textContent=s;e.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove('show'),3000)}
function animateText(id,txt){const e=$(id);if(e.textContent!==txt){e.textContent=txt;e.animate([{opacity:.45,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{duration:380,easing:'ease-out'})}}
const PAGE_INFO={overview:{label:'HOME',title:'Everyone included. Every expense explained.',desc:'See the spending and balances for this trip.'},expenses:{label:'EXPENSE LEDGER',title:'All trip expenses',desc:'Find an expense, see who paid, and check how it was split.',action:'＋ Add expense'},breakdown:{label:'DETAILED SPLIT',title:'How every share adds up.',desc:'See the amount assigned to each family or traveller, expense by expense.',action:'＋ Add expense'},travellers:{label:'YOUR CIRCLE',title:'Your people',desc:'Add families and travellers, then choose who shares each expense.',action:'＋ Add family'},settlements:{label:'SETTLEMENTS',title:'Who pays whom',desc:'Review suggested transfers based on each person’s share and payments.',action:'View detailed split'},activity:{label:'CHANGE HISTORY',title:'Activity',desc:'See edits made on this device. This is not a shared audit history.',action:'Back to expenses'}};
const routeNames=Object.keys(PAGE_INFO);
function routeFromHash(){const raw=location.hash.replace(/^#\/?/,'').split('?')[0];return routeNames.includes(raw)?raw:'overview'}
function updateScreenShell(t,c){
 const home=tab==='overview';document.body.dataset.view=tab;
 $('homeOnly').hidden=!home;$('pageIntro').hidden=home;
 $('currentTripTop').textContent=t.name;
 if(home){$('tripTitle').innerHTML=esc(t.name.replace(/ Trip$/,'')).replace(/\s([^\s]+)$/,' <em>$1</em>')+(t.name.endsWith(' Trip')?' <em>Trip.</em>':'');animateText('total',money(c.total));animateText('members',t.travellers.length.toString());animateText('remaining',money(c.remaining));$('heroTrav').textContent=t.travellers.length+' travellers'}
 else{const p=PAGE_INFO[tab];$('pageEyebrow').textContent=p.label;$('pageTitle').textContent=p.title;$('pageDescription').textContent=p.desc;$('pageAction').textContent=p.action||'＋ Add expense'}
 document.title=`${home?'Home':PAGE_INFO[tab].title} · Namma Paalu`;
 document.querySelectorAll('[data-tab]').forEach(x=>{x.classList.toggle('active',x.dataset.tab===tab);if(x.dataset.tab===tab)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current')});
}
function render(){const t=trip(),c=calc();updateScreenShell(t,c);let html='';if(tab==='overview')html=renderOverview(t,c);else if(tab==='expenses')html=renderExpenses(t,c);else if(tab==='travellers')html=renderTravellers(t,c);else if(tab==='breakdown')html=renderBreakdown(t,c);else if(tab==='activity')html=renderActivity(t,c);else html=renderSettlements(t,c);$('content').innerHTML=html;attach();}

const rowExpense=(t,e,edit=false)=>{const icons={petrol:'⛽',toll:'🛣️',coffee:'☕',breakfast:'🥘',evening:'🍲',outing:'🎫'};let emoji=icons[e.id]||(/hotel|stay|room/i.test(e.name)?'🏨':/petrol|car|fuel|toll/i.test(e.name)?'🚙':/food|coffee|tea|breakfast|dinner|lunch|snack/i.test(e.name)?'🍽️':'🧾');return `<div class="row"><div class="expenseicon">${emoji}</div><div class="detail"><strong>${esc(e.name)}</strong><div class="muted">${esc(payerLabel(t,e))} paid · ${e.participants.length} people</div></div><div style="text-align:right"><div class="money">${money(e.amount)}</div>${edit?`<div class="exp-actions"><button data-edit="${esc(e.id)}">Edit</button><button data-delete="${esc(e.id)}">Delete</button></div>`:''}</div></div>`};

let v8Metric='share',v8Family=null,v8Mode='family',v8Open=null,v8Matrix=false,v8PeopleOpen=null,v8ActivityFilter='all',v8OpenExpense=null;
let npSettleMode='direct';
const V8_COLORS=['#873BFF','#FFD231','#B783F8','#5F86EE','#E39B5B','#38BDA8','#CB75B3'];
function v8Info(t,c,h){const members=t.travellers.filter(p=>p.householdId===h.id);return {h,members,paid:c.paid[h.id]||0,share:c.owed[h.id]||0,balance:c.balances[h.id]||0}}
function v8Status(b){return b<0?'To pay':b>0?'To receive':'Settled'}
function v8Insights(t,c){const data=t.households.map((h,i)=>({...v8Info(t,c,h),color:V8_COLORS[i%V8_COLORS.length]}));if(!data.length)return '<p class="note">Add families to explore insights.</p>';if(!data.some(x=>x.h.id===v8Family))v8Family=data[0].h.id;
const metrics=[['share','Share'],['paid','Paid'],['owed','Owes'],['receive','Receives']];const value=d=>v8Metric==='share'?d.share:v8Metric==='paid'?d.paid:v8Metric==='owed'?Math.max(0,-d.balance):Math.max(0,d.balance);const total=data.reduce((a,d)=>a+value(d),0),selected=data.find(x=>x.h.id===v8Family)||data[0];let offset=0;const stops=data.map(d=>{const start=offset;offset+=total?value(d)/total*100:0;return `${d.color} ${start}% ${offset}%`}).join(',');const pct=total?Math.round(value(selected)/total*100):0;
const circleLength=2*Math.PI*86;let distance=0;
const arcs=data.map(d=>{const portion=total?value(d)/total:0;const dash=portion*circleLength;const start=distance;distance+=dash;return portion>0?`<circle class="v8-slice ${d.h.id===v8Family?'active':''}" data-v8-wheel="${esc(d.h.id)}" role="button" tabindex="0" aria-label="Select ${esc(d.h.name)}: ${money(value(d))}" cx="120" cy="120" r="86" fill="none" stroke="${d.color}" stroke-width="34" stroke-dasharray="${Math.max(0,dash-.9)} ${circleLength}" stroke-dashoffset="${-start}" transform="rotate(-90 120 120)"/>`:''}).join('');
const contributions=t.expenses.map(e=>({e,amount:shareFor(allocationsFor(t,c,e),selected.h.id,'householdId')})).filter(x=>x.amount>0).sort((a,b)=>b.amount-a.amount);
return `<section class="panel v8-insights"><div class="panelhead"><div><div class="eyebrow">EXPLORE YOUR CIRCLE</div><h3>Trip insights</h3><p class="subtext">Switch between shares, contributions and balances, then select a family for details.</p></div><span class="chip">Interactive</span></div><div class="v8-switch" role="group" aria-label="Insight metric">${metrics.map(([k,l])=>`<button class="${v8Metric===k?'selected':''}" data-v8-metric="${k}" aria-pressed="${v8Metric===k}">${l}</button>`).join('')}</div><div class="v8-insight-main"><div class="v8-donut-wrap"><div class="v8-donut v8-clickable-donut"><svg class="v8-wheel-svg" viewBox="0 0 240 240" role="group" aria-label="Select a family by tapping a coloured chart segment"><circle cx="120" cy="120" r="86" stroke="#342343" stroke-width="34" fill="none"/>${arcs}</svg><div class="v8-donut-hole"><span class="np84-hole-pct">${pct}%</span><small>${v8Metric==='owed'?'Owes':v8Metric==='receive'?'Receives':v8Metric==='paid'?'Paid':'Share'}</small></div></div><div class="np84-wheel-summary" aria-live="polite"><span class="np84-wheel-dot" style="background:${selected.color}"></span><span class="np84-wheel-details"><strong title="${esc(selected.h.name)}">${esc(selected.h.name)}</strong><b>${money(value(selected))}</b></span></div></div><div class="v8-family-list">${data.map(d=>`<button class="v8-family-option ${v8Family===d.h.id?'selected':''}" data-v8-family="${esc(d.h.id)}"><i style="background:${d.color}"></i><span>${esc(d.h.name)}<small>${d.members.length} travellers</small></span><strong>${money(value(d))}</strong></button>`).join('')}</div></div><div class="v8-influence"><div class="v8-influence-head"><strong>What makes up ${esc(selected.h.name)}'s share?</strong><small>Calculated from ${contributions.length} participating expenses</small></div><div class="v8-influence-list">${contributions.length?contributions.map(({e,amount})=>`<button type="button" data-v8-wheel-exp="${esc(e.id)}" class="v8-influence-row"><span>${esc(e.name)}<small>${esc(categoryOf(e))}</small></span><strong>${money(amount)}</strong><span class="v8-influence-track"><i style="width:${selected.share?Math.max(1,amount/selected.share*100):0}%"></i></span></button>`).join(''):'<p class="note">This family has no allocated expenses for this trip.</p>'}</div></div><div class="v8-insight-footer"><div><small>Paid by ${esc(selected.h.name)}</small><strong>${money(selected.paid)}</strong></div><div><small>Allocated share</small><strong>${money(selected.share)}</strong></div><div><small>${v8Status(selected.balance)}</small><strong class="${selected.balance<0?'v8-warn':'v8-positive'}">${money(Math.abs(selected.balance))}</strong></div></div><button class="v8-text-link" data-v8-detail="${esc(selected.h.id)}">View ${esc(selected.h.name)}'s full breakdown <span>↗</span></button></section>`}
function updateInsightOnly(metricChanged=false){
 const panel=document.querySelector('.v8-insights');if(!panel)return;
 const previous=panel.querySelector('.v8-wheel-svg');
 const oldSlices=previous?[...previous.querySelectorAll('.v8-slice')].map(el=>({id:el.dataset.v8Wheel,dash:el.getAttribute('stroke-dasharray'),offset:el.getAttribute('stroke-dashoffset')})):[];
 const fresh=document.createElement('template');fresh.innerHTML=v8Insights(trip(),calc()).trim();const next=fresh.content.querySelector('.v8-insights');if(!next)return;
 const nextSvg=next.querySelector('.v8-wheel-svg');
 const freshSlices=[...nextSvg.querySelectorAll('.v8-slice')];
 if(!metricChanged){
   // Reuse SVG geometry in a family-selection change. No graph redraw or layout reflow.
   const newCenter=next.querySelector('.v8-donut-hole');const oldCenter=panel.querySelector('.v8-donut-hole');
   if(oldCenter&&newCenter){oldCenter.innerHTML=newCenter.innerHTML;oldCenter.classList.remove('np-selection-reveal');void oldCenter.offsetWidth;oldCenter.classList.add('np-selection-reveal')}
   panel.querySelectorAll('.v8-slice').forEach(el=>{el.classList.toggle('active',el.dataset.v8Wheel===v8Family);el.setAttribute('aria-pressed',String(el.dataset.v8Wheel===v8Family))});
 }else if(previous&&nextSvg){
   const map=new Map(oldSlices.map(o=>[o.id,o]));
   freshSlices.forEach(el=>{const o=map.get(el.dataset.v8Wheel);if(o){let a=el.getAttribute('stroke-dasharray'),b=el.getAttribute('stroke-dashoffset');el.setAttribute('stroke-dasharray',o.dash);el.setAttribute('stroke-dashoffset',o.offset);requestAnimationFrame(()=>requestAnimationFrame(()=>{el.setAttribute('stroke-dasharray',a);el.setAttribute('stroke-dashoffset',b)}))}});
   previous.replaceWith(nextSvg);
   panel.querySelector('.v8-donut-hole').innerHTML=next.querySelector('.v8-donut-hole').innerHTML;
 }
 const oldSummary=panel.querySelector('.np84-wheel-summary'),newSummary=next.querySelector('.np84-wheel-summary');
 if(oldSummary&&newSummary){oldSummary.innerHTML=newSummary.innerHTML;oldSummary.classList.remove('np-selection-reveal');void oldSummary.offsetWidth;oldSummary.classList.add('np-selection-reveal')}
 const oldList=panel.querySelector('.v8-family-list'),newList=next.querySelector('.v8-family-list');if(oldList&&newList)oldList.innerHTML=newList.innerHTML;
 const influence=panel.querySelector('.v8-influence'),newInfluence=next.querySelector('.v8-influence');
 if(influence&&newInfluence){
   // Keep a stable insight surface even when families have different expense counts.
   const startH=influence.getBoundingClientRect().height;
   influence.style.minHeight=Math.max(startH,230)+'px';
   influence.innerHTML=newInfluence.innerHTML;
   const endH=influence.scrollHeight;
   if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){influence.style.minHeight='230px'}
   else {influence.style.height=startH+'px';influence.style.overflow='hidden';requestAnimationFrame(()=>{influence.style.height=Math.max(230,endH)+'px'});setTimeout(()=>{influence.style.height='';influence.style.overflow='';influence.style.minHeight='230px'},330)}
 }
 const foot=panel.querySelector('.v8-insight-footer'),newFoot=next.querySelector('.v8-insight-footer');if(foot&&newFoot)foot.innerHTML=newFoot.innerHTML;
 const link=panel.querySelector('[data-v8-detail]'),newLink=next.querySelector('[data-v8-detail]');if(link&&newLink){link.outerHTML=newLink.outerHTML}
 if(metricChanged){panel.querySelectorAll('[data-v8-metric]').forEach(b=>{const active=b.dataset.v8Metric===v8Metric;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active))})}
 // Rebind only the new controls; do not call render(), scrollTo(), or replace #content.
 panel.querySelectorAll('[data-v8-family]').forEach(b=>b.onclick=()=>{v8Family=b.dataset.v8Family;updateInsightOnly(false)});
 panel.querySelectorAll('[data-v8-wheel-exp]').forEach(b=>b.onclick=()=>{v8OpenExpense=b.dataset.v8WheelExp;go('breakdown')});
 const detail=panel.querySelector('[data-v8-detail]');if(detail)detail.onclick=()=>{v8Mode='family';v8Matrix=false;v8Open=detail.dataset.v8Detail;go('breakdown')};
}

function v8AllocationCards(t,c){const isPerson=v8Mode==='person';const entities=isPerson?t.travellers.map(p=>({id:p.id,label:pn(p),subtitle:nm(t,p.householdId),family:p.householdId,share:t.expenses.reduce((acc,e)=>acc+shareFor(allocationsFor(t,c,e),p.id,'travellerId'),0)})):t.households.map(h=>({id:h.id,label:h.name,subtitle:t.travellers.filter(p=>p.householdId===h.id).length+' people',family:h.id,share:c.owed[h.id]||0,paid:c.paid[h.id]||0,balance:c.balances[h.id]||0}));return `<div class="v8-card-list">${entities.map((d,i)=>{const open=v8Open===d.id;const rows=t.expenses.map(e=>({e,amount:shareFor(allocationsFor(t,c,e),d.id,isPerson?'travellerId':'householdId')})).filter(x=>x.amount>0);return `<article class="v8-allocation ${open?'open':''}"><button class="v8-allocation-head" data-v8-open="${esc(d.id)}" aria-expanded="${open}"><span class="v8-avatar" style="--av:${V8_COLORS[i%V8_COLORS.length]}">${esc(d.label.slice(0,2).toUpperCase())}</span><span class="v8-allocation-name"><strong>${esc(d.label)}</strong><small>${esc(d.subtitle)}</small></span><span class="v8-allocation-amount"><strong>${money(d.share)}</strong><small>Allocated share</small></span><span class="v8-chevron">⌄</span></button>${open?`<div class="v8-allocation-body"><div class="v8-share-breakdown">${rows.map(({e,amount})=>`<div class="v8-break-row"><span>${esc(e.name)}<small>${esc(categoryOf(e))}</small></span><strong>${money(amount)}</strong></div>`).join('')||'<div class="note">No expense allocations yet.</div>'}</div>${!isPerson?`<div class="v8-summary-triplet"><span>Paid<strong>${money(d.paid)}</strong></span><span>Share<strong>${money(d.share)}</strong></span><span>${v8Status(d.balance)}<strong>${money(Math.abs(d.balance))}</strong></span></div>`:''}</div>`:''}</article>`}).join('')||'<div class="empty">Add people to start your split.</div>'}</div>`}
function v8AdvancedMatrix(t,c){let persons=v8Mode==='person',rows=persons?t.travellers.map(p=>({id:p.id,name:pn(p),kind:'travellerId'})):t.households.map(h=>({id:h.id,name:h.name,kind:'householdId'}));return `<section class="panel v8-matrix-panel"><div class="panelhead"><div><h3>Advanced allocation matrix</h3><p class="subtext">For detailed spreadsheet-style comparisons. Use the cards for mobile.</p></div></div><div class="matrix-scroll" tabindex="0" aria-label="Scrollable allocation table"><table class="matrix"><thead><tr><th>${persons?'Person':'Family'}</th>${t.expenses.map(e=>`<th>${esc(e.name)}</th>`).join('')}<th>Total share</th></tr></thead><tbody>${rows.map(r=>{const vals=t.expenses.map(e=>shareFor(allocationsFor(t,c,e),r.id,r.kind));return `<tr><th>${esc(r.name)}</th>${vals.map((v,i)=>`<td>${v?`<button class="v8-cell" data-v8-cell="${esc(r.id)}|${esc(t.expenses[i].id)}|${r.kind}">${money(v)}</button>`:'—'}</td>`).join('')}<td>${money(vals.reduce((a,b)=>a+b,0))}</td></tr>`}).join('')}</tbody></table></div></section>`}
function v8ExpenseDetails(t,e){
 const c=calculateTrip(t),allocs=allocationsFor(t,c,e);
 const byFamily=t.households.map(h=>{const people=allocs.filter(a=>a.householdId===h.id);return {h,people,total:people.reduce((n,a)=>n+a.amount,0)}}).filter(x=>x.people.length);
 return `<div class="v8-exp-details"><div class="v8-detail-grid"><span>Paid by<strong>${esc(payerLabel(t,e))}</strong></span><span>Included travellers<strong>${e.participants.length} of ${t.travellers.length}</strong></span><span>Split method<strong>${esc(e.method||'equal')}</strong></span></div><p class="note">Only the travellers listed below are charged for this expense. All other travellers owe ₹0 for it.</p>${byFamily.map(x=>`<div class="np-expense-family"><div class="v8-break-row"><span><strong>${esc(x.h.name)}</strong><small>${x.people.length} selected ${x.people.length===1?'person':'people'}</small></span><strong>${money(x.total)}</strong></div>${x.people.map(a=>{const p=t.travellers.find(p=>p.id===a.travellerId);return `<div class="np-direct-person"><span>${esc(p?pn(p):a.travellerId)}</span><strong>${money(a.amount)}</strong></div>`}).join('')}</div>`).join('')}</div>`;
}
function renderOverview(t,c){if(!t.travellers.length)return `<section class="panel onboarding"><div class="eyebrow">A FRESH START</div><h2>Every trip starts with your people.</h2><p class="subtext">This trip is ready. Add a family and the travellers joining you, then record your first expense.</p><div class="actions"><button class="btn sun" data-go="travellers">Add travellers →</button></div></section>`;const hh=t.households.map(h=>{const n=t.travellers.filter(p=>p.householdId===h.id).length,b=c.balances[h.id]||0;return `<div class="row"><div class="avatar ${b<0?'gold':''}">${esc(h.name.slice(0,2).toUpperCase())}</div><div class="detail"><strong>${esc(h.name)}</strong><div class="muted">${n} travellers · Share ${money(c.owed[h.id]||0)}</div></div><div style="text-align:right"><div class="money">${money(Math.abs(b))}</div><div class="status ${b>0?'credit':b<0?'debit':''}">${b>0?'↑ To receive':b<0?'↗ To pay':'✓ Settled'}</div></div></div>`}).join('');const max=c.total||1;const mainCosts=t.expenses.map(e=>({name:e.name,amount:e.amount})).sort((a,b)=>b.amount-a.amount).slice(0,4);const pct=x=>Math.max(0,Math.round(100*x/max));const group=t.households.map((h,i)=>({h,amount:c.owed[h.id]||0}));const pal=['#873bff','#ffd231','#b97bff','#6b438e','#5d3e72'];const segments=group.reduce((acc,g,i)=>{const start=acc.prev,deg=c.total?360*g.amount/c.total:0;acc.parts.push(`${pal[i%pal.length]} ${start}deg ${start+deg}deg`);acc.prev+=deg;return acc},{prev:0,parts:[]});return `<div class="motion-strip"><div class="motion-tile"><small>Recorded expenses</small><strong>${t.expenses.length}</strong><span class="sub">Across this trip</span></div><div class="motion-tile"><small>Average per traveller</small><strong>${money(t.travellers.length?Math.round(c.total/t.travellers.length):0)}</strong><span class="sub">Informational average, not a bill</span></div><div class="motion-tile"><small>To settle</small><strong>${money(c.remaining)}</strong><span class="sub">Before unverified claims</span></div></div><div class="contentgrid"><div><section class="panel"><div class="panelhead"><div><h3>Family balances</h3><p class="subtext">See each family's allocated costs, contributions and balance.</p></div><span class="chip">${t.households.length} groups</span></div>${hh||'<div class="empty">Add your family groups.</div>'}</section><section class="panel"><div class="panelhead"><div><h3>Recent expenses</h3><p class="subtext">Browse recent costs and review who shared them.</p></div><button class="btn mini ghost" data-go="breakdown">View breakdown ↗</button></div>${t.expenses.slice(-4).reverse().map(e=>rowExpense(t,e)).join('')||'<div class="empty"><div class="illustration">✦</div>No expenses yet</div>'}</section></div><div>${v8Insights(t,c)}<section class="panel"><div class="panelhead"><div><h3>Top spending</h3><p class="subtext">The biggest costs recorded for this trip</p></div></div>${mainCosts.map((e,i)=>`<div class="splitrow"><div class="head"><span>${esc(e.name)}</span><b>${money(e.amount)}</b></div><div class="track"><div class="fill ${i===0?'sunfill':''}" data-width="${pct(e.amount)}%"></div></div></div>`).join('')||'<div class="note">Add expenses to see insights.</div>'}</section></div></div>`}
function categoryOf(e){return /fuel|petrol|toll|taxi|cab|car|bus|train|flight/i.test(e.name)?'Transport':/hotel|stay|room|lodg/i.test(e.name)?'Stay':/breakfast|lunch|dinner|food|coffee|tea|snack|restaurant/i.test(e.name)?'Food':/outing|ticket|entry|temple/i.test(e.name)?'Activities':'Other'}
function v8ExpenseRow(t,e){return `<article class="v8-allocation"><button class="v8-exp-head" data-v8-exp="${esc(e.id)}" aria-expanded="${v8OpenExpense===e.id}"><span>${esc(e.name)}<small>${esc(payerLabel(t,e))} paid · ${esc(categoryOf(e))}</small></span><strong>${money(e.amount)}</strong><span class="v8-chevron">⌄</span></button>${v8OpenExpense===e.id?`<div class="v8-allocation-body">${v8ExpenseDetails(t,e)}<div class="actions"><button class="btn mini ghost" data-edit="${esc(e.id)}">Edit expense</button><button class="btn mini ghost" data-delete="${esc(e.id)}">Delete</button></div></div>`:''}</article>`}
function renderExpenses(t,c){const filtered=t.expenses.filter(e=>(expenseFilter==='all'||categoryOf(e)===expenseFilter)&&(`${e.name} ${payerLabel(t,e)}`).toLowerCase().includes(expenseQuery.toLowerCase()));return `<section class="panel"><div class="sectiontitle"><div><div class="eyebrow">THE EXPENSE LEDGER</div><h2>Every expense, easy to check.</h2><p class="subtext">Find any expense, check who paid and review each person’s share.</p></div><button class="btn sun" id="addExpenseInline">＋ Add expense</button></div><div class="toolbar"><input class="input" id="expenseSearch" placeholder="⌕ Search expenses or payer" aria-label="Search expenses" value="${esc(expenseQuery)}"><select id="expenseCategory" class="select" aria-label="Filter by category">${['all','Transport','Food','Stay','Activities','Other'].map(x=>`<option value="${x}" ${expenseFilter===x?'selected':''}>${x==='all'?'All categories':x}</option>`).join('')}</select></div><div class="expense-list">${filtered.length?filtered.map(e=>v8ExpenseRow(t,e)).join(''):'<div class="empty"><div class="illustration">⌕</div><b>No matching expenses</b><p class="note">Try a different search or add a new cost.</p></div>'}</div><p class="soft-label">${filtered.length} of ${t.expenses.length} expenses shown</p></section><section class="panel"><div class="panelhead"><h3>Trip insights</h3><span class="chip">Live calculations</span></div><div class="peoplegroup"><div class="membercard"><strong>${t.expenses.length}</strong><span>Expenses logged</span></div><div class="membercard"><strong>${money(c.total)}</strong><span>Grand total</span></div><div class="membercard"><strong>${t.travellers.length}</strong><span>Travellers</span></div></div></section>`}
function renderTravellers(t,c){return `<section class="panel"><div class="sectiontitle"><div><div class="eyebrow">THE PEOPLE BEHIND THE TRIP</div><h2>Name your families.</h2><p class="subtext">Tap a family card to enter its real name. Changes appear automatically throughout Home, Expenses, Split and Settle on this device.</p></div><div class="actions np-people-head-actions"><button class="btn ghost" id="shareFromPeople" type="button">↗ Share trip</button><button class="btn violet" id="addFamily">＋ Add family</button></div></div><div class="v8-people-summary"><span>${t.households.length}<small>Families</small></span><span>${t.travellers.length}<small>Travellers</small></span></div><div class="v8-card-list">${t.households.map((h,i)=>{const members=t.travellers.filter(p=>p.householdId===h.id),open=v8PeopleOpen===h.id;return `<article class="v8-allocation"><button class="v8-allocation-head" data-v8-people="${esc(h.id)}" aria-expanded="${open}"><span class="v8-avatar" style="--av:${V8_COLORS[i%V8_COLORS.length]}">${esc(h.name.slice(0,2).toUpperCase())}</span><span class="v8-allocation-name"><strong>${esc(h.name)}</strong><small>${members.length} people · ${money(c.owed[h.id]||0)} share</small></span><span class="v8-chevron">⌄</span></button><div class="np-family-action-row"><button type="button" class="np-rename-family" data-rename-family="${esc(h.id)}" aria-label="Edit name of ${esc(h.name)}">✎ Edit family name</button></div>${open?`<div class="v8-allocation-body"><div class="v8-people-fields"><label class="v8-person-edit np-family-name-field"><span class="v8-member-initial">✎</span><span class="v8-input-wrap"><small>Family name</small><input class="input" data-family-name="${esc(h.id)}" value="${esc(h.name)}" aria-label="Family name for ${esc(h.name)}" placeholder="e.g. Family name" maxlength="70" autocomplete="off"></span></label>${members.map((p,i)=>`<label class="v8-person-edit"><span class="v8-member-initial">${esc((p.name||'P').slice(0,1).toUpperCase())}</span><span class="v8-input-wrap"><small>Traveller ${i+1}</small><input class="input" data-name="${esc(p.id)}" value="${esc(p.name||'')}" aria-label="Traveller ${i+1} name" placeholder="Add name" maxlength="55"></span></label>`).join('')}</div><div class="actions"><button class="btn mini ghost" data-newperson="${esc(h.id)}">＋ Add person</button><button class="btn mini sun" id="saveNames">Save family & people</button></div></div>`:''}</article>`}).join('')||'<div class="empty"><b>Build your circle</b><p>Add the first family to begin.</p></div>'}</div></section>`}
function summary(t,c){
 const direct=directExpenseCharges(t,c);
 const payee=d=>d.payeeName||nm(t,d.to);
 return [
 t.name.toUpperCase(),
 'Travellers: '+t.travellers.length,
 'Trip total: '+money(c.total),
 '',
 'FAMILY ALLOCATED SHARES',
 ...t.households.map(h=>h.name+' ('+t.travellers.filter(p=>p.householdId===h.id).length+' people): '+money(c.owed[h.id]||0)),
 '',
 'DIRECT CHARGES — TO ORIGINAL PAYERS (BEFORE PAYMENTS)',
 ...(direct.length?direct.flatMap(d=>[
   nm(t,d.from)+' pays '+payee(d)+': '+money(d.amount),
   ...d.expenses.map(e=>'  '+e.name+' · '+e.passengers+' selected people · '+money(e.amount)),
   ...d.expenses.flatMap(e=>e.people.map(p=>'    '+p.name+' · '+money(p.amount)))
 ]):['No direct inter-family charges']),
 '',
 'ALTERNATIVE: NET SETTLEMENT (OFFSETS ALL EXPENSES & CONFIRMED PAYMENTS)',
 ...(c.transfers.length?c.transfers.map(x=>nm(t,x.from)+' pays '+nm(t,x.to)+': '+money(x.amount)):['No net balance due']),
 '',
 'DO NOT PAY BOTH LISTS. They are alternative ways of understanding the same expenses.',
 'Direct charges list original shares; net settlement reflects recorded confirmed payments.',
 '',
 'EXPENSES',
 ...t.expenses.map(e=>e.name+' · '+money(e.amount)+' · paid by '+(e.payerTravellerId?(t.travellers.find(p=>p.id===e.payerTravellerId)?.name||nm(t,e.payerHouseholdId)):nm(t,e.payerHouseholdId))),
 '',
 'Payment claims are not payment confirmations.'
 ].join('\n');
}

// Transparent allocation ledger: every row is built directly from the engine, never from rounded display values.
function allocationsFor(t,c,e){return c.allocations.filter(a=>a.expenseId===e.id)}
function shareFor(allocs,id,key){return allocs.filter(a=>a[key]===id).reduce((n,a)=>n+a.amount,0)}
function personLabel(t,id){const p=t.travellers.find(q=>q.id===id);return p?pn(p):'Unknown person'}
function splitReport(t,c){
 const rows=[['Expense','Paid by','Total (INR)',...t.households.map(h=>h.name+' share (INR)')]];
 for(const e of t.expenses){const a=allocationsFor(t,c,e);rows.push([e.name,nm(t,e.payerHouseholdId),(e.amount/100).toFixed(2),...t.households.map(h=>(shareFor(a,h.id,'householdId')/100).toFixed(2))])}
 rows.push(['TOTAL','',(c.total/100).toFixed(2),...t.households.map(h=>(c.owed[h.id]/100).toFixed(2))]);
 rows.push(['PAID','', '',...t.households.map(h=>(c.paid[h.id]/100).toFixed(2))]);
 rows.push(['NET BALANCE','', '',...t.households.map(h=>(c.balances[h.id]/100).toFixed(2))]);
 return rows.map(row=>row.map(value=>'"'+String(value).replace(/"/g,'""')+'"').join(',')).join('\r\n');
}
function renderBreakdown(t,c){return `<section class="panel v8-split-intro"><div class="sectiontitle"><div><div class="eyebrow">EVERY RUPEE, EXPLAINED</div><h2>See how each expense was divided.</h2><p class="subtext">Open a family or person to see their allocated expenses and totals.</p></div><button class="btn ghost" id="splitExport">↓ Export CSV</button></div><div class="v8-summary-triplet v8-hero-summary"><span>Total expenses<strong>${money(c.total)}</strong></span><span>Allocated<strong>${money(Object.values(c.owed).reduce((a,b)=>a+b,0))}</strong></span><span>To settle<strong>${money(c.remaining)}</strong></span></div><div class="v8-switch v8-split-switch" role="group" aria-label="Split display"><button data-v8-mode="family" class="${v8Mode==='family'?'selected':''}">Families</button><button data-v8-mode="person" class="${v8Mode==='person'?'selected':''}">People</button><button data-v8-mode="matrix" class="${v8Matrix?'selected':''}">Advanced table</button></div></section>${v8Matrix?v8AdvancedMatrix(t,c):v8AllocationCards(t,c)}<section class="panel"><div class="panelhead"><div><h3>Expense-level explanation</h3><p class="subtext">Tap an expense to see who was included and how it was divided.</p></div></div><div class="v8-card-list">${t.expenses.map(e=>`<article class="v8-allocation"><button class="v8-exp-head" data-v8-exp="${esc(e.id)}" aria-expanded="${v8OpenExpense===e.id}"><span>${esc(e.name)}<small>${esc(payerLabel(t,e))} paid</small></span><strong>${money(e.amount)}</strong><span class="v8-chevron">⌄</span></button>${v8OpenExpense===e.id?v8ExpenseDetails(t,e):''}</article>`).join('')||'<p class="note">No expenses yet.</p>'}</div></section><p class="v8-note">Financial figures are calculated in paise. Unverified payment claims do not reduce balances.</p>`}

function renderSettlements(t,c){
 const ledgers=settlementLedgers(t);
 const grouped=ledgers.map(g=>{
  const scoped=scopedTrip(t,g),original=g.kind==='main';
  const transactions=original?g.calc.transfers:directExpenseCharges(scoped,g.calc);
  const rows=transactions.map(x=>{
   const paidTo=x.payeeName||nm(t,x.to);
   const details=original?'':x.expenses.map(e=>`<div class="np-ledger-detail"><div class="np-direct-expense-title"><span><b>${esc(e.name)}</b><small>${e.passengers} of ${e.totalPassengers} selected passengers · ${esc(nm(t,x.from))}</small></span><b>${money(e.amount)}</b></div><div class="np-direct-equation">${e.method==='equal'?`${e.passengers} passenger${e.passengers===1?'':'s'} · ${money(e.amount)} total`:'Custom '+e.method+' shares'}</div>${e.people.map(p=>`<div class="np-direct-person"><span>${esc(p.name)}</span><strong>${money(p.amount)}</strong></div>`).join('')}</div>`).join('');
   return `<article class="np-ledger-payment"><div class="np-ledger-transfer"><div><small>${esc(nm(t,x.from))} pays</small><h4>${esc(paidTo)}</h4></div><strong>${money(x.amount)}</strong></div>${details}<div class="np-direct-actions"><button class="btn mini ghost" type="button" data-view-calculation="breakdown" data-ledger="${esc(g.id)}">See calculation ↗</button></div></article>`;
  }).join('');
  const originalDescription='Original trip amounts are calculated only from the original shared expenses and first car. Other cars cannot change these payments.';
  const carDescription='Only passengers selected for this car’s petrol, toll and other assigned costs are charged. Nothing is offset against the original settlement.';
  return `<section class="panel np-ledger-panel" data-ledger-group="${esc(g.id)}">
   <div class="np-ledger-head"><div><small>${original?'ORIGINAL SETTLEMENT · PRESERVED':'SEPARATE CAR SETTLEMENT'}</small><h3>${esc(g.label)}</h3><p>${original?originalDescription:carDescription}</p></div><div class="np-ledger-total"><small>${g.expenses.length} expenses</small><strong>${money(g.total)}</strong></div></div>
   <div class="np-ledger-stat-row"><span>${original?'Original payments':'Car passenger charges'}<strong>${money(transactions.reduce((sum,x)=>sum+x.amount,0))}</strong></span><span>${transactions.length} payments</span></div>
   <div class="np-ledger-payments">${rows||'<p class="note">No payment is needed between families in this settlement.</p>'}</div>
  </section>`;
 }).join('');
 return `<section class="panel v8-settle-banner"><div class="eyebrow">SEPARATE SETTLEMENTS · NO CROSS-CAR DEDUCTIONS</div><h2>Each car. Its own split.</h2><p class="subtext">The original trip settlement stays unchanged. Additional cars are calculated separately using only their selected passengers.</p><div class="v8-people-summary"><span>${money(c.total)}<small>Total recorded expenses</small></span><span>${ledgers.length}<small>Independent settlements</small></span></div></section>
 <section class="np-ledger-list">${grouped}</section>
 <section class="panel"><div class="panelhead"><h3>Copy the breakdown</h3></div><p class="note">The summary keeps each car separate, with no deductions across settlements.</p><div class="actions"><button class="btn sun" id="copySummary">Copy summary</button><button class="btn ghost" id="waSummary">WhatsApp ↗</button></div><div class="notice">These are suggested amounts from the expenses recorded on this device. Claims are not confirmed payments.</div></section>`;
}

function renderActivity(t,c){const entries=t.history||[];const selected=entries.filter(x=>v8ActivityFilter==='all'||(v8ActivityFilter==='expense'?/expense|delet|undo/i.test(x.action):/payment|claim/i.test(x.action)));const groups={};for(const x of selected){const date=new Date(x.at).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});(groups[date]??=[]).push(x)}return `<section class="panel"><div class="sectiontitle"><div><div class="eyebrow">EVERY CHANGE COUNTS</div><h2>Changes on this device.</h2><p class="subtext">Browse edits recorded in this browser. Cloud accounts are needed for shared, verified history.</p></div><span class="chip">${entries.length} events</span></div><div class="v8-switch v8-activity-switch">${[['all','All activity'],['expense','Expenses'],['payment','Payments']].map(([k,l])=>`<button data-v8-activity="${k}" class="${v8ActivityFilter===k?'selected':''}">${l}</button>`).join('')}</div>${Object.entries(groups).map(([date,items])=>`<div class="v8-history-group"><h3>${esc(date)}</h3>${items.map(x=>`<div class="v8-history-item"><span class="v8-history-dot"></span><div><strong>${esc(x.action)}</strong><small>${esc(x.detail)}</small></div><time>${esc(new Date(x.at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}))}</time></div>`).join('')}</div>`).join('')||'<div class="empty">No matching activity yet.</div>'}</section>`}
function offerUndo(tripId,record,index){undoRecord={tripId,record,index};clearTimeout(undoTimer);$('undoText').textContent=`${record.name} removed`;const el=$('undoToast');el.classList.add('show');undoTimer=setTimeout(()=>{undoRecord=null;el.classList.remove('show')},10000)}
function deleteExpense(id){const t=trip(),e=t.expenses.find(x=>x.id===id);if(!e)return;if(!confirm('Remove '+e.name+'? Undo is available for 10 seconds.'))return;const index=t.expenses.indexOf(e);t.expenses.splice(index,1);logAction(t,'Expense deleted',e.name+' · '+money(e.amount));save();render();offerUndo(t.id,deep(e),index)}
$('undoButton').onclick=()=>{if(!undoRecord)return;const {tripId,record,index}=undoRecord;const t=trips.find(x=>x.id===tripId);if(t&&!t.expenses.some(x=>x.id===record.id)){t.expenses.splice(Math.min(index,t.expenses.length),0,record);logAction(t,'Deletion undone',record.name);save();render();showToast('Expense restored')}undoRecord=null;clearTimeout(undoTimer);$('undoToast').classList.remove('show')};
function attach(){const t=trip();$('expenseSearch')?.addEventListener('input',e=>{expenseQuery=e.target.value;const a=e.target.selectionStart;const el=e.target;const results=t.expenses.filter(x=>(expenseFilter==='all'||categoryOf(x)===expenseFilter)&&(`${x.name} ${payerLabel(t,x)}`).toLowerCase().includes(expenseQuery.toLowerCase()));const holder=document.querySelector('.expense-list');if(holder)holder.innerHTML=results.length?results.map(x=>v8ExpenseRow(t,x)).join(''):'<div class="empty"><div class="illustration">⌕</div><b>No matching expenses</b><p class="note">Try a different search or category.</p></div>';document.querySelector('.soft-label').textContent=`${results.length} of ${t.expenses.length} expenses shown`;document.querySelectorAll('[data-edit]').forEach(x=>x.onclick=()=>expenseModal(t.expenses.find(e=>e.id===x.dataset.edit)));document.querySelectorAll('[data-delete]').forEach(x=>x.onclick=()=>deleteExpense(x.dataset.delete));});$('expenseCategory')?.addEventListener('change',e=>{expenseFilter=e.target.value;render()});document.querySelectorAll('[data-share-transfer]').forEach(x=>x.onclick=()=>{const [f,to,amount]=x.dataset.shareTransfer.split('|');copy(`${nm(t,f)} pays ${nm(t,to)} ${money(Number(amount))} · ${t.name}`)});$('splitFamily')?.addEventListener('change',e=>{splitFamily=e.target.value;expandedExpense=null;render()});document.querySelectorAll('[data-split-view]').forEach(el=>el.onclick=()=>{splitView=el.dataset.splitView;render()});document.querySelectorAll('[data-expand]').forEach(el=>el.onclick=()=>{expandedExpense=expandedExpense===el.dataset.expand?null:el.dataset.expand;render()});$('splitExport')?.addEventListener('click',()=>{const blob=new Blob(['\ufeff'+splitReport(t,calc())],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='namma-paalu-detailed-split.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),500);showToast('Detailed split exported')});document.querySelectorAll('[data-go]').forEach(x=>x.onclick=()=>go(x.dataset.go));document.querySelectorAll('[data-view-calculation]').forEach(x=>x.onclick=()=>openCalculationPage());document.querySelectorAll('[data-np-settle-mode]').forEach(x=>x.onclick=()=>{npSettleMode=x.dataset.npSettleMode;render()});document.querySelectorAll('[data-copy-direct]').forEach(x=>x.onclick=()=>{const [from,to,amount,payeeId]=x.dataset.copyDirect.split('|');const payee=payeeId?t.travellers.find(p=>p.id===payeeId):null;copy(nm(t,from)+' pays '+(payee?pn(payee):nm(t,to))+' '+money(Number(amount))+' for selected expenses')});$('addExpenseInline')?.addEventListener('click',()=>expenseModal());document.querySelectorAll('[data-edit]').forEach(x=>x.onclick=()=>expenseModal(t.expenses.find(e=>e.id===x.dataset.edit)));document.querySelectorAll('[data-delete]').forEach(x=>x.onclick=()=>deleteExpense(x.dataset.delete));$('saveNames')?.addEventListener('click',()=>{const field=document.querySelector('[data-family-name]');if(field){const name=field.value.trim().replace(/\s+/g,' ');if(!name){showToast('Please enter a family name');field.focus();return}if(t.households.some(h=>h.id!==field.dataset.familyName&&h.name.toLocaleLowerCase()===name.toLocaleLowerCase())){showToast('Another family already has that name');field.focus();return}const family=t.households.find(h=>h.id===field.dataset.familyName);if(family&&family.name!==name){logAction(t,'Family renamed',family.name+' → '+name);family.name=name}}document.querySelectorAll('[data-name]').forEach(x=>{const p=t.travellers.find(p=>p.id===x.dataset.name);if(p)p.name=x.value.trim()||null});logAction(t,'Names updated','Family and traveller names saved');save();render();showToast('Names updated across the trip ✦')});$('shareFromPeople')?.addEventListener('click',npShareTrip);$('addFamily')?.addEventListener('click',familyModal);document.querySelectorAll('[data-newperson]').forEach(x=>x.onclick=()=>{const hid=x.dataset.newperson;t.travellers.push({id:uid(),name:null,householdId:hid});logAction(t,'Traveller added',nm(t,hid));save();render();showToast('Traveller added')});document.querySelectorAll('[data-claim]').forEach(x=>x.onclick=()=>{const [from,to,am]=x.dataset.claim.split('|');if(!confirm('Record a PAYMENT CLAIM only? The receiver must confirm through a secure account in the future cloud app.'))return;(t.claims??=[]).push({id:uid(),from,to,amount:Number(am),createdAt:new Date().toISOString(),status:'unverified'});logAction(t,'Unverified payment claim',nm(t,from)+' → '+nm(t,to)+' · '+money(Number(am)));save();render();showToast('Payment claim recorded — not confirmed')});$('copySummary')?.addEventListener('click',()=>copy(summary(t,calc())));$('waSummary')?.addEventListener('click',()=>window.open('https://wa.me/?text='+encodeURIComponent(summary(t,calc())),'_blank','noopener,noreferrer'));document.querySelectorAll('[data-width]').forEach(e=>requestAnimationFrame(()=>e.style.width=e.dataset.width));
 document.querySelector('.expense-list')?.addEventListener('click',event=>{const b=event.target.closest('[data-v8-exp],[data-edit],[data-delete]');if(!b)return;event.stopPropagation();if(b.dataset.v8Exp){v8OpenExpense=v8OpenExpense===b.dataset.v8Exp?null:b.dataset.v8Exp;render()}else if(b.dataset.edit){expenseModal(t.expenses.find(e=>e.id===b.dataset.edit))}else if(b.dataset.delete){deleteExpense(b.dataset.delete)}});
 document.querySelectorAll('[data-v8-metric]').forEach(x=>x.onclick=()=>{v8Metric=x.dataset.v8Metric;updateInsightOnly(true)});
 document.querySelectorAll('[data-v8-family]').forEach(x=>x.onclick=()=>{v8Family=x.dataset.v8Family;updateInsightOnly(false)});
 const chartPanel=document.querySelector('.v8-insights');if(chartPanel){chartPanel.addEventListener('click',e=>{const slice=e.target.closest('[data-v8-wheel]');if(!slice||!chartPanel.contains(slice))return;v8Family=slice.dataset.v8Wheel;updateInsightOnly(false)});chartPanel.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const slice=e.target.closest('[data-v8-wheel]');if(!slice||!chartPanel.contains(slice))return;e.preventDefault();v8Family=slice.dataset.v8Wheel;updateInsightOnly(false)})}
 document.querySelectorAll('[data-v8-wheel-exp]').forEach(x=>x.onclick=()=>{v8OpenExpense=x.dataset.v8WheelExp;go('breakdown')});
 document.querySelectorAll('[data-v8-detail]').forEach(x=>x.onclick=()=>{v8Mode='family';v8Matrix=false;v8Open=x.dataset.v8Detail;go('breakdown')});
 document.querySelectorAll('[data-v8-mode]').forEach(x=>x.onclick=()=>{if(x.dataset.v8Mode==='matrix')v8Matrix=!v8Matrix;else{v8Mode=x.dataset.v8Mode;v8Matrix=false;v8Open=null}render()});
 document.querySelectorAll('[data-v8-open]').forEach(x=>x.onclick=()=>{v8Open=v8Open===x.dataset.v8Open?null:x.dataset.v8Open;render()});
 document.querySelectorAll('[data-v8-people]').forEach(x=>x.onclick=()=>{v8PeopleOpen=v8PeopleOpen===x.dataset.v8People?null:x.dataset.v8People;render()});document.querySelectorAll('[data-rename-family]').forEach(x=>x.addEventListener('click',()=>renameFamilyModal(x.dataset.renameFamily)));
 if(tab!=='expenses')document.querySelectorAll('[data-v8-exp]').forEach(x=>x.onclick=()=>{v8OpenExpense=v8OpenExpense===x.dataset.v8Exp?null:x.dataset.v8Exp;render()});
 document.querySelectorAll('[data-v8-activity]').forEach(x=>x.onclick=()=>{v8ActivityFilter=x.dataset.v8Activity;render()});
 document.querySelectorAll('[data-v8-cell]').forEach(x=>x.onclick=()=>{const [id,eid,kind]=x.dataset.v8Cell.split('|');const e=t.expenses.find(z=>z.id===eid);const am=shareFor(allocationsFor(t,calc(),e),id,kind);openModal('How this share was calculated',`<div class="v8-detail-grid"><span>Expense<strong>${esc(e.name)}</strong></span><span>Full amount<strong>${money(e.amount)}</strong></span><span>Your share<strong>${money(am)}</strong></span></div><p class="note">${e.participants.length} selected participants. Split method: ${esc(e.method||'equal')}.</p>`)});
 }
function go(t){if(!routeNames.includes(t))return;try{const share=sharedView?new URLSearchParams(location.hash.split('?')[1]||'').get('share'):null;const dest='#/'+t+(share?'?share='+share:'');if(location.hash!==dest)history.pushState({view:t},'',dest)}catch(e){console.warn('Could not update app URL',e)}tab=t;render();const main=$('content');if(main){main.style.animation='none';main.style.opacity='1';main.style.visibility='visible';main.style.transform='none'}window.scrollTo({top:0,left:0,behavior:'instant'})}
function openCalculationPage(){v8Mode='family';v8Matrix=false;v8Open=null;v8OpenExpense=null;go('breakdown')}
function openModal(title,content){$('modalTitle').textContent=title;$('modalContent').innerHTML=content;$('modal').classList.add('open');$('modal').querySelector('input,select,button')?.focus()}
function closeModal(){$('modal').classList.remove('open')}
function expenseModal(existing=null){
 const t=trip();if(!t.travellers.length){showToast('Add travellers first');go('travellers');return}
 const e=existing;
 openModal(e?'Edit expense':'Add a new expense',`<div class="step-track" id="expenseProgress"><span></span><span></span><span></span><span></span></div>
 <div class="expense-step" data-step="0"><div class="step-kicker">STEP 01 · THE EXPENSE</div><h3 class="step-heading">Add an expense</h3><p class="step-hint">Enter what was purchased, the total amount and who paid.</p><div class="fields"><label class="field wide">Expense title<input class="input" id="ename" value="${esc(e?.name||'')}" maxlength="85" placeholder="Dinner, fuel, hotel..." /></label><label class="field">Amount (₹)<input class="input" id="eamount" type="number" min="0.01" step="0.01" value="${e?(e.amount/100).toFixed(2):''}" placeholder="0.00" /></label><label class="field">Who paid?<select class="select" id="epayer"><option value="">Choose a payer</option>${t.households.map(h=>`<optgroup label="${esc(h.name)}"><option value="h:${esc(h.id)}" ${!e?.payerTravellerId&&e?.payerHouseholdId===h.id?'selected':''}>${esc(h.name)} · family</option>${t.travellers.filter(p=>p.householdId===h.id).map(p=>`<option value="p:${esc(p.id)}" ${e?.payerTravellerId===p.id?'selected':''}>${esc(pn(p))} · ${esc(h.name)}</option>`).join('')}</optgroup>`).join('')}</select></label><label class="field wide">Which settlement should include this cost?<select class="select" id="eledger"><option value="main">Original trip + first car (keep existing settlement)</option><option value="car">Separate car expenses (selected passengers only)</option></select><span class="note">A separate car never changes the original settlement.</span></label></div></div>
 <div class="expense-step" data-step="1" hidden><div class="step-kicker">STEP 02 · PARTICIPANTS</div><h3 class="step-heading">Choose participants</h3><p class="step-hint">Only checked people will pay a share of this expense. For car petrol or toll, select passengers of that car only; everyone else is charged ₹0.</p><div class="panelhead" style="margin-bottom:12px"><strong id="selectedCount">0 selected</strong><div><button class="btn mini ghost" id="selectAll" type="button">Everyone</button> <button class="btn mini ghost" id="selectNone" type="button">Clear</button></div></div><div class="pgrid">${t.travellers.map(p=>`<label class="person"><input type="checkbox" class="participant" value="${esc(p.id)}" ${(e?e.participants.includes(p.id):false)?'checked':''}><span>${esc(pn(p))}<br><span class="muted">${esc(nm(t,p.householdId))}</span></span></label>`).join('')}</div></div>
 <div class="expense-step" data-step="2" hidden><div class="step-kicker">STEP 03 · SPLIT METHOD</div><h3 class="step-heading">Choose how to split</h3><p class="step-hint">Split equally, by percentage, by weight, or enter exact amounts.</p><label class="field wide">Choose split method<select id="emethod" class="select"><option value="equal">Equal — same share for everyone</option><option value="percentage">Percentages — total 100%</option><option value="weighted">Shares / weights</option><option value="exact">Exact amounts</option></select></label><div id="splitInputs" class="custom-split"></div></div>
 <div class="expense-step" data-step="3" hidden><div class="step-kicker">STEP 04 · REVIEW</div><h3 class="step-heading">Review before saving</h3><p class="step-hint">Check each participant's allocation and the total before saving.</p><div class="split-preview" id="liveSplitPreview"></div><div class="notice">Preview only: local records cannot be synchronized across devices. Payment approvals are not enabled.</div></div>
 <p id="formError" role="alert" aria-live="assertive" style="color:var(--red);min-height:16px"></p><div class="step-buttons"><button class="btn ghost" id="stepBack" type="button">Cancel</button><button class="btn sun" id="stepNext" type="button">Continue →</button></div>`);
 let step=0;
 const ids=()=>[...document.querySelectorAll('.participant:checked')].map(x=>x.value);
 const updateSelected=()=>{$('selectedCount').textContent=ids().length+' of '+t.travellers.length+' selected'};
 const showStep=()=>{document.querySelectorAll('[data-step]').forEach(el=>el.hidden=Number(el.dataset.step)!==step);document.querySelectorAll('#expenseProgress span').forEach((el,i)=>el.classList.toggle('on',i<=step));$('stepBack').textContent=step?'← Back':'Cancel';$('stepNext').textContent=step===3?(e?'Save changes':'Save expense'):'Continue →';$('formError').textContent='';if(step===3)drawPreview();};
 const drawInputs=()=>{const method=$('emethod').value,selected=ids();if(method==='equal'){$('splitInputs').innerHTML='';return}const last=Object.fromEntries([...document.querySelectorAll('[data-share]')].map(x=>[x.dataset.share,x.value]));let equal=selected.length?allocate(10000,Object.fromEntries(selected.map(id=>[id,1]))):{};$('splitInputs').innerHTML=`<div class="split-editor-header"><strong>${method==='exact'?'Amount per traveller':method==='percentage'?'Percentage per traveller':'Weight per traveller'}</strong><span class="muted">${method==='percentage'?'Must total 100%':method==='exact'?'Must equal the bill':'Relative shares'}</span></div>${selected.map(id=>{const p=t.travellers.find(x=>x.id===id);const v=last[id]??(e?.method===method?(method==='exact'?((e.amounts?.[id]||0)/100).toFixed(2):method==='percentage'?((e.weights?.[id]||0)/100).toFixed(2):(e.weights?.[id]||1)):(method==='exact'?'':method==='percentage'?(equal[id]/100).toFixed(2):'1'));return `<label class="share-line"><span>${esc(pn(p))} <small>· ${esc(nm(t,p.householdId))}</small></span><input class="input" data-share="${esc(id)}" type="number" min="0" step="${method==='weighted'?'1':'0.01'}" value="${esc(v)}" aria-label="${esc(pn(p))} ${method}" /></label>`}).join('')}`};
 const draft=()=>{const name=$('ename').value.trim(),amount=parseMoney($('eamount').value),payer=$('epayer').value,participants=ids(),method=$('emethod').value;if(!name)throw Error('Give this expense a title');if(!payer)throw Error('Choose who paid');if(!participants.length)throw Error('Choose at least one traveller');let ph,pt=null;if(payer.startsWith('h:'))ph=payer.slice(2);else if(payer.startsWith('p:')){pt=payer.slice(2);ph=t.travellers.find(p=>p.id===pt)?.householdId}if(!ph)throw Error('Choose a valid payer');const ledger=$('eledger').value;const record={id:e?.id||uid(),name,amount,payerHouseholdId:ph,participants,method,ledgerId:ledger==='car'?'car:'+ph:'main'};if(pt)record.payerTravellerId=pt;if(method!=='equal'){const fields=[...document.querySelectorAll('[data-share]')];if(fields.length!==participants.length)throw Error('Complete each allocation');if(method==='exact'){record.amounts=Object.fromEntries(fields.map(f=>[f.dataset.share,parseMoney(f.value,true)]));if(Object.values(record.amounts).reduce((a,b)=>a+b,0)!==amount)throw Error('Exact amounts must add up to '+money(amount))}else if(method==='percentage'){record.weights=Object.fromEntries(fields.map(f=>[f.dataset.share,parseMoney(f.value,true)]));if(Object.values(record.weights).reduce((a,b)=>a+b,0)!==10000)throw Error('Percentages must total exactly 100%')}else{record.weights=Object.fromEntries(fields.map(f=>{const v=Number(f.value);if(!Number.isSafeInteger(v)||v<0)throw Error('Use nonnegative whole-number weights');return [f.dataset.share,v]}));if(Object.values(record.weights).every(v=>!v))throw Error('At least one weight must be positive')}}const clone=deep(t);if(e)Object.assign(clone.expenses.find(x=>x.id===e.id),record);else clone.expenses.push(record);const result=calculateTrip(clone);const item=result.allocations.filter(a=>a.expenseId===record.id);return {record,item}};
 const drawPreview=()=>{const {record,item}=draft();$('liveSplitPreview').innerHTML=`<small class="muted">${esc(record.name)} · ${record.participants.length} people · ${esc(record.method)}</small><div style="margin:10px 0"><strong>${money(record.amount)}</strong><div class="muted">Paid by ${esc(payerLabel(t,record))}</div></div>${item.map(a=>`<div class="preview-line"><span>${esc(personLabel(t,a.travellerId))}</span><b>${money(a.amount)}</b></div>`).join('')}`};
 const ledgerInput=$('eledger');
 const existingLedger=e?expenseBucket(t,e):null;
 ledgerInput.value=existingLedger?(existingLedger==='main'?'main':'car'):'main';
 let ledgerWasEdited=false;
 ledgerInput.addEventListener('change',()=>{ledgerWasEdited=true});
 const suggestLedger=()=>{
  if(e||ledgerWasEdited)return;
  const payer=$('epayer').value;
  const family=payer.startsWith('h:')?payer.slice(2):payer.startsWith('p:')?t.travellers.find(p=>p.id===payer.slice(2))?.householdId:null;
  const petrolOrToll=/\\b(petrol|fuel|toll)\\b/i.test($('ename').value);
  ledgerInput.value=(family&&family!==originalCarPayer(t)&&petrolOrToll)?'car':'main';
 };
 $('epayer').addEventListener('change',suggestLedger);
 $('ename').addEventListener('input',suggestLedger);
 suggestLedger();
 $('emethod').value=e?.method||'equal';$('emethod').onchange=drawInputs;document.querySelectorAll('.participant').forEach(x=>x.onchange=()=>{updateSelected();drawInputs()});$('selectAll').onclick=()=>{document.querySelectorAll('.participant').forEach(x=>x.checked=true);updateSelected();drawInputs()};$('selectNone').onclick=()=>{document.querySelectorAll('.participant').forEach(x=>x.checked=false);updateSelected();drawInputs()};updateSelected();drawInputs();showStep();
 $('stepBack').onclick=()=>{if(!step)closeModal();else{step--;showStep()}};
 $('stepNext').onclick=()=>{try{if(step===0){parseMoney($('eamount').value);if(!$('ename').value.trim())throw Error('Enter a title');if(!$('epayer').value)throw Error('Choose who paid')}if(step===1&&!ids().length)throw Error('Choose at least one traveller');if(step===2)draft();if(step<3){step++;showStep();return}const {record}=draft();if(e)Object.assign(e,record);else t.expenses.push(record);logAction(t,e?'Expense edited':'Expense added',record.name+' · '+money(record.amount));save();closeModal();go('expenses');showToast(e?'Expense updated ✦':'Expense saved ✦')}catch(err){$('formError').textContent=err.message}};
}
function parseMoney(s,zero=false){const x=String(s??'').trim();if(!/^\d+(?:\.\d{1,2})?$/.test(x))throw Error('Enter an amount with at most 2 decimals');const [whole,frac='']=x.split('.');const amount=Number(whole)*100+Number(frac.padEnd(2,'0'));if(!Number.isSafeInteger(amount)||amount<0||(!zero&&amount===0))throw Error('Invalid amount');return amount}
function renameFamilyModal(hid){const t=trip(),family=t.households.find(h=>h.id===hid);if(!family)return;openModal('Edit family name',`<p class="note">This changes the name across Home, Expenses, Split and Settle on this device. Existing expense amounts will not change.</p><div class="fields"><label class="field wide">Family name<input class="input" id="renameFamilyInput" value="${esc(family.name)}" maxlength="70" autocomplete="off" aria-label="New family name"></label></div><div class="actions"><button type="button" class="btn sun" id="confirmFamilyRename">Save family name</button></div>`);const input=$('renameFamilyInput'),button=$('confirmFamilyRename');const commit=()=>{const next=input.value.trim().replace(/\s+/g,' ');if(!next){showToast('Enter a family name');input.focus();return}if(t.households.some(h=>h.id!==hid&&h.name.toLocaleLowerCase()===next.toLocaleLowerCase())){showToast('That family name is already used');input.focus();return}if(family.name!==next){const previous=family.name;family.name=next;logAction(t,'Family renamed',previous+' → '+next);save()}closeModal();render();showToast('Family name updated throughout trip')};button.addEventListener('click',commit);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commit()}});input.focus();input.select()}
function familyModal(){openModal('Add family / group',`<div class="fields"><label class="field wide">Family name<input class="input" id="familyName" placeholder="e.g. Asha's family" maxlength="70"></label><label class="field wide">Number of people<input class="input" id="familyCount" type="number" min="1" max="40" step="1" value="2"></label></div><div class="actions"><button class="btn sun" id="saveFamily">Add family</button></div>`);$('saveFamily').onclick=()=>{const name=$('familyName').value.trim(),count=Number($('familyCount').value);if(!name||!Number.isInteger(count)||count<1||count>40){showToast('Enter family name and 1–40 members');return}const hid=uid(),t=trip();t.households.push({id:hid,name});for(let i=1;i<=count;i++)t.travellers.push({id:uid(),name:null,householdId:hid});logAction(t,'Traveller added',nm(t,hid));save();closeModal();go('travellers');showToast('Family added ✦')}}
function newTripModal(){openModal('Create your next trip',`<p class="note">Start a fresh trip while reusing your saved families and traveller names.</p><div class="fields"><label class="field wide">Trip name<input class="input" id="newName" placeholder="e.g. Goa Family Vacation" maxlength="80"></label><label class="field wide">Family profiles<select class="select" id="copyPeople"><option value="yes">Reuse current families and people</option><option value="no">Start without travellers</option></select></label></div><div class="actions"><button class="btn sun" id="createTrip">Create trip</button></div>`);$('createTrip').onclick=()=>{const name=$('newName').value.trim();if(!name){showToast('Enter a trip name');return}const old=trip(),copy=$('copyPeople').value==='yes',t={id:uid(),name,date:new Date().toISOString().slice(0,10),households:copy?deep(old.households):[],travellers:copy?deep(old.travellers):[],expenses:[],confirmedPayments:[],claims:[]};if(!copy){t.households=[];t.travellers=[]}trips.unshift(t);active=t.id;save();closeModal();go('overview');showToast('New trip created ✦')}}
function switchTrip(){openModal('Your trips',`<p class="note">Choose a trip or start a new adventure.</p>${trips.map(t=>`<button class="btn ghost" style="width:100%;text-align:left;margin-bottom:9px;white-space:normal" data-pick="${esc(t.id)}">✦ ${esc(t.name)} <span class="muted">· ${t.expenses.length} expenses</span></button>`).join('')}<div class="actions"><button class="btn sun" id="modalNewTrip">＋ Create trip</button></div>`);document.querySelectorAll('[data-pick]').forEach(x=>x.onclick=()=>{active=x.dataset.pick;save();closeModal();go('overview')});$('modalNewTrip').onclick=newTripModal}
async function copy(s){try{await navigator.clipboard.writeText(s);showToast('Summary copied ✦')}catch(e){prompt('Copy summary:',s)}}
$('closeModal').onclick=closeModal;$('modal').addEventListener('click',e=>{if(e.target===$('modal'))closeModal()});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});document.querySelectorAll('[data-tab]').forEach(x=>x.onclick=()=>go(x.dataset.tab));$('shareTripLink').onclick=npShareTrip;$('addExpenseHero').onclick=()=>expenseModal();$('switchTrip').onclick=switchTrip;$('newTrip').onclick=newTripModal;
$('exportData').onclick=()=>{const blob=new Blob([JSON.stringify({trips,active},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='namma-paalu-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),500)};$('importData').onclick=()=>$('fileInput').click();$('fileInput').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const d=JSON.parse(await f.text());if(!Array.isArray(d.trips)||!d.trips.length)throw Error('bad');for(const t of d.trips)calculateTrip(t);if(!confirm('Replace locally saved trips with this backup?'))return;trips=d.trips;active=d.active;save();render();showToast('Backup imported')}catch(err){showToast('Invalid backup: '+err.message)}e.target.value=''};
$('brandHome').onclick=()=>go('overview');$('switchTripTop').onclick=switchTrip;
$('pageAction').onclick=()=>{if(tab==='travellers')familyModal();else if(tab==='settlements')go('breakdown');else if(tab==='activity')go('expenses');else expenseModal()};
window.addEventListener('hashchange',()=>{const next=routeFromHash();if(next!==tab){tab=next;render()}window.scrollTo({top:0,behavior:'instant'})});window.addEventListener('popstate',()=>{const next=routeFromHash();if(next!==tab){tab=next;render()}});
(async()=>{await npLoadSharedTrip();tab=routeFromHash();render()})().catch(e=>{console.error(e);tab='overview';render()});