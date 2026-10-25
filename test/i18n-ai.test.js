const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const ai = require('../i18nAi');
const { document, extension } = require('./helpers');
const baseUrl = 'https://translation.example/v1';
const settings = { 'i18n.ai.baseUrl': baseUrl, 'i18n.ai.model': 'test-model' };
const profile = { url: ai.endpoint(baseUrl), model: 'test-model', prompt: ai.DEFAULT_PROMPT, timeoutMs: 1000 };
const draft = { key: 'K', rows: [{ id: 0, locale: 'ru', value: 'Привет', options: [{}] }, { id: 1, locale: 'en', value: '', options: [{}] }, { id: 2, locale: 'uz', value: '', options: [{}] }] };
const input = { text: 'Привет {name} %s <b>мир</b>', sourceLocale: 'ru', targets: ['en','uz'] };
const response = translations => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations }) } }] });
function transport() {
    const requests = [];
    const request = (url, options, callback) => {
        const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; }; req.end = payload => { req.payload = payload; };
        const item = { url, options, req, reply(raw, status = 200) {
            const res = new EventEmitter();res.statusCode = status; res.destroy = () => { res.destroyed = true; }; this.res = res;
            callback(res); if (!res.destroyed) { res.emit('data', Buffer.from(raw)); res.emit('end'); }
        }, headers(status = 200) { const res = new EventEmitter();res.statusCode=status;res.destroy=()=>{res.destroyed=true;};this.res=res;callback(res);return res; } };
        requests.push(item); return req;
    };
    return { requests, request };
}
const root='/work/app', bl=root+'/Example.bl', ru=root+'/app_ru.nls', en=root+'/app_en.nls', uz=root+'/app_uz.nls';
const source='class Example { string title = "$K$"; }';
const xml=(value,key='K')=>`<properties><entry key="${key}">${value}</entry></properties>`;
const state=panel=>panel.webview.sentMessages.filter(m=>m.type==='state').at(-1);
async function action(panel,type,extra={}) { const s=state(panel);await panel.receiveMessage({type,session:s.session,sequence:s.sequence+1,...extra});return state(panel); }
async function flush(panel, predicate = s => !s.ai.running) {
    for(let i=0;i<40;i++){await new Promise(setImmediate);if(predicate(state(panel)))return state(panel);}
    throw Error('AI mock did not settle');
}
async function setup(t, options={}) {
    const io=transport(), secrets=new Map([[ai.secretId(profile.url),'fixture-key-not-real']]);
    const env=await extension({[bl]:source,[ru]:xml('Привет'),[en]:xml('Existing'),[uz]:xml('Other','Other')},[document(bl,source)],
        {workspaceFolders:['/work'],checkoutRoots:[root],configuration:settings,secrets,aiRequest:io.request,...options});
    t.after(()=>env.dispose());const panel=await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'K'});await panel.receiveMessage({type:'ready'});
    return {io,env,panel,secrets};
}
async function prepare(panel,targets=['en','uz'],text='Привет') {
    await action(panel,'aiOpen');return action(panel,'aiPrepare',{text,sourceLocale:'ru',targets});
}
async function start(panel,targets=['en','uz']) {
    const s=await prepare(panel,targets);assert.ok(s.ai.review);return action(panel,'aiSend',{token:s.ai.review.token});
}

test('AI config is user-only; endpoint canonicalization and settings have no silent defaults', () => {
    assert.equal(ai.endpoint('https://api.example/v1/'),'https://api.example/v1/chat/completions');
    assert.equal(ai.endpoint('http://localhost:8000/api'),'http://localhost:8000/api/chat/completions');
    for(const url of ['', 'file:///a','https://user:pass@api.example/v1','https://api.example/v1?key=secret','https://api.example/#hash','https://api.example/a b']) assert.throws(()=>ai.endpoint(url));
    const vscode={workspace:{getConfiguration:()=>({inspect:key=>({globalValue:settings[key],workspaceValue:key.endsWith('baseUrl')?'https://malicious.example/v1':undefined})})}};
    assert.equal(ai.profile(vscode).url,profile.url);
    vscode.workspace.getConfiguration=()=>({inspect:()=>({workspaceValue:'malicious'})});assert.throws(()=>ai.profile(vscode));
    const manifest=require('../package.json');assert.equal(manifest.engines.vscode,'^1.60.0');
    for(const key of ['baseUrl','model','translationPrompt','timeoutMs'])assert.equal(manifest.contributes.configuration.properties['bl.i18n.ai.'+key].scope,'machine');
    assert.equal(manifest.contributes.configuration.properties['bl.i18n.ai.translationPrompt'].default,ai.DEFAULT_PROMPT);
    assert.ok(!Object.keys(manifest.contributes.configuration.properties).some(k=>/apiKey/i.test(k)));
});

