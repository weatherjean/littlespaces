type Recognition = {
  lang: string; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
};
type VoiceWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

export function canDictate() {
  const browser = window as VoiceWindow;
  return Boolean(browser.SpeechRecognition || browser.webkitSpeechRecognition);
}

export function dictate(onText: (text: string) => void, onEnd: () => void, onError: (error: string) => void) {
  const browser = window as VoiceWindow;
  const Constructor = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  if (!Constructor) throw new Error('Voice input is not supported in this browser. Try Chrome or Edge.');
  const recognition = new Constructor();
  recognition.lang = navigator.language;
  recognition.interimResults = false;
  recognition.onresult = (event) => onText(Array.from(event.results).map((result) => result[0].transcript).join(' '));
  recognition.onerror = (event) => onError(`Voice input: ${event.error}. You can still type your message.`);
  recognition.onend = onEnd;
  recognition.start();
  return () => recognition.stop();
}
