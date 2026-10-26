const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseNls } = require('../localizationModel');
const { translationEdits, fingerprint } = require('../localizationEdits');
const { createDraft, updateRow, serializeDraft, restoreDraft } = require('../i18nDraft');
const { renderI18nView } = require('../i18nView');
const { document, extension } = require('./helpers');
const root = '/work/app', bl = root + '/Example.bl', ru = root + '/app_ru.nls', en = root + '/app_en.nls', uz = root + '/app_uz.nls';
const source = 'class Example { string title = "$Workspace.title$"; }';
const xml = (value, key = 'Workspace.title') => `<properties>\n    <entry key="${key}">${value}</entry>\n    <!-- keep -->\n    <entry key="Other">Other &amp; unchanged</entry>\n</properties>`;
const model = (text, file = ru) => ({ ...parseNls(text, file), text, filePath: file });
const state = panel => panel.webview.sentMessages.filter(m => m.type === 'state').slice(-1)[0];
async function action(panel, type, data = {}) { const s = state(panel); await panel.receiveMessage({ type, session: s.session, sequence: s.sequence + 1, ...data }); return state(panel); }
async function setup(t, overrides = {}, options = {}) {
    const doc = document(bl, source);
    const env = await extension({ [bl]: source, [ru]: xml('Документы'), [en]: xml('Documents'), [uz]: xml('Бошқа', 'Other.title'), ...overrides }, [doc], {
        workspaceFolders: ['/work'], checkoutRoots: [root], ...options });
    t.after(() => env.dispose());
    const panel = await env.commands.get('bl.editTranslation')({ sourceUri: bl, key: 'Workspace.title' });
    await panel.receiveMessage({ type: 'ready' });
    return { env, doc, panel };
}
function choose(s, locale, existing = true) {
    const row = s.rows.find(r => r.locale === locale), option = row.options.find(o => (o.value !== null) === existing);
    return { row: row.id, target: option.id };
}

test('surgical XML edits preserve comments, CDATA, unrelated keys, CRLF, BOM and self-closing forms', () => {
    for (const [raw, value] of [
        ['<properties><entry key="K">old<!--inline comment-->more</entry><!--root--></properties>', '<new> & "quote"'],
        ['<properties><entry key="K"><![CDATA[old]]><!--inside-->tail</entry></properties>', 'a]]>b\n中文 📄'],
        ['<properties><entry key="K"><![CDATA[old]]></entry></properties>', 'a\r\nb'],
        ['<properties><entry key=\'K\'/></properties>', ''],
        ['<properties><entry key="K"><!--inside--></entry></properties>', 'Filled'],
        ['\ufeff<properties>\r\n\t<entry key="K">old &amp; text</entry>\r\n\t<!--keep-->\r\n</properties>', 'new']
    ]) {
        const resource = model(raw), entry = resource.entries.find(e => e.key === 'K');
        const updated = translationEdits(resource, 'K', value, entry.entryStart).updated;
        assert.equal(parseNls(updated, ru).entries[0].value, value);
        for (const comment of raw.match(/<!--[\s\S]*?-->/g) || []) assert.ok(updated.includes(comment));
        if (raw.startsWith('\ufeff')) assert.ok(updated.startsWith('\ufeff'));
        if (raw.includes('\r\n')) assert.ok(updated.includes('\r\n\t<!--keep-->\r\n'));
    }
    for (const raw of ['<properties/>', '<properties>\r\n\t<!--keep-->\r\n</properties>', xml('old')]) {
        const updated = translationEdits(model(raw), 'New.key', 'A & B\rC', null).updated;
        assert.equal(parseNls(updated, ru).entries.find(e => e.key === 'New.key').value, 'A & B\rC');
        if (raw.includes('<!--keep-->')) assert.ok(updated.includes('<!--keep-->'));
        if (raw.includes('Other &amp; unchanged')) assert.ok(updated.includes('Other &amp; unchanged'));
    }
    assert.throws(() => translationEdits(model(xml('a')), 'Workspace.title', 'b', null), /существует/);
    assert.throws(() => translationEdits(model('<properties>'), 'K', 'b'), /поврежд/);
    assert.throws(() => translationEdits(model(xml('a')), 'Workspace.title', '\u0001', model(xml('a')).entries[0].entryStart), /XML/);
});

test('draft distinguishes empty/missing/conflict, explicit targets and bounded validated edits', () => {
    const resources = [model(xml('')), model(xml('Documents'), en), model(xml('Conflict'), root + '/other_en.nls'), model(xml('Other','Other.title'), uz)];
    const draft = createDraft({ root, resources }, 'Workspace.title', 'ru');
    assert.equal(draft.rows[0].status, 'found'); assert.equal(draft.rows[0].value, '');
    const english = draft.rows.find(r => r.locale === 'en'); assert.equal(english.status, 'conflict'); assert.equal(english.target, null);
    const missing = draft.rows.find(r => r.locale === 'uz'); assert.equal(missing.status, 'missing'); assert.equal(missing.target, 0);
    updateRow(draft, missing.id, '', missing.options[0].id); assert.equal(missing.edited, true); // Existing empty != missing.
    const revision = draft.revision;
    assert.throws(() => updateRow(draft, 900, 'X', 0)); assert.throws(() => updateRow(draft, missing.id, 'X', 900));
    assert.throws(() => updateRow(draft, missing.id, 'a'.repeat(65537), 0)); assert.equal(draft.revision, revision);
    const saved = serializeDraft(draft); assert.ok(!JSON.stringify(saved).includes('<properties>'));
    const other = createDraft({ root: '/work/other', resources }, 'Workspace.title', 'ru'); assert.equal(restoreDraft(other, saved), false);
    const changed = createDraft({ root, resources: resources.map(r => r.filePath === uz ? model(xml('Changed','Other.title'),uz) : r) }, 'Workspace.title','ru');
    assert.equal(restoreDraft(changed,saved),true); assert.equal(changed.rows.find(r=>r.locale==='uz').stale,true);
});