test('prompt variables are one-pass escaped data; request is bounded and has no tools/JSON-mode requirements', () => {
    const p=ai.prepareRequest(profile,{...input,text:'{{unknown}} <script>not HTML</script>'},draft);
    assert.deepEqual(Object.keys(p.body),['model','messages']);assert.equal(p.body.messages[0].role,'system');
    assert.ok(p.body.messages[1].content.includes('{{unknown}}'));
    for(const template of ['', '{{unknown}}','{{ sourceText }}','{{broken','}}', 'a'.repeat(32769)]) assert.throws(()=>ai.renderPrompt(template,{sourceText:'x'}));
    for(const invalid of [{...input,targets:[]},{...input,targets:['en','en']},{...input,targets:['fr']},{...input,targets:['ru']},{...input,text:''},{...input,text:'x'.repeat(65537)},{...input,sourceLocale:'xx'}])assert.throws(()=>ai.prepareRequest(profile,invalid,draft));
    assert.throws(()=>ai.prepareRequest({...profile,prompt:'{{sourceText}}'.repeat(2000)},{...input,text:"x".repeat(1000)},draft),/размер|длинный/);
});

test('AI response contract validates all locales and repeated placeholders before exposing any values', () => {
    const values={en:'Hello {name} %s <b>world</b>',uz:'Salom {name} %s <b>dunyo</b>'};
    assert.deepEqual(ai.validateResponse(response(values),{sourceText:input.text,targetLocales:['en','uz']},'fixture-key'),values);
    for(const raw of ['not json',response({en:values.en}),response({...values,fr:'Bonjour'}),response({...values,en:1}),response({...values,en:'bad\u0001'}),JSON.stringify({choices:[{message:{content:'```json\n{}\n```'}}]})])assert.throws(()=>ai.validateResponse(raw,{sourceText:input.text,targetLocales:['en','uz']}));
    assert.throws(()=>ai.validateResponse(response({...values,en:'Hello'}),{sourceText:input.text,targetLocales:['en','uz']}),/placeholders/);
    assert.throws(()=>ai.validateResponse(response({...values,en:values.en+' fixture-key'}),{sourceText:input.text,targetLocales:['en','uz']},'fixture-key'),/недопустимые/);
    const rich='${user} {0} $Key$ %1$s %% <br/>';
    assert.deepEqual(ai.tokens(rich),ai.tokens(rich+' translated'));
    assert.throws(()=>ai.validateResponse(response({en:'{name}'}),{sourceText:'{name} {name}',targetLocales:['en']}),/placeholders/);
    assert.throws(()=>ai.validateResponse(JSON.stringify({choices:[{finish_reason:'length',message:{content:JSON.stringify({translations:{en:'x'}})}}]}),{sourceText:'x',targetLocales:['en']}));
});

test('transport golden request and response, no retries/redirects/raw error leakage', async () => {
    const io=transport(),prepared=ai.prepareRequest(profile,input,draft),token=ai.cancellation();
    const pending=ai.requestChat(prepared,'fixture-key',token,io.request);assert.equal(io.requests.length,1);
    const call=io.requests[0];assert.equal(call.url.href,profile.url);assert.equal(call.options.method,'POST');assert.equal(call.options.headers.Authorization,'Bearer fixture-key');
    assert.equal(call.options.headers['Content-Length'],Buffer.byteLength(call.req.payload));assert.deepEqual(JSON.parse(call.req.payload),prepared.body);
    call.reply(response({en:'Hello {name} %s <b>world</b>',uz:'Salom {name} %s <b>dunyo</b>'}));assert.equal((await pending).en,'Hello {name} %s <b>world</b>');
    for(const code of [302,401,429,500]) { const another=ai.requestChat(prepared,'fixture-key',ai.cancellation(),io.request);io.requests.at(-1).reply('PRIVATE BODY fixture-key',code);await assert.rejects(another,error=>!error.message.includes('PRIVATE')&&!error.message.includes('fixture-key')); }
    assert.equal(io.requests.length,5);
    assert.ok(!ai.safeError(Error('Bearer SECRET')).includes('SECRET'));
});

