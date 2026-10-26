const { test } = require('node:test');
const assert = require('node:assert/strict');
const { document, extension } = require('./helpers');
const { parseNls } = require('../localizationModel');
const { fingerprint } = require('../localizationEdits');
const { keyError, renamePlan, snapshotSignature } = require('../i18nRename');
const root = '/work/app', bl = root + '/Example.bl', ru = root + '/app_ru.nls', en = root + '/app_en.nls';
const source = 'class Example { string title = "$Workspace.title$"; }';
const xml = (value, key = 'Workspace.title') => `<properties>\n<entry key="${key}">${value}</entry>\n</properties>`;
const model = (text, filePath = ru) => ({...parseNls(text,filePath),text,filePath});
const state = panel => panel.webview.sentMessages.at(-1);
async function action(panel,type,extra={}) {const s=state(panel);await panel.receiveMessage({type,session:s.session,sequence:s.sequence+1,...extra});return state(panel);}
async function setup(t, overrides={}, options={}) {
    const doc=document(bl,source);
    const env=await extension({[bl]:source,[ru]:xml('Документы'),[en]:xml('Documents'),...overrides},[doc],{
        workspaceFolders:['/work'],checkoutRoots:[root],inputResponses:['Workspace.heading'],...options});
    t.after(()=>env.dispose());
    const panel=await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Workspace.title'});await panel.receiveMessage({type:'ready'});
    return {env,panel,doc};
}
const pure=(resources=[model(xml('Документы')),model(xml('Documents'),en)],blSources=[{filePath:bl,text:source}])=>({root,resources,blSources});

test('rename validates exact shared key grammar and bounded plan, without trimming or partial results',()=>{
    for(const name of ['',null,{},'same key',' Key','Key ','1key','<img>','k'.repeat(257)]) assert.ok(keyError('K',name));
    assert.ok(keyError('K','K'));assert.equal(keyError('K','Workspace.heading'),null);
    const many=Array.from({length:10000},(_,i)=>({filePath:root+'/'+i+'.bl',text:''}));
    assert.throws(()=>renamePlan(pure(undefined,many),'Workspace.title','Workspace.heading'),/слишком большой/);
});

test('pure plan changes only exact BL key spans and NLS key attributes, preserving syntax and translations',()=>{
    const raw='\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<properties>\r\n<!-- Workspace.title -->\r\n<entry key=\'Workspace&#46;title\'><![CDATA[Document & $Workspace.title$]]><!--in--></entry>\r\n<entry key="Other">Workspace.title</entry>\r\n</properties>';
    const text='// "$Workspace.title$"\r\n/* "$Workspace.title$" */\r\nstring a = "$Workspace.title$", b = "Workspace.title", c = "$Workspace.title.extra$", d = \'$Workspace.title$\';\r\nstring escaped = "\\\"$Workspace.title$\\\""; string e = "$Workspace.title$";';
    const plan=renamePlan(pure([model(raw),model(xml('Documents'),en)],[{filePath:bl,text}]),'Workspace.title','Workspace.heading');
    assert.equal(plan.changes.length,3);const nls=plan.changes.find(c=>c.filePath===ru),change=plan.changes.find(c=>c.filePath===bl);
    assert.equal(nls.updated,raw.replace('Workspace&#46;title','Workspace.heading'));
    assert.equal(parseNls(nls.updated,ru).entries[0].value,'Document & $Workspace.title$');
    assert.equal(change.count,2);assert.deepEqual(change.lines,[3,4]);
    assert.ok(change.updated.includes('// "$Workspace.title$"'));assert.ok(change.updated.includes('"$Workspace.title.extra$"'));
    assert.equal((change.updated.match(/"\$Workspace.heading\$"/g)||[]).length,2);
    assert.equal(plan.signature,snapshotSignature(pure([model(raw),model(xml('Documents'),en)],[{filePath:bl,text}])));
});

