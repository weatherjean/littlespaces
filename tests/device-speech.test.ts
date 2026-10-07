import assert from 'node:assert/strict';
import test from 'node:test';
import { speak, stopSpeech, subscribePlayback } from '../web/speech.js';

test('playback reports start, finish, failure and cancellation without stale events', () => {
  class Utterance {
    onstart?: () => void;
    onend?: () => void;
    onerror?: () => void;
    constructor(public text: string) {}
  }
  const utterances: Utterance[] = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousUtterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      SpeechSynthesisUtterance: Utterance,
      speechSynthesis: {
        cancel() {},
        getVoices: () => [],
        speak: (value: Utterance) => utterances.push(value),
      },
    },
  });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: Utterance,
  });
  let playing = false;
  const unsubscribe = subscribePlayback((value: boolean) => {
    playing = value;
  });
  try {
    speak('First reply');
    utterances[0].onstart?.();
    assert.equal(playing, true);
    utterances[0].onend?.();
    assert.equal(playing, false);
    speak('Second reply');
    utterances[1].onstart?.();
    assert.equal(playing, true);
    stopSpeech();
    assert.equal(playing, false);
    speak('Third reply');
    utterances[2].onstart?.();
    utterances[1].onend?.();
    assert.equal(playing, true, 'An old cancellation event must not stop the new reply');
    utterances[2].onerror?.();
    assert.equal(playing, false);
  } finally {
    stopSpeech();
    unsubscribe();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousUtterance)
      Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', previousUtterance);
    else Reflect.deleteProperty(globalThis, 'SpeechSynthesisUtterance');
  }
});
