import json
import os
import re
import sys
import fnmatch

FILE_PATTERNS = [
    "QuestionPro_API_*.txt",
    "QuestionPro_Help_*.txt"
]

OUTPUT_FILE = "index.json"


def get_files():
    files = []
    for f in os.listdir("."):
        for pattern in FILE_PATTERNS:
            if fnmatch.fnmatch(f, pattern):
                files.append(f)
                break
    return sorted(files)


def extract_keywords(text, max_keywords=20):
    stopwords = set([
        "the","a","an","and","or","but","in","on","at","to","for","of","with",
        "is","are","was","were","be","been","has","have","had","do","does","did",
        "this","that","these","those","it","its","by","from","as","not","can",
        "will","you","your","we","our","they","their","what","how","when","where",
        "which","who","if","so","all","any","more","also","use","used","using",
        "may","into","than","then","about","up","out","per","each","such","other"
    ])
    words = re.findall(r"[a-z]{3,}", text.lower())
    freq = {}
    for w in words:
        if w not in stopwords:
            freq[w] = freq.get(w, 0) + 1
    sorted_words = sorted(freq.items(), key=lambda x: -x[1])
    return [w for w, _ in sorted_words[:max_keywords]]


def parse_file(filepath):
    entries = []
    filename = os.path.basename(filepath)

    if "_API_" in filename:
        file_type = "api"
    else:
        file_type = "help"

    match = re.search(r"QuestionPro_(?:API|Help)_(.+)\.txt$", filename, re.IGNORECASE)
    product = match.group(1).lower() if match else "unknown"

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            raw = f.read()
    except Exception as e:
        print(f"  ERROR reading {filepath}: {e}")
        return entries

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        keywords = extract_keywords(raw)
        entries.append({
            "title": filename.replace(".txt", "").replace("_", " "),
            "product": product,
            "type": file_type,
            "category": file_type,
            "path": filename,
            "article_id": None,
            "summary": raw[:300].strip(),
            "tags": keywords
        })
        return entries

    if isinstance(data, dict) and "articles" in data:
        articles = data["articles"]
        for article in articles:
            art_id = str(article.get("id", ""))
            title = article.get("title", "Untitled")
            content = article.get("content", "")
            category = article.get("product", product)
            keywords = extract_keywords(f"{title} {content}")
            entries.append({
                "title": title,
                "product": product,
                "type": file_type,
                "category": category,
                "path": filename,
                "article_id": art_id,
                "summary": content[:300].strip(),
                "tags": keywords
            })
        return entries

    if isinstance(data, dict) and "article" in data:
        article = data["article"]
        art_id = str(article.get("id", ""))
        title = article.get("title", "Untitled")
        content = article.get("content", "")
        category = article.get("product", product)
        keywords = extract_keywords(f"{title} {content}")
        entries.append({
            "title": title,
            "product": product,
            "type": file_type,
            "category": category,
            "path": filename,
            "article_id": art_id,
            "summary": content[:300].strip(),
            "tags": keywords
        })
        return entries

    if isinstance(data, list):
        for item in data:
            art_id = str(item.get("id", ""))
            title = item.get("title", "Untitled")
            content = item.get("content", item.get("text", ""))
            category = item.get("product", product)
            keywords = extract_keywords(f"{title} {content}")
            entries.append({
                "title": title,
                "product": product,
                "type": file_type,
                "category": category,
                "path": filename,
                "article_id": art_id,
                "summary": content[:300].strip(),
                "tags": keywords
            })
        return entries

    text = json.dumps(data)
    keywords = extract_keywords(text)
    entries.append({
        "title": filename.replace(".txt", "").replace("_", " "),
        "product": product,
        "type": file_type,
        "category": file_type,
        "path": filename,
        "article_id": None,
        "summary": text[:300].strip(),
        "tags": keywords
    })
    return entries


def main():
    files = get_files()
    print(f"Found {len(files)} files to index:")
    for f in files:
        print(f"  {f}")

    all_entries = []
    for filepath in files:
        print(f"\nProcessing: {filepath}")
        entries = parse_file(filepath)
        print(f"  -> {len(entries)} entries")
        all_entries.extend(entries)

    print(f"\nTotal entries: {len(all_entries)}")

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(all_entries, f, indent=2, ensure_ascii=False)

    size_kb = os.path.getsize(OUTPUT_FILE) / 1024
    print(f"Written to {OUTPUT_FILE} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
