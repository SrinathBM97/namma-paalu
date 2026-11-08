import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const js=fs.readFileSync('app.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('style.css','utf8');
new vm.Script(js,{filename:'app.js'});
for(const id of ['homeOnly','content','pageIntro','tripTitle','currentTripTop','total','members','remaining'])assert.ok(html.includes('id="'+id+'"'),'Missing '+id);
for(const page of ['overview','expenses','breakdown','travellers','settlements','activity'])assert.ok(js.includes(page+':'),'Missing route '+page);
assert.ok(html.includes('app.js?v='),'Versioned script reference missing');
assert.ok(css.includes('.v6-home .hero-art'),'Hero styles missing');

// Family names must be editable and resolved dynamically by ID.
assert.ok(js.includes('data-family-name='),'Family rename input missing');
assert.ok(js.includes('Family renamed'),'Family rename action missing');
assert.ok(js.includes('family.name=name'),'Family name persistence missing');
assert.ok(js.includes('const nm=(t,id)=>t.households.find'),'Dynamic family name lookup missing');


// Shared snapshot links must remain view-only and preserve their URL fragment through navigation.
assert.ok(html.includes('id="shareTripLink"'),'Share trip button missing');
assert.ok(html.includes('id="npSnapshotNotice"'),'Shared snapshot notice missing');
assert.ok(js.includes("new CompressionStream('gzip')"),'Compressed snapshot encoding missing');
assert.ok(js.includes("new DecompressionStream('gzip')"),'Compressed snapshot decoding missing');
assert.ok(js.includes("url.hash='#/overview?share='+payload"),'Snapshot must use URL fragment');
assert.ok(js.includes("location.hash.split('?')[1]"),'Snapshot fragment import missing');
assert.ok(js.includes('await npLoadSharedTrip()'),'Snapshot boot import missing');
assert.ok(js.includes("const share=sharedView?"),'Snapshot must persist across navigation');
assert.ok(js.includes("document.body.classList.add('np-shared-view')"),'Shared view read-only state missing');


assert.ok(js.includes("openModal('Your trip viewing link',content)"),'Share preview modal missing');
assert.ok(js.includes("labelList=t.households.map"),'Exact household preview missing');
assert.ok(js.includes("id=\"npCopyLink\""),'Copy link control missing');
assert.ok(js.includes("id=\"npPreviewLink\""),'Recipient preview action missing');
assert.ok(js.includes("shareFromPeople"),'People page share action missing');
assert.ok(js.includes("Name your families before sharing"),'Placeholder-name guard missing');


assert.ok(js.includes("chartPanel.addEventListener('click'"),'Wheel segment clicks must use delegated listener after SVG replacement');
assert.ok(js.includes("chartPanel.addEventListener('keydown'"),'Wheel segments must remain keyboard accessible');
assert.ok(js.includes("data-view-calculation=\"breakdown\""),'Settlement needs explicit calculation navigation');
assert.ok(js.includes("function openCalculationPage()"),'Calculation route action missing');
assert.ok(js.includes("go('breakdown')"),'Calculation action must enter Split');
assert.ok(js.includes("main.style.animation='none'"),'Route must not remain hidden behind animation');


// Actual function execution, not just text matching: catch ReferenceErrors in view renderers.
const nodes=new Map();
const node=id=>({id,hidden:false,textContent:'',innerHTML:'',style:{},dataset:{},classList:{toggle(){},add(){},remove(){}},setAttribute(){},removeAttribute(){},addEventListener(){},animate(){},querySelector(){return null},querySelectorAll(){return []}});
const fakeDocument={
 getElementById(id){if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id)},
 querySelectorAll(){return []},querySelector(){return null},addEventListener(){},
 body:{dataset:{},classList:{add(){}}},
 createElement(){return {innerHTML:'',content:{querySelector(){return null}}}}
};
const fakeLocation={hash:'#/settlements',href:'https://example.org/#/settlements'};
const fakeHistory={pushState(_a,_b,hash){fakeLocation.hash=hash;fakeLocation.href='https://example.org/'+hash}};
const runtime=js.slice(0,js.indexOf("$('closeModal').onclick="));
assert.ok(runtime.length>30000,'Could not isolate application functions');
const scenario=runtime+String.raw`
 tab='settlements';render();
 const before=document.body.dataset.view;
 const button=document.getElementById('content').innerHTML.includes('data-view-calculation="breakdown"');
 openCalculationPage();
 const after=document.body.dataset.view;
 const content=document.getElementById('content').innerHTML;
 globalThis.smoke={before,button,after,url:location.hash,hasBreakdown:content.includes('Expense-level explanation'),total:calc().total,peopleHasRename:renderTravellers(trip(),calc()).includes('data-rename-family'),splitHasRename:content.includes('data-rename-family')};
`;
const context={document:fakeDocument,localStorage:{getItem(){return null},setItem(){}},location:fakeLocation,window:{scrollTo(){},matchMedia(){return {matches:false}}},history:fakeHistory,console};
vm.runInNewContext(scenario,context,{timeout:2000});
assert.equal(context.smoke.before,'settlements');
assert.equal(context.smoke.button,true);
assert.equal(context.smoke.after,'breakdown');
assert.equal(context.smoke.url,'#/breakdown');
assert.equal(context.smoke.hasBreakdown,true);
assert.equal(context.smoke.total,2363000);
assert.equal(context.smoke.peopleHasRename,true);
assert.equal(context.smoke.splitHasRename,false);

console.log('Syntax, family renaming, sharing, and baseline wiring checks passed.');
