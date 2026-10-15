export function canDictate() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}
export function dictate(onText, onEnd, onError) {
  const Constructor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Constructor)
    throw Error(
      'Voice input is not supported in this browser. Try Chrome or Edge, or type your message.',
    );
  const recognition = new Constructor();
  recognition.lang = navigator.language;
  recognition.interimResults = false;
  recognition.onresult = (e) =>
    onText(
      Array.from(e.results)
        .map((result) => result[0].transcript)
        .join(' '),
    );
  recognition.onerror = (e) => {
    const messages = {
      'not-allowed': 'Microphone access was denied. Allow access in your browser settings.',
      'service-not-allowed': 'Speech recognition is not allowed by this browser or device.',
      'audio-capture': 'No microphone is available. Check your device settings.',
      'no-speech': 'No speech was detected. Try speaking again.',
      network: 'Speech recognition lost its connection. Try again when you are online.',
      aborted: 'Voice input stopped.',
      'language-not-supported': 'Speech recognition does not support the selected language.',
    };
    onError(
      `${messages[e.error] || 'Speech recognition could not finish. Try again.'} You can still type your message.`,
    );
  };
  recognition.onend = onEnd;
  recognition.start();
  return {
    stop: () => recognition.stop(),
    cancel: () => {
      // stop() may still deliver a final result; disposal must never submit it.
      recognition.onresult = recognition.onerror = recognition.onend = null;
      if (recognition.abort) recognition.abort();
      else recognition.stop();
    },
  };
}
const voicePreference = 'little-spaces-speaking-voice';
export function savedVoice() {
  try {
    return localStorage.getItem(voicePreference) || '';
  } catch {
    return '';
  }
}
export function saveVoice(value) {
  try {
    localStorage.setItem(voicePreference, value);
  } catch {
    /* Session choice still works. */
  }
}
export function speakingVoices() {
  const language = navigator.language.toLowerCase();
  const novelty =
    /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Trinoids|Whisper|Wobble|Zarvox)$/i;
  const score = (v) => {
    const lang = v.lang.toLowerCase().replace('_', '-');
    return (
      (lang === language ? 100 : lang.split('-')[0] === language.split('-')[0] ? 50 : 0) +
      (/natural|enhanced|premium|Google|Siri/i.test(v.name)
        ? 30
        : /Samantha|Daniel|Karen|Moira|Tessa/i.test(v.name)
          ? 20
          : 0) +
      (v.default ? 1 : 0)
    );
  };
  return (window.speechSynthesis?.getVoices() || [])
    .filter((v) => !novelty.test(v.name))
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
export function speak(text, onEnd = () => {}, voiceURI = savedVoice()) {
  window.speechSynthesis?.cancel();
  if (!window.speechSynthesis || !text) return;
  const voices = speakingVoices();
  const voice = voices.find((v) => v.voiceURI === voiceURI) || voices[0];
  // Read words rather than Markdown punctuation and link destinations.
  const plain = text.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').replace(/[*`#]/g, '');
  const spoken = new SpeechSynthesisUtterance(plain);
  if (voice) spoken.voice = voice;
  spoken.lang = voice?.lang || navigator.language;
  spoken.onend = onEnd;
  spoken.onerror = onEnd;
  window.speechSynthesis.speak(spoken);
}
