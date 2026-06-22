/**
 * QP Insights Commons Worker - Hybrid: Repo files + Live QP Help
 * Reads index.json (cookbook .txt + JSON docs) AND help-sitemap.json (live QP help).
 * Path fix: uses raw encodeURIComponent on filename (no double-encoding).
 */
const GITHUB_RAW  = "https://raw.githubusercontent.com/adityagopalkrishnan-dotcom/solutions/main";
const INDEX_URL   = GITHUB_RAW + "/index.json";
const SITEMAP_URL = GITHUB_RAW + "/help-sitemap.json";
const QP_ROUTER   = "https://airouter-api.questionpro.com/v1/prompt-routes";
const QP_API_KEY  = "55e63ea5-e2a9-4c27-a5aa-d89b9da77db4";
const QP_USER_ID  = 4379318;
const QP_ORG_ID   = 4285979;
const TOP_REPO=5, TOP_HELP=3, MAX_REPO=5000, MAX_HELP=3000, CACHE_IDX=3600, CACHE_HELP=1800;

const SYNONYMS = {
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
  "intercept":      ["widget","trigger","popup","overlay","survey","cx","rule","display","embed"],
};

function expandQuery(q) {
  const lower = q.toLowerCase().replace(/[^a-z0-9\s]/g,' ');
  const words = new Set(lower.split(/\s+/).filter(w => w.length >= 3));
  for (const [phrase, syns] of Object.entries(SYNONYMS)) {
    if (lower.includes(phrase)) syns.forEach(s => s.split(' ').forEach(w => { if(w.length>=3) words.add(w); }));
  }
  return [...words];
}

function scoreRepo(e, words) {
  const title=(e.title||'').toLowerCase(), kw=(e.kw||'').toLowerCase(), summ=(e.summary||'').toLowerCase();
  let s=0;
  for (const w of words) {
    if (title.includes(w)) s += e.type==='plaintext' ? 6 : 4;
    if (kw.includes(w))    s += e.type==='plaintext' ? 4 : 2;
    if (summ.includes(w))  s += (e.type==="json_article" ? 2 : 1);
  }
  return s;
}

function scoreHelp(e, words) {
  const slug=(e.slug||'').toLowerCase(), title=(e.title||'').toLowerCase(), prod=(e.product||'').toLowerCase();
  let s=0;
  for (const w of words) {
    if (title.includes(w)) s+=4; if (slug.includes(w)) s+=3; if (prod.includes(w)) s+=2;
  }
  return s;
}

async function fetchRepoFile(e) {
  // Path is raw filename (may contain spaces). Encode each path segment correctly.
  const filename = e.path || (e.id + '.txt');
  const url = GITHUB_RAW + "/" + filename.split('/').map(seg => encodeURIComponent(seg)).join('/');
  const r = await fetch(url, { cf: { cacheTtl: CACHE_IDX, cacheEverything: true } });
  if (!r.ok) throw new Error("Repo " + filename + ": HTTP " + r.status);
  const raw = await r.text();
  if (e.type === 'plaintext') return raw.slice(0, MAX_REPO);
  if (e.type === 'json_article') {
    let data; try { data = JSON.parse(raw); } catch { return raw.slice(0, MAX_REPO); }
    const arts = data.articles || [];
    const art  = arts.find(a => a.id === e.article_id) || arts[0];
    if (!art) return '';
    const parts = [];
    if (art.title) parts.push("# " + art.title);
    if (art.url)   parts.push("Source: " + art.url);
    if (art.summary && art.summary !== art.title) parts.push(art.summary);
    if (art.content) parts.push(art.content);
    return parts.join("\n\n").slice(0, MAX_REPO);
  }
  return raw.slice(0, MAX_REPO);
}

function extractHelpPage(html, url) {
  let c = html
    .replace(/<script[\s\S]*?<\/script>/gi,'')
    .replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<nav[\s\S]*?<\/nav>/gi,'')
    .replace(/<header[\s\S]*?<\/header>/gi,'')
    .replace(/<footer[\s\S]*?<\/footer>/gi,'')
    .replace(/<!--[\s\S]*?-->/g,'');
  const tm = c.match(/<title>([^<]+)<\/title>/);
  const title = tm ? tm[1].replace(/\s*[|\-]\s*QuestionPro.*$/i,'').trim() : '';
  const idx = c.indexOf('class="right-section-wrapper"');
  let body = idx>=0 ? c.substring(idx,idx+40000) : c;
  body = body.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
             .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
             .replace(/\s+/g,' ').trim();
  return (title ? "# "+title+"\nSource: "+url+"\n\n" : "Source: "+url+"\n\n") + body.slice(0,MAX_HELP);
}

