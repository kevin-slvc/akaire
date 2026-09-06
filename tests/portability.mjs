#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const code = await fs.readFile(new URL('../rv-layer.js',import.meta.url),'utf8');
const server = http.createServer((req,res)=>{
  if(req.url.startsWith('/rv-layer.js')) {res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(code);return;}
  const u=new URL(req.url,'http://localhost');
  res.end(`<html><title>Portable</title><body><p>Target text</p><script>window.__rvResolved={rev:'r-old',ids:['c1']}</script><script src="/rv-layer.js" data-rv-default="on" ${u.searchParams.has('id')?'data-rv-doc-id="'+u.searchParams.get('id')+'"':''}></script></body></html>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
const c={id:'c1',quote:'Target text',note:'Keep me',status:'open',images:[{name:'original.png'}],replies:[{id:'reply1',text:'Follow-up',created:'2026-09-06'}],before:'',after:'',pos:0,resolvedRev:'r-old'};
const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const packet={format:'akaire-review',schema:1,source:{path:'/old.html',docId:''},store:{docId:'/old.html',title:'Portable',updated:null,comments:[c,{id:'c2',quote:'Done',note:'done note',status:'done',images:[],kind:'block',path:'1',tag:'P',fp:'Target text',anchor:{tail:'Target text',ord:0,ratio:0}}],appliedRevs:['r-old']},images:[{name:'original.png',data}]};
const context=await browser.newContext({acceptDownloads:true});
const page=await context.newPage();page.on('dialog',d=>d.accept());
async function visit(url){await page.goto(base+url);await page.waitForSelector('#rvimport');await page.evaluate(()=>localStorage.setItem('rv-layer:guide','done'));}
async function upload(p){await page.locator('#rvimportfile').setInputFiles({name:'review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await page.waitForFunction(()=>!document.querySelector('#rvimport').disabled);}
try{
 await visit('/new.html');await upload(packet);
 assert.equal(await page.evaluate(()=>window.__rv.store.comments[0].status),'open');
 assert.equal(await page.evaluate(()=>window.__rv.store.comments[0].replies[0].text),'Follow-up');
 assert.equal(await page.evaluate(()=>window.__rv.store.comments[1].anchor.tail),'Target text');
 const originalName=await page.evaluate(()=>window.__rv.store.comments[0].images[0].name);assert.notEqual(originalName,'original.png');
 await upload(packet);assert.match(await page.locator('#rvtoast').textContent(),/既にあります/);
 const downloading=page.waitForEvent('download');await page.click('#rvportable');const download=await downloading;
 const exported=JSON.parse(await fs.readFile(await download.path(),'utf8'));assert.equal(exported.images[0].data,data);assert.equal(exported.store.comments.length,2);
 await visit('/new.html?id=stable');assert.equal(await page.evaluate(()=>window.__rv.store.comments.length),2);
 await visit('/renamed.html?id=stable');assert.equal(await page.evaluate(()=>window.__rv.store.comments[0].status),'open');
 await visit('/new.html?id=other');assert.equal(await page.evaluate(()=>window.__rv.store.comments.length),0);
 await visit('/broken.html');await page.evaluate(()=>localStorage.setItem('rv:/broken.html','{broken'));await page.reload();assert.equal(await page.evaluate(()=>localStorage.getItem('rv:/broken.html')),'{broken');
 await visit('/invalid.html');const invalid=structuredClone(packet);invalid.store.comments.push(invalid.store.comments[0]);await upload(invalid);assert.equal(await page.evaluate(()=>window.__rv.store.comments.length),0);assert.match(await page.locator('#rvtoast').textContent(),/重複/);
 invalid.schema=99;await upload(invalid);assert.match(await page.locator('#rvtoast').textContent(),/未対応/);
 const bad=structuredClone(packet);bad.store.comments[0].replies[0].text=4;await upload(bad);assert.match(await page.locator('#rvtoast').textContent(),/型/);
 await visit('/fresh.html');const fresh=structuredClone(packet);fresh.store.appliedRevs=[];await upload(fresh);assert.equal(await page.evaluate(()=>window.__rv.store.comments[0].status),'done');
 const imageKeys=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('rv-layer',2);r.onsuccess=()=>{const db=r.result;const q=db.transaction('images').objectStore('images').getAllKeys();q.onsuccess=()=>{resolve(q.result);db.close();};q.onerror=reject;};r.onerror=reject;}));
 const beforeKeys=await imageKeys();
 await visit('/invalid-tags.html');const beforeTagDisk=await page.evaluate(()=>localStorage.getItem('rv:/invalid-tags.html'));
 for(const tag of ['[','',null,undefined]){
   const badTag=structuredClone(packet);badTag.store.comments[0].kind='block';badTag.store.comments[0].path='1';badTag.store.comments[0].tag=tag;
   await upload(badTag);assert.match(await page.locator('#rvtoast').textContent(),/タグ名/);assert.equal(await page.evaluate(()=>localStorage.getItem('rv:/invalid-tags.html')),beforeTagDisk);assert.deepEqual(await imageKeys(),beforeKeys);
 }
 const badPath=structuredClone(packet);delete badPath.store.comments[1].path;await upload(badPath);assert.match(await page.locator('#rvtoast').textContent(),/パス/);assert.equal(await page.evaluate(()=>localStorage.getItem('rv:/invalid-tags.html')),beforeTagDisk);assert.deepEqual(await imageKeys(),beforeKeys);

 await visit('/quota.html');await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='rv:/quota.html')throw new Error('quota');return set.call(this,k,v);};});await upload(packet);assert.equal(await page.evaluate(()=>window.__rv.store.comments.length),0);assert.match(await page.locator('#rvtoast').textContent(),/quota/);assert.deepEqual(await imageKeys(),beforeKeys);
 await visit('/put-failure.html');await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='images')throw new Error('put rejected');return put.apply(this,args);};});await upload(packet);assert.equal(await page.evaluate(()=>window.__rv.store.comments.length),0);assert.match(await page.locator('#rvtoast').textContent(),/原寸画像を保存できません/);assert.deepEqual(await imageKeys(),beforeKeys);
 await visit('/legacy.html');await page.evaluate(()=>{localStorage.removeItem('rv:/legacy.html');localStorage.setItem('rv:legacy.html',JSON.stringify({docId:'legacy.html',title:'Old',comments:[{id:'legacy',quote:'Target text',note:'Old',images:[],status:'open'}],appliedRevs:['r-old']}));});await visit('/legacy.html?id=legacy-doc');assert.equal(await page.evaluate(()=>window.__rv.store.comments[0].id),'legacy');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('rv-layer:legacy-claimed'))['rv:legacy.html']),'/legacy.html');
 await visit('/legacy.html?id=DIFFERENT-DOCUMENT');assert.equal(await page.evaluate(()=>window.__rv.store.comments.length),0);
 for(const legacy of [false,true]){
   const pathname=legacy?'/claim-legacy.html':'/claim-path.html';
   await visit(pathname);
   await page.evaluate(({pathname,legacy})=>{localStorage.removeItem('rv:'+pathname);localStorage.setItem(legacy?'rv:'+pathname.slice(1):'rv:'+pathname,JSON.stringify({docId:legacy?pathname.slice(1):pathname,title:'Old',comments:[{id:'claim',quote:'Target text',note:'Old',status:'open',images:[]}],appliedRevs:['r-old']}));},{pathname,legacy});
   await page.addInitScript(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('rv-layer:path-owner:'))throw new Error('owner quota');return set.call(this,k,v);};});
   const stable=legacy?'claim-legacy':'claim-path';await visit(pathname+'?id='+stable);
   assert.equal(await page.evaluate(()=>window.__rv.store.comments.length),1);
   assert.equal(await page.evaluate(pathname=>localStorage.getItem('rv-layer:path-owner:'+pathname),pathname),null);
   await visit(pathname+'?id='+stable+'-other');assert.equal(await page.evaluate(()=>window.__rv.store.comments.length),0);
 }

 await visit('/absent-image.html');await page.evaluate(()=>localStorage.setItem('rv:/absent-image.html',JSON.stringify({docId:'/absent-image.html',title:'Missing',comments:[{id:'missing',quote:'Target text',note:'Image',status:'open',images:[{name:'absent.png'}]}],appliedRevs:['r-old']})));await page.reload();await page.click('#rvportable');await page.waitForFunction(()=>!document.querySelector('#rvportable').disabled);assert.match(await page.locator('#rvtoast').textContent(),/原寸画像がありません/);

 // Simulate provenance from another environment: it must not reserve local paths.
 const foreign=structuredClone(packet);foreign.store.migratedFromPath='/foreign-original.html';
 await visit('/imported-elsewhere.html?id=foreign-import');await upload(foreign);
 assert.equal(await page.evaluate(()=>window.__rv.store.migratedFromPath),undefined);
 await visit('/foreign-original.html');await page.evaluate(()=>localStorage.setItem('rv:/foreign-original.html',JSON.stringify({docId:'/foreign-original.html',title:'Local',comments:[{id:'local-only',quote:'Target text',note:'Local',status:'open',images:[]}],appliedRevs:['r-old']})));
 await visit('/foreign-original.html?id=local-document');assert.equal(await page.evaluate(()=>window.__rv.store.comments[0].id),'local-only');
 // Existing local provenance survives import into an empty, already migrated destination.
 await visit('/preserve-provenance.html');await page.evaluate(()=>localStorage.setItem('rv:/preserve-provenance.html',JSON.stringify({docId:'/preserve-provenance.html',title:'Empty',comments:[],appliedRevs:['r-old']})));
 await visit('/preserve-provenance.html?id=preserved');await page.reload();await upload(foreign);assert.equal(await page.evaluate(()=>window.__rv.store.migratedFromPath),'/preserve-provenance.html');
 const migrationDownload=page.waitForEvent('download');await page.click('#rvportable');const migrationFile=await migrationDownload;const migrationPacket=JSON.parse(await fs.readFile(await migrationFile.path(),'utf8'));assert.equal(migrationPacket.store.migratedFromPath,undefined);
 // Corruption introduced after load is discovered by export's merge and must stop export.
 await visit('/merge-quarantine.html');await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('rv:/merge-quarantine.html'));state.comments.push(null);localStorage.setItem('rv:/merge-quarantine.html',JSON.stringify(state));});
 const corruptDisk=await page.evaluate(()=>localStorage.getItem('rv:/merge-quarantine.html'));let emitted=false;const onDownload=()=>{emitted=true;};page.on('download',onDownload);await page.click('#rvportable');await page.waitForFunction(()=>!document.querySelector('#rvportable').disabled);page.off('download',onDownload);assert.match(await page.locator('#rvtoast').textContent(),/読めないコメント/);assert.equal(emitted,false);assert.equal(await page.evaluate(()=>localStorage.getItem('rv:/merge-quarantine.html')),corruptDisk);

 const noDB=await browser.newContext();await noDB.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:undefined}));const np=await noDB.newPage();np.on('dialog',d=>d.accept());await np.goto(base+'/no-db.html');await np.locator('#rvimportfile').setInputFiles({name:'review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(packet))});await np.waitForFunction(()=>!document.querySelector('#rvimport').disabled);assert.match(await np.locator('#rvtoast').textContent(),/IndexedDB/);assert.equal(await np.evaluate(()=>window.__rv.store.comments.length),0);
 console.log('portability: PASS (full state/original bytes/reopened rev/new rev/stable rename/path ownership/corruption/schema/types/duplicate import/quota/IDB unavailable)');
}finally{await browser.close();await new Promise(r=>server.close(r));}
