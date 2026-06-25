/**
 * QP Insights Commons Worker — v2
 * Scoring engine: TF-IDF weighted, phrase-boosted, stopword-filtered
 * Secrets: QP_API_KEY, GITHUB_TOKEN (Cloudflare env vars)
 */
const GITHUB_RAW  = "https://raw.githubusercontent.com/adityagopalkrishnan-dotcom/solutions/main";
const GITHUB_API  = "https://api.github.com/repos/adityagopalkrishnan-dotcom/solutions";
const WORKFLOW_ID = "298863246";
const INDEX_URL   = GITHUB_RAW + "/index.json";
const SITEMAP_URL = GITHUB_RAW + "/help-sitemap.json";
const QP_ROUTER   = "https://airouter-api.questionpro.com/v1/prompt-routes";
const QP_USER_ID  = 4379318;
const QP_ORG_ID   = 4285979;
const TOP_REPO=5, TOP_HELP=3, MAX_REPO=12000, MAX_HELP=3000, CACHE_IDX=60, CACHE_HELP=1800;
const ISOLATE_TTL = 300_000; // 5 min

// ── Global isolate cache ───────────────────────────────────────────────────
let _repoIndex = null, _repoIndexTs = 0;
let _helpSitemap = null, _helpSitemapTs = 0;
let _idfTable = null; // computed once from index

async function getRepoIndex() {
  const now = Date.now();
  if (_repoIndex && (now - _repoIndexTs) < ISOLATE_TTL) return _repoIndex;
  const bust = Math.floor(Date.now()/60000); // bust cache every minute
  const r = await fetch(INDEX_URL + "?v=" + bust, {cf:{cacheTtl:CACHE_IDX,cacheEverything:true}});
  if (!r.ok) return _repoIndex || [];
  _repoIndex = await r.json();
  _repoIndexTs = now;
  _idfTable = null; // invalidate IDF on index refresh
  return _repoIndex;
}

async function getHelpSitemap() {
  const now = Date.now();
  if (_helpSitemap && (now - _helpSitemapTs) < ISOLATE_TTL) return _helpSitemap;
  const bust2 = Math.floor(Date.now()/60000);
  const r = await fetch(SITEMAP_URL + "?v=" + bust2, {cf:{cacheTtl:CACHE_IDX,cacheEverything:true}});
  if (!r.ok) return _helpSitemap || [];
  _helpSitemap = await r.json();
  _helpSitemapTs = now;
  return _helpSitemap;
}

// ── TF-IDF table (built once per isolate lifetime) ────────────────────────
// Includes 2-char meaningful acronyms: ai, cx, hr, ux, ui, id, qr, nps, ces
const SHORT_KEEP = new Set(['ai','cx','hr','ux','ui','id','qr','vr','ar']);
const STOPWORDS  = new Set([
  'the','and','for','are','was','were','will','our','you','your','its',
  'this','that','with','have','has','had','not','but','also','from',
  'into','any','more','all','get','set','new','one','two','per','via',
  'use','can','how','what','why','who','when','where','using','used',
  'their','they','them','then','than','been','being','does','did',
  'could','would','should','each','some','very','just','now','may',
  'about','only','such','both','here','too','same','other'
]);

function tokenize(text) {
  // Extract words of 3+ chars OR short acronyms we want to keep
  const raw = (text||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/);
  return raw.filter(w =>
    w.length >= 3 && !STOPWORDS.has(w) ||
    (w.length === 2 && SHORT_KEEP.has(w))
  );
}

function buildIDF(index) {
  if (_idfTable) return _idfTable;
  const docCount = index.length;
  const df = {};
  for (const e of index) {
    const words = new Set(tokenize([e.title, e.kw, e.summary].join(' ')));
    for (const w of words) df[w] = (df[w]||0) + 1;
  }
  const table = {};
  for (const [w, count] of Object.entries(df)) {
    table[w] = Math.log(docCount / count);
  }
  _idfTable = table;
  return table;
}

function getIDF(idf, word) {
  return idf[word] ?? 3.5; // unknown word = treat as very distinctive
}