const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, api-key"};
function jres(d,s){ return new Response(JSON.stringify(d),{status:s||200,headers:Object.assign({"Content-Type":"application/json"},CORS)}); }

export default {
  async fetch(request) {
    if (request.method==="OPTIONS") return new Response(null,{headers:CORS});
    if (request.method!=="POST")    return jres({error:"Method not allowed"},405);
    let body; try{body=await request.json();}catch{return jres({error:"Invalid JSON"},400);}

    let question="", inputs=[];
    if (body.input_data && body.input_data.input) {
      inputs=body.input_data.input;
      const qe=inputs.find(i=>i.key==="QUESTION"); question=qe?qe.value:"";
    } else { question=body.question||""; }
    if (!question) return jres({error:"Missing question"},400);

    try {
      const words = expandQuery(question);

      const [repoIndex, helpSitemap] = await Promise.all([
        fetch(INDEX_URL,   {cf:{cacheTtl:CACHE_IDX,cacheEverything:true}}).then(r=>r.ok?r.json():[]),
        fetch(SITEMAP_URL, {cf:{cacheTtl:CACHE_IDX,cacheEverything:true}}).then(r=>r.ok?r.json():[]),
      ]);

      const topRepo = repoIndex
        .map(e=>({e,s:scoreRepo(e,words)})).filter(x=>x.s>0)
        .sort((a,b)=>b.s-a.s).slice(0,TOP_REPO);

      const topHelp = helpSitemap
        .map(e=>({e,s:scoreHelp(e,words)})).filter(x=>x.s>0)
        .sort((a,b)=>b.s-a.s).slice(0,TOP_HELP);

      const [repoTexts, helpTexts] = await Promise.all([
        Promise.all(topRepo.map(async({e})=>{
          try {
            const text=await fetchRepoFile(e);
            return text&&text.length>80 ? "=== "+(e.type==='plaintext'?'SOLUTION':'DOC')+": "+e.title+" ===\n"+text : null;
          } catch(err) { return null; }
        })),
        Promise.all(topHelp.map(async({e})=>{
          try {
            const r=await fetch(e.url,{headers:{"User-Agent":"QP-Insights-Commons/1.0"},cf:{cacheTtl:CACHE_HELP,cacheEverything:true}});
            if(!r.ok) return null;
            const text=extractHelpPage(await r.text(),e.url);
            return text&&text.length>80 ? "=== HELP: "+e.title+" ["+e.product+"] ===\n"+text : null;
          } catch { return null; }
        })),
      ]);

      const context=[...repoTexts.filter(Boolean),...helpTexts.filter(Boolean)].join("\n\n")
        ||"No relevant documentation found.";

      const newInputs=[...inputs.filter(i=>i.key!=="CONTEXT"),{key:"CONTEXT",value:context}];
      if(!newInputs.find(i=>i.key==="QUESTION")) newInputs.unshift({key:"QUESTION",value:question});

      const payload=Object.assign({},body,{
        user_id:body.user_id||QP_USER_ID,
        organization_id:body.organization_id||QP_ORG_ID,
        input_data:{input:newInputs}
      });
      delete payload.question; delete payload.historyStr;

      const apiKey=request.headers.get("api-key")||QP_API_KEY;
      const rd=await fetch(QP_ROUTER,{method:"POST",headers:{"Content-Type":"application/json","api-key":apiKey},body:JSON.stringify(payload)}).then(r=>r.json());

      return jres(Object.assign({},rd,{
        _sources:[
          ...topRepo.map(({e,s})=>({title:e.title,type:e.type,score:s})),
          ...topHelp.map(({e,s})=>({title:e.title,type:'help',score:s,url:e.url})),
        ]
      }));
    } catch(err){ return jres({error:err.message},500); }
  }
};