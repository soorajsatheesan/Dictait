"""Local contextual memory: indexed terms, co-occurrence graph and optional notes."""
from __future__ import annotations

import functools
import json
import re
import sqlite3
import time
import uuid
from pathlib import Path

SUPPORT = Path.home() / "Library" / "Application Support" / "Dictait"


class MemoryStore:
    def __init__(self, path=None):
        self.path = Path(path) if path is not None else SUPPORT / "memory.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=0.2)
        self.path.chmod(0o600)
        self.db.executescript("""
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS terms (
                id INTEGER PRIMARY KEY, term TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL DEFAULT 'term', uses INTEGER NOT NULL DEFAULT 1,
                last_used REAL NOT NULL, language TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS term_search USING fts5(term, tokenize='unicode61');
            CREATE TABLE IF NOT EXISTS links (
                source INTEGER REFERENCES terms(id), target INTEGER REFERENCES terms(id),
                weight INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(source, target), CHECK(source < target)
            );
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY, body TEXT NOT NULL, created REAL NOT NULL, language TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(id UNINDEXED, body, tokenize='unicode61');
            CREATE TABLE IF NOT EXISTS note_terms (
                note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
                term_id INTEGER REFERENCES terms(id), PRIMARY KEY(note_id, term_id)
            );
        """)

    def remember(self, text, entities, language=None, save_note=False):
        # A model may only index terms that actually occur in the dictated text.
        entities = [e for e in entities[:24] if isinstance(e, dict) and
                    isinstance(e.get("term"), str) and 1 < len(e["term"].strip()) <= 80 and
                    e["term"].casefold().strip() in text.casefold()]
        now = time.time()
        ids = set()
        with self.db:
            for entity in entities:
                term = entity["term"].strip()
                key = term.casefold()
                kind = entity.get("kind", "term")
                if kind not in {"person", "project", "organization", "technical", "topic", "term"}:
                    kind = "term"
                existing = self.db.execute("SELECT id FROM terms WHERE normalized=?", (key,)).fetchone()
                if existing:
                    term_id = existing[0]
                    self.db.execute("UPDATE terms SET uses=uses+1, last_used=?, language=COALESCE(?,language) WHERE id=?", (now, language, term_id))
                else:
                    cursor = self.db.execute("INSERT INTO terms(term,normalized,kind,last_used,language) VALUES(?,?,?,?,?)", (term, key, kind, now, language))
                    term_id = cursor.lastrowid
                    self.db.execute("INSERT INTO term_search(rowid,term) VALUES(?,?)", (term_id, term))
                ids.add(term_id)
            ordered = sorted(ids)
            for i, source in enumerate(ordered):
                for target in ordered[i + 1:]:
                    self.db.execute("INSERT INTO links(source,target) VALUES(?,?) ON CONFLICT(source,target) DO UPDATE SET weight=weight+1", (source, target))
            note_id = None
            if save_note and text.strip():
                note_id = uuid.uuid4().hex
                self.db.execute("INSERT INTO notes VALUES(?,?,?,?)", (note_id, text, now, language))
                self.db.execute("INSERT INTO note_search(id,body) VALUES(?,?)", (note_id, text))
                self.db.executemany("INSERT INTO note_terms VALUES(?,?)", [(note_id, term_id) for term_id in ordered])
            # Bound prompt memory and graph size, retaining frequently/recently used terms.
            stale = self.db.execute("SELECT id FROM terms ORDER BY uses DESC,last_used DESC LIMIT -1 OFFSET 2000").fetchall()
            for (term_id,) in stale:
                self.db.execute("DELETE FROM links WHERE source=? OR target=?", (term_id, term_id))
                self.db.execute("DELETE FROM note_terms WHERE term_id=?", (term_id,))
                self.db.execute("DELETE FROM term_search WHERE rowid=?", (term_id,))
                self.db.execute("DELETE FROM terms WHERE id=?", (term_id,))
        return note_id

    def vocabulary(self, limit=60, query=None):
        relevant = []
        words = re.findall(r"\w{3,}", query or "")[:20]
        if words:
            search = " OR ".join('"' + word + '"' for word in words)
            relevant = self.db.execute("SELECT t.term FROM term_search s JOIN terms t ON t.id=s.rowid WHERE term_search MATCH ? ORDER BY rank LIMIT ?", (search, limit)).fetchall()
            # Include neighboring concepts from the co-occurrence graph.
            neighbors = self.db.execute("""
                SELECT DISTINCT t.term FROM terms t JOIN links l ON t.id=l.source OR t.id=l.target
                WHERE l.source IN (SELECT rowid FROM term_search WHERE term_search MATCH ?)
                   OR l.target IN (SELECT rowid FROM term_search WHERE term_search MATCH ?)
                ORDER BY t.last_used DESC LIMIT ?
            """, (search, search, limit)).fetchall()
            relevant += neighbors
        recent = self.db.execute("SELECT term FROM terms ORDER BY last_used DESC,uses DESC LIMIT ?", (limit * 2,)).fetchall()
        # Guessed terms (kind "term") must look like names; older versions learned "Let" or "Climb".
        kinds = dict(self.db.execute("SELECT term, kind FROM terms").fetchall())
        terms = [term for term in dict.fromkeys(row[0] for row in relevant + recent)
                 if (name_like(term) if kinds.get(term, "term") == "term" else meaningful(term))][:limit]
        return [{"word": term, "alias": ""} for term in terms]

    def search(self, query, limit=10):
        words = re.findall(r"\w+", query)[:20]
        if not words:
            return []
        search = " OR ".join('"' + word + '"' for word in words)
        return [{"id": row[0], "body": row[1], "created": row[2], "language": row[3]}
                for row in self.db.execute("SELECT n.id,n.body,n.created,n.language FROM note_search s JOIN notes n ON n.id=s.id WHERE note_search MATCH ? ORDER BY rank LIMIT ?", (search, limit))]

    def stats(self):
        return {name: self.db.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
                for name in ("terms", "links", "notes")}

    @staticmethod
    def term_filename(term, term_id):
        safe = re.sub(r'[\x00-\x1f/\\:*?"<>|#\[\]]', "_", term).strip(" .")[:70]
        return f"{safe or 'Term'}-{term_id}"

    def write_note(self, note_id, destination=None, refresh_graph=True):
        """Incrementally maintain a live Obsidian-compatible vault after each dictation."""
        automatic = destination is None
        destination = Path(destination) if destination else self.path.parent / "Notes"
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        note = self.db.execute("SELECT body,created,language FROM notes WHERE id=?", (note_id,)).fetchone()
        if note is None:
            return
        body, created, language = note
        rows = self.db.execute("SELECT t.id,t.term,t.kind,t.uses FROM terms t JOIN note_terms n ON n.term_id=t.id WHERE n.note_id=?", (note_id,)).fetchall()
        names = {term_id: self.term_filename(term, term_id) for term_id, term, _, _ in rows}
        links = " ".join(f"[[{name}]]" for name in names.values())
        title = time.strftime("%Y-%m-%d %H-%M-%S", time.localtime(created))
        note_file = f"Dictation {title}-{note_id[:8]}"
        (destination / f"{note_file}.md").write_text(f"# Dictation {title}\n\n{body}\n\n{links}\n\nLanguage: {language or 'unknown'}\n", encoding="utf-8")
        for term_id, term, kind, uses in rows:
            neighbors = self.db.execute("""SELECT t.id,t.term,l.weight FROM terms t JOIN links l
                ON t.id=CASE WHEN l.source=? THEN l.target ELSE l.source END
                WHERE l.source=? OR l.target=? ORDER BY l.weight DESC""", (term_id, term_id, term_id)).fetchall()
            related = "\n".join(f"- [[{self.term_filename(other_term, other_id)}]] · mentioned together {weight} time(s)" for other_id, other_term, weight in neighbors)
            notes = self.db.execute("SELECT n.id,n.created FROM notes n JOIN note_terms nt ON nt.note_id=n.id WHERE nt.term_id=? ORDER BY n.created DESC LIMIT 30", (term_id,)).fetchall()
            note_links = "\n".join(f"- [[Dictation {time.strftime('%Y-%m-%d %H-%M-%S', time.localtime(timestamp))}-{identifier[:8]}]]" for identifier, timestamp in notes)
            text = f"# {term}\n\nType: {kind} · Mentions: {uses}\n\n## Related terms\n\n{related}\n\n## Dictations\n\n{note_links}\n"
            (destination / f"{names[term_id]}.md").write_text(text, encoding="utf-8")
        index = destination / "Dictait.md"
        if not index.exists():
            index.write_text("# Dictait memory\n\nThis vault is maintained by Dictait. Open the graph view to explore terms and dictations. Connections mean terms were mentioned together, not proven factual relationships.\n", encoding="utf-8")
        if automatic:
            destination.chmod(0o700)
            for filename in [f"{note_file}.md", "Dictait.md"] + [f"{name}.md" for name in names.values()]:
                (destination / filename).chmod(0o600)
        if refresh_graph:
            self.refresh_graph(destination)

    def refresh_graph(self, destination=None):
        destination = Path(destination) if destination else self.path.parent / "Notes"
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        terms = [{"id": term_id, "term": term, "kind": kind, "uses": uses,
                  "file": self.term_filename(term, term_id)}
                 for term_id, term, kind, uses in self.db.execute("SELECT id,term,kind,uses FROM terms")]
        notes = [{"id": note_id, "body": body, "created": created, "language": language,
                  "file": f"Dictation {time.strftime('%Y-%m-%d %H-%M-%S', time.localtime(created))}-{note_id[:8]}"}
                 for note_id, body, created, language in self.db.execute("SELECT id,body,created,language FROM notes ORDER BY created DESC")]
        links = [{"source": source, "target": target, "weight": weight}
                 for source, target, weight in self.db.execute("SELECT source,target,weight FROM links")]
        note_terms = [{"note": note_id, "term": term_id} for note_id, term_id in self.db.execute("SELECT note_id,term_id FROM note_terms")]
        encoded = json.dumps({"terms": terms, "notes": notes, "links": links, "note_terms": note_terms}, ensure_ascii=False)
        encoded = encoded.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
        template = Path(__file__).with_name("memory_graph.html").read_text(encoding="utf-8")
        graph = destination / "graph.html"
        graph.write_text(template.replace("__DICTAIT_DATA__", encoded), encoding="utf-8")
        graph.chmod(0o600)

    def attach_terms(self, note_id, entities):
        with self.db:
            for entity in entities:
                if not isinstance(entity, dict) or not isinstance(entity.get("term"), str):
                    continue
                row = self.db.execute("SELECT id FROM terms WHERE normalized=?", (entity["term"].strip().casefold(),)).fetchone()
                if row:
                    self.db.execute("INSERT OR IGNORE INTO note_terms VALUES(?,?)", (note_id, row[0]))

    def export_obsidian(self, destination):
        """Export a portable vault with wiki-links; the database remains the source."""
        destination = Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        rows = self.db.execute("SELECT id,term,kind,uses FROM terms ORDER BY id").fetchall()
        names = {row[0]: self.term_filename(row[1], row[0]) for row in rows}
        for term_id, term, kind, uses in rows:
            neighbors = self.db.execute("SELECT CASE WHEN source=? THEN target ELSE source END,weight FROM links WHERE source=? OR target=? ORDER BY weight DESC", (term_id, term_id, term_id)).fetchall()
            links = "\n".join(f"- [[{names[other]}]] · mentioned together {weight} time(s)" for other, weight in neighbors)
            body = f"# {term}\n\nType: {kind} · Mentions: {uses}\n\n## Related terms\n\n{links or 'No connections yet.'}\n"
            (destination / f"{names[term_id]}.md").write_text(body, encoding="utf-8")
        for note_id, body, created, language in self.db.execute("SELECT id,body,created,language FROM notes"):
            term_ids = self.db.execute("SELECT term_id FROM note_terms WHERE note_id=?", (note_id,)).fetchall()
            links = " ".join(f"[[{names[term_id]}]]" for (term_id,) in term_ids)
            title = time.strftime("%Y-%m-%d %H-%M-%S", time.localtime(created))
            text = f"# Dictation {title}\n\n{body}\n\n{links}\n\nLanguage: {language or 'unknown'}\n"
            (destination / f"Dictation {title}-{note_id[:8]}.md").write_text(text, encoding="utf-8")
        (destination / "Dictait.md").write_text("# Dictait memory\n\nAll speech processing stays local. Connections mean terms were mentioned together, not proven factual relationships.\n\n" + "\n".join(f"- [[{name}]]" for name in names.values()) + "\n", encoding="utf-8")
        self.refresh_graph(destination)
        return self.stats()

    def close(self):
        self.db.close()


