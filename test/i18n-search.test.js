const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseNls } = require('../localizationModel');
const { createI18nSearch, searchRecords, searchMatches, insertionTarget } = require('../i18nSearch');
const { document, extension } = require('./helpers');
const root='/work/clm', bl=root+'/Example.bl', ru=root+'/app_ru.nls', en=root+'/app_en.nls';
const source='class Example { string title = "$Old.key$"; }';
const xml=entries=>'<properties>'+entries.map(([key,value])=>`<entry key="${key}">${value}</entry>`).join('')+'</properties>';
const files={ [bl]:source, [ru]:xml([['Workspace.title','Документы'],['Old.key','Старое']]), [en]:xml([['Workspace.title','Documents'],['Empty.key','']]) };
const action=name=>items=>items.find(item=>item.action===name);
async function pick(picker, query='Документы', locale='ru') {
    for(let i=0;i<60 && picker.busy;i++)await new Promise(setImmediate);
    assert.equal(picker.busy,false,'search snapshot loaded');
    picker.value=query;
    const item=picker.visibleItems.find(item=>item.record && item.record.locale===locale);
    assert.ok(item,`Missing result for ${query}/${locale}`);picker.accept(item);
}
async function setup(t,options={},extra={}) {
    const doc=document(bl,extra[bl] || source),env=await extension({...files,...extra},[doc],{workspaceFolders:['/work'],checkoutRoots:[root],...options});
    t.after(()=>env.dispose());return {env,doc};
}
async function show(env,doc,needle='$Old.key$',whole=false) {
    const text=doc.getText(),start=text.indexOf(needle);assert.ok(start>=0);
    const selection=new env.vscode.Selection(doc.positionAt(start+(whole?0:1)),doc.positionAt(whole?start+needle.length:start+1));
    return env.showEditor(doc,selection);
}
function resource(file,text) { return {...parseNls(text,file),filePath:file,text}; }

test('search model handles full Unicode values, multiword query, empty/conflicting/duplicate/incomplete sources and capped results',()=>{
    const a=resource(ru,xml([['Workspace.title','Документы'],['Long.key','x'.repeat(500)+' École'],['Empty.key','']]));
    const b=resource(root+'/other_ru.nls',xml([['Workspace.title','Документы'],['Workspace.title','Архив']]));
    const broken=resource(root+'/bad_ru.nls','<invalid>');
    const state={root,resources:[a,b,broken]},records=searchRecords(state,'ru');
    const match=searchMatches(records,'ДОКУМЕНТЫ ru');assert.equal(match.total,1);assert.equal(match.records[0].sources.length,2);assert.equal(match.records[0].conflict,true);assert.equal(match.records[0].incomplete,true);
    assert.equal(searchMatches(records,'e\u0301cole').records[0].key,'Long.key');assert.equal(searchMatches(records,'Long.key École').total,1);
    assert.equal(searchMatches(records,'Empty.key').records[0].value,'');assert.equal(searchMatches(records,'missing').total,0);
    const many=searchRecords({root,resources:[resource(ru,xml(Array.from({length:240},(_,i)=>['K'+i,'Value'])))]},'ru');
    assert.equal(searchMatches(many,'').total,240);assert.equal(searchMatches(many,'').records.length,200);
});

test('insertion plans are lexical, preserve localization delimiters and refuse comments/ordinary/unclosed strings or multi-cursor',()=>{
    function target(text,start,end=start,selections=1) {
        const doc=document(bl,text),selection={start:doc.positionAt(start),end:doc.positionAt(end)};
        return insertionTarget({document:doc,selection,selections:Array.from({length:selections},()=>selection)});
    }
    for(const text of ['// comment','/* comment','"unterminated',"'guid literal'",'"ordinary"']) {
        assert.equal(target(text,Math.min(4,text.length-1)),null,text);
    }
    assert.equal(target('// comment',10),null);assert.equal(target('/* comment',10),null);assert.equal(target('"unterminated',13),null);
    const literal='string s = "$Old.key$";';const plan=target(literal,literal.indexOf('Old')+1);assert.equal(literal.slice(plan.from,plan.to),'"$Old.key$"');
    assert.equal(target('""',1).from,0);assert.equal(target('"plain"',0,7).to,7);assert.ok(target('string s = ;',11));
    assert.equal(target('a\nb',0,3),null);assert.equal(target('code',2,2,2),null);
});