test('open uses explicit BL key, Active tab, shared scope, no split/network and isolated trusted hover action', async t => {
    const { env, doc, panel } = await setup(t);
    assert.equal(panel.column, env.vscode.ViewColumn.Active); assert.equal(panel.config.enableScripts,true); assert.deepEqual([...panel.config.localResourceRoots],[]);
    const s = state(panel); assert.equal(s.key,'Workspace.title'); assert.equal(s.root,root); assert.equal(s.rows.length,3);
    assert.equal(s.rows.find(r=>r.locale==='uz').status,'missing');
    assert.ok(!env.requiredModules.some(m=>/^(http|https|net|tls)$/.test(m)));
    const repeated = await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Workspace.title'}); assert.equal(repeated,panel);
    assert.equal(env.panels.length,1);
    const hover = await env.providers.hover.provideHover(doc,doc.positionAt(source.indexOf('$')+1));
    assert.equal(hover.contents[0].isTrusted,undefined); assert.equal(hover.contents[1].isTrusted,true); assert.match(hover.contents[1].value,/command:bl.editTranslation/);
    assert.equal(await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Unknown.key'}),undefined);
});

test('preview/back are read-only; Apply changes native buffers for several languages, never disk/BL', async t => {
    const { env, doc, panel } = await setup(t);
    let s = state(panel);
    s = await action(panel,'edit',{...choose(s,'ru'),value:'Договоры'});
    s = await action(panel,'edit',{...choose(s,'en'),value:'Contracts'});
    s = await action(panel,'edit',{...choose(s,'uz',false),value:'Шартномалар'});
    assert.match(s.notice,/сохранён локально/); assert.equal(env.appliedEdits.length,0);
    s = await action(panel,'preview'); assert.equal(s.preview.length,3); assert.equal(s.preview.find(c=>c.locale==='uz').before,null);
    assert.equal(env.contents.get(ru),xml('Документы')); assert.equal(doc.getText(),source);
    s = await action(panel,'back'); assert.equal(s.preview,null); assert.equal(s.rows.find(r=>r.locale==='ru').value,'Договоры');
    await action(panel,'preview'); s = await action(panel,'apply');
    assert.equal(env.appliedEdits.length,1); assert.match(s.notice,/Save/); assert.equal(s.preview,null);
    assert.equal(env.contents.get(ru),xml('Документы')); assert.equal(env.contents.get(bl),source);
    for (const [file,value] of [[ru,'Договоры'],[en,'Contracts'],[uz,'Шартномалар']]) {
        const nls = env.vscode.workspace.textDocuments.find(d=>d.uri.fsPath===file);
        assert.equal(nls.isDirty,true); assert.equal(parseNls(nls.getText(),file).entries.find(e=>e.key==='Workspace.title').value,value);
        assert.ok(nls.getText().includes('<!-- keep -->')); assert.ok(nls.getText().includes('Other &amp; unchanged'));
    }
    assert.equal(Object.keys(env.storedDrafts.get('z8bl.i18n.drafts.v1')).length,0);
    await action(panel,'apply'); assert.equal(env.appliedEdits.length,1);
});

test('dirty NLS is the baseline; changes after load or preview cannot be overwritten', async t => {
    const { env, panel } = await setup(t);
    let s = await action(panel,'edit',{...choose(state(panel),'ru'),value:'Mine'});
    await action(panel,'preview');
    const resource = env.vscode.workspace.textDocuments.find(d=>d.uri.fsPath===ru);
    Object.assign(resource,document(ru,xml('Their new value'))); resource.isDirty=true; await env.change(resource);
    s = await action(panel,'apply'); assert.match(s.error,/изменился/); assert.equal(env.appliedEdits.length,0);
    assert.equal(resource.getText(),xml('Their new value')); assert.equal(s.rows.find(r=>r.locale==='ru').value,'Mine');
    panel.dispose();
    const reopened = await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Workspace.title'}); await reopened.receiveMessage({type:'ready'});
    s = state(reopened); assert.equal(s.rows.find(r=>r.locale==='ru').value,'Mine'); assert.equal(s.rows.find(r=>r.locale==='ru').stale,true);
    s = await action(reopened,'preview'); assert.ok(s.error); assert.equal(env.appliedEdits.length,0);
});

test('close/reopen and extension reload restore local acknowledged drafts, with no checkout sharing', async t => {
    const storedDrafts = new Map();
    const { env, panel } = await setup(t,{}, {workspaceState:storedDrafts});
    await action(panel,'edit',{...choose(state(panel),'en'),value:'Saved draft'}); panel.dispose();
    const reopened = await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Workspace.title'}); await reopened.receiveMessage({type:'ready'});
    assert.equal(state(reopened).rows.find(r=>r.locale==='en').value,'Saved draft');
    env.dispose();
    const second = await setup(t,{}, {workspaceState:storedDrafts}); assert.equal(state(second.panel).rows.find(r=>r.locale==='en').value,'Saved draft');
    assert.equal(second.env.contents.get(en),xml('Documents'));
});

test('discard/reload require confirmation; cancellation retains draft and disk', async t => {
    const { env, panel } = await setup(t);
    await action(panel,'edit',{...choose(state(panel),'ru'),value:'Mine'});
    let s = await action(panel,'discard'); assert.equal(s.rows.find(r=>r.locale==='ru').value,'Mine');
    env.vscode.window.showWarningMessage = async ()=> 'Отменить изменения';
    s = await action(panel,'reload'); assert.equal(s.rows.find(r=>r.locale==='ru').value,'Документы');
    assert.equal(s.rows.some(r=>r.edited),false); assert.equal(env.appliedEdits.length,0); assert.equal(env.contents.get(ru),xml('Документы'));
    assert.equal(Object.keys(env.storedDrafts.get('z8bl.i18n.drafts.v1')).length,0);
});

test('storage failures report unsaved draft without claiming success or losing current inputs', async t => {
    const { env, panel } = await setup(t); env.storageControl.fail=true;
    let s = await action(panel,'edit',{...choose(state(panel),'en'),value:'Cannot persist'});
    assert.match(s.notice,/НЕ сохранён/); assert.match(s.error,/скопируйте/); assert.equal(s.rows.find(r=>r.locale==='en').value,'Cannot persist');
    await action(panel,'preview'); s = await action(panel,'back'); assert.match(s.notice,/НЕ сохранён/);
    env.storageControl.fail=false; s = await action(panel,'edit',{...choose(s,'en'),value:'Can persist'}); assert.match(s.notice,/сохранён локально/);
});

test('messages cannot supply paths, execute commands or apply stale sessions/sequences/unknown row IDs', async t => {
    const { env, panel } = await setup(t);
    let s = state(panel);
    await panel.receiveMessage({type:'edit',session:'wrong',sequence:10,row:0,value:'attack',target:0});
    assert.equal(state(panel).rows[0].value,s.rows[0].value);
    s = await action(panel,'edit',{row:999,value:'attack',target:0}); assert.match(s.error,/Некорректное/);
    s = await action(panel,'openSource',{row:0,option:999,path:'/etc/passwd'}); assert.equal(env.sourceOpens.length,0);
    await panel.receiveMessage({type:'apply',session:s.session,sequence:s.sequence}); assert.equal(env.appliedEdits.length,0);
    assert.equal(env.contents.get(ru),xml('Документы'));
    const before=env.commandCalls.length; await action(panel,'executeCommand',{command:'evil'}); assert.equal(env.commandCalls.length,before);
});

test('conflicting duplicates require target choice; selecting one never edits the other declaration', async t => {
    const other = root+'/other_ru.nls';
    const { env, panel } = await setup(t,{[other]:xml('Другие документы')});
    let s = state(panel), row = s.rows.find(r=>r.locale==='ru'); assert.equal(row.status,'conflict'); assert.equal(row.target,null);
    s = await action(panel,'edit',{row:row.id,target:null,value:'Chosen'}); s = await action(panel,'preview'); assert.match(s.error,/выберите/);
    const option=row.options.find(o=>o.filePath===ru);
    await action(panel,'edit',{row:row.id,target:option.id,value:'Chosen'}); await action(panel,'preview'); await action(panel,'apply');
    assert.equal(env.appliedEdits.length,1); assert.ok(env.appliedEdits[0].entries.every(e=>e.uri.fsPath===ru)); assert.equal(env.contents.get(other),xml('Другие документы'));
});

test('untrusted workspace permits offline draft but blocks Apply path, source buttons use active group', async t => {
    const { env, panel } = await setup(t);
    await action(panel,'openSource',{row:0,option:state(panel).rows[0].target}); assert.equal(env.sourceOpens[0].config.viewColumn,env.vscode.ViewColumn.Active);
    env.vscode.workspace.isTrusted=false;
    await action(panel,'edit',{...choose(state(panel),'ru'),value:'Mine'});
    const s=await action(panel,'preview'); assert.match(s.error,/доверенный/); assert.equal(env.appliedEdits.length,0);
});

test('webview uses nonce CSP, safe DOM updates and theme/focus/accessibility without external assets', () => {
    const html = renderI18nView('fixture-nonce');
    assert.match(html,/connect-src 'none'/); assert.match(html,/script-src 'nonce-fixture-nonce'/); assert.match(html,/style-src 'nonce-fixture-nonce'/);
    assert.match(html,/aria-live="polite"/); assert.match(html,/role="alert"/); assert.match(html,/vscode-focusBorder/); assert.match(html,/forced-colors/);
    assert.match(html, /<details id="details"><summary>Источники и подробности<\/summary>/);
    assert.match(html, /<details id="review-details"><summary>Показать изменения<\/summary>/);
    assert.match(html, />Проверить изменения…<\/button>/);
    assert.ok(!html.includes('position:fixed'));
    assert.ok(!html.includes('innerHTML')); assert.ok(!html.includes('https://')); assert.ok(!html.includes('eval('));
    const script = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)[1]; assert.doesNotThrow(()=>new vm.Script(script));
    assert.match(script,/\.textContent/); assert.match(script,/document\.activeElement/); assert.match(script,/sequence/);
});

function webviewHarness() {
    const nodes = new Map(), sent = [], listeners = new Map();
    class Element {
        constructor(tag) { this.tag=tag; this.children=[];this.handlers=new Map();this.hidden=false;this.disabled=false;this.value='';this.textContent='';this.style={};this.scrollHeight=34;this.open=false; }
        set id(id) {this._id=id;nodes.set(id,this);} get id(){return this._id;}
        append(...children){this.children.push(...children);} replaceChildren(...children){this.children=children;}
        setAttribute(key,value){this[key]=value;} addEventListener(type,fn){this.handlers.set(type,fn);}
        click(){this.handlers.get('click')?.();} focus(){doc.activeElement=this;}
    }
    for(const id of ['rows','status','preview','key','scope','error','count','edit','review','apply','back','reload','discard','changes','close','details','review-details','review-summary','ai','ai-open','ai-form','ai-review','ai-wait','ai-error','ai-prepare','ai-send','ai-back','ai-cancel','ai-text','ai-source','ai-targets','ai-endpoint','ai-payload','ai-summary','view-caption','ai-target-count','ai-target-help','proposal-bar','proposal-all','proposal-count','proposal-accept','proposal-help','proposal-undo','resource-summary','resource-paths','add-language','rename-key','review-title','rename-scope','ai-recover','error-reload']){const node=new Element('div');node.id=id;}
    const doc={activeElement:null,createElement:tag=>new Element(tag),getElementById:id=>nodes.get(id),addEventListener:(type,fn)=>listeners.set('document:'+type,fn)};
    const html=renderI18nView('safe'),script=/<script[^>]*>([\s\S]*)<\/script>/.exec(html)[1];
    vm.runInNewContext(script,{document:doc,window:{addEventListener:(type,fn)=>listeners.set(type,fn)},acquireVsCodeApi:()=>({postMessage:m=>sent.push(m)})});
    return {nodes,sent,listeners,doc,receive:model=>listeners.get('message')({data:model})};
}

test('actual webview script keeps focus while saving, retains typed value on resource selection, and rejects stale acknowledgements', () => {
    const {nodes,sent,doc,receive} = webviewHarness();
    assert.equal(sent[0].type,'ready');
    const snapshot={type:'state',session:'session',sequence:0,generation:0,key:'K',root:'/checkout',locale:'ru',rows:[{id:0,locale:'ru',status:'found',original:'Old',value:'Old',edited:false,target:0,options:[{id:0,label:'source',value:'Old'},{id:1,label:'second',value:'Second'}]}],notice:'Ready',busy:false,saving:false,preview:null};
    receive(snapshot);
    const field=nodes.get('value-0'); doc.activeElement=field;field.value='<script>Not HTML</script>';field.handlers.get('input')();
    assert.equal(sent[1].value,'<script>Not HTML</script>');
    receive({...snapshot,sequence:1,saving:true,notice:'Saving',rows:[{...snapshot.rows[0],value:field.value,edited:true}]});
    assert.equal(field.disabled,false,'storage acknowledgement must not disable focused input');assert.equal(doc.activeElement,field);
    assert.equal(nodes.get('preview').disabled,true);
    const select=nodes.get('target-0');select.value='1';select.handlers.get('change')();
    assert.equal(field.value,'<script>Not HTML</script>','changing resource must not clobber manual typing');
    receive({...snapshot,sequence:1,notice:'stale ack'});assert.notEqual(nodes.get('status').textContent,'stale ack');
    receive({...snapshot,sequence:2,rows:[{...snapshot.rows[0],value:field.value,edited:true,target:1}],preview:[{locale:'ru',path:'source',before:'Old',after:field.value}]});
    assert.equal(nodes.get('preview').hidden,true);assert.equal(nodes.get('apply').hidden,false);assert.equal(nodes.get('back').hidden,false);
    assert.equal(nodes.get('changes').children[0].children[2].children[1].children[1].textContent,field.value);
});

