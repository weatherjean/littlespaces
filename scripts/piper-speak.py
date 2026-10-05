"""One request per process; exiting releases the model and ONNX working memory."""
import json
import re
import sys
import wave

from piper import PiperVoice

request = json.load(sys.stdin)
text = request["text"]
if not isinstance(text, str) or not text.strip() or len(text) > 1200:
    raise ValueError("Speech text must contain 1–1200 characters.")

voice = PiperVoice.load(sys.argv[1], use_cuda=False)
# Bound inference length even when a reply contains a long sentence without punctuation.
parts = re.findall(r".{1,180}(?:\s+|$)|.{1,180}", text.replace("\n", " "))
with wave.open(sys.argv[2], "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(voice.config.sample_rate)
    for part in parts:
        for chunk in voice.synthesize(part):
            wav.writeframes(chunk.audio_int16_bytes)