# Everyday words that start sentences or get capitalized are never names or terms.
COMMON = set("""
a about actually add after again ah all also am an and any are as ask at back bad be because been before being both but by
call can check clean close come could day did do does done dude each eight even every fine first five for four from get give go
going good got great had has have he hello her here hey hi him his how i if in is it its just keep know last let like look made
make many maybe me more most much my need new next nice nine no not now number of off ok okay old on one only or other our out
over please point put read really right run said same say second see send set seven she should show six so some start still
stop such sure take tell ten test than thank thanks that the their them then there these they thing think third this those
three through to today tomorrow too try turn two um uh up us use very want was we well were what when where which who why will
with would write yeah yes yesterday yet you your monday tuesday wednesday thursday friday saturday sunday
""".split())


def meaningful(term):
    """A learned term worth keeping: at least one word that is not an everyday word."""
    return any(word not in COMMON for word in re.findall(r"[a-z0-9']+", term.casefold()))


@functools.lru_cache(maxsize=1)
def dictionary():
    """Lowercase English words from macOS's own word list (proper nouns there are capitalized)."""
    try:
        with open("/usr/share/dict/words", encoding="utf-8", errors="ignore") as words:
            return frozenset(line.strip() for line in words if line[:1].islower())
    except OSError:
        return frozenset()


def name_like(term):
    """A guessed term must contain a word that is neither everyday nor in the dictionary, so a
    capitalized "Climb" or "Who" never becomes a spelling hint, while "GitHub" or "Everest" can."""
    words = re.findall(r"[a-z0-9']+", term.casefold())
    if all(word in COMMON for word in words):
        return False
    if len(words) == 1:
        return words[0] not in dictionary()
    # "Whisper Turbo" reads as a name; "To Climb" is a capitalized phrase.
    return not any(word in COMMON for word in words) or any(word not in COMMON and word not in dictionary() for word in words)


def fallback_entities(text):
    # A conservative fallback if entity extraction is unavailable or over budget.
    candidates = []
    for match in re.findall(r"\b(?:[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2}|[a-z]+[A-Z][a-zA-Z0-9]*)\b", text):
        words = match.split()
        while words and words[0].casefold() in COMMON:  # "So Maya" → "Maya"
            words.pop(0)
        while words and words[-1].casefold() in COMMON:
            words.pop()
        if words:
            candidates.append(" ".join(words))
    return [{"term": term, "kind": "term"} for term in dict.fromkeys(candidates) if name_like(term)][:24]