test('toolkit uses checkout-isolated drafts and refuses excluded/generated resources even after config change', async t => {
    const otherRoot='/work/other',otherBl=otherRoot+'/Example.bl',otherNls=otherRoot+'/other_ru.nls';
    const { env,panel }=await setup(t,{[otherBl]:source,[otherNls]:xml('Другой checkout'),[root+'/target/generated_ru.nls']:xml('Generated')},
        {checkoutRoots:[root,otherRoot],configuration:{'index.exclude':[]}});
    assert.ok(state(panel).rows.flatMap(r=>r.options).every(o=>!o.filePath.includes('/target/')&&!o.filePath.startsWith(otherRoot)));
    await action(panel,'edit',{...choose(state(panel),'ru'),value:'First draft'}); panel.dispose();
    const second=await env.commands.get('bl.editTranslation')({sourceUri:otherBl,key:'Workspace.title'});await second.receiveMessage({type:'ready'});
    assert.equal(state(second).rows.find(r=>r.locale==='ru').value,'Другой checkout');assert.equal(state(second).root,otherRoot);
    const reopened=await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Workspace.title'});await reopened.receiveMessage({type:'ready'});
    assert.equal(state(reopened).rows.find(r=>r.locale==='ru').value,'First draft');
    await action(reopened,'preview');await env.configure({'index.exclude':['**/app_ru.nls']});
    const s=await action(reopened,'apply');assert.match(s.error,/изменился|scope/);assert.equal(env.appliedEdits.length,0);
});

test('close during asynchronous preview cancels before any WorkspaceEdit, leaving durable draft intact', async t => {
    const { env,panel }=await setup(t);
    await action(panel,'edit',{...choose(state(panel),'en'),value:'My draft'});
    const original=env.vscode.workspace.openTextDocument;
    let release;const delayed=new Promise(resolve=>{release=resolve;});
    env.vscode.workspace.openTextDocument=async uri=>{await delayed;return original(uri);};
    const pending=action(panel,'preview');panel.dispose();release();await pending;
    assert.equal(env.appliedEdits.length,0);
    assert.ok(JSON.stringify(env.storedDrafts.get('z8bl.i18n.drafts.v1')).includes('My draft'));
});


test('compact editor hides ordinary statuses, keeps empty distinct from missing, and reveals required source choice', () => {
    const {nodes,receive}=webviewHarness();
    const row=(id,locale,status,value,target)=>({id,locale,status,original:value,value,edited:false,target,options:[{id:0,label:'resource',value:status==='missing'?null:value}]});
    const model={type:'state',session:'compact',sequence:0,generation:0,key:'K',root:'/checkout',locale:'ru',rows:[row(0,'ru','found','',0),row(1,'en','missing','',null),row(2,'fr','conflict','A',null),{...row(3,'uz','unavailable','',null),options:[]}],notice:'Нет изменений.',busy:false,saving:false,preview:null};
    receive(model);
    assert.equal(nodes.get('warning-0').hidden,true);assert.equal(nodes.get('help-0').hidden,true);
    assert.equal(nodes.get('value-0').rows,1);assert.equal(nodes.get('value-0').placeholder,'Пустой перевод');
    assert.equal(nodes.get('source-0').open,false);assert.equal(nodes.get('details').open,false);
    assert.equal(nodes.get('warning-1').textContent,'Нет перевода');assert.equal(nodes.get('value-1').placeholder,'Введите перевод');
    assert.equal(nodes.get('source-1').open,true);assert.equal(nodes.get('source-2').open,true);
    assert.equal(nodes.get('warning-2').hidden,false);assert.equal(nodes.get('value-3').disabled,true);
    assert.equal(nodes.get('rows').children[2].children[0].children[0].textContent,'fr','unknown locale stays a code');
    receive({...model,rows:model.rows.map(r=>r.id===1?{...r,edited:true,value:'New'}:r)});
    assert.equal(nodes.get('preview').disabled,true,'missing edited target still blocks Save');
    receive({...model,rows:model.rows.map(r=>r.id===0?{...r,edited:true,stale:true}:r)});
    assert.equal(nodes.get('warning-0').textContent,'Источник изменился');assert.equal(nodes.get('preview').disabled,true);
});

test('compact disclosures and growing fields survive acknowledgement, review and Back', () => {
    const {nodes,sent,doc,receive}=webviewHarness();
    const row={id:0,locale:'ru',status:'found',original:'Old',value:'Old',edited:false,target:0,options:[{id:0,label:'resource',value:'Old'}]};
    const model={type:'state',session:'compact',sequence:0,generation:0,key:'K',root:'/checkout',locale:'ru',rows:[row],notice:'Ready',busy:false,saving:false,preview:null};receive(model);
    const field=nodes.get('value-0');nodes.get('source-0').open=true;nodes.get('details').open=true;
    field.focus();field.scrollHeight=100;field.value='One\nTwo\nThree';field.handlers.get('input')();
    assert.equal(field.style.height,'100px');assert.equal(sent.at(-1).type,'edit');
    const edited={...model,sequence:1,rows:[{...row,edited:true,value:field.value}]};receive(edited);
    assert.equal(doc.activeElement,field);assert.equal(nodes.get('source-0').open,true);assert.equal(nodes.get('details').open,true);
    field.scrollHeight=400;field.handlers.get('input')();assert.equal(field.style.height,'180px');
    receive({...edited,sequence:2});nodes.get('preview').click();assert.equal(sent.at(-1).type,'preview');
    const review={...edited,sequence:3,preview:[{locale:'ru',path:'resource',before:'Old',after:field.value}]};receive(review);
    assert.equal(nodes.get('review-summary').textContent,'Файлов: 1 · Языки: RU');assert.equal(nodes.get('review-details').open,false);
    assert.equal(nodes.get('edit').hidden,true);assert.equal(nodes.get('review').hidden,false);assert.equal(doc.activeElement,nodes.get('apply'));
    const card=nodes.get('changes').children[0];nodes.get('review-details').open=true;
    receive({...review,busy:true});assert.equal(nodes.get('changes').children[0],card,'review must not rebuild on operation status');assert.equal(nodes.get('review-details').open,true);
    nodes.get('back').click();assert.equal(sent.at(-1).type,'back');receive({...edited,sequence:4});
    assert.equal(field.value,'One\nTwo\nThree');assert.equal(nodes.get('source-0').open,true);assert.equal(nodes.get('apply').hidden,true);assert.equal(nodes.get('preview').hidden,false);assert.equal(doc.activeElement,field);
});

test('AI webview input-first flow has one primary per phase, safe payload review, no send on opening and responsive editing while waiting', () => {
    const {nodes,sent,doc,receive}=webviewHarness();
    const rows=[{id:0,locale:'ru',value:'Source',original:'Source',status:'found',target:0,options:[{id:0,label:'ru',value:'Source'}],edited:false,revision:0},
        {id:1,locale:'en',value:'Existing',original:'Existing',status:'found',target:0,options:[{id:0,label:'en',value:'Existing'}],edited:false,revision:0},
        {id:2,locale:'uz',value:'',original:'',status:'missing',target:null,options:[{id:0,label:'uz',value:null}],edited:false,revision:0}];
    const base={type:'state',session:'ai',sequence:0,generation:0,key:'K',root:'/checkout',locale:'ru',rows,notice:'Ready',busy:false,saving:false,preview:null,ai:{open:false,running:false,error:'',review:null,proposals:[]}};receive(base);
    assert.equal(nodes.get('ai').hidden,true);nodes.get('ai-open').click();assert.equal(sent.at(-1).type,'aiOpen');
    const open={...base,sequence:1,ai:{...base.ai,open:true}};receive(open);
    assert.equal(nodes.get('ai-text').value,'Source');assert.equal(doc.activeElement,nodes.get('ai-text'));
    assert.equal(nodes.get('ai-target-0').disabled,true);assert.equal(nodes.get('ai-target-0').container.hidden,true);assert.equal(nodes.get('ai-target-1').checked,true);assert.equal(nodes.get('ai-target-2').checked,true);
    assert.equal(nodes.get('preview').hidden,true);assert.equal(nodes.get('ai-prepare').hidden,false);assert.equal(nodes.get('ai-send').hidden,true);
    nodes.get('ai-text').value='Typed <script>not markup</script>';nodes.get('ai-text').handlers.get('input')();
    nodes.get('ai-prepare').click();assert.equal(sent.at(-1).type,'aiPrepare');assert.equal(sent.at(-1).text,nodes.get('ai-text').value);assert.deepEqual(Array.from(sent.at(-1).targets),['en','uz']);
    const review={...open,sequence:2,ai:{...open.ai,review:{token:'prepared-token',url:'endpoint',model:'m',data:{sourceLocale:'ru',targetLocales:['uz'],sourceText:nodes.get('ai-text').value},body:{messages:[{content:nodes.get('ai-text').value}]}}}};receive(review);
    assert.equal(nodes.get('ai-text').value,'Typed <script>not markup</script>');assert.equal(nodes.get('ai-prepare').hidden,true);assert.equal(nodes.get('ai-send').hidden,false);
    assert.ok(nodes.get('ai-payload').textContent.includes('<script>'));assert.ok(nodes.get('ai-summary').textContent.includes('ru → uz'));
    assert.equal(nodes.get('ai-back').textContent,'Изменить текст');
    nodes.get('ai-send').click();assert.equal(sent.at(-1).type,'aiSend');assert.equal(sent.at(-1).token,'prepared-token');assert.equal(nodes.get('ai-send').disabled,true);
    receive({...open,sequence:3,ai:{...open.ai,running:true,review:null}});
    assert.equal(nodes.get('ai-cancel').hidden,false);assert.equal(nodes.get('ai-send').hidden,true);assert.equal(nodes.get('ai-prepare').hidden,true);
    assert.equal(nodes.get('edit').hidden,false);assert.equal(nodes.get('value-1').disabled,false);assert.equal(nodes.get('ai-text').disabled,true);
    nodes.get('ai-cancel').click();assert.equal(sent.at(-1).type,'aiCancel');
    receive({...open,sequence:4,ai:{...open.ai,error:'Cancelled'}});assert.equal(nodes.get('ai-text').value,'Typed <script>not markup</script>');assert.equal(nodes.get('ai-error').textContent,'Cancelled');
});