test('transport absolute timeout, cancellation, early abort, bounded streaming and network failures', async () => {
    const io=transport(),prepared=ai.prepareRequest(profile,input,draft),cancel=ai.cancellation();
    cancel.cancel();await assert.rejects(ai.requestChat(prepared,'key',cancel,io.request),/отменено/);assert.equal(io.requests.length,0);
    const token=ai.cancellation(),pending=ai.requestChat(prepared,'key',token,io.request);token.cancel();await assert.rejects(pending,/отменено/);assert.equal(io.requests[0].req.destroyed,true);
    const timed=ai.requestChat({...prepared,profile:{...profile,timeoutMs:10}},'key',ai.cancellation(),io.request);await assert.rejects(timed,/вовремя/);
    const large=ai.requestChat(prepared,'key',ai.cancellation(),io.request);io.requests.at(-1).headers().emit('data',Buffer.alloc(1048577));await assert.rejects(large,/размер/);
    const broken=ai.requestChat(prepared,'key',ai.cancellation(),io.request);io.requests.at(-1).req.emit('error',Error('PRIVATE'));await assert.rejects(broken,error=>!error.message.includes('PRIVATE'));
    const partial=ai.requestChat(prepared,'key',ai.cancellation(),io.request);io.requests.at(-1).headers().emit('aborted');await assert.rejects(partial,/соединиться/);
});

test('credentials are password inputs and endpoint-bound SecretStorage; no settings/workspace writes', async t => {
    const {env,secrets,panel}=await setup(t,{inputResponses:['new-fixture-key']});
    await env.commands.get('bl.setTranslationApiKey')();assert.equal(secrets.get(ai.secretId(profile.url)),'new-fixture-key');assert.equal(env.prompts.at(-1).password,true);
    assert.equal(env.storageWrites.length,0);assert.ok(!JSON.stringify(panel.webview.sentMessages).includes('new-fixture-key'));
    await env.configure({'i18n.ai.baseUrl':'https://other.example/v1'});
    await env.commands.get('bl.clearTranslationApiKey')();assert.equal(secrets.get(ai.secretId(profile.url)),'new-fixture-key','changing provider does not delete unrelated credential');
    await env.configure({'i18n.ai.baseUrl':baseUrl});await env.commands.get('bl.clearTranslationApiKey')();assert.equal(secrets.has(ai.secretId(profile.url)),false);
});

test('offline UI and AI preparation make zero requests; invalid token/config/missing key/trust cannot send', async t => {
    const {env,panel,io,secrets}=await setup(t);await action(panel,'aiOpen');await action(panel,'aiClose');assert.equal(io.requests.length,0);
    let s=await prepare(panel);assert.equal(io.requests.length,0);assert.ok(s.ai.review.body.messages);assert.ok(!JSON.stringify(s).includes('fixture-key-not-real'));
    await action(panel,'aiSend',{token:'forged'});assert.equal(io.requests.length,0);
    env.vscode.workspace.isTrusted=false;await action(panel,'aiSend',{token:s.ai.review.token});assert.equal(io.requests.length,0);
    env.vscode.workspace.isTrusted=true;s=await prepare(panel);secrets.clear();await action(panel,'aiSend',{token:s.ai.review.token});assert.match(state(panel).ai.error,/API-ключ/);assert.equal(io.requests.length,0);
    s=await prepare(panel);await env.configure({'i18n.ai.model':'changed'});await action(panel,'aiSend',{token:s.ai.review.token});assert.equal(io.requests.length,0);
    await env.configure({'i18n.ai.baseUrl':''});s=await prepare(panel);assert.match(s.ai.error,/Настройте/);assert.equal(io.requests.length,0);
});

