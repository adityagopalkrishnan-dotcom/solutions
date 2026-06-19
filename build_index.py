import os
import json
import re

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(REPO_ROOT, "index.json")

SKIP_FILES = {"index.json", "build_index.py", "index.html", "worker.js", "README.md"}

def extract_keywords(text, max_keywords=20):
      stopwords = {"the","a","an","in","is","it","of","to","and","or","for","with","this","that","are","was","on","at","by","from","as","be","has","have","had","not","but","if","its","also","can","will","all","more","about","their","they","which","when","how"}
      words = re.findall(r'\b[a-zA-Z]{4,}\b', text.lower())
      freq = {}
      for w in words:
                if w not in stopwords:
                              freq[w] = freq.get(w, 0) + 1
                      return [w for w, _ in sorted(freq.items(), key=lambda x: -x[1])[:max_keywords]]

  def parse_help_file(data, filename):
        entries = []
        article = data.get("article", {})
        meta = data.get("meta", {})
        title = article.get("title", filename)
        content = article.get("content", "")
        product = meta.get("product", "unknown")
        category = article.get("category", "")
        entries.append({"title": title, "product": product, "category": category, "tags": extract_keywords(f"{title} {content}"), "path": filename, "type": "help", "summary": content[:300].strip()})
        return entries

def parse_api_file(data, filename):
      entries = []
      meta = data.get("meta", {})
      product = meta.get("product", "unknown")
      articles = data.get("articles", [])
      for article in articles:
                title = article.get("title", "")
                content = article.get("content", "")
                article_id = article.get("id", "")
                entries.append({"title": title, "product": product, "category": article.get("category", ""), "tags": extract_keywords(f"{title} {content}"), "path": filename, "article_id": article_id, "type": "api", "summary": content[:300].strip()})
            return entries

def parse_combined_file(data, filename):
      entries = []
    for article in data:
              title = article.get("title", "")
              content = article.get("content", "")
              product = article.get("product", "unknown")
              article_id = article.get("id", "")
              entries.append({"title": title, "product": product, "category": article.get("category", ""), "tags": extract_keywords(f"{title} {content}"), "path": filename, "article_id": article_id, "type": "combined", "summary": content[:300].strip()})
          return entries

def process_file(filepath, filename):
      entries = []
    try:
              with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                            raw = f.read().strip()
                        try:
                                      data = json.loads(raw)
except json.JSONDecodeError:
            entries.append({"title": filename.replace(".txt", "").replace("_", " "), "product": "general", "category": "", "tags": extract_keywords(raw), "path": filename, "type": "text", "summary": raw[:300].strip()})
            return entries
        if isinstance(data, list):
                      entries = parse_combined_file(data, filename)
elif isinstance(data, dict):
            if "articles" in data:
                              entries = parse_api_file(data, filename)
elif "article" in data:
                entries = parse_help_file(data, filename)
else:
                content = json.dumps(data)
                  entries.append({"title": filename.replace(".txt", "").replace("_", " "), "product": data.get("product", "general"), "category": "", "tags": extract_keywords(content), "path": filename, "type": "json", "summary": content[:300].strip()})
except Exception as e:
        print(f"  Error: {e}")
    return entries

def main():
      all_entries = []
    txt_files = [f for f in os.listdir(REPO_ROOT) if f.endswith(".txt") and f not in SKIP_FILES]
    print(f"Found {len(txt_files)} .txt files to index...\n")
    for filename in sorted(txt_files):
              filepath = os.path.join(REPO_ROOT, filename)
        entries = process_file(filepath, filename)
        print(f"  {filename} -> {len(entries)} entries")
        all_entries.extend(entries)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
              json.dump(all_entries, f, indent=2)
    print(f"\nDone! {len(all_entries)} total entries written to index.json")

if __name__ == "__main__":
      main()
