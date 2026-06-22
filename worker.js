/**
 * QP Insights Commons Worker
 * Secrets injected via Cloudflare env vars:
 *   QP_API_KEY, GITHUB_TOKEN
 * Other config is non-secret and hardcoded for simplicity.
 */
const GITHUB_RAW   = "https://raw.githubusercontent.com/adityagopalkrishnan-dotcom/solutions/main";
const GITHUB_API   = "https://api.github.com/repos/adityagopalkrishnan-dotcom/solutions";
const WORKFLOW_ID  = "298863246";
const INDEX_URL    = GITHUB_RAW + "/index.json";
const SITEMAP_URL  = GITHUB_RAW + "/help-sitemap.json";
const QP_ROUTER    = "https://airouter-api.questionpro.com/v1/prompt-routes";
const QP_USER_ID   = 4379318;
const QP_ORG_ID    = 4285979;
const TOP_REPO=5, TOP_HELP=3, MAX_REPO=5000, MAX_HELP=3000, CACHE_IDX=3600, CACHE_HELP=1800;

const PRODUCT_SIGNALS = {
  cx:          ["nps","csat","ces","workspace","touchpoint","closed loop","detractor","promoter","customer experience","ticket","feedback"],
  workforce:   ["pulse","engagement","heatmap","employee","department","hr","workforce","manager","360"],
  communities: ["panel","members","portal","community","discussion","forum","recruit"],
  surveys:     ["survey","question","branch","logic","skip","template","quota","block","distribution"],
};

function inferProduct(text) {
  const lower=(text||'').toLowerCase();
  const scores={cx:0,workforce:0,communities:0,surveys:0};
  for (const [prod,signals] of Object.entries(PRODUCT_SIGNALS))
    for (const s of signals) if(lower.includes(s)) scores[prod]++;
  const top=Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  return top[0][1]>0?top[0][0]:null;
}

const SYNONYMS={
  "ai router":      ["webhook","integration","custom variable","api","trigger","prompt","sentiment","classification","sous chef","prep cook"],
  "webhook":        ["ai router","integration","trigger","callback","endpoint"],
  "sentiment":      ["ai router","open-ended","text analysis","classification","theme","prep cook"],
  "conversational": ["sous chef","adaptive survey","ai survey","ai router"],
  "salesforce":     ["smoke alarm","crm","trigger","integration"],
  "tv guide":       ["the menu","dynamic list","middleware","searchable"],
  "nps":            ["net promoter","cx","customer experience","score","loyalty"],
  "cx":             ["customer experience","nps","csat","ces","touchpoint","workspace"],
  "workforce":      ["employee","engagement","hr","pulse"],
  "communities":    ["panel","portal","members","community"],
  "intercept":      ["widget","trigger","popup","overlay","rule","display","embed","cx","tracking"],
};

function expandQuery(q){
  const lower=q.toLowerCase().replace(/[^a-z0-9\s]/g,' ');
  const words=new Set(lower.split(/\s+/).filter(w=>w.length>=3));
  for(const [phrase,syns] of Object.entries(SYNONYMS))
    if(lower.includes(phrase)) syns.forEach(s=>s.split(' ').forEach(w=>{if(w.length>=3)words.add(w);}));
  return [...words];
}

function scoreRepo(e,words,activeProduct){
  const title=(e.title||'').toLowerCase(),kw=(e.kw||'').toLowerCase(),summ=(e.summary||'').toLowerCase();
  let s=0;
  for(const w of words){
    if(title.includes(w)) s+=e.type==='plaintext'?6:4;
    if(kw.includes(w))    s+=e.type==='plaintext'?4:2;
    if(summ.includes(w))  s+=e.type==='json_article'?2:1;
  }
  if(activeProduct&&s>0){
    const prod=(e.product||'').toLowerCase();
    const match=prod.includes(activeProduct)||
      (activeProduct==='cx'&&(prod.includes('cx')||prod.includes('customer')))||
      (activeProduct==='workforce'&&prod.includes('workforce'))||
      (activeProduct==='communities'&&prod.includes('communities'));
    s=match?Math.round(s*1.5):Math.round(s*0.7);
  }
  return s;
}