test('explicit send auto-fills unchanged missing fields, proposes existing replacements, persists drafts but never applies XML', async t => {
    const {env,panel,io}=await setup(t);await start(panel);assert.equal(io.requests.length,1);assert.equal(state(panel).ai.running,true);
    io.requests[0].reply(response({en:'Hello',uz:'Salom'}));let s=await flush(panel);
    assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing');assert.equal(s.ai.proposals.find(p=>p.row===s.rows.find(r=>r.locale==='en').id).value,'Hello');
    const missing=s.rows.find(r=>r.locale==='uz');assert.equal(missing.value,'Salom');assert.equal(missing.ai,true);assert.equal(missing.target,0);
    s=await action(panel,'edit',{row:missing.id,target:missing.options[0].id,value:missing.value});assert.equal(s.rows.find(r=>r.locale==='uz').ai,true,'choosing a source does not erase AI provenance');
    assert.equal(env.appliedEdits.length,0);assert.equal(env.contents.get(en),xml('Existing'));
    const row=s.rows.find(r=>r.locale==='en'), proposal=s.ai.proposals.find(p=>p.row===row.id);await action(panel,'aiAcceptSelected',{items:[{...proposal,revision:row.revision-1}]});assert.equal(state(panel).rows.find(r=>r.locale==='en').value,'Existing');
    s=await action(panel,'aiAcceptSelected',{items:[proposal]});assert.equal(s.rows.find(r=>r.locale==='en').value,'Hello');assert.equal(s.rows.find(r=>r.locale==='en').ai,true);
    assert.ok(JSON.stringify(env.storageWrites).includes('Hello'));assert.ok(!JSON.stringify(env.storageWrites).includes('fixture-key'));
    panel.dispose();const reopened=await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'K'});await reopened.receiveMessage({type:'ready'});assert.equal(state(reopened).rows.find(r=>r.locale==='en').ai,true);
});

test('manual typing during request survives response, offered separately and stale accept cannot replace newer input', async t => {
    const {panel,io}=await setup(t);await start(panel,['uz']);let row=state(panel).rows.find(r=>r.locale==='uz');
    await action(panel,'edit',{row:row.id,target:row.options[0].id,value:'Manual'});
    io.requests[0].reply(response({uz:'AI text'}));let s=await flush(panel);row=s.rows.find(r=>r.locale==='uz');assert.equal(row.value,'Manual');assert.equal(s.ai.proposals.length,1);
    const proposal=s.ai.proposals[0];
    await action(panel,'edit',{row:row.id,target:row.target,value:'New manual'});s=await action(panel,'aiAcceptSelected',{items:[proposal]});assert.equal(s.rows.find(r=>r.locale==='uz').value,'New manual');
    assert.match(s.ai.proposals[0].reason,/Поле изменилось/);
    s=await action(panel,'aiAcceptSelected',{items:[{...proposal,revision:s.rows.find(r=>r.locale==='uz').revision}]});assert.equal(s.rows.find(r=>r.locale==='uz').value,'New manual','forging a current revision cannot accept an obsolete proposal');
});

test('cancel/close/config changes/reload invalidate late responses without retries or source changes', async t => {
    for(const event of ['aiCancel','close','config','reload']) {
        const {panel,io,env}=await setup(t);await start(panel,['uz']);
        if(event==='config')await env.configure({'i18n.ai.model':'new'});else await action(panel,event);
        io.requests[0].reply(response({uz:'Late'}));await new Promise(setImmediate);await new Promise(setImmediate);
        assert.equal(io.requests.length,1);assert.equal(env.appliedEdits.length,0);assert.ok(!JSON.stringify(env.storageWrites).includes('Late'));
        if(event==='aiCancel')assert.match(state(panel).ai.error,/оплат/);
    }
});

test('HTTP needs separate native consent; source changed during request cannot auto-fill; provider errors stay sanitized', async t => {
    const a=await setup(t,{configuration:{...settings,'i18n.ai.baseUrl':'http://localhost:8000/v1'}});a.secrets.set(ai.secretId(ai.endpoint('http://localhost:8000/v1')),'http-fixture-key');
    await start(a.panel,['uz']);assert.equal(a.io.requests.length,0);assert.ok(a.env.messages.some(m=>m.message.includes('без шифрования')));
    const {panel,io,env}=await setup(t);await start(panel,['uz']);env.contents.set(uz,xml('Modified'));await env.fileEvent('change',uz);
    io.requests[0].reply(response({uz:'New'}));const s=await flush(panel);assert.equal(s.rows.find(r=>r.locale==='uz').value,'');assert.equal(s.rows.find(r=>r.locale==='uz').stale,true);
    const b=await setup(t);await start(b.panel,['uz']);b.io.requests[0].reply('PRIVATE fixture-key-not-real',401);await flush(b.panel);assert.ok(!JSON.stringify(b.panel.webview.sentMessages).includes('PRIVATE'));assert.match(state(b.panel).ai.error,/отклонил/);
});

