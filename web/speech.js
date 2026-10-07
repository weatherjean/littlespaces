// Device-owned speech; the Rust server never loads a speech model.
const preference = 'little-spaces-speech-voice';
export function voices() {
  return window.speechSynthesis?.getVoices() || [];
}
export function selectedVoice() {
  try {
    return localStorage.getItem(preference) || '';
  } catch {
    return '';
  }
}
export function chooseVoice(uri) {
  try {
    localStorage.setItem(preference, uri);
  } catch {}
}
export function stopSpeech() {
  window.speechSynthesis?.cancel();
}
export function speak(text) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance)
    throw Error('Speech playback is unavailable on this device.');
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voices().find((voice) => voice.voiceURI === selectedVoice()) || null;
  window.speechSynthesis.speak(utterance);
}