test('AI proposals use safe text, explicit token/revision-bound batch accept, preserve inputs through review invalidation', () => {
    const {nodes,sent,receive}=webviewHarness();
    const row={id:0,locale:'en',value:'Original',status:'found',target:0,options:[{id:0,label:'source',value:'Original'}],edited:false,revision:8};
    const base={type:'state',session:'ai',sequence:0,generation:0,key:'K',root:'/checkout',locale:'en',rows:[row],notice:'Ready',busy:false,saving:false,preview:null,ai:{open:false,running:false,error:'',review:null,proposals:[{row:0,value:'<script>AI text</script>',token:'one',revision:8,reason:''}]}};
    receive(base);const proposal=nodes.get('proposal-0');assert.equal(proposal.hidden,false);assert.equal(nodes.get('proposal-value-0').textContent,'<script>AI text</script>');assert.equal(nodes.get('value-0').value,'Original');
    nodes.get('proposal-accept').click();assert.equal(sent.at(-1).type,'aiAcceptSelected');assert.equal(sent.at(-1).items[0].revision,8);assert.equal(sent.at(-1).items[0].token,'one');
    assert.equal(nodes.get('proposal-accept').disabled,true,'duplicate clicks blocked before ack');
    receive({...base,sequence:1,rows:[{...row,revision:9}],ai:{...base.ai,proposals:[{...base.ai.proposals[0],reason:'Поле изменилось'}]}});
    assert.equal(nodes.get('proposal-choice-0').disabled,true);assert.equal(nodes.get('proposal-accept').disabled,true);
    receive({...base,sequence:2,ai:{...base.ai,open:true,review:{token:'old',url:'endpoint',model:'m',body:{}}}});
    nodes.get('ai-text').value='New input';nodes.get('ai-text').handlers.get('input')();assert.equal(sent.at(-1).type,'aiInvalidate');assert.equal(nodes.get('ai-send').disabled,true);assert.equal(nodes.get('ai-prepare').hidden,false);
    receive({...base,sequence:3,ai:{...base.ai,open:true,review:null}});assert.equal(nodes.get('ai-text').value,'New input');
});


test('AI compact form defaults all eligible targets on, preserves deselection through source changes and acknowledgement, and filters hidden source payload', () => {
    const {nodes,sent,receive}=webviewHarness();
    const row=(id,locale,value,extra={})=>({id,locale,value,original:value,status:'found',target:0,options:[{id:0,label:locale,value}],edited:false,revision:0,...extra});
    const base={type:'state',session:'targets',sequence:0,generation:0,key:'K',root:'/checkout',locale:'ru',rows:[row(0,'ru','Source'),row(1,'en','Existing',{edited:true}),row(2,'uz','Saved'),row(3,'fr','',{status:'unavailable',options:[]})],notice:'Ready',busy:false,saving:false,preview:null,ai:{open:false,running:false,error:'',review:null,proposals:[]}};
    receive(base);const open={...base,ai:{...base.ai,open:true}};receive(open);
    assert.equal(nodes.get('view-caption').textContent,'Перевод с ИИ');assert.equal(nodes.get('details').hidden,true);
    assert.equal(nodes.get('ai-target-0').container.hidden,true);assert.equal(nodes.get('ai-target-1').checked,true);assert.equal(nodes.get('ai-target-2').checked,true);assert.ok(!nodes.has('ai-target-3'));
    assert.equal(nodes.get('ai-target-count').textContent,'2 из 2');assert.equal(nodes.get('ai-target-help').hidden,true);
    nodes.get('ai-target-2').checked=false;nodes.get('ai-target-2').handlers.get('change')();
    assert.equal(nodes.get('ai-target-count').textContent,'1 из 2');
    nodes.get('ai-source').value='en';nodes.get('ai-source').handlers.get('change')();
    assert.equal(nodes.get('ai-target-1').container.hidden,true);assert.equal(nodes.get('ai-target-0').container.hidden,false);assert.equal(nodes.get('ai-target-0').checked,true);assert.equal(nodes.get('ai-target-2').checked,false);
    nodes.get('ai-text').value='Preserved input';receive({...open,saving:true});
    assert.equal(nodes.get('ai-target-2').checked,false);assert.equal(nodes.get('ai-source').value,'en');assert.equal(nodes.get('ai-text').value,'Preserved input');
    nodes.get('ai-prepare').click();const request=sent.at(-1);assert.equal(request.sourceLocale,'en');assert.deepEqual(Array.from(request.targets),['ru']);
    receive({...open,sequence:request.sequence});nodes.get('ai-target-0').checked=false;nodes.get('ai-target-0').handlers.get('change')();
    assert.equal(nodes.get('ai-prepare').disabled,true);assert.match(nodes.get('ai-target-help').textContent,/хотя бы один/);
    receive({...base,sequence:request.sequence});assert.equal(nodes.get('details').hidden,false);assert.equal(nodes.get('view-caption').textContent,'Переводы');
    receive({...open,sequence:request.sequence});assert.equal(nodes.get('ai-source').value,'ru');assert.equal(nodes.get('ai-target-2').checked,true,'new opening resets all available targets to checked');
});

test('AI source-only workspace explains empty targets, and confirmation/cancel focus does not steal active manual editing', () => {
    const {nodes,doc,receive}=webviewHarness();
    const row={id:0,locale:'ru',value:'Source',original:'Source',status:'found',target:0,options:[{id:0,label:'ru',value:'Source'}],edited:false,revision:0};
    const base={type:'state',session:'focus',sequence:0,generation:0,key:'K',root:'/checkout',locale:'ru',rows:[row],notice:'Ready',busy:false,saving:false,preview:null,ai:{open:true,running:false,error:'',review:null,proposals:[]}};
    receive(base);assert.equal(nodes.get('ai-prepare').disabled,true);assert.match(nodes.get('ai-target-help').textContent,/Нет других/);assert.equal(nodes.get('ai-target-count').textContent,'0 из 0');
    receive({...base,ai:{...base.ai,review:{token:'t',url:'endpoint',model:'m',body:{}}}});assert.equal(doc.activeElement,nodes.get('ai-send'));
    receive({...base,ai:{...base.ai,running:true}});assert.equal(doc.activeElement,nodes.get('ai-cancel'));
    nodes.get('value-0').focus();receive({...base,ai:{...base.ai,open:false}});assert.equal(doc.activeElement,nodes.get('value-0'));
});