test('cancel during pending consent/secret lookup prevents sending, forged actions remain offline', async t => {
    const {env,panel,io}=await setup(t);
    let release;const waiting=new Promise(resolve=>{release=resolve;});
    // The mock exposes storage on the context indirectly through the supplied Map.
    const oldGet=env.secrets.get.bind(env.secrets);env.secrets.get=async key=>{await waiting;return oldGet(key);};
    const s=await prepare(panel,['uz']);
    const pending=panel.receiveMessage({type:'aiSend',session:s.session,sequence:s.sequence+1,token:s.ai.review.token});
    await new Promise(setImmediate);
    const cancelled=panel.receiveMessage({type:'aiCancel',session:s.session,sequence:s.sequence+2});release();await pending;await cancelled;
    assert.equal(io.requests.length,0);assert.match(state(panel).ai.error,/отменено/);
    await panel.receiveMessage({type:'aiPrepare',session:'wrong',sequence:999,text:'x',sourceLocale:'ru',targets:['uz']});assert.equal(io.requests.length,0);
    await action(panel,'aiPrepare',{text:'x',sourceLocale:'ru',targets:['forged']});assert.equal(state(panel).ai.review,null);
});

test('response schema failures and storage errors preserve drafts; malformed response never partially fills fields', async t => {
    const {panel,env,io}=await setup(t);await start(panel);io.requests[0].reply(response({en:'Valid',uz:42}));let s=await flush(panel);
    assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing');assert.equal(s.rows.find(r=>r.locale==='uz').value,'');assert.match(s.ai.error,/JSON/);
    env.storageControl.fail=true;await start(panel,['uz']);io.requests[1].reply(response({uz:'Keep in window'}));s=await flush(panel,s=>!s.ai.running&&!s.saving);
    assert.equal(s.rows.find(r=>r.locale==='uz').value,'Keep in window');assert.match(s.error,/скопируйте/i);assert.match(s.notice,/НЕ сохранён/);assert.equal(env.appliedEdits.length,0);
});

async function twoProposals(t) {
    const fixture = await setup(t), {panel,io} = fixture;
    const missing=state(panel).rows.find(r=>r.locale==='uz');
    await action(panel,'edit',{row:missing.id,target:missing.options[0].id,value:'Manual uz'});
    await start(panel);io.requests[0].reply(response({en:'AI en',uz:'AI uz'}));
    await flush(panel,s=>!s.ai.running&&!s.saving);
    return fixture;
}
const selections = panel => state(panel).ai.proposals.map(({row,revision,token})=>({row,revision,token}));

test('batch accepts all into draft, undo restores values/targets/provenance/proposals without reverting unrelated edits', async t => {
    const {panel,env,io}=await twoProposals(t), before=state(panel), items=selections(panel);
    assert.equal(items.length,2);
    let s=await action(panel,'aiAcceptSelected',{items});
    assert.equal(s.ai.proposals.length,0);assert.equal(s.ai.undo,true);assert.match(s.notice,/Принято переводов: 2/);
    assert.deepEqual(s.rows.filter(r=>['en','uz'].includes(r.locale)).map(r=>r.value),['AI en','AI uz']);
    const ruRow=s.rows.find(r=>r.locale==='ru');await action(panel,'edit',{row:ruRow.id,value:'Unrelated manual',target:ruRow.target});
    s=await action(panel,'aiUndoAccept');assert.equal(s.ai.undo,false);assert.equal(s.ai.proposals.length,2);
    assert.equal(s.rows.find(r=>r.locale==='ru').value,'Unrelated manual');
    for(const locale of ['en','uz']) {
        const old=before.rows.find(r=>r.locale===locale), restored=s.rows.find(r=>r.locale===locale);
        assert.equal(restored.value,old.value);assert.equal(restored.target,old.target);assert.equal(!!restored.ai,!!old.ai);assert.equal(restored.edited,old.edited);assert.ok(restored.revision>old.revision);
    }
    assert.notEqual(s.ai.proposals[0].token,before.ai.proposals[0].token);
    s=await action(panel,'aiAcceptSelected',{items});assert.match(s.error,/изменилось/);assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing','old batch cannot replay after undo');
    assert.equal(env.appliedEdits.length,0);assert.equal(io.requests.length,1);assert.equal(env.contents.get(en),xml('Existing'));
    assert.ok(!JSON.stringify(env.storageWrites).includes('proposals'));assert.ok(!JSON.stringify(env.storageWrites).includes('token'));
});

