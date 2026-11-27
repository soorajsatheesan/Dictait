"""Failure and privacy checks; no model downloads required."""
import io
import json
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
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

    def test_cleanup_unchanged_marker_preserves_the_dictation(self):
        engine = worker.Engine(memory=False)
        engine.llm = Mock()
        engine.tokenizer = Mock()
        engine.tokenizer.encode.return_value = list(range(10))
        engine.prompt = Mock(return_value=[1, 2, 3])
        text = "Please send the invoice before Tuesday."

        def unchanged(*args, **kwargs):
            yield SimpleNamespace(text="<unchanged>", finish_reason="stop")

        modules = {
            "mlx_lm": SimpleNamespace(stream_generate=unchanged),
            "mlx_lm.sample_utils": SimpleNamespace(make_sampler=Mock()),
        }
        with patch.dict(sys.modules, modules):
            self.assertEqual(engine.clean(text), (text, None))

    def test_incomplete_model_output_still_keeps_the_requested_list(self):
        engine = worker.Engine(memory=False)
        engine.llm = Mock()
        engine.tokenizer = Mock()
        engine.tokenizer.encode.return_value = [1]
        engine.prompt = Mock(return_value=[1, 2, 3])

        def incomplete(*args, **kwargs):
            yield SimpleNamespace(text="1. Call Maya.", finish_reason="length")

        modules = {
            "mlx_lm": SimpleNamespace(stream_generate=incomplete),
            "mlx_lm.sample_utils": SimpleNamespace(make_sampler=Mock()),
        }
        with patch.dict(sys.modules, modules):
            self.assertEqual(engine.clean("Number these. Call Maya. Send the deck."),
                             ("1. Call Maya.\n2. Send the deck.", None))

    def test_reviewed_correction_keeps_changes_beyond_the_first_240_characters(self):
        engine = FakeEngine()
        prefix = "Keep the rest of this sentence unchanged. " * 8
        original = prefix + "Ask queen."
        corrected = prefix + "Ask Qwen."
        with tempfile.TemporaryDirectory() as directory:
            self.run_request(engine, make_wav(directory), examples=[{"original": original, "corrected": corrected}])
        self.assertEqual(engine.examples[0]["original"], original)
        self.assertEqual(engine.examples[0]["corrected"], corrected)

    def test_practice_memory_off_never_reads_or_writes_the_memory_store(self):
        engine = FakeEngine()
        engine.memory = Mock()
        with tempfile.TemporaryDirectory() as directory:
            events = self.run_request(engine, make_wav(directory), memory="off")
        self.assertEqual(events[-1]["event"], "result")
        self.assertEqual(engine.memory.mock_calls, [])

    def test_note_indexing_yields_to_new_dictation_and_preserves_fallback_terms(self):
        from memory import fallback_entities

        engine = worker.Engine()
        engine.memory = Mock()
        engine.llm = Mock()
        engine.tokenizer = Mock()
        text = "Ask Maya about Dictait."
        pending = Mock(side_effect=[False, False, True])
        tokens = []
        closed = []

        def stream_generate(*args, **kwargs):
            try:
                for token in ('[', '{"term":"Maya"}', ']'):
                    tokens.append(token)
                    yield SimpleNamespace(text=token)
            finally:
                closed.append(True)

        modules = {
            "mlx_lm": SimpleNamespace(stream_generate=stream_generate),
            "mlx_lm.sample_utils": SimpleNamespace(make_sampler=Mock()),
        }
        with patch.dict(sys.modules, modules):
            engine.index_memory(text, "en", note_id="saved", input_pending=pending)

        self.assertEqual(tokens, ['[', '{"term":"Maya"}'])
        self.assertEqual(closed, [True])
        engine.memory.attach_terms.assert_called_once_with("saved", fallback_entities(text), text=text)
        engine.memory.write_note.assert_called_once_with("saved")

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
        self.assertEqual(worker.writing_intent("Could you split this up into paragraphs? The release is ready."),
                         ("paragraphs", "The release is ready."))
        self.assertEqual(worker.writing_intent("The release is ready. Could you convert this into an email?"),
                         ("email", "The release is ready"))
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

    def test_short_auto_transcription_keeps_language_and_vocabulary_hint(self):
        engine = worker.Engine(memory=False)
        engine.stt = Mock()
        engine.vocabulary = [{"word": "Maya"}]
        audio = object()
        with patch.object(engine, "whisper_single_window", return_value=("Bonjour Maya.", "fr")) as single_window:
            self.assertEqual(engine.transcribe(audio, "auto", "Un message"), "Bonjour Maya.")
        single_window.assert_called_once_with(audio, "Maya. Un message")
        engine.stt.transcribe.assert_not_called()
        self.assertEqual(engine.detected_language, "fr")

    def test_short_auto_transcription_falls_back_with_detected_language(self):
        engine = worker.Engine(memory=False)
        engine.stt = Mock()
        engine.stt.transcribe.return_value = {"language": "hi", "segments": [{"text": "नमस्ते।"}]}
        with patch.object(engine, "whisper_single_window", return_value=(None, "hi")):
            self.assertEqual(engine.transcribe(object(), "auto"), "नमस्ते।")
        self.assertEqual(engine.stt.transcribe.call_args.kwargs["language"], "hi")
        self.assertEqual(engine.detected_language, "hi")

    def test_whisper_loops_collapse_to_one_copy(self):
        loop = "In bullet points. Third, who is the third person to climb Everest? " * 9 + "Third, who is the third person to climb"
        self.assertEqual(worker.collapse_repeats(loop), "In bullet points. Third, who is the third person to climb Everest?")
        self.assertEqual(worker.collapse_repeats("Go go go go now."), "Go now.")
        similar = "Who climbed first? Who climbed second? Who climbed third?"
        self.assertEqual(worker.collapse_repeats(similar), similar)

    def test_silence_garbage_from_a_real_session_is_removed(self):
        vocab = [{"word": "Sooraj"}, {"word": "Satheesan"}, {"word": "Truffaire"}]
        garbage = ("Sooraj, We'll be right back. Sooraj, We'll be right back. Hi, I'm the same. Sooraj, We'll be right back. "
                   "Sooraj, You Don't Can You, You Don't Can You, You Don't Sooraj, You'll Be Able, It's Sooraj, You'll Be "
                   "Sooraj, We'll be back to the next video. Sooraj, We'll be right back. Sooraj, You Can't Do, I Do, I Do, I Do, I "
                   "Sooraj, We'll be right back.")
        self.assertEqual(worker.scrub_hallucinations(garbage, vocab), "")
        self.assertEqual(worker.scrub_hallucinations("Sooraj, Now. Now. Now. Now.", vocab), "")
        # Real speech around a hallucinated outro survives, and the outro goes.
        mixed = "Ship the build on Friday. Thanks for watching."
        self.assertEqual(worker.scrub_hallucinations(mixed, vocab), "Ship the build on Friday.")

    def test_real_sentences_that_mention_outro_words_are_kept(self):
        vocab = [{"word": "Sooraj"}]
        for text in ["You'll be fine once the build finishes.",
                     "Please subscribe to the newsletter so the team gets release notes every Friday morning.",
                     "Sooraj will review the pull request tomorrow.",
                     "Thanks, Maya."]:
            self.assertEqual(worker.scrub_hallucinations(text, vocab), text)

    def test_prompt_words_alone_in_a_doubtful_segment_are_dropped(self):
        words = {"sooraj", "truffaire"}
        self.assertFalse(worker.keep_segment({"text": " Sooraj, now.", "no_speech_prob": 0.3, "avg_logprob": -0.6}, words))
        self.assertTrue(worker.keep_segment({"text": " Sooraj, call Truffaire.", "no_speech_prob": 0.02, "avg_logprob": -0.2}, words))

    def test_title_case_drift_is_lowered_but_names_stay(self):
        fixed = worker.fix_spurious_title_case("Build While Downloading Looks Like A Mess For Maya On GitHub.", [{"word": "Maya"}])
        self.assertTrue(fixed.startswith("Build while downloading looks like a mess"))
        self.assertIn("Maya", fixed)
        self.assertIn("GitHub", fixed)
        self.assertEqual(worker.fix_spurious_title_case("Send the UI notes to Priya today."), "Send the UI notes to Priya today.")

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