function scoreHelp(e,words,activeProduct){
  const slug=(e.slug||'').toLowerCase(),title=(e.title||'').toLowerCase(),prod=(e.product||'').toLowerCase();
  let s=0;
  for(const w of words){if(title.includes(w))s+=4;if(slug.includes(w))s+=3;if(prod.includes(w))s+=2;}
  if(activeProduct&&s>0){
    const match=prod.includes(activeProduct)||
      (activeProduct==='cx'&&(prod.includes('cx')||prod.includes('customer')))||
      (activeProduct==='workforce'&&prod.includes('workforce'))||
      (activeProduct==='communities'&&prod.includes('communities'));
    s=match?Math.round(s*1.5):Math.round(s*0.7);
  }
  return s;
}

const fileCache={};
async function getFile(path){
  if(fileCache[path]) return fileCache[path];
  const url=GITHUB_RAW+"/"+path.split('/').map(encodeURIComponent).join('/');
  const r=await fetch(url,{cf:{cacheTtl:CACHE_IDX,cacheEverything:true}});
  if(!r.ok) return null;
  fileCache[path]=await r.text();
  return fileCache[path];
}

async function fetchRepoEntry(e){
  const raw=await getFile(e.path);
  if(!raw) return null;
  if(e.type==='plaintext') return raw.slice(0,MAX_REPO);
  if(e.type==='json_article'){
    let data;try{data=JSON.parse(raw);}catch{return raw.slice(0,MAX_REPO);}
    const art=(data.articles||[]).find(a=>a.id===e.article_id);
    if(!art) return null;
    const parts=[];
    if(art.title) parts.push("# "+art.title);
    if(art.url)   parts.push("Source: "+art.url);
    if(art.summary&&art.summary!==art.title) parts.push(art.summary);
    if(art.content) parts.push(art.content);
    return parts.join("\n\n").slice(0,MAX_REPO);
  }
  return raw.slice(0,MAX_REPO);
}

