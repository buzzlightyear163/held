# Builds index.html (everything in one file) from src/ + lib/held.js.
# Run from the repo root:  python src/build.py
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = root / "src"
html = (src / "index.src.html").read_text(encoding="utf-8")
html = html.replace("/*@CSS*/", (src / "site.css").read_text(encoding="utf-8"))
html = html.replace("/*@CORE*/", (root / "lib" / "held.js").read_text(encoding="utf-8"))
html = html.replace("/*@APP*/", (src / "app.js").read_text(encoding="utf-8"))
(root / "index.html").write_text(html, encoding="utf-8")
print("index.html", len(html), "bytes")
