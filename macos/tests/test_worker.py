"""Failure and privacy checks; no model downloads required."""
import io
import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import worker
import numpy as np


class FakeEngine:
    def __init__(self):
        self.calls = 0

    def transcribe(self, audio, language, previous=""):
        self.calls += 1
        self.previous = previous
        return "I has 12 apples."

    def clean(self, text):
        return "I have 12 apples.", None


class ChunkEngine:
    """Returns one transcript piece per call, like consecutive parts of a long dictation."""
    smart_formatting = True
    clean_long = worker.Engine.clean_long

    def __init__(self, pieces):
        self.pieces = iter(pieces)
        self.prompts = []
        self.edits = []

    def transcribe(self, audio, language, previous=""):
        self.prompts.append(previous)
        return next(self.pieces)

    def clean(self, text, budget=2.5, smart=None):
        return text[:1].upper() + text[1:], None

    def edit(self, selection, instruction):
        self.edits.append((selection, instruction))
        return selection.upper(), None


def run_session(engine, directory, pieces, **final):
    """Send all but the last piece as chunks, then finish; returns the events."""
    paths = [make_wav(directory, name=f"part{index}.wav") for index in range(pieces)]
    requests = [{"command": "chunk", "id": "s", "index": index, "path": str(path)} for index, path in enumerate(paths[:-1])]
    requests.append({"command": "transcribe", "id": "s", "path": str(paths[-1]), **final})
    output = io.StringIO()
    worker.serve(engine, [json.dumps(request) for request in requests], output)
    assert not any(path.exists() for path in paths)
    return [json.loads(line) for line in output.getvalue().splitlines()]


def make_wav(directory, rate=16000, silent=False, name="audio.wav"):
    path = Path(directory) / name
    samples = np.zeros(16000, dtype="<i2") if silent else (np.sin(np.arange(16000) * 0.1) * 5000).astype("<i2")
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(samples.tobytes())
    return path


