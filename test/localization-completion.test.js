const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { completionContext, completionCandidates, MAX_ITEMS } = require('../localizationCompletion');
const { localizationLiterals } = require('../localizationPresentation');
const { parseNls, resolveTranslation } = require('../localizationModel');
const { createLocalization } = require('../localization');
const { document, extension } = require('./helpers');
const root='/work/app', bl=root+'/Example.bl', ru=root+'/app_ru.nls', en=root+'/app_en.nls';
const xml=(value='Документы',key='Workspace.title')=>`<properties><entry key="${key}">${value}</entry></properties>`;
const model=(text,file=ru)=>({...parseNls(text,file),filePath:file,text});
const replace=(text,item,doc)=>text.slice(0,doc.offsetAt(item.range.start))+item.insertText+text.slice(doc.offsetAt(item.range.end));
async function setup(t,text='class Example { string title = "$Workspace.t$"; }',extra={},options={}) {
    const doc=document(bl,text);
    const env=await extension({[bl]:text,[ru]:xml(),[en]:xml('Documents'),...extra},[doc],{workspaceFolders:['/work'],checkoutRoots:[root],...options});
    t.after(()=>env.dispose());return {env,doc};
}
const items=list=>list.items || list;
async function suggestions(env,doc,offset,token={}) { return env.providers.completion.provideCompletionItems(doc,doc.positionAt(offset),token); }

test('shared scanner yields exact single-line contexts for key prefix, empty dollars and incomplete quotes', () => {
    for(const [input,expected] of [
        ['"$Workspace.t|$"','"$Workspace.title$"'],
        ['"$Workspace.t|"','"$Workspace.title$"'],
        ['"$Workspace.t|','"$Workspace.title$"'],
        ['"$Workspace.t|$','"$Workspace.title$"'],
        ['"$|"','"$Workspace.title$"'],
        ['"$|','"$Workspace.title$"'],
        ['"$|$"','"$Workspace.title$"'],
        ['"$Workspace.|old.tail$"','"$Workspace.title$"'],
        ['// previous\r\nstring title = "$Workspace.t|$";','// previous\r\nstring title = "$Workspace.title$";'],
        ['string title = "$Workspace.t|\r\nstring next = "untouched";', 'string title = "$Workspace.title$"\r\nstring next = "untouched";']
    ]) {
        const offset=input.indexOf('|'),text=input.replace('|',''),context=completionContext(text,offset);
        assert.ok(context,input);assert.ok(context.start<=offset&&offset<=context.end);
        assert.ok(!text.slice(context.start,context.end).includes('\n'));
        const result=text.slice(0,context.start)+'Workspace.title$'+(context.closeQuote?'"':'')+text.slice(context.end);
        assert.equal(result,expected,input);
        assert.equal(localizationLiterals(result).filter(item=>item.key==='Workspace.title').length,1);
    }
});

test('completion context never guesses comments, ordinary/single-quoted/escaped strings, invalid keys or dollar suffix positions', () => {
    for(const input of [
        '// "$Workspace.t|$"','/* "$Workspace.t|$" */','/* unclosed "$Workspace.t|',
        '"prefix $Workspace.t|$"',"'$Workspace.t|$'",'"\\$Workspace.t|$"','"$Workspace\\.t|$"',
        '"$Workspace.t| extra"','"$123|"','"$Workspace.t$|"','"$Workspace.title$"|',
        '"|$Workspace.t$"','"$Work\nspace.t|$"','Workspace.t|', '"$Workspace.t|;']) {
        const offset=input.indexOf('|');assert.equal(completionContext(input.replace('|',''),offset),null,input);
    }
    for(const offset of [-1,100,1.5,NaN])assert.equal(completionContext('"$"',offset),null);
});

