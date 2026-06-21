/**
 * QP Insights Commons Worker - Live Help Fetch
 * Fetches live from questionpro.com/help/ on every question.
 */

const GITHUB_RAW  = "https://raw.githubusercontent.com/adityagopalkrishnan-dotcom/solutions/main";
const SITEMAP_URL = GITHUB_RAW + "/help-sitemap.json";
const QP_ROUTER   = "https://airouter-api.questionpro.com/v1/prompt-routes";
const QP_API_KEY  = "55e63ea5-e2a9-4c27-a5aa-d89b9da77db4";
const QP_USER_ID  = 4379318;
const QP_ORG_ID   = 4285979;
const TOP_N = 5, MAX_ARTICLE = 4000, CACHE_SITEMAP = 3600;

function scoreEntry(entry, words) {
  const slug = entry.slug.toLowerCase(), title = entry.title.toLowerCase(), prod = entry.product.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (title.includes(w)) s += 4;
    if (slug.includes(w))  s += 3;
    if (prod.includes(w))  s += 2;
  }
  return s;
}

function extractArticle(html) {
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const titleM = clean.match(/<title>([^<]+)<\/title>/);
  const title  = titleM ? titleM[1].replace(/\s*[|\-]\s*QuestionPro.*$/i, '').trim() : '';

  const idx  = clean.indexOf('class="right-section-wrapper"');
  let body = idx >= 0 ? clean.substring(idx, idx + 40000) : clean;

  body = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();

  return (title ? title + "\n\n" : '') + body.slice(0, MAX_ARTICLE);
}

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, api-key",
};
function jres(d, s) {
  return new Response(JSON.stringify(d), { status: s || 200, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST")    return jres({ error: "Method not allowed" }, 405);
    let body; try { body = await request.json(); } catch { return jres({ error: "Invalid JSON" }, 400); }

    let question = "", inputs = [];
    if (body.input_data && body.input_data.input) {
      inputs = body.input_data.input;
      const qe = inputs.find(i => i.key === "QUESTION");
      question = qe ? qe.value : "";
    } else {
      question = body.question || "";
    }
    if (!question) return jres({ error: "Missing question" }, 400);

    try {
      // 1. Load sitemap index (cached 1hr)
      const smRes = await fetch(SITEMAP_URL, { cf: { cacheTtl: CACHE_SITEMAP, cacheEverything: true } });
      if (!smRes.ok) throw new Error("Sitemap fetch failed: " + smRes.status);
      const sitemap = await smRes.json();

      // 2. Score articles
      const qWords = question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
      const scored = sitemap
        .map(e => ({ e, s: scoreEntry(e, qWords) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, TOP_N);

      // 3. Fetch live articles in parallel (cached 30min by Cloudflare)
      const articleTexts = await Promise.all(
        scored.map(async ({ e }) => {
          try {
            const r = await fetch(e.url, {
              headers: { "User-Agent": "QP-Insights-Commons/1.0" },
              cf: { cacheTtl: 1800, cacheEverything: true }
            });
            if (!r.ok) return null;
            const text = extractArticle(await r.text());
            if (!text || text.length < 100) return null;
            return "--- [" + e.title + " | " + e.product + "]\nSource: " + e.url + "\n" + text;
          } catch { return null; }
        })
      );

      const context = articleTexts.filter(Boolean).join("\n\n") || "No relevant help articles found.";

      // 4. Forward to QP AI Router
      const newInputs = [
        ...inputs.filter(i => i.key !== "CONTEXT"),
        { key: "CONTEXT", value: context }
      ];
      if (!newInputs.find(i => i.key === "QUESTION")) newInputs.unshift({ key: "QUESTION", value: question });

      const payload = Object.assign({}, body, {
        user_id: body.user_id || QP_USER_ID,
        organization_id: body.organization_id || QP_ORG_ID,
        input_data: { input: newInputs }
      });
      delete payload.question; delete payload.historyStr;

      const apiKey = request.headers.get("api-key") || QP_API_KEY;
      const routerRes = await fetch(QP_ROUTER, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": apiKey },
        body: JSON.stringify(payload)
      });
      const rd = await routerRes.json();

      return jres(Object.assign({}, rd, {
        _sources: scored.map(({ e, s }) => ({ title: e.title, product: e.product, score: s, url: e.url }))
      }));

    } catch (err) { return jres({ error: err.message }, 500); }
  }
};