function extractHelpPage(html,url){
  let c=html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
           .replace(/<nav[\s\S]*?<\/nav>/gi,'').replace(/<header[\s\S]*?<\/header>/gi,'')
           .replace(/<footer[\s\S]*?<\/footer>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
  const tm=c.match(/<title>([^<]+)<\/title>/);
  const title=tm?tm[1].replace(/\s*[|\-]\s*QuestionPro.*$/i,'').trim():'';
  const idx=c.indexOf('class="right-section-wrapper"');
  let body=idx>=0?c.substring(idx,idx+40000):c;
  body=body.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
           .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
  return (title?"# "+title+"\nSource: "+url+"\n\n":"Source: "+url+"\n\n")+body.slice(0,MAX_HELP);
}

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, api-key"};
function jres(d,s){return new Response(JSON.stringify(d),{status:s||200,headers:Object.assign({"Content-Type":"application/json"},CORS)});}

async function handleContribute(body,env){
  const {filename,content,contributor}=body;
  if(!filename||!content) return jres({error:"filename and content required"},400);
  const ghToken=env.GITHUB_TOKEN;
  if(!ghToken) return jres({error:"GitHub token not configured"},500);

  const safeName=filename.replace(/[/\\<>:"|?*]/g,'').replace(/\s+/g,'_').trim();
  if(!safeName) return jres({error:"Invalid filename"},400);

  const checkRes=await fetch(GITHUB_API+"/contents/"+encodeURIComponent(safeName),{
    headers:{"Authorization":"token "+ghToken,"Accept":"application/vnd.github+json"}
  });
  let sha=null;
  if(checkRes.ok){const d=await checkRes.json();sha=d.sha;}

  const encoded=btoa(unescape(encodeURIComponent(content)));
  const writeBody={message:"Community contribution: "+safeName+(contributor?" by "+contributor:""),content:encoded};
  if(sha) writeBody.sha=sha;

  const writeRes=await fetch(GITHUB_API+"/contents/"+encodeURIComponent(safeName),{
    method:"PUT",
    headers:{"Authorization":"token "+ghToken,"Content-Type":"application/json","Accept":"application/vnd.github+json"},
    body:JSON.stringify(writeBody)
  });
  if(!writeRes.ok){const err=await writeRes.text();return jres({error:"Write failed: "+err.substring(0,100)},500);}

  // Trigger index rebuild
  await fetch(GITHUB_API+"/actions/workflows/"+WORKFLOW_ID+"/dispatches",{
    method:"POST",
    headers:{"Authorization":"token "+ghToken,"Content-Type":"application/json","Accept":"application/vnd.github+json"},
    body:JSON.stringify({ref:"main"})
  }).catch(()=>{});

  return jres({success:true,message:"Contributed! Knowledge base updates in ~60 seconds.",filename:safeName});
}

export default {
  async fetch(request,env){
    if(request.method==="OPTIONS") return new Response(null,{headers:CORS});
    const url=new URL(request.url);

    if(url.pathname.endsWith("/contribute")){
      if(request.method!=="POST") return jres({error:"Method not allowed"},405);
      let body;try{body=await request.json();}catch{return jres({error:"Invalid JSON"},400);}
      return handleContribute(body,env);
    }

    if(request.method!=="POST") return jres({error:"Method not allowed"},405);
    let body;try{body=await request.json();}catch{return jres({error:"Invalid JSON"},400);}

    let question="",inputs=[],historyStr="";
    if(body.input_data&&body.input_data.input){
      inputs=body.input_data.input;
      const qe=inputs.find(i=>i.key==="QUESTION");question=qe?qe.value:"";
      const he=inputs.find(i=>i.key==="CONVERSATION_HISTORY");historyStr=he?he.value:"";
    } else {question=body.question||"";historyStr=body.historyStr||"";}
    if(!question) return jres({error:"Missing question"},400);

    const pinnedProduct=body.pinned_product||null;
    const historyTurns=(historyStr||"").split(/\[User\]/i).slice(-4).join(' ');
    const inferredProduct=pinnedProduct||inferProduct(question+' '+historyTurns);
    const questionWords=expandQuery(question);
    const historyWords=expandQuery(historyTurns).filter(w=>!questionWords.includes(w)).slice(0,15);
    const allWords=[...questionWords,...historyWords];

    try{
      const [repoIndex,helpSitemap]=await Promise.all([
        fetch(INDEX_URL,  {cf:{cacheTtl:CACHE_IDX,cacheEverything:true}}).then(r=>r.ok?r.json():[]),
        fetch(SITEMAP_URL,{cf:{cacheTtl:CACHE_IDX,cacheEverything:true}}).then(r=>r.ok?r.json():[]),
      ]);

      const topRepo=repoIndex.map(e=>({e,s:scoreRepo(e,allWords,inferredProduct)}))
        .filter(x=>x.s>0).sort((a,b)=>b.s-a.s).slice(0,TOP_REPO);
      const topHelp=helpSitemap.map(e=>({e,s:scoreHelp(e,allWords,inferredProduct)}))
        .filter(x=>x.s>0).sort((a,b)=>b.s-a.s).slice(0,TOP_HELP);

      const [repoTexts,helpTexts]=await Promise.all([
        Promise.all(topRepo.map(async({e})=>{
          try{const t=await fetchRepoEntry(e);return t&&t.length>80?"=== "+(e.type==='plaintext'?'SOLUTION':'DOC')+": "+e.title+" ===\n"+t:null;}
          catch{return null;}
        })),
        Promise.all(topHelp.map(async({e})=>{
          try{
            const r=await fetch(e.url,{headers:{"User-Agent":"QP-Insights-Commons/1.0"},cf:{cacheTtl:CACHE_HELP,cacheEverything:true}});
            if(!r.ok) return null;
            const t=extractHelpPage(await r.text(),e.url);
            return t&&t.length>80?"=== HELP: "+e.title+" ["+e.product+"] ===\n"+t:null;
          }catch{return null;}
        })),
      ]);

      const context=[...repoTexts.filter(Boolean),...helpTexts.filter(Boolean)].join("\n\n")||"No relevant documentation found.";
      const newInputs=[...inputs.filter(i=>i.key!=="CONTEXT"),{key:"CONTEXT",value:context}];
      if(!newInputs.find(i=>i.key==="QUESTION")) newInputs.unshift({key:"QUESTION",value:question});

      const qpKey=env.QP_API_KEY||request.headers.get("api-key");
      const payload=Object.assign({},body,{
        user_id:body.user_id||QP_USER_ID,
        organization_id:body.organization_id||QP_ORG_ID,
        input_data:{input:newInputs}
      });
      delete payload.question;delete payload.historyStr;delete payload.pinned_product;

      const rd=await fetch(QP_ROUTER,{method:"POST",headers:{"Content-Type":"application/json","api-key":qpKey},body:JSON.stringify(payload)}).then(r=>r.json());

      return jres(Object.assign({},rd,{
        _sources:[...topRepo.map(({e,s})=>({title:e.title,type:e.type,score:s})),...topHelp.map(({e,s})=>({title:e.title,type:'help',score:s,url:e.url}))],
        _detected_product:inferredProduct,
      }));
    }catch(err){return jres({error:err.message},500);}
  }
};