test('AI compact markup keeps disclosures and consent accessible without a giant disclaimer or duplicate heading', () => {
    const html=renderI18nView('compact');
    assert.ok(!html.includes('<h2>Перевод с ИИ</h2>'));
    assert.match(html,/<details id="ai-notes"><summary>О переводе с ИИ<\/summary>/);
    assert.match(html,/fieldset aria-describedby="ai-target-help"/);
    assert.match(html,/id="ai-cancel-note"/);assert.match(html,/>Проверить запрос<\/button>/);
    assert.match(html,/#ai-targets input:focus-visible/);assert.ok(!html.includes(':has('));
});

test('bulk proposal selection defaults checked, mixed/select-none/select-all and deselection survive ack/subset acceptance', () => {
    const {nodes,sent,receive,doc}=webviewHarness();
    const rows=['en','uz'].map((locale,id)=>({id,locale,value:'Original '+locale,status:'found',target:0,options:[{id:0,label:'source',value:'Original '+locale}],edited:false,revision:0}));
    const proposals=rows.map(row=>({row:row.id,value:'AI '+row.locale,revision:0,token:row.locale,reason:''}));
    const base={type:'state',session:'bulk',sequence:0,generation:0,key:'K',root:'/checkout',locale:'en',rows,notice:'Ready',busy:false,saving:false,preview:null,ai:{open:false,running:false,error:'',review:null,proposals,undo:false}};
    receive(base);assert.equal(nodes.get('proposal-bar').hidden,false);assert.equal(nodes.get('proposal-all').checked,true);assert.equal(nodes.get('proposal-all').indeterminate,false);assert.equal(nodes.get('proposal-accept').textContent,'Принять все (2)');
    const uz=nodes.get('proposal-choice-1');uz.checked=false;uz.focus();uz.handlers.get('change')();
    assert.equal(nodes.get('proposal-all').indeterminate,true);assert.equal(nodes.get('proposal-count').textContent,'1 из 2');assert.equal(nodes.get('proposal-accept').textContent,'Принять выбранные (1)');
    receive({...base,saving:true});receive(base);assert.equal(uz.checked,false);assert.equal(doc.activeElement,uz);
    nodes.get('proposal-accept').focus();nodes.get('proposal-accept').click();assert.equal(sent.at(-1).items.length,1);assert.equal(sent.at(-1).items[0].row,0);assert.equal(nodes.get('proposal-all').disabled,true);
    receive({...base,sequence:1,rows:[{...rows[0],value:'AI en',revision:1,edited:true,ai:true},rows[1]],ai:{...base.ai,proposals:[proposals[1]],undo:true}});
    assert.equal(uz.checked,false);assert.equal(nodes.get('proposal-count').textContent,'0 из 1');assert.equal(nodes.get('proposal-accept').disabled,true);assert.equal(nodes.get('proposal-undo').hidden,false);
    const all=nodes.get('proposal-all');all.checked=true;all.handlers.get('change')();assert.equal(uz.checked,true);assert.equal(all.indeterminate,false);assert.equal(nodes.get('proposal-accept').textContent,'Принять все (1)');
    all.checked=false;all.handlers.get('change')();assert.equal(uz.checked,false);assert.equal(nodes.get('proposal-accept').disabled,true);
    nodes.get('proposal-undo').focus();nodes.get('proposal-undo').click();assert.equal(sent.at(-1).type,'aiUndoAccept');
    receive({...base,sequence:2,rows:[{...rows[0],revision:2},rows[1]],ai:{...base.ai,proposals:[{...proposals[0],revision:2,token:'restored'},proposals[1]]}});
    assert.equal(nodes.get('proposal-choice-0').checked,true);assert.equal(uz.checked,false);assert.equal(doc.activeElement,all);assert.equal(nodes.get('proposal-undo').hidden,true);
});

test('blocked proposals are explained/excluded, manual input locks accept until ack, toolbar hides outside proposals phase', () => {
    const {nodes,sent,receive,doc}=webviewHarness();
    const rows=['en','uz'].map((locale,id)=>({id,locale,value:'Original',status:'found',target:0,options:[{id:0,label:'source',value:'Original'}],edited:false,revision:0}));
    const proposals=rows.map(row=>({row:row.id,value:'AI',revision:0,token:row.locale,reason:row.id===1?'Ресурс недоступен.':''}));
    const base={type:'state',session:'guard',sequence:0,generation:0,key:'K',root:'/checkout',locale:'en',rows,notice:'Ready',busy:false,saving:false,preview:null,ai:{open:false,running:false,error:'',review:null,proposals,undo:false}};
    receive(base);assert.equal(nodes.get('proposal-choice-1').disabled,true);assert.equal(nodes.get('proposal-choice-1').checked,false);assert.match(nodes.get('proposal-reason-1').textContent,/недоступен/);assert.equal(nodes.get('proposal-count').textContent,'1 из 1');assert.match(nodes.get('proposal-help').textContent,/Недоступные/);
    const value=nodes.get('value-0');value.focus();value.value='Manual';value.handlers.get('input')();assert.equal(sent.at(-1).type,'edit');assert.equal(nodes.get('proposal-accept').disabled,true);
    receive({...base,sequence:1,rows:[{...rows[0],value:'Manual',revision:1,edited:true},rows[1]],ai:{...base.ai,proposals:[{...proposals[0],reason:'Поле изменилось'},proposals[1]]}});
    assert.equal(nodes.get('proposal-accept').disabled,true);assert.equal(nodes.get('proposal-all').disabled,true);assert.equal(value.value,'Manual');assert.equal(doc.activeElement,value);
    receive({...base,sequence:1,ai:{...base.ai,proposals:[]}});assert.equal(nodes.get('proposal-bar').hidden,true);
    receive({...base,sequence:1,preview:[]});assert.equal(nodes.get('proposal-bar').hidden,true);
    receive({...base,sequence:1,ai:{...base.ai,open:true}});assert.equal(nodes.get('proposal-bar').hidden,true);
});

test('full acceptance moves disappearing action focus to undo and keeps proposal labels/theme/accessibility semantic', () => {
    const {nodes,receive,doc}=webviewHarness();
    const row={id:0,locale:'en',value:'Original',status:'found',target:0,options:[{id:0,label:'source',value:'Original'}],edited:false,revision:0};
    const base={type:'state',session:'focusbulk',sequence:0,generation:0,key:'K',root:'/checkout',locale:'en',rows:[row],notice:'Ready',busy:false,saving:false,preview:null,ai:{open:false,running:false,error:'',review:null,proposals:[{row:0,value:'AI',revision:0,token:'p',reason:''}],undo:false}};
    receive(base);nodes.get('proposal-accept').focus();nodes.get('proposal-accept').click();
    receive({...base,sequence:1,rows:[{...row,value:'AI',ai:true,revision:1}],ai:{...base.ai,proposals:[],undo:true}});
    assert.equal(doc.activeElement,nodes.get('proposal-undo'));assert.equal(nodes.get('proposal-bar').hidden,true);
    const html=renderI18nView('safe');assert.match(html,/role="group" aria-label="Предложения ИИ для текущего ключа"/);assert.match(html,/label for="proposal-all"/);assert.match(html,/#proposal-bar.*var\(--vscode-panel-border\)/);assert.match(html,/\.proposal input:focus-visible/);
    assert.equal(nodes.get('proposal-choice-0')['aria-describedby'],'proposal-reason-0');
});

test('CLM-shaped targets use exact directory/stem family; absent uz never borrows workflow, GPT or notifications resources', () => {
    const core = root + '/base-core/resources/pro.doczilla.base.core';
    const resources = [model(xml('Документы'), core + '_ru.nls'), model(xml('Documents'), core + '_en.nls'),
        model(xml('Unrelated', 'Other'), root + '/workflow/workflow_uz.nls'),
        model(xml('Other', 'Other'), core + '.notifications_uz.nls'),
        model(xml('Other', 'Other'), root + '/gpt/pro.doczilla.base.core_uz.nls')];
    const draft = createDraft({root, resources}, 'Workspace.title', 'ru');
    assert.deepEqual(draft.rows.map(r => r.locale), ['ru', 'en']);
    for (const row of draft.rows) { assert.equal(row.target, 0); assert.equal(row.options.length, 1); assert.ok(row.options[0].filePath.startsWith(core + '_')); }
    const required = createDraft({root, resources}, 'Workspace.title', 'ru', ['uz']).rows.find(r => r.locale === 'uz');
    assert.equal(required.target, null); assert.equal(required.options.length, 0); assert.match(required.resourceHelp, /Нет NLS-файла/);
    const unknown = createDraft({root, resources}, 'Unknown.key', 'ru');
    assert.equal(unknown.rows.length, 1); assert.equal(unknown.rows[0].options.length, 0); assert.match(unknown.rows[0].resourceHelp, /Не удалось определить/);
});

test('one existing sibling auto-selects missing insertion, regional suffixes match and ambiguous families remain explicit', () => {
    const resources = [model(xml('Source'), ru), model(xml('Other', 'Other'), en),
        model(xml('Other', 'Other'), root + '/app_en_US.nls')];
    const rows = createDraft({root, resources}, 'Workspace.title', 'ru').rows;
    for (const locale of ['en', 'en-us']) {
        const row = rows.find(r => r.locale === locale); assert.equal(row.status, 'missing'); assert.equal(row.target, 0); assert.equal(row.options[0].entryStart, null);
    }
    for (const secondValue of ['Source', 'Different']) {
        const multiple = [...resources, model(xml(secondValue), root + '/other_ru.nls'), model(xml('Other', 'Other'), root + '/other_en.nls')];
        const draft = createDraft({root, resources: multiple}, 'Workspace.title', 'ru');
        assert.equal(draft.rows[0].target, null); assert.equal(draft.rows.find(r => r.locale === 'en').target, null);
    }
});

test('only malformed related resources make Toolkit locale unavailable', () => {
    const resources = [model(xml('Source'), ru), model('<properties>', root + '/other_en.nls')];
    const available = createDraft({root, resources}, 'Workspace.title', 'en').rows[0];
    assert.equal(available.status, 'missing'); assert.equal(available.options.length, 0);
    resources.push(model('<properties>', en));
    assert.equal(createDraft({root, resources}, 'Workspace.title', 'en').rows[0].status, 'unavailable');
});

test('legacy unrelated target stays stale with copyable AI text; saved null is never silently auto-selected', () => {
    const resources = [model(xml('Source'), ru), model(xml('Other', 'Other'), en)];
    const old = {root, key:'Workspace.title', rows:[{locale:'en', original:'', value:'Recovered AI', ai:true,
        target:{filePath:root+'/workflow_en.nls', entryStart:null, hash:'old'}}]};
    const draft = createDraft({root, resources}, 'Workspace.title', 'ru'); assert.equal(restoreDraft(draft, old), true);
    const row = draft.rows.find(r => r.locale === 'en'); assert.equal(row.value, 'Recovered AI'); assert.equal(row.ai, true); assert.equal(row.stale, true); assert.equal(row.target, null);
    const again = createDraft({root, resources}, 'Workspace.title', 'ru'); restoreDraft(again, serializeDraft(draft));
    assert.equal(again.rows.find(r => r.locale === 'en').stale, true);
    old.rows[0].target = null;
    const nullDraft = createDraft({root, resources}, 'Workspace.title', 'ru'); restoreDraft(nullDraft, old);
    assert.equal(nullDraft.rows.find(r => r.locale === 'en').target, null);
});

test('missing sibling default applies only to its existing file, with no manual target and no disk save', async t => {
    const {env, panel} = await setup(t);
    const row = state(panel).rows.find(r => r.locale === 'uz'); assert.equal(row.target, 0);
    await action(panel, 'edit', {row:row.id, target:row.target, value:'Default insertion'});
    await action(panel, 'preview'); const result = await action(panel, 'apply');
    assert.equal(result.error, ''); assert.equal(env.appliedEdits.length, 1);
    assert.equal(env.contents.get(uz), xml('Бошқа', 'Other.title'));
    assert.equal(parseNls(env.vscode.workspace.textDocuments.find(d => d.uri.fsPath === uz).getText(), uz).entries.find(e => e.key === 'Workspace.title').value, 'Default insertion');
});

test('family anchor disappearing blocks preview and Apply even when missing target itself is unchanged', async t => {
    for (const phase of ['preview', 'apply']) {
        const {env, panel} = await setup(t, {[en]:xml('Other', 'Other')});
        const row = state(panel).rows.find(r => r.locale === 'uz');
        await action(panel, 'edit', {row:row.id, target:row.target, value:'Keep my text'});
        if (phase === 'apply') await action(panel, 'preview');
        env.contents.set(ru, xml('Other', 'Other')); await env.fileEvent('change', ru);
        const result = await action(panel, phase); assert.ok(result.error); assert.equal(env.appliedEdits.length, 0);
        assert.equal(result.rows.find(r => r.locale === 'uz').value, 'Keep my text');
    }
});

test('actual UI script hides absent/stale AI targets and makes missing resource rows read-only with concrete help', () => {
    const {nodes, receive} = webviewHarness();
    const draft = createDraft({root, resources:[model(xml('Source'), ru), model(xml('English'), en)]}, 'Workspace.title', 'ru', ['uz']);
    draft.rows.find(r => r.locale === 'en').stale = true;
    receive({type:'state',session:'family',sequence:0,generation:0,key:draft.key,root,locale:'ru',rows:draft.rows,notice:'Ready',busy:false,saving:false,preview:null,
        ai:{open:true,running:false,error:'',review:null,proposals:[]}});
    const uzRow = draft.rows.find(r => r.locale === 'uz'); assert.equal(nodes.get('value-'+uzRow.id).readOnly, true);
    assert.match(nodes.get('help-'+uzRow.id).textContent, /Нет NLS-файла/);
    assert.ok(!nodes.has('ai-target-'+uzRow.id)); assert.ok(!nodes.has('ai-target-'+draft.rows.find(r => r.locale === 'en').id));
});

test('resource summary names real sets with full paths in details and sole selected source opens directly without select', () => {
    const {nodes, receive, sent} = webviewHarness();
    const draft = createDraft({root, resources:[model(xml('Source'),ru), model(xml('English'),en)]}, 'Workspace.title', 'ru');
    const base={type:'state',session:'sources',sequence:0,generation:0,key:draft.key,root,locale:'ru',resourceSets:draft.resourceSets,rows:draft.rows,notice:'Ready',busy:false,saving:false,preview:null};
    receive(base);
    assert.equal(nodes.get('resource-summary').textContent, 'Ресурсы: app · EN, RU');
    assert.match(nodes.get('resource-paths').textContent, /app_ru.nls/);
    assert.equal(nodes.get('target-0').hidden, true); assert.equal(nodes.get('source-0').hidden, true);
    const link=nodes.get('direct-source-0').children[0]; assert.equal(link.textContent, 'Открыть файл'); assert.match(link.title, /app_ru.nls/);
    link.click(); assert.equal(sent.at(-1).type, 'openSource'); assert.equal(sent.at(-1).option, 0);
    receive({...base,sequence:1,resourceSets:[...draft.resourceSets,{label:'other',path:'other',locales:['ru']}],rows:draft.rows.map(r=>r.id===0?{...r,target:null}:r)});
    assert.equal(nodes.get('resource-summary').textContent, 'Наборов ресурсов: 2 · EN, RU');
    assert.equal(nodes.get('target-0').hidden, false); assert.equal(nodes.get('source-0').open, true); assert.equal(nodes.get('direct-source-0').hidden, true);
});

test('no-file locale is static while saved text stays copyable and source-unavailable remains a different state', () => {
    const {nodes,receive}=webviewHarness();
    const draft=createDraft({root,resources:[model(xml('Source'),ru)]},'Workspace.title','ru',['uz']);
    const row=draft.rows.find(r=>r.locale==='uz');
    const base={type:'state',session:'no-file',sequence:0,generation:0,key:draft.key,root,locale:'ru',resourceSets:draft.resourceSets,rows:draft.rows,notice:'Ready',busy:false,saving:false,preview:null};receive(base);
    assert.equal(nodes.get('value-'+row.id).hidden,true); assert.equal(nodes.get('no-resource-'+row.id).hidden,false);
    assert.match(nodes.get('no-resource-'+row.id).textContent,/Нет NLS-файла/); assert.equal(nodes.get('warning-'+row.id).hidden,true);
    receive({...base,rows:draft.rows.map(r=>r.id===row.id?{...r,edited:true,stale:true,value:'Recovered'}:r)});
    const field=nodes.get('value-'+row.id); assert.equal(field.hidden,false); assert.equal(field.readOnly,true); assert.equal(field.value,'Recovered');
    assert.match(nodes.get('no-resource-'+row.id).textContent,/копирования/); assert.equal(nodes.get('recover-'+row.id).hidden,false);
    receive({...base,rows:draft.rows.map(r=>r.id===row.id?{...r,status:'unavailable'}:r)});
    assert.equal(field.hidden,false); assert.equal(field.disabled,true); assert.equal(nodes.get('no-resource-'+row.id).hidden,true);
    assert.equal(nodes.get('warning-'+row.id).textContent,'Ресурс недоступен');
});

test('proposal comparison updates actual manual text immediately, preserves focus and keeps proposal escaped', () => {
    const {nodes,receive,doc}=webviewHarness();
    const row={id:0,locale:'en',value:'Original',status:'found',target:0,options:[{id:0,label:'source',value:'Original'}],edited:false,revision:0};
    const base={type:'state',session:'compare',sequence:0,generation:0,key:'K',root,locale:'en',rows:[row],notice:'Ready',busy:false,saving:false,preview:null,
        ai:{open:false,running:false,error:'',review:null,proposals:[{row:0,value:'<script>AI</script>',token:'p',revision:0,reason:''}]}};
    receive(base);assert.equal(nodes.get('proposal-current-0').textContent,'Original');assert.equal(nodes.get('proposal-value-0').textContent,'<script>AI</script>');
    const field=nodes.get('value-0');field.focus();field.value='Typed before ack';field.handlers.get('input')();
    assert.equal(nodes.get('proposal-current-0').textContent,'Typed before ack');assert.equal(doc.activeElement,field);assert.equal(nodes.get('proposal-accept').disabled,true);
    receive({...base,sequence:1,rows:[{...row,value:field.value,edited:true,revision:1}],ai:{...base.ai,proposals:[{...base.ai.proposals[0],reason:'Поле изменилось'}]}});
    assert.equal(nodes.get('proposal-current-0').textContent,'Typed before ack');assert.equal(nodes.get('proposal-choice-0').disabled,true);
    assert.equal(doc.activeElement,field);assert.match(renderI18nView('theme'),/\.proposal-comparison.*grid/);
    field.value='Long\ntranslation';field.handlers.get('input')();assert.match(nodes.get('proposal-current-0').className || nodes.get('proposal-0').children[1].className,/stacked/);
});

test('UI recovery is conditional and emits bounded host actions, not user-controlled commands or setting IDs', () => {
    const {nodes,receive,sent}=webviewHarness();
    const base={type:'state',session:'recover',sequence:0,generation:0,key:'K',root,locale:'ru',rows:[],notice:'Ready',busy:false,saving:false,preview:null,
        ai:{open:true,running:false,error:'Model missing',recovery:{type:'settings',setting:'model'},review:null,proposals:[]}};
    receive(base);assert.equal(nodes.get('ai-recover').hidden,false);assert.equal(nodes.get('ai-recover').textContent,'Открыть настройки');nodes.get('ai-recover').click();
    assert.equal(sent.at(-1).type,'aiRecover'); assert.equal(sent.at(-1).setting,undefined);assert.equal(sent.at(-1).command,undefined);
    receive({...base,sequence:1,error:'Source changed',errorRecovery:'reload',ai:{...base.ai,open:false,error:'',recovery:null}});
    assert.equal(nodes.get('ai-recover').hidden,true);assert.equal(nodes.get('error-reload').hidden,false);nodes.get('error-reload').click();assert.equal(sent.at(-1).type,'reload');
});

test('stale recovery reload cancellation preserves changed draft and performs no Apply', async t => {
    const {env,panel}=await setup(t);
    let s=await action(panel,'edit',{...choose(state(panel),'ru'),value:'Do not lose'});await action(panel,'preview');
    const resource=env.vscode.workspace.textDocuments.find(d=>d.uri.fsPath===ru);
    Object.assign(resource,document(ru,xml('Changed externally')));await env.change(resource);
    s=await action(panel,'apply');assert.equal(s.errorRecovery,'reload');assert.equal(env.appliedEdits.length,0);
    s=await action(panel,'reload'); // Mock default dismisses modal.
    assert.equal(s.rows.find(r=>r.locale==='ru').value,'Do not lose');assert.equal(env.appliedEdits.length,0);
    assert.ok(env.messages.some(m=>m.message.includes('Отменить изменения')));
});

test('draft acknowledgement is not file saving and review describes distinct file count', async t => {
    const {env,panel}=await setup(t);
    const s=await action(panel,'edit',{...choose(state(panel),'ru'),value:'New'});
    assert.match(s.notice,/Черновик сохранён/);assert.match(s.notice,/Правки ещё не применены/);assert.equal(env.appliedEdits.length,0);
    const html=renderI18nView('labels');assert.match(html,/>Проверить изменения…<\/button>/);assert.match(html,/>Применить в файлы<\/button>/);
    assert.match(html,/не сохранятся на диск автоматически/);
});

test('Back focuses an available field, not hidden active locale without a resource', () => {
    const {nodes,receive,doc}=webviewHarness();
    const draft=createDraft({root,resources:[model(xml('Source'),ru)]},'Workspace.title','uz');
    const base={type:'state',session:'focus-empty',sequence:0,generation:0,key:draft.key,root,locale:'uz',rows:draft.rows,notice:'Ready',busy:false,saving:false,preview:null};receive(base);
    receive({...base,preview:[{locale:'ru',path:'app_ru.nls',before:'Source',after:'New'}]});
    receive(base);assert.equal(doc.activeElement,nodes.get('value-'+draft.rows.find(r=>r.locale==='ru').id));
});

test('existing sibling without key explains insertion, not resource creation or missing file', () => {
    const {nodes,receive}=webviewHarness();
    const draft=createDraft({root,resources:[model(xml('Source'),ru),model(xml('Other','Other'),en)]},'Workspace.title','ru');
    const row=draft.rows.find(r=>r.locale==='en');
    receive({type:'state',session:'insertion',sequence:0,generation:0,key:draft.key,root,locale:'ru',resourceSets:draft.resourceSets,rows:draft.rows,notice:'Ready',busy:false,saving:false,preview:null});
    assert.equal(nodes.get('value-'+row.id).hidden,false);assert.equal(nodes.get('no-resource-'+row.id).hidden,true);
    assert.match(nodes.get('help-'+row.id).textContent,/будет добавлен в существующий файл/);
    assert.equal(nodes.get('help-'+row.id).hidden,false);assert.equal(nodes.get('target-'+row.id).hidden,true);
});

const { EMPTY_RESOURCE, languageCode, familiesFor, creationPlan, attachCreatedResource } = require('../i18nResources');
const requestLanguage = locale => entries => entries.find(entry => entry.locale === locale);

test('new language planning shares locale/family grammar and preserves Java XML scaffold without keys', () => {
    assert.equal(languageCode(' pt_BR '), 'pt-br'); assert.equal(languageCode('es-419'), 'es-419');
    for (const value of ['../uz','en/US','uz.nls','en-US-extra','zh-Hant','',null,{},'123']) assert.equal(languageCode(value), null);
    const snapshot = {root, resources:[model(xml('Документы')),model(xml('Documents'),en)]};
    assert.deepEqual(familiesFor(snapshot,'Workspace.title'),[root+'/app']);
    assert.equal(creationPlan(snapshot,'Workspace.title',root+'/app','pt_BR').filePath,root+'/app_pt-br.nls');
    assert.throws(()=>creationPlan(snapshot,'Workspace.title',root+'/unrelated','uz'),/Набор/);
    const parsed = parseNls(EMPTY_RESOURCE,uz); assert.equal(parsed.issues.length,0); assert.equal(parsed.entries.length,0);
    assert.match(EMPTY_RESOURCE,/DOCTYPE properties/); assert.ok(!EMPTY_RESOURCE.includes('entry'));
});

test('add language is an explicit native create, shared discovery makes clean no-file locale available without saving translations', async t => {
    const {env,panel}=await setup(t, {}, {configuration:{'i18n.locale':'kk'}, quickPickResponses:[requestLanguage('kk')], warningResponses:['Создать файл']});
    const before=state(panel); assert.equal(before.canAddLanguage,true);
    await action(panel,'edit',{...choose(before,'ru'),value:'Мой черновик'});
    const old=state(panel).rows.find(r=>r.locale==='ru');
    const s=await action(panel,'addLanguage',{filePath:'/outside/evil.nls',locale:'../../evil',family:'/outside'});
    assert.equal(s.error,''); assert.equal(s.generation,before.generation);
    const file=root+'/app_kk.nls', row=s.rows.find(r=>r.locale==='kk');
    assert.equal(row.options.length,1); assert.equal(row.target,0); assert.equal(row.status,'missing');
    assert.equal(row.edited,false); assert.equal(row.value,'');
    assert.deepEqual(s.rows.find(r=>r.locale==='ru'),old); assert.equal(env.contents.get(ru),xml('Документы'));
    assert.equal(env.contents.get(file),''); // Native resource exists, XML is an unsaved text edit.
    const opened=env.vscode.workspace.textDocuments.find(d=>d.uri.fsPath===file);
    assert.equal(opened.getText(),EMPTY_RESOURCE); assert.equal(opened.isDirty,true);
    assert.equal(env.appliedEdits.length,1); assert.equal(env.appliedEdits[0].creates[0].options.overwrite,false);
    assert.equal(env.appliedEdits[0].creates[0].options.ignoreIfExists,false);
    assert.match(env.messages.find(m=>m.type==='warning').actions[0].detail,/app_kk.nls/);
    assert.match(s.notice,/Save/); assert.ok(!env.contents.has('/outside/evil.nls'));
    assert.ok(!env.requiredModules.some(m=>/^(http|https|net|tls)$/.test(m)));
    await action(panel,'edit',{row:row.id,target:row.target,value:'Жаңа'});
    const preview=await action(panel,'preview'); assert.equal(preview.preview.length,2);
    await action(panel,'apply');
    assert.equal(parseNls(opened.getText(),file).entries[0].value,'Жаңа');
    assert.equal(env.contents.get(file),''); // Apply remains buffer-only.
});

test('language picker cancellation and confirmation cancellation leave resources and drafts unchanged', async t => {
    for (const confirmed of [false,true]) {
        const {env,panel}=await setup(t, {}, {quickPickResponses:confirmed?[requestLanguage('kk')]:[]});
        const before=state(panel); const s=await action(panel,'addLanguage');
        assert.equal(s.error,''); assert.deepEqual(s.rows,before.rows); assert.equal(s.generation,before.generation);
        assert.equal(env.appliedEdits.length,0); assert.ok(!env.contents.has(root+'/app_kk.nls'));
    }
});

test('ambiguous family is explicitly selected and custom regional locale is normalized', async t => {
    const other=root+'/module/other_ru.nls';
    const {env,panel}=await setup(t,{[other]:xml('Иное')},{quickPickResponses:[entries=>entries.find(e=>e.family===root+'/module/other'),entries=>entries.find(e=>e.label==='Другой язык…')],inputResponses:['pt_BR'],warningResponses:['Создать файл']});
    const s=await action(panel,'addLanguage'); assert.equal(s.error,'');
    assert.ok(env.contents.has(root+'/module/other_pt-br.nls')); assert.ok(!env.contents.has(root+'/app_pt-br.nls'));
    assert.equal(env.quickPicks[0].config.title,'Добавить язык · Набор ресурсов');
    assert.match(env.prompts[0].validateInput('../oops'),/код языка/);
    assert.equal(env.prompts[0].validateInput('pt_BR'),undefined);
});

test('case/region collisions, malformed files and open buffer collisions never overwrite', async t => {
    for (const file of [root+'/APP_KK.NLS',root+'/app_pt_BR.nls']) {
        const language=file.includes('pt_')?'pt-br':'kk';
        const {env,panel}=await setup(t,{[file]:'malformed untouched'},{quickPickResponses:[language==='kk'?requestLanguage('kk'):entries=>entries.find(e=>e.label==='Другой язык…')],inputResponses:['pt-BR'],warningResponses:['Создать файл']});
        const s=await action(panel,'addLanguage'); assert.match(s.error,/уже существует/);
        assert.equal(env.contents.get(file),'malformed untouched'); assert.equal(env.appliedEdits.length,0);
    }
    const {env,panel}=await setup(t,{}, {quickPickResponses:[requestLanguage('kk')],warningResponses:['Создать файл']});
    env.vscode.workspace.textDocuments.push(document(root+'/app_kk.nls',EMPTY_RESOURCE));
    const s=await action(panel,'addLanguage'); assert.match(s.error,/уже существует/); assert.equal(env.appliedEdits.length,0);
});

test('new resource guards reject trust, excluded destinations, symlink directories, stale source and changed workspace', async t => {
    for (const reason of ['trust','exclude','symlink','hash','folders','close']) {
        const options={quickPickResponses:[requestLanguage('kk')],warningResponses:['Создать файл']};
        if(reason==='exclude') options.configuration={'index.exclude':['**/*_kk.nls']};
        if(reason==='symlink') {options.realPaths={[root+'/linked']:'/elsewhere'};options.quickPickResponses=[entries=>entries.find(e=>e.family===root+'/linked/app'),requestLanguage('kk')];}
        const {env,panel}=await setup(t,reason==='symlink'?{[root+'/linked/app_ru.nls']:xml('Linked')}: {},options);
        const original=env.vscode.window.showWarningMessage;
        env.vscode.window.showWarningMessage=async (...args)=>{
            const consent=await original(...args);
            if(reason==='trust') env.vscode.workspace.isTrusted=false;
            if(reason==='hash') {env.contents.set(ru,xml('Changed'));await env.fileEvent('change',ru);}
            if(reason==='folders') {env.vscode.workspace.workspaceFolders.splice(0);env.foldersChanged();}
            if(reason==='close') panel.dispose();
            return consent;
        };
        const s=await action(panel,'addLanguage');
        if(reason!=='close') assert.ok(s.error,reason);
        assert.equal(env.appliedEdits.length,0,reason); assert.ok(!env.contents.has(root+'/app_kk.nls'),reason);
    }
});

test('late exact-path collision/native partial failure is reported without deletion, retry or overwrite', async t => {
    for (const partial of [false,true]) {
        const {env,panel}=await setup(t,{}, {quickPickResponses:[requestLanguage('kk')],warningResponses:['Создать файл']});
        env.vscode.workspace.applyEdit=async edit=>{ assert.equal(edit.creates.length,1); env.contents.set(root+'/app_kk.nls',partial?'':'external file');return false; };
        const s=await action(panel,'addLanguage'); assert.match(s.error,/частично или уже существовать/);
        assert.equal(env.contents.get(root+'/app_kk.nls'),partial?'':'external file'); assert.equal(s.rows.length,3);
        assert.equal(env.appliedEdits.length,0);
    }
});

test('creation merge keeps null/stale recovered values and old source hashes, revisions and IDs', () => {
    const initial={root,resources:[model(xml('Документы')),model(xml('Documents'),en)]};
    const draft=createDraft(initial,'Workspace.title','ru',['kk']);
    const row=draft.rows.find(r=>r.locale==='kk'); row.value='Recovered';row.ai=true;row.edited=true;row.stale=true;row.revision=12;
    const fresh={root,resources:[...initial.resources,model(EMPTY_RESOURCE,root+'/app_kk.nls')]};
    const next=createDraft(fresh,'Workspace.title','ru',['kk']);
    const plan=creationPlan(initial,'Workspace.title',root+'/app','kk');
    const oldEnglish=draft.rows.find(r=>r.locale==='en');
    attachCreatedResource(draft,next,plan);
    assert.equal(row.value,'Recovered'); assert.equal(row.ai,true);assert.equal(row.target,null);assert.equal(row.stale,true);assert.equal(row.revision,12);
    assert.equal(draft.rows.find(r=>r.locale==='en'),oldEnglish);
    // Adding another source to an already edited locale must not rebase hashes.
    const additional= root+'/other_kk.nls';
    const anchored={root,resources:[...fresh.resources,model(xml('Other'),root+'/other_ru.nls'),model(xml('old'),additional)]};
    const current=createDraft(anchored,'Workspace.title','ru'); const kk=current.rows.find(r=>r.locale==='kk');
    const selected=kk.options.find(o=>o.filePath===additional);updateRow(current,kk.id,'Manual',selected.id);
    const changed={root,resources:anchored.resources.map(r=>r.filePath===additional?model(xml('new'),additional):r)};
    attachCreatedResource(current,createDraft(changed,'Workspace.title','ru'),plan);
    assert.equal(kk.stale,true);assert.equal(kk.value,'Manual');assert.equal(kk.options.find(o=>o.filePath===additional).hash,selected.hash);
});

test('adding a row is understated and incremental: DOM focus, inputs, proposal selection and disclosure survive', () => {
    const {nodes,sent,doc,receive}=webviewHarness();
    const draft=createDraft({root,resources:[model(xml('Документы')),model(xml('Documents'),en)]},'Workspace.title','ru');
    const base={type:'state',session:'s',sequence:0,generation:0,key:draft.key,root,locale:'ru',rows:draft.rows,resourceSets:draft.resourceSets,canAddLanguage:true,busy:false,saving:false,error:'',notice:'',preview:null,ai:{open:false,running:false,proposals:[{row:1,value:'Proposal',token:'t',revision:0,reason:''}]}};
    receive(base); assert.equal(nodes.get('add-language').hidden,false);
    const html=renderI18nView('safe');assert.match(html,/<details id="details">[\s\S]*id="add-language"[\s\S]*<\/details>/);
    assert.equal(nodes.get('details').open,false);nodes.get('details').open=true;
    const input=nodes.get('value-0');input.focus(); const checkbox=nodes.get('proposal-choice-1');checkbox.checked=false;
    const extra=createDraft({root,resources:[model(xml('Документы')),model(xml('Documents'),en),model(EMPTY_RESOURCE,root+'/app_kk.nls')]},draft.key,'ru',['kk']).rows.find(r=>r.locale==='kk');
    extra.id=2;receive({...base,rows:[...draft.rows,extra]});
    assert.equal(nodes.get('value-0'),input);assert.equal(doc.activeElement,input);assert.equal(nodes.get('proposal-choice-1'),checkbox);assert.equal(checkbox.checked,false);
    assert.equal(nodes.get('details').open,true);assert.ok(nodes.get('value-2'));
    nodes.get('add-language').click();assert.equal(sent.at(-1).type,'addLanguage');assert.equal(sent.at(-1).filePath,undefined);
    receive({...base,sequence:1,busy:true});assert.equal(nodes.get('add-language').disabled,true);
    receive({...base,sequence:1,canAddLanguage:false});assert.equal(nodes.get('add-language').hidden,true);
});

test('new language is eligible for AI preparation only after shared native buffer discovery, no network', async t => {
    const {env,panel}=await setup(t,{}, {configuration:{'i18n.ai.baseUrl':'https://translation.example/v1','i18n.ai.model':'test-model'},quickPickResponses:[requestLanguage('kk')],warningResponses:['Создать файл']});
    await action(panel,'aiOpen');let s=await action(panel,'aiPrepare',{text:'Документы',sourceLocale:'ru',targets:['kk']});
    assert.equal(s.ai.review,null);assert.ok(s.ai.error);
    await action(panel,'aiClose');await action(panel,'addLanguage');
    await action(panel,'aiOpen');s=await action(panel,'aiPrepare',{text:'Документы',sourceLocale:'ru',targets:['kk']});
    assert.equal(s.ai.error,'');assert.ok(s.ai.review);assert.deepEqual(s.ai.review.data.targetLocales,['kk']);
    assert.ok(!env.requiredModules.some(m=>/^(http|https|net|tls)$/.test(m)));
});

test('creation acknowledgement preserves real host AI proposals and acceptance Undo', async t => {
    const { EventEmitter } = require('node:events');
    const ai = require('../i18nAi'); let reply;
    const request=(url,options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{};
        reply=()=>{const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};callback(res);
            res.emit('data',Buffer.from(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({translations:{en:'AI docs'}})}}]})));res.emit('end');};return req;};
    const {env,panel}=await setup(t,{}, {configuration:{'i18n.ai.baseUrl':'https://translation.example/v1','i18n.ai.model':'test-model'},
        secrets:new Map([[ai.secretId('https://translation.example/v1/chat/completions'),'fixture-key']]),aiRequest:request,
        quickPickResponses:[requestLanguage('kk')],warningResponses:['Создать файл']});
    await action(panel,'aiOpen');let s=await action(panel,'aiPrepare',{text:'Документы',sourceLocale:'ru',targets:['en']});
    await action(panel,'aiSend',{token:s.ai.review.token});reply();
    for(let i=0;i<30 && state(panel).ai.running;i++) await new Promise(setImmediate);
    s=state(panel);assert.equal(s.ai.proposals.length,1);
    const proposals=s.ai.proposals;
    await action(panel,'addLanguage');assert.deepEqual(state(panel).ai.proposals,proposals);
    await action(panel,'aiAcceptSelected',{items:proposals});assert.equal(state(panel).ai.undo,true);
    // Add another language; the previously accepted fields remain undoable.
    env.quickPickResponses.push(requestLanguage('de'));
    env.vscode.window.showWarningMessage=async()=> 'Создать файл';
    await action(panel,'addLanguage');assert.equal(state(panel).ai.undo,true);
    s=await action(panel,'aiUndoAccept');assert.equal(s.rows.find(r=>r.locale==='en').value,'Documents');
    assert.equal(s.ai.proposals.length,1);assert.equal(env.appliedEdits.length,2);
});

