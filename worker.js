/**
 * Cloudflare Worker -- QP Insights Commons
 *
 * Handles two knowledge file types in index.json:
 *   plaintext    -> fetches entire file, truncated to MAX_CHARS
 *   json_article -> fetches file, extracts article by article_id
 *
 * Flow: question -> score index.json -> fetch top-N articles -> QP AI Router -> response
 */

const GITHUB_RAW = "https://raw.githubusercontent.com/adityagopalkrishnan-dotcom/solutions/main";
const INDEX_URL  = GITHUB_RAW + "/index.json";

const QP_ROUTER  = "https://airouter-api.questionpro.com/v1/prompt-routes";
const QP_API_KEY = "55e63ea5-e2a9-4c27-a5aa-d89b9da77db4";
const QP_USER_ID = 4379318;
const QP_ORG_ID  = 4285979;

const TOP_N         = 6;
const MAX_CHARS     = 12000;
const CACHE_SECONDS = 300;

function scoreEntry(entry, queryWords) {
  const titleL = entry.title.toLowerCase();
  const kw     = (entry.kw || '').toLowerCase();
  const summ   = (entry.summary || '').toLowerCase();
  const prod   = (entry.product || '').toLowerCase();

  let score = 0;
  for (const w of queryWords) {
    if (titleL.includes(w))  score += 4;
    else if (kw.includes(w)) score += 2;
    else if (summ.includes(w) || prod.includes(w)) score += 1;
  }
  // Boost CX Solutions cookbook/RTS entries
  if (entry.product === 'CX Solutions') score += 2;
  return score;
}

async function fetchContent(entry) {
  const url = GITHUB_RAW + "/" + entry.path;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Fetch failed for " + entry.path + ": HTTP " + res.status);
  const raw = await res.text();

  if (entry.type === 'plaintext') {
    return raw.slice(0, MAX_CHARS);
  }

  if (entry.type === 'json_article') {
    let data;
    try { data = JSON.parse(raw); } catch { return raw.slice(0, MAX_CHARS); }
    const articles = data.articles || [];
    const article  = articles.find(a => a.id === entry.article_id) || articles[0];
    return article ? buildArticleText(article) : '';
  }

  return raw.slice(0, MAX_CHARS);
}

function buildArticleText(article) {
  const parts = [];
  if (article.title)   parts.push("# " + article.title);
  if (article.url)     parts.push("Source: " + article.url);
  if (article.summary && article.summary !== article.title) parts.push(article.summary);

  if (article.headings && article.headings.length) {
    const hh = article.headings.map(h => h.text || h).filter(Boolean).join(' | ');
    if (hh) parts.push("Sections: " + hh);
  }
  if (article.steps && article.steps.length) {
    const ss = article.steps
      .map((s, i) => (i+1) + ". " + (typeof s === 'string' ? s : (s.text || '')))
      .filter(s => s.trim().length > 3);
    if (ss.length) parts.push(ss.join('\n'));
  }
  if (article.content) parts.push(article.content);
  return parts.join('\n\n').slice(0, MAX_CHARS);
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, api-key',
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

    const question      = body.question;
    const historyStr    = body.historyStr || '';
    const use_case_name = body.use_case_name || 'insights_commons';

    if (!question) return jsonResponse({ error: 'Missing question' }, 400);

    try {
      const indexRes = await fetch(INDEX_URL, {
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
      });
      if (!indexRes.ok) throw new Error("Index fetch failed: " + indexRes.status);
      const index = await indexRes.json();

      const queryWords = question.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

      const scored = index
        .map(e => ({ e, s: scoreEntry(e, queryWords) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, TOP_N);

      const contentParts = await Promise.all(
        scored.map(async ({ e }) => {
          try {
            const text = await fetchContent(e);
            if (!text || text.trim().length < 50) return null;
            return "--- [" + e.title + " | " + e.product + "] ---\n" + text;
          } catch (err) {
            console.error("Content fetch error for " + e.id + ":", err.message);
            return null;
          }
        })
      );

      const context = contentParts.filter(Boolean).join('\n\n')
                      || 'No relevant knowledge found for this query.';

      const payload = {
        user_id:         QP_USER_ID,
        organization_id: QP_ORG_ID,
        use_case_name,
        prompt_version:  2,
        data_center:     "US",
        input_data: [
          { key: "content",              value: "" },
          { key: "QUESTION",             value: question },
          { key: "CONTEXT",              value: context },
          { key: "CONVERSATION_HISTORY", value: historyStr }
        ]
      };

      const routerRes = await fetch(QP_ROUTER, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': QP_API_KEY },
        body:    JSON.stringify(payload)
      });
      const routerData = await routerRes.json();

      return jsonResponse(Object.assign({}, routerData, {
        _sources: scored.map(({ e, s }) => ({
          title: e.title, product: e.product, score: s, url: e.url || null
        }))
      }));

    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
};