test('subset acceptance leaves other proposal intact, new manual edit invalidates undo without erasing input', async t => {
    const {panel}=await twoProposals(t), items=selections(panel);
    let s=await action(panel,'aiAcceptSelected',{items:[items[0]]});assert.equal(s.ai.proposals.length,1);assert.equal(s.rows.find(r=>r.locale==='uz').value,'Manual uz');
    const row=s.rows.find(r=>r.locale==='en');s=await action(panel,'edit',{row:row.id,target:row.target,value:'New manual'});assert.equal(s.ai.undo,false);
    s=await action(panel,'aiUndoAccept');assert.equal(s.rows.find(r=>r.locale==='en').value,'New manual');assert.equal(s.ai.proposals.length,1);
    s=await action(panel,'aiAcceptSelected',{items:selections(panel)});assert.equal(s.rows.find(r=>r.locale==='uz').value,'AI uz');
});

test('forged, duplicate, unavailable and stale batches never accept a valid subset or delete proposals', async t => {
    const {panel,env}=await twoProposals(t), items=selections(panel);
    for(const invalid of [null,[],[null],[items[0],items[0]],[items[0],{...items[1],token:'forged'}],[items[0],{...items[1],row:999}],[items[0],{...items[1],revision:99}]]) {
        const s=await action(panel,'aiAcceptSelected',{items:invalid});assert.ok(s.error);assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing');assert.equal(s.ai.proposals.length,2);assert.equal(s.ai.undo,false);
    }
    const uzRow=state(panel).rows.find(r=>r.locale==='uz');await action(panel,'edit',{row:uzRow.id,target:uzRow.target,value:'Later manual'});
    let s=await action(panel,'aiAcceptSelected',{items});assert.match(s.error,/изменилось/);assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing');assert.equal(s.rows.find(r=>r.locale==='uz').value,'Later manual');
    env.contents.set(en,xml('External'));await env.fileEvent('change',en);
    s=await action(panel,'aiAcceptSelected',{items:[items[0]]});assert.match(s.error,/Источник/);assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing');assert.equal(s.rows.find(r=>r.locale==='en').stale,true);
    assert.match(s.ai.proposals.find(p=>p.row===items[0].row).reason,/Источник/);assert.equal(env.appliedEdits.length,0);
});

test('acceptance storage failure stays visibly unsaved and undo remains possible without writing XML', async t => {
    const {panel,env}=await twoProposals(t);env.storageControl.fail=true;
    let s=await action(panel,'aiAcceptSelected',{items:selections(panel)});assert.match(s.error,/сохранить/);assert.match(s.notice,/НЕ сохранён/);assert.equal(s.ai.undo,true);assert.equal(s.rows.find(r=>r.locale==='en').value,'AI en');
    s=await action(panel,'aiUndoAccept');assert.match(s.notice,/НЕ сохранён/);assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing');assert.equal(s.rows.find(r=>r.locale==='uz').value,'Manual uz');assert.equal(s.ai.proposals.length,2);
    env.storageControl.fail=false;s=await action(panel,'aiAcceptSelected',{items:selections(panel)});assert.equal(s.error,'');assert.match(s.notice,/Принято переводов: 2/);assert.equal(env.appliedEdits.length,0);
});