test('one result per valid key, exact shared resolver semantics for empty/missing/conflict/unavailable and all source evidence', () => {
    const resources=[model(xml()),model(xml('Документы'),root+'/duplicate_ru.nls'),model(xml('Documents'),en),
        model(xml('Different','Workspace.conflict')),model(xml('Other','Workspace.conflict'),root+'/other_ru.nls'),
        model(xml('','Workspace.empty')),model(xml('English only','Workspace.english'),en),
        model(xml('Bad','not insertable key'))];
    const state={root,resources},results=completionCandidates(state,'workspace.','ru');
    assert.equal(results.isIncomplete,false);assert.equal(results.items.length,4);
    assert.equal(results.items.find(r=>r.key==='Workspace.title').result.sources.length,2);
    for(const row of results.items)assert.deepEqual(row.result,resolveTranslation(resources,row.key,'ru'));
    assert.equal(results.items.find(r=>r.key==='Workspace.english').result.status,'missing');
    assert.equal(results.items.find(r=>r.key==='Workspace.empty').result.value,'');
    assert.equal(results.items.find(r=>r.key==='Workspace.conflict').result.status,'conflict');
    resources.push(model('<properties>',root+'/broken_ru.nls'));
    for(const row of completionCandidates(state,'Workspace.','ru').items) {
        assert.equal(row.result.status,'unavailable');assert.deepEqual(row.result,resolveTranslation(resources,row.key,'ru'));
    }
    assert.equal(completionCandidates(state,'Workspace.','en').items.find(r=>r.key==='Workspace.title').result.status,'found');
});

test('large key corpus is capped with incomplete continuation and avoids all-corpus resolver scan for every key', () => {
    const entries=Array.from({length:10000},(_,i)=>({key:'Key.'+String(i).padStart(5,'0'),value:'Value',locale:'ru',filePath:ru,start:i}));
    const state={root,resources:[{entries,issues:[],filePath:ru,locale:'ru'}]},start=performance.now();
    const result=completionCandidates(state,'Key.','ru');
    assert.equal(result.items.length,MAX_ITEMS);assert.equal(result.isIncomplete,true);
    assert.ok(performance.now()-start<1000,'10k source keys should not cause a quadratic scan');
    const narrowed=completionCandidates(state,'Key.0999','ru');assert.equal(narrowed.items.length,10);assert.equal(narrowed.isIncomplete,false);
    assert.ok(result.items.every(r=>r.result.status==='found'));
});

test('only one BL/file completion provider, shared preview/provenance and key-only native replacement without commands or side effects', async t => {
    const {env,doc}=await setup(t),offset=doc.getText().indexOf('Workspace.t')+'Workspace.t'.length;
    const registrations=env.providerRegistrations.filter(r=>r.selector.language==='bl');assert.equal(registrations.length,1);
    assert.equal(registrations[0].selector.scheme,'file');assert.deepEqual(Array.from(registrations[0].triggers),['$','.']);
    assert.ok(env.providers.jsCompletion);
    const list=await suggestions(env,doc,offset);assert.equal(list.isIncomplete,false);
    const item=list.items.find(r=>r.label==='Workspace.title');assert.ok(item);
    assert.match(item.detail,/ru.*Документы.*app_ru.nls/);assert.match(item.documentation.value,/Источник/);
    assert.equal(item.documentation.isTrusted,false);assert.equal(item.insertText,'Workspace.title$');assert.equal(item.filterText,'Workspace.title$');
    assert.equal(item.command,undefined);assert.equal(item.additionalTextEdits,undefined);
    assert.equal(item.range.start.line,item.range.end.line);
    assert.equal(replace(doc.getText(),item,doc),'class Example { string title = "$Workspace.title$"; }');
    assert.equal(env.appliedEdits.length,0);assert.equal(env.contents.get(bl),doc.getText());assert.equal(env.clipboard.length,0);assert.equal(env.panels.length,0);
    assert.ok(!env.requiredModules.some(m=>/^(http|https|net|tls)$/.test(m)));
});

