// Device-owned speech; the Rust server never loads a speech model.
const preference = 'little-spaces-speech-voice';
let activeUtterance = null;
let playing = false;
const playbackListeners = new Set();
function playback(value) {
  playing = value;
  playbackListeners.forEach((listener) => listener(value));
}
export function subscribePlayback(listener) {
  playbackListeners.add(listener);
  listener(playing);
  return () => playbackListeners.delete(listener);
}
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
  activeUtterance = null;
  window.speechSynthesis?.cancel();
  playback(false);
}
export function speak(text) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance)
    throw Error('Speech playback is unavailable on this device.');
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voices().find((voice) => voice.voiceURI === selectedVoice()) || null;
  activeUtterance = utterance;
  utterance.onstart = () => {
    if (activeUtterance === utterance) playback(true);
  };
  utterance.onend = utterance.onerror = () => {
    if (activeUtterance !== utterance) return;
    activeUtterance = null;
    playback(false);
  };
  try {
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    activeUtterance = null;
    playback(false);
    throw error;
  }
}