test('duplicate creation clicks during native consent are acknowledged without starting a second picker', async t => {
    const {env,panel}=await setup(t,{}, {quickPickResponses:[requestLanguage('kk')]});
    let consent, opened;
    const waiting=new Promise(resolve=>{opened=resolve;});
    env.vscode.window.showWarningMessage=()=>{opened();return new Promise(resolve=>{consent=resolve;});};
    const s=state(panel), first=panel.receiveMessage({type:'addLanguage',session:s.session,sequence:s.sequence+1});
    await waiting;
    const duplicate=panel.receiveMessage({type:'addLanguage',session:s.session,sequence:s.sequence+2});
    consent('Создать файл');await first;await duplicate;
    assert.equal(env.quickPicks.length,1);assert.equal(env.appliedEdits.length,1);
    assert.equal(state(panel).sequence,s.sequence+2);
});

test('existing no-file DOM row gains native source choices without rebuilding the field', () => {
    const {nodes,receive}=webviewHarness();
    const draft=createDraft({root,resources:[model(xml('Документы'))]},'Workspace.title','ru',['kk']);
    const base={type:'state',session:'s',sequence:0,generation:0,key:draft.key,root,locale:'ru',rows:draft.rows,busy:false,saving:false,error:'',notice:'',preview:null};
    receive(base);const field=nodes.get('value-1');assert.equal(nodes.get('target-1').children.length,1);
    const newDraft=createDraft({root,resources:[model(xml('Документы')),model(EMPTY_RESOURCE,root+'/app_kk.nls')]},draft.key,'ru',['kk']);
    receive({...base,rows:newDraft.rows});
    assert.equal(nodes.get('value-1'),field);assert.equal(field.hidden,false);
    assert.equal(nodes.get('target-1').children.length,2);assert.equal(nodes.get('target-1').value,'0');
    assert.equal(nodes.get('direct-source-1').children.length,1);
});