test('rename blocks malformed resources, missing anchors, NLS/BL collisions and ambiguous families/locales',()=>{
    const base=pure();
    for(const resources of [
        [...base.resources,model('<properties>',root+'/broken_de.nls')],
        [model(xml('Other','Other'))],
        [...base.resources,model(xml('Collision','Workspace.heading'),root+'/other_de.nls')],
        [...base.resources,model(xml('Duplicate'),root+'/other_ru.nls')],
        [model('<properties><entry key="Workspace.title">A</entry><entry key="Workspace.title">A</entry></properties>')],
        [...base.resources,model(xml('US'),root+'/app_en_US.nls'),model(xml('US'),root+'/app_en-US.nls')]
    ]) assert.throws(()=>renamePlan(pure(resources),'Workspace.title','Workspace.heading'));
    assert.throws(()=>renamePlan(pure(undefined,[{filePath:bl,text:source+' string b = "$Workspace.heading$";'}]),'Workspace.title','Workspace.heading'),/используется в BL/);
    assert.doesNotThrow(()=>renamePlan(pure(undefined,[{filePath:bl,text:source+' // "$Workspace.heading$"'}]),'Workspace.title','Workspace.heading'));
});

test('native rename preview is read-only, Apply updates BL/NLS buffers and rebinds the same panel to new key',async t=>{
    const {env,panel,doc}=await setup(t);let s=await action(panel,'rename',{to:'Forged.key',filePath:'/other'});
    assert.equal(s.error,'');assert.equal(s.previewKind,'rename');assert.equal(s.renameTo,'Workspace.heading');assert.equal(s.preview.length,3);
    assert.equal(env.appliedEdits.length,0);assert.equal(doc.getText(),source);assert.equal(env.contents.get(ru),xml('Документы'));
    s=await action(panel,'apply',{to:'Another.forged',edits:[{path:'/other'}]});assert.equal(s.error,'');assert.equal(s.key,'Workspace.heading');assert.equal(s.preview,null);
    assert.equal(panel.title,'Переводы: Workspace.heading');assert.equal(panel.column,env.vscode.ViewColumn.Active);assert.equal(env.panels.length,1);
    assert.equal(doc.getText(),source.replace('Workspace.title','Workspace.heading'));assert.equal(doc.isDirty,true);
    for(const [file,value] of [[ru,'Документы'],[en,'Documents']]) {
        const changed=env.vscode.workspace.textDocuments.find(d=>d.uri.fsPath===file);assert.equal(changed.isDirty,true);
        assert.equal(parseNls(changed.getText(),file).entries[0].key,'Workspace.heading');assert.equal(parseNls(changed.getText(),file).entries[0].value,value);
        assert.equal(env.contents.get(file),xml(value));
    }
    assert.equal(env.contents.get(bl),source);assert.equal(env.appliedEdits.length,1);assert.equal(env.appliedEdits[0].creates.length,0);
    const reopened=await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Workspace.heading'});assert.equal(reopened,panel);
    await action(panel,'apply');assert.equal(env.appliedEdits.length,1);
    assert.ok(!env.requiredModules.some(m=>/^(http|https|net|tls)$/.test(m)));
});

test('input cancellation and review Back preserve sources and draft; duplicate consent does not apply',async t=>{
    const first=await setup(t,{}, {inputResponses:[]});let s=await action(first.panel,'rename');assert.equal(s.preview,null);assert.equal(first.env.appliedEdits.length,0);
    const second=await setup(t);await action(second.panel,'rename');s=await action(second.panel,'back');assert.equal(s.preview,null);
    assert.equal(second.doc.getText(),source);assert.equal(second.env.appliedEdits.length,0);
});

test('dirty current draft, stale restoration and active AI history block rename without clearing values',async t=>{
    const {env,panel}=await setup(t);let s=state(panel);const row=s.rows.find(r=>r.locale==='ru');
    s=await action(panel,'edit',{row:row.id,target:row.target,value:'Mine'});assert.ok(s.renameBlocked);
    s=await action(panel,'rename');assert.match(s.error,/черновик/);assert.equal(s.rows.find(r=>r.locale==='ru').value,'Mine');assert.equal(env.prompts.length,0);
    assert.equal(env.appliedEdits.length,0);
    await action(panel,'aiOpen');s=await action(panel,'rename');assert.equal(s.ai.open,true);assert.equal(env.prompts.length,0);
});

