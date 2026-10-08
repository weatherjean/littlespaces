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
  recognition.onerror = (e) => onError(`Voice input: ${e.error}. You can still type your message.`);
  recognition.onend = onEnd;
  recognition.start();
  return () => recognition.stop();
}
export function speak(text) {
  window.speechSynthesis?.cancel();
  if (!window.speechSynthesis || !text) return;
  const spoken = new SpeechSynthesisUtterance(text);
  spoken.lang = navigator.language;
  window.speechSynthesis.speak(spoken);
}