class WorkerTests(unittest.TestCase):
    def run_request(self, engine, path, **kwargs):
        output = io.StringIO()
        request = {"command": "transcribe", "id": "test", "path": str(path), **kwargs}
        worker.serve(engine, [json.dumps(request)], output)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_transcript_delivered_and_audio_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = make_wav(directory)
            events = self.run_request(FakeEngine(), path)
            self.assertEqual(events[0]["event"], "transcribed")
            self.assertEqual(events[-1]["text"], "I have 12 apples.")
            self.assertEqual(events[-1]["raw"], "I has 12 apples.")
            self.assertFalse(path.exists())

    def test_cleanup_failure_preserves_raw(self):
        engine = FakeEngine()
        with tempfile.TemporaryDirectory() as directory, patch.object(engine, "clean", side_effect=RuntimeError("failed")):
            events = self.run_request(engine, make_wav(directory))
            self.assertEqual(events[-1]["text"], "I has 12 apples.")
            self.assertIn("cleanup failed", events[-1]["warning"])

    def test_cleanup_can_be_skipped(self):
        engine = FakeEngine()
        with tempfile.TemporaryDirectory() as directory, patch.object(engine, "clean", side_effect=AssertionError("must not run")):
            events = self.run_request(engine, make_wav(directory), cleanup=False)
            self.assertEqual(events[-1]["text"], "I has 12 apples.")
            self.assertIsNone(events[-1]["warning"])

    def test_silence_never_reaches_models(self):
        engine = FakeEngine()
        with tempfile.TemporaryDirectory() as directory:
            events = self.run_request(engine, make_wav(directory, silent=True))
            self.assertEqual(engine.calls, 0)
            self.assertEqual(events[-1]["text"], "")

    def test_bad_audio_deleted_and_error_is_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            path = make_wav(directory, rate=8000)
            events = self.run_request(FakeEngine(), path)
            self.assertEqual(events[-1]["event"], "error")
            self.assertIn("16 kHz", events[-1]["message"])
            self.assertFalse(path.exists())

    def test_bad_request_does_not_kill_worker(self):
        output = io.StringIO()
        worker.serve(FakeEngine(), ["not json", '{"command":"unknown","id":"second"}'], output)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(events), 2)
        self.assertEqual(events[1]["id"], "second")

    def test_number_changes_and_explanations_are_rejected(self):
        self.assertFalse(worker.valid_edit("Pay 120.50 tomorrow", "Pay 125.50 tomorrow."))
        self.assertFalse(worker.valid_edit("hello", "Here is the corrected text: Hello."))
        self.assertFalse(worker.valid_edit("hello", "<think>edit</think>Hello."))
        self.assertTrue(worker.valid_edit("i has 12 apples", "I have 12 apples."))

    def test_writing_commands_route_only_at_boundaries(self):
        self.assertEqual(worker.writing_intent("Summarize this: We need a local app with notes."), ("summary", "We need a local app with notes."))
        self.assertEqual(worker.writing_intent("We need notes and a graph. Make this into bullet points."), ("bullets", "We need notes and a graph"))
        self.assertEqual(worker.writing_intent("We ship once it is signed, make this into bullet points."), ("bullets", "We ship once it is signed"))
        self.assertEqual(worker.writing_intent("In bullet points: plan, build, ship."), ("bullets", "plan, build, ship."))
        self.assertEqual(worker.writing_intent("We plan, then we build. Make this a list."), ("bullets", "We plan, then we build"))
        self.assertEqual(worker.writing_intent("Open the app. Click record. Number these."), ("numbered", "Open the app. Click record"))
        self.assertEqual(worker.writing_intent("Make this shorter: the meeting moved to Friday because Maya is away."), ("concise", "the meeting moved to Friday because Maya is away."))
        self.assertEqual(worker.writing_intent("Thanks for the update. Make it more formal."), ("formal", "Thanks for the update"))
        self.assertEqual(worker.writing_intent("We need a list of names for the party."), ("cleanup", "We need a list of names for the party."))
        self.assertEqual(worker.writing_intent("Understand and summarize this. Make it into points. We need notes and a graph."), ("summary_bullets", "We need notes and a graph."))
        literal = 'I told Maya to summarize this report.'
        self.assertEqual(worker.writing_intent(literal), ("cleanup", literal))
        quoted = '"Summarize this" is the phrase he used.'
        self.assertEqual(worker.writing_intent(quoted), ("cleanup", quoted))
        self.assertEqual(worker.writing_intent("Make this into points: keep it local", False), ("cleanup", "Make this into points: keep it local"))

    def test_summary_and_numbering_have_appropriate_edit_guards(self):
        raw = "We are building a local desktop application with a graph and searchable notes. " * 3
        self.assertTrue(worker.valid_edit(raw, "Local desktop app with a graph and searchable notes.", "summary"))
        self.assertFalse(worker.valid_edit(raw, "Done.", "cleanup"))
        self.assertTrue(worker.valid_edit("Call Maya at 3. Send 2 notes.", "1. Call Maya at 3.\n2. Send 2 notes.", "numbered"))
        self.assertTrue(worker.valid_edit("Meet at 2, no 3.", "Meet at 3."))
        self.assertTrue(worker.valid_edit("We need 2 notes. We need 2 notes.", "We need 2 notes."))
        self.assertFalse(worker.valid_edit("Pay 125.50 tomorrow", "Pay 120.50 tomorrow.", "summary"))

    def test_explicit_day_correction_does_not_become_an_alternative(self):
        self.assertEqual(worker.clear_self_corrections("Meet Monday, no, Tuesday."), "Meet Tuesday.")
        self.assertEqual(worker.clear_self_corrections("Monday or Tuesday works."), "Monday or Tuesday works.")
        self.assertEqual(worker.clear_self_corrections("Thanks, no problem."), "Thanks, no problem.")

    def test_space_shortcut_keeps_its_modifier(self):
        raw = "Press Control Space to record. Press Control Space again to finish."
        self.assertEqual(worker.preserve_space_shortcut(raw, "Press Control Space to record. Press Space again to finish."), raw)
        separate = "Press Control Space to record. Press Space to insert a space."
        self.assertEqual(worker.preserve_space_shortcut(separate, separate), separate)

    def test_request_passes_personal_writing_preferences(self):
        engine = FakeEngine()
        with tempfile.TemporaryDirectory() as directory:
            self.run_request(engine, make_wav(directory), smart_formatting=False, writing_style="Keep it casual")
            self.assertFalse(engine.smart_formatting)
            self.assertEqual(engine.writing_style, "Keep it casual")

    def test_trim_retains_speech_and_padding(self):
        speech = np.full(16000, 0.1, dtype=np.float32)
        audio = np.concatenate([np.zeros(8000), speech, np.zeros(8000)])
        trimmed = worker.trim_silence(audio)
        self.assertEqual(len(trimmed), 16000 + 6400)
        self.assertTrue(np.allclose(trimmed[3200:19200], speech))

    def test_pieces_stream_live_text_and_finish_as_one_dictation(self):
        engine = ChunkEngine(["first we plan.", "then we build.", "finally we ship."])
        with tempfile.TemporaryDirectory() as directory:
            events = run_session(engine, directory, 3)
        self.assertEqual([event["event"] for event in events], ["partial", "chunk", "partial", "chunk", "transcribed", "result"])
        self.assertEqual(events[2]["text"], "first we plan. then we build.")
        # Short sessions get one cleanup over the whole text, with full context.
        self.assertEqual(events[-1]["text"], "First we plan. then we build. finally we ship.")
        # Later pieces stand alone: feeding Whisper the dictation so far makes it repeat itself.
        self.assertEqual(engine.prompts, ["", "", ""])

    def test_long_dictations_are_tidied_in_stretches(self):
        stretch = " ".join(["word"] * 80) + "."
        engine = ChunkEngine([stretch, stretch, stretch, "the end."])
        with tempfile.TemporaryDirectory() as directory:
            events = run_session(engine, directory, 4)
        paragraphs = events[-1]["text"].split("\n\n")
        self.assertEqual(len(paragraphs), 2)
        self.assertEqual(len(paragraphs[0].split()), 160)
        self.assertTrue(paragraphs[1].endswith("the end."))

    def test_scratch_that_reaches_back_across_pieces(self):
        engine = ChunkEngine(["We meet at five.", "No, scratch that.", "We meet at six."])
        with tempfile.TemporaryDirectory() as directory:
            events = run_session(engine, directory, 3)
        self.assertEqual(events[-1]["raw"], "We meet at six.")

    def test_context_guides_first_piece_and_joins_the_sentence(self):
        engine = ChunkEngine(["Then we ship."])
        with tempfile.TemporaryDirectory() as directory:
            events = run_session(engine, directory, 1, context="We plan first and")
        self.assertEqual(engine.prompts, ["We plan first and"])
        self.assertEqual(events[-1]["text"], " then we ship.")

    def test_instruction_over_a_selection_rewrites_it(self):
        engine = ChunkEngine(["Make this louder."])
        with tempfile.TemporaryDirectory() as directory:
            events = run_session(engine, directory, 1, selection="quiet words")
        self.assertEqual(events[-1]["mode"], "edit")
        self.assertEqual(events[-1]["text"], "QUIET WORDS")
        self.assertEqual(engine.edits, [("quiet words", "Make this louder.")])

    def test_plain_speech_over_a_selection_replaces_it(self):
        engine = ChunkEngine(["see you at six."])
        with tempfile.TemporaryDirectory() as directory:
            events = run_session(engine, directory, 1, selection="old text")
        self.assertNotIn("mode", events[-1])
        self.assertEqual(engine.edits, [])

    def test_whisper_loops_collapse_to_one_copy(self):
        loop = "In bullet points. Third, who is the third person to climb Everest? " * 9 + "Third, who is the third person to climb"
        self.assertEqual(worker.collapse_repeats(loop), "In bullet points. Third, who is the third person to climb Everest?")
        self.assertEqual(worker.collapse_repeats("Go go go go now."), "Go now.")
        similar = "Who climbed first? Who climbed second? Who climbed third?"
        self.assertEqual(worker.collapse_repeats(similar), similar)

    def test_stock_silence_phrases_are_dropped_but_real_thanks_kept(self):
        self.assertFalse(worker.keep_segment({"text": " Thank you.", "no_speech_prob": 0.4, "avg_logprob": -0.3}))
        self.assertTrue(worker.keep_segment({"text": " Thank you.", "no_speech_prob": 0.01, "avg_logprob": -0.2}))
        self.assertFalse(worker.keep_segment({"text": " Anything.", "no_speech_prob": 0.7, "avg_logprob": -1.4}))

    def test_breath_and_room_noise_never_reach_whisper(self):
        rng = np.random.default_rng(1)
        breath = rng.normal(0, 0.003, 32000).astype(np.float32)
        self.assertEqual(len(worker.trim_silence(breath)), 0)
        speech = np.concatenate([breath, np.full(16000, 0.1, dtype=np.float32), breath])
        self.assertGreater(len(worker.trim_silence(speech)), 16000)

    def test_edits_that_drop_items_are_rejected(self):
        raw = "Who climbed Everest first? Who climbed Everest second? Who climbed Everest third?"
        self.assertFalse(worker.valid_edit(raw, "- Who climbed Everest first?", "bullets"))
        self.assertTrue(worker.valid_edit(raw, "- Who climbed Everest first?\n- Who climbed Everest second?\n- Who climbed Everest third?", "bullets"))
        self.assertEqual(worker.writing_intent("Okay, in bullet points. One. Two."), ("bullets", "One. Two."))
        spoken = "Number 1, who climbed first? Second, who climbed next? 3. Who climbed last?"
        self.assertEqual(worker.list_items(spoken), ["Who climbed first?", "Who climbed next?", "Who climbed last?"])
        self.assertTrue(worker.valid_edit(spoken, "- Who climbed first?\n- Who climbed next?\n- Who climbed last?", "bullets"))
        self.assertFalse(worker.valid_edit("Order 3 boxes. Pay 40 dollars.", "- Order boxes.\n- Pay dollars.", "bullets"))

    def test_restated_words_replace_only_what_they_correct(self):
        fix = worker.resolve_restatements
        self.assertEqual(fix("Check if they are under GitHub's permission. Permitted. Then ship."), "Check if they are under GitHub's permitted. Then ship.")
        self.assertEqual(fix("Send the deck to the finance team. Marketing team. Keep it short."), "Send the deck to the marketing team. Keep it short.")
        self.assertEqual(fix("The build uses the electron framework. Electron app, I mean."), "The build uses the electron app.")
        self.assertEqual(fix("We met Truffair yesterday. Truffaire."), "We met Truffaire yesterday.")
        # Replies and new sentences are not corrections.
        for text in ["That was great. Thanks. See you soon.", "Ship it on Monday. Okay. Tuesday works too.", "Call me. Now."]:
            self.assertEqual(fix(text), text)

    def test_voice_commands_stand_alone_only(self):
        self.assertEqual(worker.apply_voice_commands("Keep this. Drop this! Scratch that."), "Keep this.")
        self.assertEqual(worker.apply_voice_commands("Please delete that file."), "Please delete that file.")
        self.assertEqual(worker.apply_voice_commands("One. New paragraph. Two."), "One.\n\nTwo.")
        self.assertTrue(worker.looks_like_instruction("Could you make this shorter"))
        self.assertFalse(worker.looks_like_instruction("Maya said hello"))

    def test_text_fits_the_sentence_it_continues(self):
        self.assertEqual(worker.fit_to_context("Then we ship.", "We plan and"), " then we ship.")
        self.assertEqual(worker.fit_to_context("Maya agreed.", "Thanks,", [{"word": "Maya"}]), " Maya agreed.")
        self.assertEqual(worker.fit_to_context("Hello.", "Done. "), "Hello.")
        self.assertEqual(worker.fit_to_context("I agree.", "Yes and"), " I agree.")

    def test_cancelled_long_dictation_is_discarded(self):
        engine = ChunkEngine(["thrown away.", "fresh start."])
        with tempfile.TemporaryDirectory() as directory:
            first, second = make_wav(directory, name="a.wav"), make_wav(directory, name="b.wav")
            requests = [{"command": "chunk", "id": "same", "index": 0, "path": str(first)},
                        {"command": "discard", "id": "same"},
                        {"command": "transcribe", "id": "same", "path": str(second)}]
            output = io.StringIO()
            worker.serve(engine, [json.dumps(request) for request in requests], output)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(events[-1]["raw"], "fresh start.")
            self.assertFalse(first.exists() or second.exists())

    def test_parts_join_without_breaking_sentences(self):
        self.assertEqual(worker.join_parts(["We met", "and agreed.", "", "Next steps."]), "We met and agreed.\n\nNext steps.")

    def test_shutdown_stops_reading(self):
        output = io.StringIO()
        worker.serve(FakeEngine(), ['{"command":"shutdown"}', "bad"], output)
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
