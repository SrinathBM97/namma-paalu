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
assert.ok(js.includes("function openCalculationPage("),'Calculation route action missing');
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
const carHouseholds=['a','b','c','d','e'].map(id=>({id,name:'Family '+id}));
const carTravellers=[['a',3],['b',3],['c',4],['d',3],['e',1]].flatMap(([hid,n])=>Array.from({length:n},(_,i)=>({id:hid+(i+1),householdId:hid,name:hid+(i+1)})));
const carExp=(id,payer,amount,participants)=>({id,name:id.replace(/(car\d)(petrol|toll)/,'$1 $2'),amount,payerHouseholdId:payer,participants});
const carTrip={households:carHouseholds,travellers:carTravellers,confirmedPayments:[],expenses:[
 carExp('car1petrol','a',350000,['a1','a2','a3','d1','e1']),
 carExp('car1toll','a',70000,['a1','a2','a3','d1','e1']),
 carExp('car2petrol','b',300000,['b1','b2','b3','c1','c2']),
 carExp('car2toll','b',50000,['b1','b2','b3','c1','c2'])
]};
const carCalc=calculateTrip(carTrip),carDirect=directExpenseCharges(carTrip,carCalc);
const familyCToB=carDirect.find(x=>x.from==='c'&&x.to==='b');
const carMarkup=renderSettlements(carTrip,carCalc);
const payerTrip=JSON.parse(JSON.stringify(carTrip));
payerTrip.expenses.find(e=>e.id==='car2petrol').payerTravellerId='b1';
payerTrip.expenses.find(e=>e.id==='car2toll').payerTravellerId='b2';
const payerCharges=directExpenseCharges(payerTrip,calculateTrip(payerTrip));
const laterTrip=JSON.parse(JSON.stringify(carTrip));laterTrip.expenses.find(e=>e.id==='car2petrol').participants=['b1','b2','b3','c1'];
const laterCalc=calculateTrip(laterTrip);
const laterDirect=directExpenseCharges(laterTrip,laterCalc);

const original=JSON.parse(JSON.stringify(trip()));
const base=calculateTrip(original);
const added=JSON.parse(JSON.stringify(original));
added.expenses.push({id:'secondCarPetrol',name:'Second car petrol',payerHouseholdId:'familyb',amount:300000,participants:['familyb-1','familyb-2','familyb-3','familyc-1','familyc-2']});
added.expenses.push({id:'secondCarToll',name:'Second car toll',payerHouseholdId:'familyb',amount:50000,participants:['familyb-1','familyb-2','familyb-3','familyc-1','familyc-2']});
const separated=settlementLedgers(added),main=separated.find(g=>g.id==='main'),car2=separated.find(g=>g.id==='car:familyb');
const homeBefore=renderOverview(original,base);
npHomeLedger='main';
const homeOriginalAfter=renderOverview(added,calculateTrip(added));
npHomeLedger='car:familyb';
const homeCarAfter=renderOverview(added,calculateTrip(added));
npHomeLedger='main';
const oldOriginalBalance=base.balances.familyb;
const originalLedgerBalance=separated.find(g=>g.id==='main').calc.balances.familyb;
const summaryOutstanding=separated.reduce((sum,g)=>sum+(g.kind==='main'?g.calc.remaining:directExpenseCharges(scopedTrip(added,g),g.calc).reduce((a,d)=>a+d.amount,0)),0);
globalThis.preserveQC={
 mainSame:JSON.stringify(main?.calc.transfers)===JSON.stringify(base.transfers),
 mainTotal:main?.total,
 carTotal:car2?.total,
 carTransfer:car2?.calc.transfers.find(x=>x.from==='familyc'&&x.to==='familyb')?.amount,
 noCross:car2?.calc.transfers.every(x=>x.to==='familyb'),
 splitHasChoices:renderBreakdown(added,calculateTrip(added)).includes('Which settlement?'),
 settlementHasTwoCards:renderSettlements(added,calculateTrip(added)).includes('ORIGINAL SETTLEMENT')&&renderSettlements(added,calculateTrip(added)).includes('SEPARATE CAR SETTLEMENT'),
 homePicker:homeCarAfter.includes('data-np-home-ledger="car:familyb"'),
 homeOriginalUnchanged:homeBefore.includes('₹4,163.59')&&homeOriginalAfter.includes('₹4,163.59'),
 homeOriginalExpenseUnchanged:homeOriginalAfter.includes('₹23,630.00')&&homeOriginalAfter.includes('Group tickets'),
 homeCarScoped:homeCarAfter.includes('Second car petrol')&&homeCarAfter.includes('Second car toll')&&!homeCarAfter.includes('Group tickets'),
 originalBalanceIntact:oldOriginalBalance===originalLedgerBalance,
 outstandingAdds:summaryOutstanding===base.remaining+140000,
 legacyFirstCar:expenseBucket(added,added.expenses[0])==='main'
};