// ── Improved repo scoring ─────────────────────────────────────────────────
function scoreRepo(entry, queryWords, idf, product) {
  const title   = tokenize(entry.title   || '');
  const kw      = tokenize(entry.kw      || '');
  const summ    = tokenize(entry.summary || '');
  const titleS  = (entry.title   || '').toLowerCase();
  const kwS     = (entry.kw      || '').toLowerCase();
  const summS   = (entry.summary || '').toLowerCase();
  const titleSet = new Set(title);
  const kwSet    = new Set(kw);
  const summSet  = new Set(summ);
  const isPlain  = entry.type === 'plaintext';

  let s = 0;
  for (const w of queryWords) {
    const w_idf = getIDF(idf, w);
    if (titleSet.has(w)) s += 8  * w_idf;
    if (kwSet.has(w))    s += 3  * w_idf;
    if (summSet.has(w))  s += 1.5 * w_idf;
  }

  // Phrase boost: consecutive query words found verbatim in fields
  const sigWords = queryWords.filter(w => !STOPWORDS.has(w));
  for (let n = 3; n >= 2; n--) {
    for (let i = 0; i <= sigWords.length - n; i++) {
      const phrase = sigWords.slice(i, i+n).join(' ');
      if (titleS.includes(phrase)) s += 20 * n;
      if (kwS.includes(phrase))    s += 10 * n;
      if (summS.includes(phrase))  s +=  5 * n;
    }
  }

  // Plaintext (cookbook/RTS) boost
  if (isPlain && s > 0) s *= 1.5;

  // Product filter
  if (product && s > 0) {
    const prod = (entry.product||'').toLowerCase();
    const match = prod.includes(product)
      || (product==='cx' && (prod.includes('cx')||prod.includes('customer')))
      || (product==='workforce' && prod.includes('workforce'))
      || (product==='communities' && prod.includes('communities'));
    s = match ? s * 1.3 : s * 0.8;
  }

  return s;
}

// ── Improved help sitemap scoring ─────────────────────────────────────────
function scoreHelp(entry, queryWords, idf, product) {
  const slug    = tokenize(entry.slug  || '');
  const title   = tokenize(entry.title || '');
  const prod    = tokenize(entry.product || '');
  const titleS  = (entry.title || '').toLowerCase();
  const slugS   = (entry.slug  || '').toLowerCase();
  const slugSet  = new Set(slug);
  const titleSet = new Set(title);
  const prodSet  = new Set(prod);

  let s = 0;
  for (const w of queryWords) {
    const w_idf = getIDF(idf, w);
    if (titleSet.has(w)) s += 8 * w_idf;
    if (slugSet.has(w))  s += 5 * w_idf;
    if (prodSet.has(w))  s += 2 * w_idf;
  }

  // Phrase boost on title and slug
  const sigWords = queryWords.filter(w => !STOPWORDS.has(w));
  for (let n = 3; n >= 2; n--) {
    for (let i = 0; i <= sigWords.length - n; i++) {
      const phrase = sigWords.slice(i, i+n).join(' ');
      if (titleS.includes(phrase)) s += 25 * n;
      if (slugS.includes(phrase))  s += 15 * n;
    }
  }

  if (product && s > 0) {
    const prodLow = (entry.product||'').toLowerCase();
    const match = prodLow.includes(product)
      || (product==='cx' && (prodLow.includes('cx')||prodLow.includes('customer')))
      || (product==='workforce' && prodLow.includes('workforce'))
      || (product==='communities' && prodLow.includes('communities'));
    s = match ? s * 1.3 : s * 0.8;
  }

  return s;
}

// ── Product detection ─────────────────────────────────────────────────────
const PRODUCT_SIGNALS = {
  cx:          ['nps','csat','ces','workspace','touchpoint','closed loop','detractor','promoter','customer experience','ticket','feedback'],
  workforce:   ['pulse','engagement','heatmap','employee','department','workforce','manager','360'],
  communities: ['panel','members','portal','community','discussion','forum','recruit'],
  surveys:     ['survey','question','branch','logic','skip','template','quota','block','distribution'],
};