test('post-create indexing/storage errors keep the created file and acknowledged draft, with honest status', async t => {
    for(const reason of ['index','storage']) {
        const {env,panel}=await setup(t,{}, {quickPickResponses:[requestLanguage('kk')],warningResponses:['Создать файл']});
        await action(panel,'edit',{...choose(state(panel),'ru'),value:'Mine'});
        if(reason==='index') {const find=env.vscode.workspace.findFiles;env.vscode.workspace.findFiles=async(...args)=>(await find(...args)).filter(file=>file.fsPath!==root+'/app_kk.nls');}
        else env.storageControl.fail=true;
        const s=await action(panel,'addLanguage');
        assert.ok(env.contents.has(root+'/app_kk.nls'));assert.equal(env.appliedEdits.length,1);
        assert.equal(s.rows.find(r=>r.locale==='ru').value,'Mine');assert.equal(s.rows.find(r=>r.locale==='ru').edited,true);
        assert.match(s.error,reason==='index'?/Файл создан/:/Не удалось сохранить/);
        if(reason==='storage') assert.match(s.notice,/НЕ сохранён/);
    }
});

test('no-anchor and untrusted contexts do not expose or execute resource creation', async t => {
    const {env,panel}=await setup(t,{[ru]:xml('Other','Other'),[en]:xml('Other','Other')});
    assert.equal(state(panel).canAddLanguage,false);const s=await action(panel,'addLanguage');assert.match(s.error,/не определён/);
    assert.equal(env.quickPicks.length,0);assert.equal(env.appliedEdits.length,0);
    const second=await setup(t);second.env.vscode.workspace.isTrusted=false;
    const locked=await action(second.panel,'addLanguage');assert.equal(locked.canAddLanguage,false);assert.match(locked.error,/доверенный/);
    assert.equal(second.env.quickPicks.length,0);assert.equal(second.env.appliedEdits.length,0);
});