test('Palette search opens translation editor for key not present in BL, using current group and zero network/source writes',async t=>{
    const {env,doc}=await setup(t,{pickerResponses:[picker=>pick(picker)],quickPickResponses:[action('edit')]});await show(env,doc);
    const panel=await env.commands.get('bl.searchTranslations')();assert.ok(panel);assert.equal(panel.column,env.vscode.ViewColumn.Active);
    await panel.receiveMessage({type:'ready'});const state=panel.webview.sentMessages.at(-1);assert.equal(state.key,'Workspace.title');assert.equal(state.root,root);
    assert.equal(state.rows.find(r=>r.locale==='ru').value,'Документы');assert.equal(env.appliedEdits.length,0);assert.equal(doc.getText(),source);
    assert.ok(!env.requiredModules.some(name=>/^(node:)?(http|https|net|tls)$/.test(name)));assert.equal(env.guidPickers[0].disposed,true);
});

test('Insert replaces whole localization literal with key not translation and uses native undo stops in dirty BL',async t=>{
    const {env,doc}=await setup(t,{pickerResponses:[picker=>pick(picker)],quickPickResponses:[action('insert')]});const editor=await show(env,doc);doc.isDirty=true;
    const result=await env.commands.get('bl.searchTranslations')();assert.equal(result.action,'insert');assert.equal(result.key,'Workspace.title');
    assert.equal(doc.getText(),source.replace('"$Old.key$"','"$Workspace.title$"'));assert.ok(!doc.getText().includes('Документы'));assert.equal(env.contents.get(bl),source);
    assert.equal(editor.lastEditOptions.undoStopBefore,true);assert.equal(editor.lastEditOptions.undoStopAfter,true);assert.equal(env.appliedEdits.length,1);
    assert.equal(env.contents.get(ru),files[ru]);
});

test('Insert supports empty string or explicitly selected whole string and refuses invalid key/comments',async t=>{
    for(const [text,needle,whole] of [['class Example { string title = ""; }','""',false],['class Example { string title = "literal"; }','"literal"',true]]) {
        const {env,doc}=await setup(t,{pickerResponses:[picker=>pick(picker)],quickPickResponses:[action('insert')]},{[bl]:text});
        await show(env,doc,needle,whole);
        assert.equal((await env.commands.get('bl.searchTranslations')()).action,'insert');assert.ok(doc.getText().includes('"$Workspace.title$"'));
    }
    const extra={[ru]:xml([['Bad$Key','Документы']])};
    const {env,doc}=await setup(t,{pickerResponses:[picker=>pick(picker)],quickPickResponses:[items=>{assert.ok(!items.some(i=>i.action==='insert'));return undefined;}]},extra);
    await show(env,doc);assert.equal(await env.commands.get('bl.searchTranslations')(),null);assert.equal(env.appliedEdits.length,0);
});

test('native action insertion blocks changed BL/editor/selection, multi-cursor, read-only trust and edit callback races',async t=>{
    for(const kind of ['document','editor','selection','trust','race','failed']) {
        let env,doc,editor;
        const options={pickerResponses:[picker=>pick(picker)],quickPickResponses:[async items=>{
            if(kind==='document'){Object.assign(doc,document(bl,source+' // changed'));await env.change(doc);}
            if(kind==='editor')await env.showEditor(document(root+'/Other.bl','class Other {}'));
            if(kind==='selection')editor.selection=new env.vscode.Selection(doc.positionAt(0),doc.positionAt(0));
            if(kind==='trust')env.vscode.workspace.isTrusted=false;
            return items.find(i=>i.action==='insert');
        }]};
        if(kind==='race')options.beforeEditorEdit=()=>{doc.version++;};
        if(kind==='failed')options.editorEditResult=false;
        ({env,doc}=await setup(t,options));editor=await show(env,doc);
        assert.equal(await env.commands.get('bl.searchTranslations')(),null,kind);assert.equal(env.appliedEdits.length,0,kind);assert.ok(env.messages.some(m=>m.type==='warning'),kind);
    }
});