function inferProduct(text) {
  const lower = (text||'').toLowerCase();
  const scores = {cx:0,workforce:0,communities:0,surveys:0};
  for (const [prod,signals] of Object.entries(PRODUCT_SIGNALS))
    for (const s of signals) if (lower.includes(s)) scores[prod]++;
  const top = Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  return top[0][1] > 0 ? top[0][0] : null;
}

// ── File fetching ─────────────────────────────────────────────────────────
const fileCache = {};
async function getFile(path) {
  if (fileCache[path]) return fileCache[path];
  const url = GITHUB_RAW + '/' + path.split('/').map(encodeURIComponent).join('/');
  const r = await fetch(url, {cf:{cacheTtl:CACHE_IDX,cacheEverything:true}});
  if (!r.ok) return null;
  fileCache[path] = await r.text();
  return fileCache[path];
}

// Extract the most relevant section of a plaintext file based on query words
// Finds the paragraph/window with the highest query-word density
function extractRelevantSection(text, queryWords, maxLen) {
  if (!queryWords || queryWords.length === 0 || text.length <= maxLen) return text.slice(0, maxLen);
  const lower = text.toLowerCase();
  // Find best starting position: scan in 500-char steps, score each window
  let bestPos = 0, bestScore = -1;
  const step = 500, winSize = maxLen;
  for (let i = 0; i < text.length - 200; i += step) {
    const window = lower.slice(i, i + winSize);
    let score = 0;
    for (const w of queryWords) { if (w.length >= 3) score += (window.split(w).length - 1); }
    if (score > bestScore) { bestScore = score; bestPos = i; }
  }
  // Always include a small intro (first 300 chars) for context
  const NL=String.fromCharCode(10); const intro = bestPos > 300 ? text.slice(0, 300) + NL+NL+'[...]'+NL+NL : '';
  const section = text.slice(bestPos, bestPos + maxLen - intro.length);
  return intro + section;
}

async function fetchRepoEntry(e, queryWords) {
  const raw = await getFile(e.path);
  if (!raw) return null;
  if (e.type === 'plaintext') return extractRelevantSection(raw, queryWords, MAX_REPO);
  if (e.type === 'json_article') {
    let data; try { data = JSON.parse(raw); } catch { return raw.slice(0, MAX_REPO); }
    const art = (data.articles||[]).find(a => a.id === e.article_id);
    if (!art) return null;
    const parts = [];
    if (art.title)   parts.push('# ' + art.title);
    if (art.url)     parts.push('Source: ' + art.url);
    if (art.summary && art.summary !== art.title) parts.push(art.summary);
    if (art.content) parts.push(art.content);
    return parts.join('\n\n').slice(0, MAX_REPO);
  }
  return raw.slice(0, MAX_REPO);
}

function extractHelpPage(html, url) {
  let c = html
    .replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<nav[\s\S]*?<\/nav>/gi,'').replace(/<header[\s\S]*?<\/header>/gi,'')
    .replace(/<footer[\s\S]*?<\/footer>/gi,'').replace(/<!--[\s\S]*?-->/g,'');
  const tm = c.match(/<title>([^<]+)<\/title>/);
  const title = tm ? tm[1].replace(/\s*[|\-]\s*QuestionPro.*$/i,'').trim() : '';
  const idx = c.indexOf('class="right-section-wrapper"');
  let body = idx >= 0 ? c.substring(idx, idx+40000) : c;
  body = body.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
             .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
             .replace(/\s+/g,' ').trim();
  return (title ? '# '+title+'\nSource: '+url+'\n\n' : 'Source: '+url+'\n\n') + body.slice(0, MAX_HELP);
}

// ── CORS + response helpers ───────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, api-key'
};
function jres(d, s) {
  return new Response(JSON.stringify(d), {status:s||200, headers:{'Content-Type':'application/json',...CORS}});
}

