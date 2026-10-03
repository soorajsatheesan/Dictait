import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from memory import MemoryStore, fallback_entities, meaningful
from worker import apply_vocabulary, normalize_vocabulary


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.memory = MemoryStore(Path(self.directory.name) / "memory.sqlite3")

    def tearDown(self):
        self.memory.close()
        self.directory.cleanup()

    def test_everyday_words_never_become_terms(self):
        terms = [entity["term"] for entity in fallback_entities("Let me check. So Priya ships Dictait on GitHub. To Climb the Everest. Keep it quick.")]
        self.assertEqual(terms, ["Priya", "Dictait", "GitHub", "Everest"])
        self.assertFalse(meaningful("Point Number Two"))
        self.assertTrue(meaningful("Whisper Flow"))

    def test_spelling_hints_skip_everyday_words_learned_earlier(self):
        self.memory.remember("Let Maya climb.", [{"term": "Let", "kind": "term"}, {"term": "Climb", "kind": "term"}, {"term": "Maya", "kind": "person"}], "en")
        self.assertEqual([entry["word"] for entry in self.memory.vocabulary()], ["Maya"])

    def test_terms_mode_does_not_store_transcripts(self):
        self.memory.remember("Dictait uses Whisper Turbo.", [{"term": "Dictait", "kind": "project"}, {"term": "Whisper Turbo", "kind": "technical"}])
        self.assertEqual(self.memory.stats(), {"terms": 2, "links": 1, "notes": 0})
        self.assertEqual(self.memory.search("Whisper"), [])

    def test_hallucinated_entities_never_enter_graph(self):
        self.memory.remember("Discuss Dictait", [{"term": "Dictait"}, {"term": "Imaginary Company"}])
        self.assertEqual(self.memory.stats()["terms"], 1)

    def test_note_index_and_graph_context_survive_restart(self):
        self.memory.remember("Dictait uses Whisper Turbo for speech.", [{"term": "Dictait"}, {"term": "Whisper Turbo"}], "en", save_note=True)
        self.memory.close()
        self.memory = MemoryStore(Path(self.directory.name) / "memory.sqlite3")
        results = self.memory.search("Whisper")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["language"], "en")
        self.assertIn("Whisper Turbo", [entry["word"] for entry in self.memory.vocabulary(query="Dictait")])

    def test_repeat_mentions_strengthen_connection(self):
        entities = [{"term": "Dictait"}, {"term": "Qwen"}]
        self.memory.remember("Dictait and Qwen", entities)
        self.memory.remember("Dictait uses Qwen", entities)
        self.assertEqual(self.memory.db.execute("SELECT weight FROM links").fetchone()[0], 2)
        self.assertEqual(self.memory.stats()["terms"], 2)

    def test_full_note_is_durable_before_graph_enrichment(self):
        note_id = self.memory.remember("Dictait uses Qwen.", [], "en", save_note=True)
        self.memory.write_note(note_id)
        vault = self.memory.path.parent / "Notes"
        self.assertEqual(self.memory.stats(), {"terms": 0, "links": 0, "notes": 1})
        self.assertTrue(any("Dictait uses Qwen." in file.read_text() for file in vault.glob("*.md")))
        entities = [{"term": "Dictait"}, {"term": "Qwen"}]
        self.memory.remember("Dictait uses Qwen.", entities)
        self.memory.attach_terms(note_id, entities)
        self.memory.write_note(note_id)
        self.assertEqual(self.memory.stats()["notes"], 1)
        self.assertEqual(self.memory.db.execute("SELECT count(*) FROM note_terms").fetchone()[0], 2)
        self.assertTrue(any("[[Qwen-" in file.read_text() for file in vault.glob("*.md")))

    def test_obsidian_export_has_links_and_no_unsafe_paths(self):
        self.memory.remember("Use A/B Project and Dictait.", [{"term": "A/B Project"}, {"term": "Dictait"}], save_note=True)
        destination = Path(self.directory.name) / "vault"
        self.memory.export_obsidian(destination)
        files = list(destination.glob("*.md"))
        self.assertEqual(len(files), 4)
        self.assertTrue(any("[[Dictait-" in file.read_text() for file in files))
        self.assertFalse((destination / "A").exists())

    def test_standalone_graph_keeps_all_notes_and_escapes_script_content(self):
        text = 'Dictait </script><script>alert("note")</script> & Qwen'
        first = self.memory.remember(text, [{"term": "Dictait"}, {"term": "Qwen"}], save_note=True)
        self.memory.write_note(first)
        second = self.memory.remember("Another Dictait reference", [{"term": "Dictait"}], save_note=True)
        self.memory.write_note(second)
        folder = self.memory.path.parent / "Notes"
        graph = (folder / "graph.html").read_text()
        encoded = re.search(r'<script id="memory-data" type="application/json">(.*?)</script>', graph, re.S).group(1)
        data = json.loads(encoded)
        self.assertEqual(len(data["notes"]), 2)
        self.assertEqual(data["notes"][1]["body"], text)
        self.assertEqual(len(data["note_terms"]), 3)
        self.assertNotIn("<", encoded)
        self.assertNotIn("__DICTAIT_DATA__", graph)
        self.assertTrue(all((folder / (note["file"] + ".md")).is_file() for note in data["notes"]))
        self.assertFalse(any(file.is_dir() for file in folder.iterdir()))

    def test_empty_archive_has_a_local_graph(self):
        self.memory.refresh_graph()
        self.assertTrue((self.memory.path.parent / "Notes" / "graph.html").is_file())

    def test_markdown_can_be_saved_before_graph_rendering(self):
        note = self.memory.remember("A durable note.", [], save_note=True)
        self.memory.write_note(note, refresh_graph=False)
        folder = self.memory.path.parent / "Notes"
        self.assertTrue(list(folder.glob("Dictation *.md")))
        self.assertFalse((folder / "graph.html").exists())
        self.memory.refresh_graph()
        self.assertIn("A durable note.", (folder / "graph.html").read_text())

    def test_aliases_are_whole_terms_and_cannot_cascade(self):
        entries = [{"word": "Dictait", "alias": "dictate"}, {"word": "Other", "alias": "Dictait"}]
        self.assertEqual(apply_vocabulary("Use dictate; dictation works.", entries), "Use Dictait; dictation works.")

    def test_longest_phrase_and_case_are_preserved(self):
        entries = [{"word": "Wispr Flow", "alias": "whisper flow"}, {"word": "Whisper", "alias": "whisper"}]
        self.assertEqual(apply_vocabulary("WHISPER FLOW and whisper", entries), "Wispr Flow and Whisper")

    def test_invalid_vocabulary_is_ignored(self):
        self.assertEqual(normalize_vocabulary("bad"), [])
        self.assertEqual(normalize_vocabulary([None, {}, {"word": "Qwen", "alias": "queen"}]), [{"word": "Qwen", "alias": "queen"}])


if __name__ == "__main__":
    unittest.main()