test('undo checks resource freshness and a new run/reload/apply invalidate old acceptance', async t => {
    const a=await twoProposals(t);await action(a.panel,'aiAcceptSelected',{items:selections(a.panel)});
    a.env.contents.set(en,xml('External'));await a.env.fileEvent('change',en);
    let s=await action(a.panel,'aiUndoAccept');assert.match(s.error,/Источник/);assert.equal(s.rows.find(r=>r.locale==='en').value,'AI en');assert.equal(a.env.appliedEdits.length,0);
    const b=await twoProposals(t);await action(b.panel,'aiAcceptSelected',{items:selections(b.panel)});
    await start(b.panel);assert.equal(state(b.panel).ai.undo,false);await action(b.panel,'aiCancel');
    const c=await twoProposals(t);await action(c.panel,'aiAcceptSelected',{items:selections(c.panel)});
    await action(c.panel,'preview');s=await action(c.panel,'apply');assert.equal(s.ai.undo,false);assert.equal(c.env.appliedEdits.length,1);
});

test('aggregate draft size rejects whole selected batch including a valid first proposal', async t => {
    const {panel,env,io}=await setup(t);
    env.contents.set(root+'/app_fr.nls',xml('French'));await env.fileEvent('create',root+'/app_fr.nls');
    env.contents.set(root+'/app_de.nls',xml('German'));await env.fileEvent('create',root+'/app_de.nls');
    // No edited fields yet, so reload requires no discard confirmation.
    await action(panel,'reload');
    const row=state(panel).rows.find(r=>r.locale==='uz');await action(panel,'edit',{row:row.id,target:row.options[0].id,value:'Manual'});
    await start(panel,['en','uz','fr','de']);const huge='x'.repeat(65536);
    io.requests[0].reply(response({en:huge,uz:huge,fr:huge,de:huge}));await flush(panel,s=>!s.ai.running&&!s.saving);
    assert.equal(state(panel).ai.proposals.length,4);
    const s=await action(panel,'aiAcceptSelected',{items:selections(panel)});
    assert.match(s.error,/слишком большой/);assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing');assert.equal(s.rows.find(r=>r.locale==='uz').value,'Manual');assert.equal(s.ai.proposals.length,4);assert.equal(s.ai.undo,false);assert.equal(env.appliedEdits.length,0);
});

test('undo restores previous AI provenance; panel recreation restores only acknowledged draft, not undo/proposals', async t => {
    const {panel,env,io}=await setup(t);await start(panel,['uz']);io.requests[0].reply(response({uz:'First AI'}));await flush(panel,s=>!s.ai.running&&!s.saving);
    let row=state(panel).rows.find(r=>r.locale==='uz');await action(panel,'edit',{row:row.id,target:row.options[0].id,value:row.value});
    await start(panel,['uz']);io.requests[1].reply(response({uz:'Second AI'}));await flush(panel,s=>!s.ai.running&&!s.saving);
    await action(panel,'aiAcceptSelected',{items:selections(panel)});let s=await action(panel,'aiUndoAccept');row=s.rows.find(r=>r.locale==='uz');
    assert.equal(row.value,'First AI');assert.equal(row.ai,true);assert.equal(row.target,row.options[0].id);
    await action(panel,'aiAcceptSelected',{items:selections(panel)});panel.dispose();
    const reopened=await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'K'});await reopened.receiveMessage({type:'ready'});s=state(reopened);
    assert.equal(s.rows.find(r=>r.locale==='uz').value,'Second AI');assert.equal(s.ai.undo,false);assert.equal(s.ai.proposals.length,0);assert.equal(env.appliedEdits.length,0);
});

test('cancelled reload/discard preserve guarded undo, confirmed reset invalidates it without source writes', async t => {
    for(const type of ['reload','discard']) {
        const {panel,env}=await twoProposals(t);await action(panel,'aiAcceptSelected',{items:selections(panel)});assert.equal(state(panel).ai.undo,true);
        // Cancellation preserves values and guarded undo; only confirmed reset discards them.
        let s=await action(panel,type);assert.equal(s.ai.undo,true);assert.equal(s.rows.find(r=>r.locale==='en').value,'AI en');assert.equal(env.appliedEdits.length,0);
        env.vscode.window.showWarningMessage=async()=> 'Отменить изменения';
        s=await action(panel,type);assert.equal(s.ai.undo,false);assert.equal(s.rows.find(r=>r.locale==='en').value,'Existing');assert.equal(env.appliedEdits.length,0);
    }
});

