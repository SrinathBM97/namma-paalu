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

console.log('Syntax, family renaming, and baseline wiring checks passed.');