test('source navigation retains every duplicate location and ignores its own NLS opening invalidation',async t=>{
    const duplicate=root+'/other_ru.nls';
    const {env,doc}=await setup(t,{pickerResponses:[picker=>pick(picker)],quickPickResponses:[action('source'),items=>items.find(i=>i.source.filePath===duplicate)]},{[duplicate]:xml([['Workspace.title','Документы']])});
    await show(env,doc);const result=await env.commands.get('bl.searchTranslations')();assert.equal(result.action,'source');
    const opened=env.sourceOpens.at(-1);assert.equal(opened.document.uri.fsPath,duplicate);assert.equal(opened.config.viewColumn,env.vscode.ViewColumn.Active);
    assert.equal(opened.document.getText(opened.config.selection),'Workspace.title');assert.equal(env.appliedEdits.length,0);
});

test('NLS/file/exclusion changes while choosing actions cancel stale selection without silent fallback',async t=>{
    for(const kind of ['file','config','delete']) {
        let env;const options={pickerResponses:[picker=>pick(picker)],quickPickResponses:[async items=>{
            if(kind==='file'){env.contents.set(ru,xml([['Workspace.title','Changed']]));await env.fileEvent('change',ru);}
            if(kind==='delete'){env.contents.delete(ru);await env.fileEvent('delete',ru);}
            if(kind==='config')await env.configure({'index.exclude':['**/app_ru.nls']});
            return items.find(i=>i.action==='insert');
        }]};
        const fixture=await setup(t,options);env=fixture.env;await show(env,fixture.doc);
        assert.equal(await env.commands.get('bl.searchTranslations')(),null,kind);assert.equal(env.appliedEdits.length,0);assert.ok(env.messages.some(m=>/Повторите поиск/.test(m.message)));
    }
});

test('no active editor chooses distinct checkout, parent workspace fallback excludes nested checkouts, opened generated buffers never enter results',async t=>{
    const other='/work/cloud',foreign=other+'/app_ru.nls';
    const {env}=await setup(t,{checkoutRoots:[root,other],pickerResponses:[async picker=>{
        await pick(picker);assert.ok(picker.items.filter(i=>i.record).every(i=>i.record.sources.every(s=>s.filePath.startsWith(root+'/'))));
    }],quickPickResponses:[items=>items.find(i=>i.scope.root===root),action('edit')]},{[foreign]:xml([['Workspace.title','Foreign']]),[root+'/target/app_ru.nls']:xml([['Generated','Документы']]),['/work/root_ru.nls']:xml([['RootOnly','Root']])});
    const panel=await env.commands.get('bl.searchTranslations')();assert.ok(panel);assert.equal(env.quickPicks[0].items.length,3);assert.equal(env.appliedEdits.length,0);
    const a=await setup(t,{checkoutRoots:[root],pickerResponses:[async picker=>{
        for(let i=0;i<60&&picker.busy;i++)await new Promise(setImmediate);
        assert.equal(picker.items.filter(i=>i.record).length,1);assert.equal(picker.items.find(i=>i.record).record.key,'RootOnly');picker.hide();
    }]},{['/work/root_ru.nls']:xml([['RootOnly','Root']])});
    await a.env.showEditor(document('/work/Root.bl','class Root {}'));await a.env.commands.get('bl.searchTranslations')();
});

test('outside-workspace/no-folder context does not silently choose another project; unsaved NLS overlay is searched',async t=>{
    const {env}=await setup(t);await env.showEditor(document('/outside/Other.bl','class Other {}'));
    assert.equal(await env.commands.get('bl.searchTranslations')(),null);assert.equal(env.guidPickers.length,0);assert.match(env.messages.at(-1).message,/workspace/);
    const a=await setup(t,{pickerResponses:[picker=>pick(picker,'Unsaved')],quickPickResponses:[action('edit')]});
    const dirty=document(ru,xml([['Workspace.title','Unsaved']]));dirty.isDirty=true;a.env.vscode.workspace.textDocuments.push(dirty);await a.env.open(dirty);await show(a.env,a.doc);
    const panel=await a.env.commands.get('bl.searchTranslations')();await panel.receiveMessage({type:'ready'});assert.equal(panel.webview.sentMessages.at(-1).rows.find(r=>r.locale==='ru').value,'Unsaved');assert.equal(a.env.contents.get(ru),files[ru]);
});