test('new-key draft is not silently merged/deleted and another checkout remains isolated',async t=>{
    const stored=new Map([['z8bl.i18n.drafts.v1',{[fingerprint(root+'\0Workspace.heading')]:{root,key:'Workspace.heading',rows:[{locale:'ru',value:'Draft',original:'',target:null}]}}]]);
    const {env,panel}=await setup(t,{['/work/other/Example.bl']:source,['/work/other/app_ru.nls']:xml('Other','Workspace.heading')},
        {workspaceState:stored,checkoutRoots:[root,'/work/other']});
    const s=await action(panel,'rename');assert.match(s.error,/нового ключа/);assert.equal(env.appliedEdits.length,0);
    assert.equal(stored.get('z8bl.i18n.drafts.v1')[fingerprint(root+'\0Workspace.heading')].rows[0].value,'Draft');
    const independent=await setup(t,{['/work/other/Example.bl']:source,['/work/other/app_ru.nls']:xml('Other','Workspace.heading')},{checkoutRoots:[root,'/work/other']});
    assert.equal((await action(independent.panel,'rename')).error,'');await action(independent.panel,'apply');
    assert.equal(independent.env.contents.get('/work/other/Example.bl'),source);
    assert.ok(independent.env.appliedEdits[0].entries.every(e=>e.uri.fsPath.startsWith(root+'/')));
});

test('rename includes dirty discovered BL/NLS buffers but never generated/excluded/undiscovered sources',async t=>{
    const excluded=root+'/ignored/Ref.bl',target=root+'/target/Ref.bl';
    const {env,panel,doc}=await setup(t,{[excluded]:source,[target]:source},{configuration:{'index.exclude':['**/ignored/**']}});
    Object.assign(doc,document(bl,source+'\nstring b = "$Workspace.title$";'));doc.isDirty=true;await env.change(doc);
    const ruDoc=await env.vscode.workspace.openTextDocument(env.vscode.Uri.file(ru));Object.assign(ruDoc,document(ru,xml('Dirty')));ruDoc.isDirty=true;await env.change(ruDoc);
    const hidden=document(target,source);env.vscode.workspace.textDocuments.push(hidden);
    const undiscovered=document(root+'/NotSaved.bl',source);env.vscode.workspace.textDocuments.push(undiscovered);
    let s=await action(panel,'rename');assert.equal(s.error,'');assert.equal(s.preview.find(c=>c.kind==='BL').count,2);
    assert.equal(s.preview.length,3);await action(panel,'apply');
    assert.equal(parseNls(ruDoc.getText(),ru).entries[0].value,'Dirty');assert.equal(hidden.getText(),source);assert.equal(undiscovered.getText(),source);
    assert.equal(env.contents.get(excluded),source);assert.equal(env.contents.get(target),source);
});

test('Apply rejects changed references, collisions, file membership, buffers, paths, exclusions, trust and workspace',async t=>{
    for(const reason of ['buffer','collision','newref','delete','version','exclude','trust','folders','realpath']) {
        const realPaths={};const {env,panel,doc}=await setup(t,{[root+'/Untouched.bl']:'class Untouched {}'},{realPaths});
        let s=await action(panel,'rename');assert.equal(s.error,'',reason);
        if(reason==='buffer') {Object.assign(doc,document(bl,source+' // manual'));doc.isDirty=true;await env.change(doc);}
        if(reason==='collision') {env.contents.set(root+'/app_de.nls',xml('C','Workspace.heading'));await env.fileEvent('create',root+'/app_de.nls');}
        if(reason==='newref') {env.contents.set(root+'/New.bl',source);await env.fileEvent('create',root+'/New.bl');}
        if(reason==='delete') env.contents.delete(root+'/Untouched.bl');
        if(reason==='version') {Object.assign(doc,document(bl,source));await env.change(doc);}
        if(reason==='exclude') await env.configure({'index.exclude':['**/Example.bl']});
        if(reason==='trust') env.vscode.workspace.isTrusted=false;
        if(reason==='folders') {env.vscode.workspace.workspaceFolders.splice(0);env.foldersChanged();}
        if(reason==='realpath') realPaths[bl]='/outside/Example.bl';
        s=await action(panel,'apply');assert.ok(s.error,reason);assert.equal(env.appliedEdits.length,0,reason);
        assert.equal(env.contents.get(ru),xml('Документы'));assert.equal(env.contents.get(en),xml('Documents'));
    }
});