class NoteTaker:
    """Says one fixed transcript and records what it was asked to clean and rewrite."""
    smart_formatting = True
    follow = worker.Engine.follow

    def __init__(self, said, llm=True):
        self.said = said
        self.llm = object() if llm else None
        self.cleanup_error = None
        self.context = ""
        self.cleaned, self.edits = [], []

    def transcribe(self, audio, language, previous=""):
        return self.said

    def clean(self, text, budget=2.5, smart=None, intent=None):
        self.cleaned.append((text, intent))
        return f"[{intent or 'cleanup'}] {text}", None

    def edit(self, selection, instruction):
        self.edits.append((selection, instruction))
        return selection.upper(), None


class HeyInstructionTests(unittest.TestCase):
    def run_request(self, engine, **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            request = {"command": "transcribe", "id": "hey", "path": str(make_wav(directory)), **kwargs}
            worker.serve(engine, [json.dumps(request)], output)
            return json.loads(output.getvalue().splitlines()[-1])

    def test_instruction_applies_to_what_was_said_before_it(self):
        segments = worker.split_directives("The login breaks on refresh. The token isn't stored. Hey, make bullet points of that. "
                                           "Also the settings page is slow.")
        self.assertEqual(segments, [["The login breaks on refresh. The token isn't stored.", ["make bullet points of that"]],
                                    ["Also the settings page is slow.", []]])

    def test_instruction_at_the_start_applies_to_what_follows(self):
        self.assertEqual(worker.split_directives("Hey, make this a numbered list. Buy milk. Call mom."),
                         [["Buy milk. Call mom.", ["make this a numbered list"]]])

    def test_ordinary_hey_stays_text(self):
        for said in ["Hey Sarah, can you send me the deck?", "Hey, make sure you bring the docs.", "Hey there, how are you?",
                     "Hey, fix it tomorrow please.", "Hey, put it on the list. Thanks!", "They make it short."]:
            self.assertEqual(worker.split_directives(said), [[said, []]], said)

    def test_scopes_reach_back_to_the_last_sentence_or_everything(self):
        self.assertEqual(worker.split_directives("First thing. Second thing. Hey, put the last sentence in a table."),
                         [["First thing.", []], ["Second thing.", ["put the last sentence in a table"]]])
        self.assertEqual(worker.split_directives("One. Hey, bullet that. Two. Hey, summarize everything."),
                         [["One.\n\nTwo.", ["bullet that", "summarize everything"]]])

    def test_instructions_map_to_tuned_intents(self):
        self.assertEqual(worker.directive_intent(["keep it quick"]), "concise")
        self.assertEqual(worker.directive_intent(["make this a numbered list"]), "numbered")
        self.assertEqual(worker.directive_intent(["summarize that and make it bullet points"]), "summary_bullets")
        self.assertEqual(worker.directive_intent(["turn this into a prompt for Codex"]), "prompt")
        self.assertEqual(worker.directive_intent(["put this in a table"]), "custom")
        self.assertEqual(worker.directive_intent(["make it shorter and more formal"]), "custom")

    def test_instruction_is_followed_and_never_typed(self):
        engine = NoteTaker("I need to meet Maya on Tuesday. Hey, keep it quick. Also bring the deck.")
        event = self.run_request(engine)
        self.assertEqual(engine.cleaned, [("I need to meet Maya on Tuesday.", "cleanup"), ("Also bring the deck.", "cleanup")])
        self.assertEqual(engine.edits, [("[cleanup] I need to meet Maya on Tuesday.", worker.SHORTER)])
        self.assertEqual(event["text"], "[CLEANUP] I NEED TO MEET MAYA ON TUESDAY. [cleanup] Also bring the deck.")
        self.assertEqual(event["instructions"], 1)
        self.assertNotIn("hey", event["text"].lower())

    def test_tuned_instruction_uses_its_cleanup_prompt(self):
        engine = NoteTaker("Open the app. Click record. Hey, number these.")
        self.assertEqual(self.run_request(engine)["text"], "[numbered] Open the app. Click record.")
        self.assertEqual(engine.edits, [])

    def test_unusual_instruction_goes_to_the_editor(self):
        engine = NoteTaker("Rent is 900, food is 300. Hey, put this in a table.")
        event = self.run_request(engine)
        self.assertEqual(engine.edits, [("[cleanup] Rent is 900, food is 300.", "put this in a table")])
        self.assertEqual(event["text"], "[CLEANUP] RENT IS 900, FOOD IS 300.")

    def test_without_cleanup_instructions_are_still_not_typed(self):
        engine = NoteTaker("Buy milk. Call mom. Hey, bullet points.", llm=False)
        event = self.run_request(engine, cleanup=False)
        self.assertEqual(event["text"], "- Buy milk.\n- Call mom.")

    def test_lists_start_their_own_paragraph(self):
        engine = NoteTaker("We ship Friday. Hey, bullet that. Then we rest.")
        engine.clean = lambda text, budget=2.5, smart=None, intent=None: ("- " + text if intent == "bullets" else text, None)
        self.assertEqual(self.run_request(engine)["text"], "- We ship Friday.\n\nThen we rest.")

    def test_natural_points_command_preserves_each_spoken_item(self):
        engine = NoteTaker("Points, make this points, one. Make it more accurate, two, make it faster, three. Make it more intuitive.", llm=False)
        result = self.run_request(engine, cleanup=False)
        self.assertEqual(result["text"], "- Make it more accurate\n- Make it faster\n- Make it more intuitive.")

    def test_points_command_inside_dictation_keeps_surrounding_prose(self):
        engine = NoteTaker("We need two changes. Make this points, first fix spelling. Second check number 3.5. "
                           "New paragraph. The deadline is Friday.", llm=False)
        result = self.run_request(engine, cleanup=False)
        self.assertEqual(result["text"], "We need two changes.\n\n- Fix spelling.\n- Check number 3.5.\n\nThe deadline is Friday.")

    def test_hey_points_with_spoken_items_is_not_a_previous_dictation_edit(self):
        engine = NoteTaker("Hey, make this points, one, check the logs, two, restart the app.", llm=False)
        result = self.run_request(engine, cleanup=False, previous_output="Earlier text.")
        self.assertEqual(result["text"], "- Check the logs\n- Restart the app.")
        self.assertEqual(engine.edits, [])

    def test_spoken_numbers_create_a_numbered_list_when_formatting_is_on(self):
        raw = "One. Call Maya. Two, send the file."
        self.assertEqual(self.run_request(NoteTaker(raw), cleanup=False, context="After this")["text"],
                         "\n1. Call Maya.\n2. Send the file.")
        self.assertEqual(self.run_request(NoteTaker(raw), cleanup=False, context="After this\n")["text"],
                         "1. Call Maya.\n2. Send the file.")
        self.assertEqual(self.run_request(NoteTaker(raw), cleanup=False, smart_formatting=False)["text"], raw)

    def test_polite_list_questions_work_at_either_end_without_cleanup(self):
        for raw, expected in [
            ("Can you make this points? One, call Maya. Two, send the deck.", "- Call Maya.\n- Send the deck."),
            ("Call Maya. Send the deck. Could you number these?", "1. Call Maya.\n2. Send the deck"),
            ("Could you make this a numbered list? Call Dr. Maya; check version 3.5; send the deck.",
             "1. Call Dr. Maya\n2. Check version 3.5\n3. Send the deck."),
            ("Make this numbered points. One, call Maya. Two, send the deck.", "1. Call Maya.\n2. Send the deck."),
            ("Bullet points. Call Maya. Send the deck.", "- Call Maya.\n- Send the deck."),
            ("Numbered list. Call Maya. Send the deck.", "1. Call Maya.\n2. Send the deck."),
            ("Could you make this a numbered list? Call Maya, send the deck.", "1. Call Maya\n2. Send the deck."),
            ("Make this numbered points. Call Maya, if she's free.", "1. Call Maya, if she's free."),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(self.run_request(NoteTaker(raw, llm=False), cleanup=False)["text"], expected)

    def test_spoken_breaks_survive_at_the_edges_of_cleaned_text(self):
        engine = NoteTaker("New line. Call Maya. New paragraph.")
        engine.clean = lambda text: (text.strip(), None)
        self.assertEqual(self.run_request(engine, context="Draft")["text"], "\nCall Maya.\n\n")
        self.assertEqual(self.run_request(NoteTaker("New paragraph.", llm=False))["text"], "\n\n")
        self.assertEqual(self.run_request(NoteTaker("New Line Call Maya New Paragraph"), cleanup=False)["text"],
                         "\nCall Maya\n\n")
        literal = "New line items should be added to the new paragraph"
        self.assertEqual(worker.apply_voice_commands(literal), literal)
        self.assertFalse(worker.valid_edit("Call Maya.\n\nSend the deck.", "Call Maya. Send the deck."))

    def test_points_shorthand_does_not_repeat_duplicate_numbered_lines(self):
        raw = "Points. 1. Make it accurate. 2. Make it faster. 3. Make it clearer. 3. Make it clearer."
        self.assertEqual(self.run_request(NoteTaker(raw), cleanup=False)["text"],
                         "- Make it accurate.\n- Make it faster.\n- Make it clearer.")

    def test_plain_prose_and_decimal_values_are_not_list_labels(self):
        for raw in ("First impressions matter. Second place can still be good.",
                    "One cup is enough. Two cups is too much.",
                    "Number one hit of the summer. Number two came out in June.",
                    "Bullet points look clear on the page.",
                    "Numbered lists help me stay organized.",
                    "The update is 1.2. The next one is 2.3."):
            self.assertIsNone(worker.format_spoken_list(raw))
        self.assertEqual(worker.format_spoken_list("Make this points: Number 1, get in at 3.5. Point two, check 2 inputs."),
                         "- Get in at 3.5.\n- Check 2 inputs.")

    def test_follow_up_rewrites_the_last_paste(self):
        engine = NoteTaker("Hey, make that shorter.")
        event = self.run_request(engine, previous_output=" we will meet maya on tuesday at the office")
        self.assertEqual(event["mode"], "followup")
        self.assertEqual(engine.edits, [("we will meet maya on tuesday at the office", "make that shorter")])
        self.assertEqual(event["text"], " WE WILL MEET MAYA ON TUESDAY AT THE OFFICE")

    def test_follow_up_with_nothing_recent_types_nothing(self):
        event = self.run_request(NoteTaker("Hey, make that shorter."))
        self.assertEqual((event["mode"], event["text"]), ("followup", ""))

    def test_follow_ups_need_a_clear_reference(self):
        self.assertEqual(worker.followup_instruction("Hey, add a line about the deadline to that."), "add a line about the deadline to that")
        self.assertEqual(worker.followup_instruction("Hey Dictait, turn it into bullets."), "turn it into bullets")
        self.assertIsNone(worker.followup_instruction("Hey, add me to the channel."))
        self.assertIsNone(worker.followup_instruction("Hey, can you send that file?"))

    def test_smart_formatting_off_types_hey_as_said(self):
        engine = NoteTaker("Hey, make that shorter.")
        engine.smart_formatting = False
        event = self.run_request(engine, smart_formatting=False, previous_output="text")
        self.assertNotIn("mode", event)
        self.assertEqual(engine.cleaned, [("Hey, make that shorter.", None)])

    def test_hey_before_an_instruction_over_a_selection_still_edits(self):
        self.assertTrue(worker.looks_like_instruction("Hey, make this shorter."))

    def test_restatements_do_not_corrupt_normal_short_sentences(self):
        fix = worker.resolve_restatements
        for text in [
            "I saw John. I left.",
            "I fixed the bug in the app. The app works.",
            "We shipped the feature today. Shipped it.",
            "Let's check the code. Good code.",
        ]:
            self.assertEqual(fix(text), text, text)

    def test_valid_edit_allows_spoken_heres_icant_numbers_and_hindi(self):
        self.assertTrue(worker.valid_edit("here's the plan for tomorrow", "Here's the plan for tomorrow."))
        self.assertTrue(worker.valid_edit("i can't make it to the meeting", "I can't make it to the meeting."))
        self.assertTrue(worker.valid_edit("Pay 1000 dollars", "Pay 1,000 dollars."))
        self.assertTrue(worker.valid_edit("Meet at five", "Meet at 5."))
        self.assertFalse(worker.valid_edit("Meet at five", "Meet at 6."))
        # Hindi coverage catches dropped words instead of trivially returning 1.0.
        raw_hi = "आज मौसम बहुत अच्छा है और हम शाम को बाजार जाएंगे और खाना खाएंगे।"
        self.assertFalse(worker.valid_edit(raw_hi, "आज मौसम।"))
        self.assertTrue(worker.valid_edit(raw_hi, raw_hi))

    def test_cleanup_preserves_negations_and_allows_expanded_contractions(self):
        self.assertFalse(worker.valid_edit("Do not send the invoice.", "Do send the invoice."))
        self.assertFalse(worker.valid_edit("Maya can attend.", "Maya cannot attend."))
        self.assertFalse(worker.valid_edit("I won't send it, and Sam won't either.", "I’ll send it, and Sam won't either."))
        self.assertTrue(worker.valid_edit("I can’t attend.", "I cannot attend."))
        self.assertTrue(worker.valid_edit("I won't attend.", "I will not attend."))
        self.assertTrue(worker.valid_edit("Pick no. 2.", "Pick number 2."))

    def test_voice_commands_preserve_question_exclamation_and_decimals(self):
        self.assertEqual(worker.apply_voice_commands("Are you coming? New paragraph. Let me know."), "Are you coming?\n\nLet me know.")
        self.assertEqual(worker.apply_voice_commands("Watch out! New line. Next step."), "Watch out!\nNext step.")
        self.assertEqual(worker.apply_voice_commands("Keep this. The version is 3.5. Scratch that."), "Keep this.")
        self.assertEqual(worker.apply_voice_commands("Keep this. Meet Dr. Smith tomorrow. Scratch that."), "Keep this.")

    def test_spoken_punctuation_preserves_literal_mentions(self):
        raw = "Where is the file, question mark. I found it, exclamation point."
        self.assertEqual(worker.apply_voice_commands(raw), "Where is the file? I found it!")
        literal = "The phrase, question mark, appears on the slide."
        self.assertEqual(worker.apply_voice_commands(literal), literal)

    def test_scratch_the_last_line_removes_the_whole_line(self):
        raw = "Keep this. New line. Remove this sentence. Remove this one too. Scratch the last line. Keep the next line."
        self.assertEqual(worker.normalize_dictation(raw), "Keep this.\nKeep the next line.")

if __name__ == "__main__":
    unittest.main()