test('empty/filter/codicon-safe/capped results and cancellation/disposal keep source buffers unchanged',async t=>{
    const extra={[ru]:xml(Array.from({length:235},(_,i)=>['K'+i,i===0?'literal $(zap)':'value']))};
    const {env}=await setup(t,{pickerResponses:[async picker=>{
        for(let i=0;i<60&&picker.busy;i++)await new Promise(setImmediate);
        assert.equal(picker.items.filter(i=>i.record).length,200);assert.match(picker.placeholder,/200/);assert.match(picker.title,/из 237/);
        picker.value='literal';assert.ok(picker.items[0].description.includes('\\$(zap)'));
        picker.value='nothing';assert.equal(picker.items[0].record,undefined);picker.accept();assert.equal(picker.disposed,false);picker.hide();
    }]},extra);await env.commands.get('bl.searchTranslations')();assert.equal(env.guidPickers[0].disposed,true);assert.equal(env.appliedEdits.length,0);
    for(const kind of ['cancel','dispose']) {
        let callback,fixture;const token={isCancellationRequested:false,onCancellationRequested(fn){callback=fn;return{dispose(){}};}};
        fixture=await setup(t,{pickerResponses:[picker=>{if(kind==='dispose')fixture.env.dispose();else{token.isCancellationRequested=true;callback();}assert.equal(picker.disposed,true);} ]});
        assert.equal(await fixture.env.commands.get('bl.searchTranslations')(undefined,token),null);assert.equal(fixture.env.panels.length,0);assert.equal(fixture.env.appliedEdits.length,0);
    }
});

test('search command is activated explicitly and grouped only under existing BL submenu',()=>{
    const p=require('../package.json');assert.ok(p.activationEvents.includes('onCommand:bl.searchTranslations'));assert.ok(p.contributes.commands.some(c=>c.command==='bl.searchTranslations'));
    assert.ok(p.contributes.menus['bl.tools'].some(c=>c.command==='bl.searchTranslations'&&c.when==='resourceLangId == bl'));
    assert.ok(!p.contributes.menus['editor/context'].some(c=>c.command==='bl.searchTranslations'));assert.equal(p.engines.vscode,'^1.60.0');
});

test('cancel/disposal while snapshot is genuinely pending ignores late load; stale load explains retry without opening editor',async t=>{
    for(const mode of ['cancel','dispose','stale']) {
        let release,cancelListener,ctx,current=true;
        const pending=new Promise(resolve=>{release=resolve;});
        const token={isCancellationRequested:false,onCancellationRequested(fn){cancelListener=fn;return{dispose(){cancelListener=null;}};}};
        const {env,doc}=await setup(t,{pickerResponses:[picker=>{
            assert.equal(picker.busy,true);
            if(mode==='cancel'){token.isCancellationRequested=true;cancelListener();}
            if(mode==='dispose')ctx.subscriptions.at(-1).dispose();
            if(mode==='stale')current=false;
            release({root,epoch:0,resources:[resource(ru,files[ru])]});
        }]});
        await show(env,doc);ctx={subscriptions:[]};let opened=0;
        const search=createI18nSearch(env.vscode,{rootFor:()=>root,freshSnapshot:()=>pending,isSnapshotCurrent:()=>current},
            {openSearchTranslation(){opened++;}},ctx);
        t.after(()=>ctx.subscriptions.forEach(s=>s.dispose()));
        assert.equal(await search.searchTranslation(undefined,token),null);await new Promise(setImmediate);
        assert.equal(opened,0);assert.equal(env.guidPickers[0].disposed,true);assert.equal(env.appliedEdits.length,0);
        if(mode==='stale')assert.ok(env.messages.some(m=>/Повторите поиск/.test(m.message)));
    }
});
