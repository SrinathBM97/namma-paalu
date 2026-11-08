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

console.log('Syntax, family renaming, sharing, and baseline wiring checks passed.');
