let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let levelerNode = null;

async function stopAudio() {
  if (levelerNode) {
    levelerNode.port.postMessage({ type: 'reset' });
    levelerNode.disconnect();
  }
  if (sourceNode) sourceNode.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  if (audioContext && audioContext.state !== 'closed') await audioContext.close();
  audioContext = null;
  mediaStream = null;
  sourceNode = null;
  levelerNode = null;
}

async function startAudio(streamId, settings) {
  await stopAudio();
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL('src/audio/audio-worklet-processor.js'),
  );
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  levelerNode = new AudioWorkletNode(audioContext, 'voice-leveler-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
  });
  levelerNode.port.postMessage({ type: 'settings', settings });
  levelerNode.port.onmessage = ({ data }) => {
    if (data?.type === 'meter') {
      chrome.runtime.sendMessage({ type: 'offscreen-meter', metrics: data });
    }
  };
  sourceNode.connect(levelerNode);
  levelerNode.connect(audioContext.destination);
  await audioContext.resume();
  chrome.runtime.sendMessage({ type: 'offscreen-status', status: 'running' });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'start-audio') {
    startAudio(message.streamId, message.settings)
      .then(() => sendResponse({ ok: true }))
      .catch(async (error) => {
        await stopAudio();
        chrome.runtime.sendMessage({
          type: 'offscreen-status',
          status: 'stopped',
          error: error instanceof Error ? error.message : String(error),
        });
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message.type === 'stop-audio') {
    stopAudio()
      .then(() => {
        chrome.runtime.sendMessage({ type: 'offscreen-status', status: 'stopped' });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'update-settings') {
    levelerNode?.port.postMessage({ type: 'settings', settings: message.settings });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