test('provider retains trailing code and CRLF, replaces existing suffix, and completes missing dollars/quotes without snippets', async t => {
    for(const marked of ['string title = "$Workspace.|old$"; other();','// 📄\r\nstring title = "$Workspace.t|"; other();','string title = "$Workspace.t|\r\nother();','string title = "$|$";']) {
        const offset=marked.indexOf('|'),text=marked.replace('|',''),{env,doc}=await setup(t,text);
        const item=items(await suggestions(env,doc,offset)).find(r=>r.label==='Workspace.title');assert.ok(item,marked);
        const result=replace(text,item,doc);assert.equal(localizationLiterals(result)[0].source,'"$Workspace.title$"');
        assert.ok(result.endsWith(text.includes('other();')?'other();':'";'));
        if(text.includes('\r\n'))assert.equal((result.match(/\r\n/g)||[]).length,(text.match(/\r\n/g)||[]).length);
    }
});

test('locale switching is independent from display mode; missing/conflict/broken preview never falls back', async t => {
    const {env,doc}=await setup(t),offset=doc.getText().indexOf('Workspace.t')+11;
    await env.configure({'i18n.displayMode':'keys','i18n.locale':'en'});
    let item=items(await suggestions(env,doc,offset))[0];assert.match(item.detail,/en.*Documents/);
    await env.configure({'i18n.locale':'uz'});item=items(await suggestions(env,doc,offset))[0];assert.match(item.detail,/uz.*Нет перевода/);
    assert.ok(!item.detail.includes('Документы'));assert.ok(item.documentation.value.includes('Источник \\(ru\\)'));
    await env.configure({'i18n.locale':'ru'});env.contents.set(root+'/conflict_ru.nls',xml('Other'));await env.fileEvent('create',root+'/conflict_ru.nls');
    item=items(await suggestions(env,doc,offset))[0];assert.match(item.detail,/Конфликт переводов/);assert.ok(!item.detail.includes('Документы'));
    env.contents.set(root+'/broken_ru.nls','<properties>');await env.fileEvent('create',root+'/broken_ru.nls');
    item=items(await suggestions(env,doc,offset))[0];assert.match(item.detail,/Индекс языка неполон/);assert.ok(item.documentation.value.replace(/\\/g,'').includes('broken_ru'));
});

test('untrusted Markdown/source values are escaped, bounded and never create completion actions', async t => {
    const value='[run](command:evil) <script>x</script>\n'+'a'.repeat(5000);
    const {env,doc}=await setup(t,undefined,{[ru]:xml(value.replace(/</g,'&lt;').replace(/>/g,'&gt;'))});
    const item=items(await suggestions(env,doc,doc.getText().indexOf('Workspace.t')+11))[0];
    assert.equal(item.documentation.isTrusted,false);assert.ok(item.documentation.value.includes('\\[run\\]'));
    assert.ok(item.documentation.value.length<2000);assert.ok(!item.detail.includes('\n'));assert.equal(item.command,undefined);
});

test('discovered unsaved keys overlay disk, events invalidate them, and target/build/user-excluded buffers do not bypass discovery', async t => {
    const generated=root+'/target/generated_ru.nls',build=root+'/build/built_ru.nls',excluded=root+'/excluded_ru.nls';
    const {env,doc}=await setup(t,'string title = "$|";'.replace('|',''),{[generated]:xml('Generated','Generated.key'),[build]:xml('Built','Built.key'),[excluded]:xml('Excluded','Excluded.key')},{configuration:{'index.exclude':['**/excluded_ru.nls']}});
    const nls=await env.vscode.workspace.openTextDocument(env.vscode.Uri.file(ru));
    Object.assign(nls,document(ru,xml('Несохранённый','Unsaved.key')));nls.isDirty=true;await env.change(nls);
    const offset=doc.getText().indexOf('$')+1;
    let list=items(await suggestions(env,doc,offset));assert.ok(list.some(r=>r.label==='Unsaved.key'));assert.ok(!list.some(r=>r.label==='Generated.key'||r.label==='Built.key'||r.label==='Excluded.key'));
    for(const path of [generated,build,excluded]) { const opened=await env.vscode.workspace.openTextDocument(env.vscode.Uri.file(path));opened.isDirty=true;await env.change(opened); }
    list=items(await suggestions(env,doc,offset));assert.ok(!list.some(r=>/Generated|Built|Excluded/.test(r.label)));
    assert.ok(env.contents.get(ru).includes('Workspace.title'));assert.equal(env.appliedEdits.length,0);
    env.contents.delete(en);await env.fileEvent('delete',en);assert.ok(!items(await suggestions(env,doc,offset)).some(r=>r.label==='Workspace.title'));
    await env.configure({'index.exclude':['**/*.nls']});assert.equal(items(await suggestions(env,doc,offset)).length,0);
});