test('rename remains secondary, explains blockers, shows file/line preview and uses theme-aware safe DOM', () => {
    const {nodes,sent,receive,doc}=webviewHarness();
    const draft=createDraft({root,resources:[model(xml('Документы')),model(xml('Documents'),en)]},'Workspace.title','ru');
    const base={type:'state',session:'s',sequence:0,generation:0,key:draft.key,root,locale:'ru',rows:draft.rows,resourceSets:draft.resourceSets,canRename:true,renameBlocked:'',busy:false,saving:false,error:'',notice:'',preview:null};
    receive(base);assert.equal(nodes.get('rename-key').hidden,false);assert.equal(nodes.get('details').open,false);
    const html=renderI18nView('safe');assert.match(html,/<details id="details">[\s\S]*id="rename-key"[\s\S]*<\/details>/);
    nodes.get('rename-key').click();assert.equal(sent.at(-1).type,'rename');assert.equal(sent.at(-1).to,undefined);
    receive({...base,sequence:1,renameBlocked:'Сначала примените черновик'});assert.equal(nodes.get('rename-key').disabled,true);assert.match(nodes.get('rename-key').title,/черновик/);
    const preview=[{kind:'BL',path:'Example.bl',count:2,lines:[1,3],before:'Workspace.title',after:'Workspace.heading'},
        {kind:'NLS',locale:'ru',path:'<img onerror=alert(1)>_ru.nls',count:1,lines:[2],before:'Workspace.title',after:'Workspace.heading'}];
    receive({...base,sequence:1,previewKind:'rename',renameTo:'Workspace.heading',preview});
    assert.equal(nodes.get('rename-key').hidden,true);assert.equal(nodes.get('add-language').hidden,true);
    assert.equal(nodes.get('review-title').textContent,'Переименовать ключ?');assert.equal(nodes.get('apply').textContent,'Переименовать в файлах');
    assert.match(nodes.get('review-summary').textContent,/Workspace.title → Workspace.heading/);assert.match(nodes.get('review-summary').textContent,/Файлов: 2 · Замен: 3/);
    assert.equal(nodes.get('rename-scope').hidden,false);assert.equal(doc.activeElement,nodes.get('apply'));
    assert.equal(nodes.get('changes').children[1].children[1].textContent,'<img onerror=alert(1)>_ru.nls');
    assert.equal(nodes.get('changes').children[0].children[2].textContent,'Строки: 1, 3');
    receive({...base,sequence:1});assert.equal(nodes.get('rename-scope').hidden,true);assert.equal(nodes.get('review-title').textContent,'Применить переводы?');
});
