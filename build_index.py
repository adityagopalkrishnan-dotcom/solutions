"""
build_index.py -- QP Insights Commons
Generates index.json from all .txt files in the repo root.

Two modes:
  plaintext    -> one entry per file (cookbook, RTS, technical docs)
  json_article -> one entry per article (scraped QP docs with "articles" array)
"""

import json, os, re

OUTPUT_FILE = "index.json"

STOPWORDS = {
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "is","are","was","were","be","been","being","have","has","had","do","does",
    "did","will","would","could","should","may","might","shall","can","this",
    "that","these","those","it","its","they","their","we","our","you","your",
    "how","what","when","where","why","which","who","from","by","as","into",
    "through","during","before","after","above","below","up","down","out",
    "off","over","under","again","then","once","here","there","all","both",
    "each","few","more","most","other","some","such","no","not","only","own",
    "same","so","than","too","very","just","about","also","if","his","her",
    "him","she","he","i","me","my","we","us","per"
}

# Human-readable names + extra search tags for plain-text cookbook files.
PLAIN_TEXT_TITLES = {
    "AI_Router_Technical":                ("AI Router Technical Setup Guide",
                                           "ai router webhook json custom variable survey prompt setup technical cookbook"),
    "Communities":                         ("Purpose Mindset and Communities Cookbook",
                                           "communities purpose mindset personal statement fortune teller ai router"),
    "Conversational_Survey":              ("Conversational Survey Cookbook",
                                           "conversational survey sous chef adaptive ai router 7-eleven kapital bank acca nps csat ces"),
    "Conversational_Survey_ready_to_sell":("Conversational Survey Ready to Sell",
                                           "conversational survey sous chef adaptive ai router pricing rts sell benefits"),
    "SalesForce_integration":             ("Salesforce Integration Cookbook",
                                           "salesforce smoke alarm triggering survey crm flow named credential callout hpe hewlett packard"),
    "SalesForce_ready_to_sell":           ("Salesforce Triggering Ready to Sell",
                                           "salesforce smoke alarm trigger survey crm pricing rts sell benefits"),
    "Sentiment_analysis":                 ("Sentiment Analysis Cookbook",
                                           "sentiment analysis prep cook open-ended text ai router sartorius themes summary dashboard"),
    "Sentiment_analysis_ready_to_sell":   ("Sentiment Analysis Ready to Sell",
                                           "sentiment analysis prep cook open-ended text pricing rts sell benefits"),
    "TV_Guide_customisation":             ("Dynamic TV Guide Searchable List Cookbook",
                                           "tv guide the menu dynamic list middleware searchable catalogue proxy trp research ireland"),
    "TV_Guide_Ready_to_sell":             ("Dynamic TV Guide Ready to Sell",
                                           "tv guide the menu dynamic list searchable catalogue pricing rts sell benefits"),
    "Solution_intro":                     ("Solutions Cookbook Overview Quick Reference",
                                           "solutions overview pricing proof point sous chef prep cook fortune teller smoke alarm the menu"),
}

# Files to skip (not knowledge files)
SKIP_FILES = {"build_index.py", "index.json", "index.html", "worker.js", "README.md"}

def extract_keywords(text, max_kw=30):
    text = text.lower()
    text = re.sub(r'[^a-z0-9\s\-]', ' ', text)
    freq = {}
    for w in text.split():
        w = w.strip('-')
        if len(w) >= 2 and w not in STOPWORDS:
            freq[w] = freq.get(w, 0) + 1
    return ' '.join(w for w, _ in sorted(freq.items(), key=lambda x: -x[1])[:max_kw])

def index_plain_text(filepath, filename):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    file_id = filename.replace('.txt', '')
    meta = PLAIN_TEXT_TITLES.get(file_id)
    title, extra_kw = meta if meta else (file_id.replace('_', ' ').title(), '')
    kw = extract_keywords(content) + (' ' + extra_kw if extra_kw else '')
    clean = re.sub(r'[+|=\-]{2,}', ' ', content)
    clean = re.sub(r'\s+', ' ', clean).strip()
    fname_lower = filename.lower()
    if 'ready_to_sell' in fname_lower:
        category = 'sales'
    elif any(x in fname_lower for x in ['technical', 'integration', 'customis']):
        category = 'technical'
    else:
        category = 'general'
    return [{"id": file_id, "title": title, "category": category, "product": "CX Solutions",
             "kw": kw, "summary": clean[:300], "path": filename,
             "type": "plaintext", "size": len(content)}]

def index_json_articles(filepath, filename):
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    product = data.get('meta', {}).get('product', 'QuestionPro')
    entries = []
    for article in data.get('articles', []):
        art_id     = article.get('id', '')
        title      = article.get('title', 'Untitled')
        content    = article.get('content', '') or ''
        summary    = article.get('summary', '') or ''
        url        = article.get('url', '')
        word_count = article.get('word_count', 0)
        if word_count < 20 or len(content) < 80:
            continue
        headings = ' '.join(h.get('text', '') for h in (article.get('headings') or []))
        steps    = ' '.join(
            s.get('text', '') if isinstance(s, dict) else str(s)
            for s in (article.get('steps') or [])
        )
        kw = extract_keywords(f"{title} {summary} {headings} {steps} {content}")
        entry_id = re.sub(r'[^a-z0-9\-_]', '-',
                          f"{filename.replace('.txt', '')}-{art_id}".lower())
        entries.append({
            "id": entry_id, "title": title,
            "category": 'api' if 'API' in filename else 'help',
            "product": product, "kw": kw,
            "summary": (summary or content)[:200],
            "path": filename, "article_id": art_id,
            "url": url, "type": "json_article", "word_count": word_count
        })
    return entries


def main():
    index = []
    files = sorted(os.listdir('.'))
    txt_files = [f for f in files if f.endswith('.txt') and f not in SKIP_FILES]
    print(f"Indexing {len(txt_files)} .txt files...\n")

    for filename in txt_files:
        try:
            with open(filename, 'r', encoding='utf-8') as f:
                peek = f.read(10).strip()
            if peek.startswith('{') or peek.startswith('['):
                entries = index_json_articles(filename, filename)
                print(f"  {filename}: {len(entries)} articles (JSON)")
            else:
                entries = index_plain_text(filename, filename)
                print(f"  {filename}: plaintext -> '{entries[0]['title']}'")
            index.extend(entries)
        except Exception as e:
            print(f"  {filename}: ERROR -- {e}")

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(index, f, separators=(',', ':'))

    size_kb = os.path.getsize(OUTPUT_FILE) // 1024
    print(f"\n index.json: {len(index)} entries, {size_kb} KB")

if __name__ == '__main__':
    main()