test('checkout/submodule scope does not import foreign keys or locale values, outside-workspace and non-BL are empty', async t => {
    const foreignRoot='/work/foreign',foreign=foreignRoot+'/foreign_ru.nls',child=root+'/child';
    const {env,doc}=await setup(t,'string title = "$";',{[foreign]:xml('Foreign','Foreign.key'),[child+'/child_ru.nls']:xml('Child','Child.key')},{checkoutRoots:[root,foreignRoot,child]});
    const list=items(await suggestions(env,doc,doc.getText().indexOf('$')+1));assert.ok(!list.some(r=>r.label==='Foreign.key'));assert.ok(list.some(r=>r.label==='Child.key'));
    const other=document(foreignRoot+'/Example.bl','"$"');assert.deepEqual(Array.from(items(await suggestions(env,other,2)),r=>r.label),['Foreign.key']);
    for(const d of [document('/outside/Example.bl','"$"'),document(root+'/Example.js','"$"')])assert.equal(items(await suggestions(env,d,2)).length,0);
    const untitled=document(bl,'"$"');untitled.uri={scheme:'untitled',fsPath:bl};assert.equal(items(await suggestions(env,untitled,2)).length,0);
});

test('completion is absent in comments/ordinary strings and initial cancellation skips work', async t => {
    const {env}=await setup(t);
    for(const marked of ['// "$Workspace.t|$"','"normal $Workspace.t|$"',"'$Workspace.t|$'",'"$Workspace.t$|"']) {
        const d=document(bl,marked.replace('|',''));assert.equal(items(await suggestions(env,d,marked.indexOf('|'))).length,0);
    }
    const d=document(bl,'"$Workspace.t"');assert.equal(items(await suggestions(env,d,13,{isCancellationRequested:true})).length,0);
});

test('delayed completion snapshot cannot return stale document, cancelled, closed, changed-config or disposed results', async t => {
    for(const event of ['document','cancel','closed','config','disposed','folders']) {
        const {env,doc}=await setup(t);
        let release,started;const waiting=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>started=resolve);
        let delay=false;
        const service=createLocalization(env.vscode,{readFile:async file=>{if(delay){started();await waiting;}return env.contents.get(file);}});
        const subscriptions=[];await service.register({subscriptions});t.after(()=>{for(const s of subscriptions.reverse())s.dispose();});
        env.contents.set(root+'/late_ru.nls',xml('Late','Late.key'));await env.fileEvent('create',root+'/late_ru.nls');
        delay=true;const token={isCancellationRequested:false};
        const pending=service.completionProvider.provideCompletionItems(doc,doc.positionAt(doc.getText().indexOf('Workspace.t')+11),token);
        await seen;
        if(event==='document')Object.assign(doc,document(bl,'"$Changed"'));
        if(event==='cancel')token.isCancellationRequested=true;
        if(event==='closed')doc.isClosed=true;
        let changed;
        if(event==='config')changed=env.configure({'i18n.locale':'en'});
        if(event==='folders')env.foldersChanged();
        if(event==='disposed')for(const s of subscriptions)s.dispose();
        release();assert.equal(items(await pending).length,0,event);if(changed)await changed;
    }
});