test('host rejects forged absent-family and stale AI targets before consent or network', async t => {
    const {panel, env, io} = await setup(t, {configuration:{...settings, 'i18n.requiredLocales':['fr']}});
    let s = await prepare(panel, ['fr']); assert.equal(s.ai.review, null); assert.ok(s.ai.error); assert.equal(io.requests.length, 0);
    env.contents.delete(uz); await env.fileEvent('delete', uz);
    s = await prepare(panel, ['uz']); assert.equal(s.ai.review, null); assert.equal(io.requests.length, 0);
    assert.throws(() => ai.prepareRequest(profile, {...input, targets:['en']}, {...draft, rows:draft.rows.map(r => ({...r, stale:r.locale === 'en'}))}), /языки/);
});

test('family target deletion after Prepare and during async credential lookup prevents sending', async t => {
    for (const duringSecret of [false, true]) {
        const {panel, env, io, secrets} = await setup(t);
        const prepared = await prepare(panel, ['uz']); assert.ok(prepared.ai.review);
        const remove = async () => { env.contents.delete(uz); await env.fileEvent('delete', uz); };
        if (duringSecret) { const get = secrets.get.bind(secrets); secrets.get = async id => { await remove(); return get(id); }; }
        else await remove();
        const result = await action(panel, 'aiSend', {token:prepared.ai.review.token});
        assert.equal(io.requests.length, 0); assert.ok(result.ai.error);
    }
});

test('family anchor removal during response never fills draft or offers unrelated fallback proposals', async t => {
    const {panel, env, io} = await setup(t); await start(panel, ['uz']);
    for (const file of [ru, en]) { env.contents.set(file, xml('Other', 'Other')); await env.fileEvent('change', file); }
    io.requests[0].reply(response({uz:'Must not fill'})); const result = await flush(panel);
    assert.equal(result.rows.find(r => r.locale === 'uz').value, ''); assert.equal(result.ai.proposals.length, 0); assert.ok(result.ai.error);
    assert.equal(env.appliedEdits.length, 0);
});

test('each invalid AI setting has specific safe explanation and host-selected user settings recovery', async t => {
    for (const [setting,value] of [['baseUrl',''],['model',''],['translationPrompt','{{unsupported}}'],['timeoutMs',3]]) {
        const {panel,env,io}=await setup(t,{configuration:{...settings,['i18n.ai.'+setting]:value}});
        const s=await prepare(panel,['en']);assert.match(s.ai.error,new RegExp('bl\\.i18n\\.ai\\.'+setting));assert.equal(s.ai.recovery.type,'settings');assert.equal(s.ai.recovery.setting,setting);
        assert.equal(s.ai.review,null);assert.equal(io.requests.length,0);
        await action(panel,'aiRecover',{setting:'malicious',command:'arbitrary.command'});
        const call=env.commandCalls.at(-1);assert.equal(call.name,'workbench.action.openSettings');assert.equal(call.args[0],'@id:bl.i18n.ai.'+setting);
        assert.equal(io.requests.length,0);
    }
});

test('forged recovery is ignored without host error; credential recovery uses existing secret command only', async t => {
    const {panel,env,io,secrets}=await setup(t,{inputResponses:['replacement-fixture-key']});
    await action(panel,'aiRecover',{command:'arbitrary.command',setting:'evil'});assert.equal(env.commandCalls.length,0);
    const s=await prepare(panel,['en']);secrets.clear();const missing=await action(panel,'aiSend',{token:s.ai.review.token});
    assert.equal(missing.ai.recovery.type,'key');await action(panel,'aiRecover',{command:'arbitrary.command'});
    assert.equal(env.commandCalls.at(-1).name,'bl.setTranslationApiKey');assert.equal(secrets.get(ai.secretId(profile.url)),'replacement-fixture-key');assert.equal(io.requests.length,0);
    assert.ok(!JSON.stringify(panel.webview.sentMessages).includes('replacement-fixture-key'));
});

test('cancelled source recovery keeps proposals and tokens usable', async t => {
    const {panel,env}=await twoProposals(t), before=state(panel);
    const cancelled=await action(panel,'reload');
    assert.deepEqual(cancelled.ai.proposals,before.ai.proposals);assert.equal(cancelled.rows.find(r=>r.locale==='uz').value,'Manual uz');
    await action(panel,'aiAcceptSelected',{items:selections(panel)});assert.equal(state(panel).ai.undo,true);
    assert.equal(env.appliedEdits.length,0);
});