// ── Contribute handler ────────────────────────────────────────────────────
async function handleContribute(body, env) {
  const {filename, content, contributor} = body;
  if (!filename || !content) return jres({error:'filename and content required'}, 400);
  const ghToken = env.GITHUB_TOKEN;
  if (!ghToken) return jres({error:'GitHub token not configured'}, 500);

  const safeName = filename.replace(/[/\\<>:"|?*]/g,'').replace(/\s+/g,'_').trim();
  if (!safeName) return jres({error:'Invalid filename'}, 400);

  const checkRes = await fetch(GITHUB_API+'/contents/'+encodeURIComponent(safeName), {
    headers:{'Authorization':'token '+ghToken,'Accept':'application/vnd.github+json','User-Agent':'QP-Insights-Commons/1.0'}
  });
  let sha = null;
  if (checkRes.ok) { const d = await checkRes.json(); sha = d.sha; }

  const encoded = btoa(unescape(encodeURIComponent(content)));
  const writeBody = {message:'Community contribution: '+safeName+(contributor?' by '+contributor:''), content:encoded};
  if (sha) writeBody.sha = sha;

  const writeRes = await fetch(GITHUB_API+'/contents/'+encodeURIComponent(safeName), {
    method:'PUT',
    headers:{'Authorization':'token '+ghToken,'Content-Type':'application/json','Accept':'application/vnd.github+json','User-Agent':'QP-Insights-Commons/1.0'},
    body:JSON.stringify(writeBody)
  });
  if (!writeRes.ok) { const err = await writeRes.text(); return jres({error:'Write failed: '+err.slice(0,100)}, 500); }

  await fetch(GITHUB_API+'/actions/workflows/'+WORKFLOW_ID+'/dispatches', {
    method:'POST',
    headers:{'Authorization':'token '+ghToken,'Content-Type':'application/json','Accept':'application/vnd.github+json','User-Agent':'QP-Insights-Commons/1.0'},
    body:JSON.stringify({ref:'main'})
  }).catch(()=>{});

  // Invalidate caches
  _repoIndex = null; _helpSitemap = null; _idfTable = null;

  return jres({success:true, message:'Contributed! Knowledge base updates in ~60 seconds.'});
}

// ── Main fetch handler ────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, {headers:CORS});
    const url = new URL(request.url);

    if (url.pathname.endsWith('/contribute')) {
      if (request.method !== 'POST') return jres({error:'Method not allowed'}, 405);
      let body; try { body = await request.json(); } catch { return jres({error:'Invalid JSON'}, 400); }
      return handleContribute(body, env);
    }

    if (request.method !== 'POST') return jres({error:'Method not allowed'}, 405);
    let body; try { body = await request.json(); } catch { return jres({error:'Invalid JSON'}, 400); }

    let question='', inputs=[], historyStr='';
    if (body.input_data?.input) {
      inputs = body.input_data.input;
      const qe = inputs.find(i=>i.key==='QUESTION'); question = qe?.value || '';
      const he = inputs.find(i=>i.key==='CONVERSATION_HISTORY'); historyStr = he?.value || '';
    } else {
      question = body.question || ''; historyStr = body.historyStr || '';
    }
    if (!question) return jres({error:'Missing question'}, 400);

    // Detect SITUATION mode — prefix triggers problem-solving prompt behaviour
    const isSituationMode = question.trimStart().toUpperCase().startsWith('SITUATION:');
    const questionMode = isSituationMode ? 'problem-solving' : 'qa';

    // CLARIFICATION GATE — mechanical check before hitting the AI Router
    if (isSituationMode) {
      const sit = question.toLowerCase();

      // TECHNICAL BYPASS: if this looks like a "how do I" technical question
      // rather than a sales/deal situation, drop back to standard Q&A mode
      const isTechnical = /^situation:\s*(how\b|what\s+is\b|what\s+are\b|how\s+can\s+i\b|how\s+do\s+i\b|how\s+to\b|i\s+want\s+to\b|i\s+need\s+to\b|can\s+i\b|is\s+there\b|does\s+qp\b|does\s+questionpro\b)/i.test(question.trim());

      if (isTechnical) {
        // Route as standard Q&A — strip the SITUATION: prefix so the AI treats it normally
        question = question.replace(/^situation:\s*/i, '').trim();
        // Reset mode flags so context header and scoring use Q&A mode
        Object.assign(arguments[0] || {}, {}); // no-op, just use local reassignment
      } else {
        // SALES/DEAL SITUATION — apply element count gate

        // Element 1: named company type or specific industry
        const hasCustomer = /\b(company|compan|industry|industries|firm|client|bank|banking|insurance|retail|logistics|healthcare|health|pharma|airline|hotel|hospitality|telco|telecom|telecomm|fintech|startup|enterprise|government|ngo|agency|brand|manufacturer|provider|vendor|corp|organisation|organization|group|plc|ltd|university|education|media|energy|utility|utilities|automotive|real estate|property|construction|consulting|professional services|it company|tech company|software|saas)\b/.test(sit);

        // Element 2: requirement — broader to catch policy, compliance, data, workflow needs
        const hasRequirement = /\b(integrat|rfp|rfi|tender|proposal|migrat|replac|displace|closed.loop|salesforce|servicenow|zendesk|jira|sso|gdpr|voc|nps|csat|ces|cx\b|closed loop|data layer|benchmark|compet|medallia|qualtrics|surveymonkey|hubspot|dynamics|retention|policy|compliance|security|data|workflow|automat|report|dashboard|ticketing|survey|feedback|insight|analytics|employee|workforce|community|panel|intercept|segmentation|targeting|notification|alert|escalat|root cause|follow.up|followup|close the loop|relationship|transactional|touchpoint)\b/.test(sit);

        // Element 3: explicit sales/deal use case
        const hasUseCase = /\b(rfp|rfi|demo|proposal|pilot|poc|proof of concept|objection|compet|displace|displacement|renewal|upsell|cross.sell|presentation|evaluation|tender|bid|closing|negotiat|contract|meeting|call|deadline|next week|this week|due date|submission)\b/.test(sit);

        const elementCount = [hasCustomer, hasRequirement, hasUseCase].filter(Boolean).length;

        // CONVERSATION BYPASS: if previous turn was a clarification request,
        // the user is now answering it — proceed to full analysis
        // Check if previous assistant turn was a clarification request (either phrasing)
        const prevTurnWasClarification = historyStr && (
          historyStr.includes('Before I analyse this') ||
          historyStr.includes('a couple of things would help') ||
          historyStr.includes('couple of details')
        );

        if (elementCount < 2 && !prevTurnWasClarification) {
          // Let the AI generate smart clarifying questions based on what was actually typed
          // rather than returning generic canned questions
          const missingLabels = [];
          if (!hasCustomer) missingLabels.push('who the customer or industry is');
          if (!hasRequirement) missingLabels.push('what their specific requirement or pain point is');
          if (!hasUseCase) missingLabels.push('what the sales context is (RFP, demo, objection, competitive displacement)');

          const clarifyPrompt = [
            'MODE: Clarification needed. The sales situation is too vague to analyse.',
            'The user typed: ' + question,
            'Missing context: ' + missingLabels.join(', ') + '.',
            'Ask exactly 2 targeted follow-up questions to get the missing detail.',
            'Base the questions on what the user already wrote — make them specific, not generic.',
            'Start with: "Before I analyse this, a couple of things would help:"',
            'Then ask 2 bullet-point questions. Stop after the questions. Do not start analysing yet.',
          ].join('\n');

          // Send to AI Router with the clarify prompt as the question
          const qpKey = env.QP_API_KEY || request.headers.get('api-key');
          const clarifyInputs = [
            ...inputs.filter(i => i.key !== 'CONTEXT' && i.key !== 'QUESTION'),
            { key: 'QUESTION', value: clarifyPrompt },
            { key: 'CONTEXT', value: 'No context needed — just ask the clarifying questions as instructed.' }
          ];
          const clarifyPayload = Object.assign({}, body, {
            user_id: body.user_id || QP_USER_ID,
            organization_id: body.organization_id || QP_ORG_ID,
            input_data: { input: clarifyInputs }
          });
          delete clarifyPayload.question; delete clarifyPayload.historyStr; delete clarifyPayload.pinned_product;

          const clarifyResp = await fetch(QP_ROUTER, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': qpKey },
            body: JSON.stringify(clarifyPayload)
          }).then(r => r.json());

          return jres(Object.assign({}, clarifyResp, {
            _clarification_requested: true,
            _elements_found: elementCount
          }));
        }
      }
    }

    const pinnedProduct  = body.pinned_product || null;
    const historyTurns   = (historyStr||'').split(/\[User\]/i).slice(-4).join(' ');
    const inferredProduct = pinnedProduct || inferProduct(question+' '+historyTurns);

    // Tokenize with new engine (handles 'ai', 'cx', etc.)
    const questionWords = tokenize(question);
    const historyWords  = tokenize(historyTurns).filter(w => !questionWords.includes(w)).slice(0, 15);
    const allWords = [...new Set([...questionWords, ...historyWords])];

    try {
      const [repoIndex, helpSitemap] = await Promise.all([getRepoIndex(), getHelpSitemap()]);

      // Build IDF from current index
      const idf = buildIDF(repoIndex);

      const topRepo = repoIndex
        .map(e => ({e, s:scoreRepo(e, allWords, idf, inferredProduct)}))
        .filter(x => x.s > 0).sort((a,b) => b.s-a.s).slice(0, TOP_REPO);

      const topHelp = helpSitemap
        .map(e => ({e, s:scoreHelp(e, allWords, idf, inferredProduct)}))
        .filter(x => x.s > 0).sort((a,b) => b.s-a.s).slice(0, TOP_HELP);

      const [repoTexts, helpTexts] = await Promise.all([
        Promise.all(topRepo.map(async ({e}) => {
          try {
            const t = await fetchRepoEntry(e, allWords);
            return t && t.length > 80 ? '=== '+(e.type==='plaintext'?'SOLUTION':'DOC')+': '+e.title+' ===\n'+t : null;
          } catch { return null; }
        })),
        Promise.all(topHelp.map(async ({e}) => {
          try {
            const r = await fetch(e.url, {headers:{'User-Agent':'QP-Insights-Commons/1.0'}, cf:{cacheTtl:CACHE_HELP,cacheEverything:true}});
            if (!r.ok) return null;
            const t = extractHelpPage(await r.text(), e.url);
            return t && t.length > 80 ? '=== HELP: '+e.title+' ['+e.product+'] ===\n'+t : null;
          } catch { return null; }
        }))
      ]);

      const rawContext = [...repoTexts.filter(Boolean), ...helpTexts.filter(Boolean)].join('\n\n')
        || 'No relevant documentation found.';

      // Bridge the gap between how the user asks and how the documents describe it.
      // Prepending a "seeking" statement helps the AI connect the question to the right
      // section of the retrieved content without having to infer the link itself.
      const contextHeader = [
        isSituationMode
          ? 'MODE: Problem-solving. Analyse the situation and provide capabilities, gaps, competitive positioning and talking points.'
          : 'MODE: Q&A. Answer the question directly from the sources below.',
        'The user is asking about: ' + question,
        inferredProduct ? 'Product context: ' + inferredProduct : '',
        topRepo.length > 0 ? 'Most relevant sources found: ' + topRepo.slice(0,3).map(({e})=>e.title).join(', ') : '',
        'Use ONLY the following sources to answer. Do not supplement from general knowledge.',
        '---',
      ].filter(Boolean).join('\n');

      const context = contextHeader + '\n\n' + rawContext;

      const newInputs = [...inputs.filter(i=>i.key!=='CONTEXT'), {key:'CONTEXT', value:context}];
      if (!newInputs.find(i=>i.key==='QUESTION')) newInputs.unshift({key:'QUESTION', value:question});

      const qpKey = env.QP_API_KEY || request.headers.get('api-key');
      const payload = Object.assign({}, body, {
        user_id: body.user_id || QP_USER_ID,
        organization_id: body.organization_id || QP_ORG_ID,
        input_data: {input: newInputs}
      });
      delete payload.question; delete payload.historyStr; delete payload.pinned_product;

      const rd = await fetch(QP_ROUTER, {
        method:'POST',
        headers:{'Content-Type':'application/json','api-key':qpKey},
        body:JSON.stringify(payload)
      }).then(r=>r.json());

      return jres(Object.assign({}, rd, {
        _sources: [
          ...topRepo.map(({e,s})=>({title:e.title, type:e.type, score:Math.round(s)})),
          ...topHelp.map(({e,s})=>({title:e.title, type:'help', score:Math.round(s), url:e.url}))
        ],
        _detected_product: inferredProduct,
      }));

    } catch(err) { return jres({error:err.message}, 500); }
  }
};