globalThis.carQC={
 total:carCalc.total,
 cToB:familyCToB?.amount,
 petrol:familyCToB?.expenses.find(e=>e.id==='car2petrol')?.amount,
 toll:familyCToB?.expenses.find(e=>e.id==='car2toll')?.amount,
 passengers:familyCToB?.expenses.find(e=>e.id==='car2petrol')?.passengers,
 perPerson:familyCToB?.expenses.find(e=>e.id==='car2petrol')?.people.map(p=>p.amount),
 unrelatedDirect:carDirect.some(x=>x.from==='c'&&x.to==='a'||x.from==='d'&&x.to==='b'),
 netCouldRedirect:carCalc.transfers.some(x=>x.from==='c'&&x.to==='a'),
 renderedMath:carMarkup.includes('2 of 5 selected passengers')&&carMarkup.includes('₹1,200.00'),
 defaultMode:carMarkup.includes('SEPARATE CAR SETTLEMENT')&&carMarkup.includes('ORIGINAL SETTLEMENT'),
 changedDirect:laterDirect.find(x=>x.from==='c'&&x.to==='b')?.amount,
 changedCar2Petrol:laterDirect.find(x=>x.from==='c'&&x.to==='b')?.expenses.find(e=>e.id==='car2petrol')?.amount,
 car1Unchanged:laterDirect.find(x=>x.from==='d'&&x.to==='a')?.amount,
 namedPayerCount:payerCharges.filter(x=>x.from==='c'&&x.to==='b').length,
 namedPayerNames:payerCharges.filter(x=>x.from==='c'&&x.to==='b').map(x=>x.payeeName),
 namedPayerAmounts:payerCharges.filter(x=>x.from==='c'&&x.to==='b').map(x=>x.amount),
 splitTotalMatches:carCalc.total===770000
};
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
assert.equal(context.preserveQC.mainSame,true,'Adding another car must not change a single original settlement transfer');
assert.equal(context.preserveQC.mainTotal,2363000);
assert.equal(context.preserveQC.carTotal,350000);
assert.equal(context.preserveQC.carTransfer,140000);
assert.equal(context.preserveQC.noCross,true);
assert.equal(context.preserveQC.splitHasChoices,true);
assert.equal(context.preserveQC.settlementHasTwoCards,true);
assert.equal(context.preserveQC.legacyFirstCar,true);
assert.equal(context.preserveQC.homePicker,true);
assert.equal(context.preserveQC.homeOriginalUnchanged,true,'Original family Home balance unchanged');
assert.equal(context.preserveQC.homeOriginalExpenseUnchanged,true,'Original Home expense content unchanged');
assert.equal(context.preserveQC.homeCarScoped,true,'Second car Home does not include original shared ticket costs');
assert.equal(context.preserveQC.originalBalanceIntact,true);
assert.equal(context.preserveQC.outstandingAdds,true,'Overall outstanding adds isolated ledgers without netting');
assert.equal(context.carQC.total,770000,'Two-car trip total');
assert.equal(context.carQC.cToB,140000,'Two passengers from Family C owe Family B 1400');
assert.equal(context.carQC.petrol,120000,'Car 2 petrol two-person cost');
assert.equal(context.carQC.toll,20000,'Car 2 toll two-person cost');
assert.equal(context.carQC.passengers,2);
assert.deepEqual(Array.from(context.carQC.perPerson),[60000,60000]);
assert.equal(context.carQC.unrelatedDirect,false,'Other car passengers must not be charged');
assert.equal(context.carQC.netCouldRedirect,true,'Net settlement can redirect due to global offset');
assert.equal(context.carQC.renderedMath,true,'Two-person math must appear in Settle UI');
assert.equal(context.carQC.defaultMode,true,'Direct expense charges default');
assert.equal(context.carQC.changedDirect,95000,'Changing petrol participants recalculates only the selected shares');
assert.equal(context.carQC.changedCar2Petrol,75000,'4-way car petrol after one person deselected');
assert.equal(context.carQC.car1Unchanged,84000,'Unrelated car charge unchanged');
assert.equal(context.carQC.namedPayerCount,2,'Two different named payers must be separate');
assert.deepEqual(Array.from(context.carQC.namedPayerNames),['b1','b2']);
assert.deepEqual(Array.from(context.carQC.namedPayerAmounts),[120000,20000]);



assert.ok(js.includes("function directExpenseCharges("),'Per-expense direct charges must exist');
assert.ok(js.includes('function settlementLedgers('),'Independent car ledgers must exist');
assert.ok(js.includes("(e?e.participants.includes(p.id):false)"),'New expenses must NOT silently preselect all passengers');
assert.ok(js.includes("Included travellers"),'Detailed expense allocations must show selected participants');
assert.ok(js.includes('data-ledger-group'),'Independent ledger cards must render');

assert.ok(js.includes('INDEPENDENT SETTLEMENTS — NEVER COMBINE DIFFERENT CARS'),'Summary must keep cars separate');
assert.ok(js.includes('Car settlements stay separate'),'Summary must not offset across cars');
assert.ok(js.includes('function v8ExpenseDetails(t,e)'),'Expense breakdown renderer missing');


assert.ok(js.includes('id="eledger"'),'Expense form must choose original vs independent car');
assert.ok(js.includes("ledgerId:ledger==='car'?'car:'+ph:'main'"),'Expense must retain an independent ledger identifier');
assert.ok(js.includes('class="panel np-ledger-picker"'),'Split page must filter by settlement ledger');
assert.ok(js.includes('openCalculationPage(x.dataset.ledger'),'Calculation must open the correct car ledger');
assert.ok(js.includes('function originalCarPayer('),'First car must be retained as original ledger');
assert.ok(js.includes('function settlementLedgers('),'Independent car groups required');

console.log('Syntax, family renaming, sharing, and baseline wiring checks passed.');