test('rename source read failures and ambiguous NLS do not produce a partial preview',async t=>{
    for(const reason of ['read','ambiguous','malformed','invalid']) {
        const extra=reason==='ambiguous'?{[root+'/other_ru.nls']:xml('Duplicate')}:reason==='malformed'?{[root+'/broken_de.nls']:'<properties>'}:{};
        const {env,panel}=await setup(t,extra,{inputResponses:[reason==='invalid'?' bad key':'Workspace.heading']});
        if(reason==='read') {const find=env.vscode.workspace.findFiles;env.vscode.workspace.findFiles=async(glob,...args)=>{const files=await find(glob,...args);return glob==='**/*.bl'?[...files,env.vscode.Uri.file(root+'/Missing.bl')]:files;};}
        const s=await action(panel,'rename');assert.ok(s.error,reason);assert.equal(s.preview,null);assert.equal(env.appliedEdits.length,0);
    }
});

test('native failure never reports success; closing during a successful Apply does not rollback',async t=>{
    const first=await setup(t);await action(first.panel,'rename');first.env.vscode.workspace.applyEdit=async()=>false;
    let s=await action(first.panel,'apply');assert.match(s.error,/не применил rename/);assert.equal(first.doc.getText(),source);
    const second=await setup(t);await action(second.panel,'rename');const apply=second.env.vscode.workspace.applyEdit;
    second.env.vscode.workspace.applyEdit=async edit=>{const result=await apply(edit);second.panel.dispose();return result;};
    await action(second.panel,'apply');assert.equal(second.doc.getText(),source.replace('Workspace.title','Workspace.heading'));assert.equal(second.env.appliedEdits.length,1);
});

test('post-commit storage/index errors report the committed rename without rollback or loss of other drafts',async t=>{
    for(const reason of ['storage','index']) {
        const {env,panel,doc}=await setup(t);await action(panel,'rename');
        if(reason==='storage') env.storageControl.fail=true;
        else {const apply=env.vscode.workspace.applyEdit;env.vscode.workspace.applyEdit=async edit=>{const applied=await apply(edit);env.vscode.workspace.workspaceFolders.splice(0);env.foldersChanged();return applied;};}
        const s=await action(panel,'apply');assert.match(s.error,/уже применён/);assert.equal(s.key,'Workspace.heading');
        assert.equal(doc.getText(),source.replace('Workspace.title','Workspace.heading'));assert.equal(env.appliedEdits.length,1);
    }
});

test('delayed source discovery and panel close invalidate preparation before preview or native edits',async t=>{
    for(const reason of ['edit','close']) {
        const {env,panel,doc}=await setup(t);const find=env.vscode.workspace.findFiles;
        let fired=false;env.vscode.workspace.findFiles=async(...args)=>{
            const result=await find(...args);
            if(args[0]==='**/*.bl'&&!fired) {fired=true;if(reason==='close') panel.dispose();else {Object.assign(doc,document(bl,source+' // changed'));await env.change(doc);}}
            return result;
        };
        const s=await action(panel,'rename');assert.equal(env.appliedEdits.length,0);
        if(reason==='edit') {assert.ok(s.error);assert.equal(s.preview,null);}else assert.equal(panel.disposed,true);
    }
});

test('rename blocks a touched symlink outside checkout and does not open a partial preview',async t=>{
    const {env,panel}=await setup(t,{}, {realPaths:{[bl]:'/outside/Example.bl'}});
    const s=await action(panel,'rename');assert.match(s.error,/вне checkout/);assert.equal(s.preview,null);assert.equal(env.appliedEdits.length,0);
});

test('native apply reservation prevents a concurrently opened target panel from replacing map identity',async t=>{
    const {env,panel}=await setup(t);await action(panel,'rename');const apply=env.vscode.workspace.applyEdit;
    let blocked;
    env.vscode.workspace.applyEdit=async edit=>{const result=await apply(edit);blocked=await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Workspace.heading'});return result;};
    const s=await action(panel,'apply');assert.equal(s.error,'');assert.equal(blocked,undefined);assert.equal(env.panels.length,1);
    assert.equal(await env.commands.get('bl.editTranslation')({sourceUri:bl,key:'Workspace.heading'}),panel);
});

test('duplicate discovery entries and physical file aliases cannot generate overlapping native edits',async t=>{
    assert.throws(()=>renamePlan(pure(undefined,[{filePath:bl,text:source},{filePath:bl,text:source}]),'Workspace.title','Workspace.heading'),/найден несколько раз/);
    const alias=root+'/Alias.bl';const {env,panel}=await setup(t,{[alias]:source},{realPaths:{[alias]:bl}});
    const s=await action(panel,'rename');assert.match(s.error,/через несколько путей/);assert.equal(s.preview,null);assert.equal(env.appliedEdits.length,0);
});
