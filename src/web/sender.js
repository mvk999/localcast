import {
  candidateDetails,
  debugEnabled,
  errorDetails,
  sdpDetails,
  trackDetails,
  transceiverDetails,
  videoCapabilities,
  videoStats
} from './diagnostics.js';

const codeInput = document.querySelector('#code');
const connectButton = document.querySelector('#connect');
const shareButton = document.querySelector('#share');
const stopButton = document.querySelector('#stop');
const pairing = document.querySelector('#pairing');
const sharing = document.querySelector('#sharing');
const status = document.querySelector('#status');
const preview = document.querySelector('#preview');
document.querySelector('#origin').textContent = location.origin;
const latencyProfile = document.querySelector('#latency-profile');

let socket;
let peer;
let stream;
let paired = false;
let pendingCandidates = [];
let remoteIceComplete = false;
let peerSequence = 0;
let statsTimer;

function emit(level, message, details) {
  const line = `[Sender] ${message}`;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](line, details ?? '');
  if (debugEnabled && paired && socket?.readyState === WebSocket.OPEN) {
    send({ type: 'debug-log', level, message, details });
  }
}

function setStatus(message) { status.textContent = message; }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function normalizeCode(value) { return value.replace(/\D/g, '').slice(0, 6); }

const VIDEO_PROFILES = {
  balanced: { label: 'Boa qualidade + baixa latência', maxWidth: 1920, maxHeight: 1080, maxBitrate: 10_000_000 },
  'low-latency': { label: 'Máxima fluidez', maxWidth: 1280, maxHeight: 720, maxBitrate: 6_000_000 }
};

function selectedVideoProfile() {
  return VIDEO_PROFILES[latencyProfile.value] ?? VIDEO_PROFILES.balanced;
}

async function configureCaptureForVideo(track, profile) {
  try {
    if ('contentHint' in track) track.contentHint = 'motion';
    if (typeof track.applyConstraints === 'function') {
      await track.applyConstraints({ width: { max: profile.maxWidth }, height: { max: profile.maxHeight }, frameRate: { max: 30 } });
    }
    emit('info', 'capture optimized for motion', { profile: profile.label, contentHint: track.contentHint, ...trackDetails(track) });
  } catch (error) {
    emit('warn', 'capture optimization not applied', errorDetails(error));
  }
}

async function configureSenderForVideo(sender, profile) {
  try {
    const parameters = sender.getParameters();
    parameters.degradationPreference = 'maintain-framerate';
    if (parameters.encodings?.length) {
      parameters.encodings[0].maxBitrate = profile.maxBitrate;
      parameters.encodings[0].maxFramerate = 30;
    }
    await sender.setParameters(parameters);
    emit('info', 'sender optimized for low delay', { profile: profile.label, maxBitrate: profile.maxBitrate, degradationPreference: parameters.degradationPreference });
  } catch (error) {
    emit('warn', 'sender latency preferences not applied', errorDetails(error));
  }
}

function stopStats() {
  clearInterval(statsTimer);
  statsTimer = undefined;
}

function startStats(instance) {
  if (!debugEnabled) return;
  stopStats();
  const sample = async () => {
    if (peer !== instance || instance.connectionState === 'closed') return stopStats();
    try { emit('info', 'outbound RTP stats', await videoStats(instance, 'outbound')); }
    catch (error) { emit('warn', 'getStats outbound failed', errorDetails(error)); }
  };
  sample();
  statsTimer = setInterval(sample, 2_000);
}

function bindTrackEvents(track, scope) {
  for (const eventName of ['ended', 'mute', 'unmute']) {
    track.addEventListener(eventName, () => {
      emit(eventName === 'ended' ? 'warn' : 'info', `${scope} track ${eventName}`, trackDetails(track));
      if (scope === 'capture' && eventName === 'ended' && stream) stopTransmission('Capture ended');
    });
  }
}

function reset(message = 'Aguardando uma TV…', { stopCapture = true } = {}) {
  stopStats();
  paired = false;
  pairing.hidden = false;
  sharing.hidden = true;
  shareButton.hidden = false;
  stopButton.hidden = true;
  codeInput.value = '';
  connectButton.disabled = true;
  if (stopCapture && stream) stream.getTracks().forEach((track) => track.stop());
  stream = undefined;
  preview.pause();
  preview.srcObject = null;
  preview.hidden = true;
  if (peer) peer.close();
  peer = undefined;
  pendingCandidates = [];
  remoteIceComplete = false;
  setStatus(message);
}

function stopTransmission(message = 'Transmissão encerrada.') {
  if (!stream && !peer) return;
  emit('info', message);
  if (stream) stream.getTracks().forEach((track) => track.stop());
  send({ type: 'stop' });
  reset('Transmissão encerrada. A TV exibirá um novo código.', { stopCapture: false });
}

function createPeer() {
  const id = ++peerSequence;
  const instance = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  peer = instance;
  emit('info', `PeerConnection #${id} created`, { iceServers: 0, senderCapabilities: videoCapabilities(RTCRtpSender) });
  instance.onicecandidate = ({ candidate }) => {
    if (!candidate) {
      emit('info', `PC #${id} ICE gathering complete`);
      send({ type: 'ice-complete' });
      return;
    }
    emit('info', `PC #${id} ICE candidate generated/sent`, candidateDetails(candidate));
    send({ type: 'candidate', candidate });
  };
  instance.onsignalingstatechange = () => emit('info', `PC #${id} signalingState`, { state: instance.signalingState });
  instance.onconnectionstatechange = () => {
    emit(instance.connectionState === 'failed' ? 'error' : 'info', `PC #${id} connectionState`, { state: instance.connectionState });
    if (instance.connectionState === 'connected') setStatus(stream?.getAudioTracks().length ? 'Transmitindo vídeo e áudio.' : 'Transmitindo vídeo.');
    if (['failed', 'disconnected'].includes(instance.connectionState)) setStatus('A conexão WebRTC foi interrompida.');
  };
  instance.oniceconnectionstatechange = () => emit(instance.iceConnectionState === 'failed' ? 'error' : 'info', `PC #${id} iceConnectionState`, { state: instance.iceConnectionState });
  instance.onicegatheringstatechange = () => emit('info', `PC #${id} iceGatheringState`, { state: instance.iceGatheringState });
  return instance;
}

async function addRemoteCandidate(candidate) {
  if (!peer?.remoteDescription) {
    pendingCandidates.push(candidate);
    emit('info', 'ICE candidate received and queued', { pending: pendingCandidates.length, ...candidateDetails(candidate) });
    return;
  }
  await peer.addIceCandidate(candidate);
  emit('info', 'ICE candidate received and added', candidateDetails(candidate));
}

async function handleMessage(message) {
  if (message.type === 'sender-ready') {
    setStatus('Digite o código exibido na TV.');
    emit('info', 'WebSocket connected');
  }
  if (message.type === 'paired') {
    paired = true;
    pairing.hidden = true;
    sharing.hidden = false;
    setStatus('TV autorizada. Escolha o que compartilhar quando estiver pronto.');
    emit('info', 'TV authorized');
  }
  if (message.type === 'pairing-denied') {
    setStatus(message.reason === 'attempts_exceeded' ? 'Tentativas excessivas. Recarregue esta página.' : `Código recusado. Tentativas restantes: ${message.remaining ?? 0}.`);
    if (message.reason === 'attempts_exceeded') connectButton.disabled = true;
  }
  if (message.type === 'answer' && peer) {
    emit('info', 'answer received', sdpDetails(message.description.sdp));
    await peer.setRemoteDescription(message.description);
    emit('info', 'remoteDescription set (answer)', { transceivers: transceiverDetails(peer) });
    for (const candidate of pendingCandidates.splice(0)) await addRemoteCandidate(candidate);
    if (remoteIceComplete) await peer.addIceCandidate(null);
  }
  if (message.type === 'candidate' && peer) await addRemoteCandidate(message.candidate);
  if (message.type === 'ice-complete' && peer) {
    if (peer.remoteDescription) await peer.addIceCandidate(null);
    else remoteIceComplete = true;
    emit('info', 'remote ICE gathering complete');
  }
  if (message.type === 'session-ended') reset('Sessão encerrada. A TV exibirá um novo código.');
}

function connectSocket() {
  socket = new WebSocket(`ws://${location.host}/signal`);
  socket.addEventListener('open', () => send({ type: 'sender-hello' }));
  socket.addEventListener('error', () => emit('error', 'WebSocket error'));
  socket.addEventListener('close', () => { if (paired) reset('Conexão local encerrada. Recarregue a página.'); });
  socket.addEventListener('message', ({ data }) => {
    Promise.resolve(JSON.parse(data)).then(handleMessage).catch((error) => {
      emit('error', 'signaling message failed', errorDetails(error));
      setStatus(`Erro de sinalização: ${error.name}`);
    });
  });
}

codeInput.addEventListener('input', () => {
  codeInput.value = normalizeCode(codeInput.value);
  connectButton.disabled = codeInput.value.length !== 6 || socket?.readyState !== WebSocket.OPEN;
});
connectButton.addEventListener('click', () => send({ type: 'pair', code: codeInput.value }));
shareButton.addEventListener('click', async () => {
  if (!paired || peer) return;
  const profile = selectedVideoProfile();
  emit('info', 'Capture requested', { profile: profile.label, target: `${profile.maxWidth}x${profile.maxHeight}@30` });
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: true,
      systemAudio: 'include',
      windowAudio: 'system'
    });
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();
    emit('info', 'Capture granted', { streamId: stream.id, videoTracks: videoTracks.length, audioTracks: audioTracks.length, tracks: stream.getTracks().map(trackDetails) });
    if (audioTracks.length === 0) emit('warn', 'No audio track was provided for the selected surface');
    if (videoTracks.length === 0) throw new Error('getDisplayMedia returned no video track.');
    for (const track of videoTracks) await configureCaptureForVideo(track, profile);
    for (const track of audioTracks) {
      if ('contentHint' in track) track.contentHint = 'music';
    }

    preview.srcObject = stream;
    preview.hidden = false;
    try {
      await preview.play();
      emit('info', 'Local preview playing', { width: preview.videoWidth, height: preview.videoHeight });
    } catch (error) {
      emit('error', 'Local preview play failed', errorDetails(error));
    }
    const instance = createPeer();
    for (const track of stream.getTracks()) {
      bindTrackEvents(track, 'capture');
      const sender = instance.addTrack(track, stream);
      if (track.kind === 'video') await configureSenderForVideo(sender, profile);
      emit('info', 'track added to RTCPeerConnection', trackDetails(track));
    }
    const senders = instance.getSenders().map((sender) => ({ track: trackDetails(sender.track) }));
    emit('info', 'peer senders after addTrack', { senders });
    if (!senders.some((sender) => sender.track.kind === 'video' && sender.track.readyState === 'live')) {
      throw new Error('No live video sender after addTrack.');
    }

    const offer = await instance.createOffer();
    emit('info', 'offer created', sdpDetails(offer.sdp));
    if (!sdpDetails(offer.sdp).videoMediaSection) throw new Error('Offer has no m=video section.');
    await instance.setLocalDescription(offer);
    emit('info', 'localDescription set (offer)', { ...sdpDetails(instance.localDescription.sdp), transceivers: transceiverDetails(instance) });
    send({ type: 'offer', description: instance.localDescription });
    emit('info', 'offer sent to TV');
    shareButton.hidden = true;
    stopButton.hidden = false;
    setStatus('Conectando vídeo à TV…');
    startStats(instance);
  } catch (error) {
    emit('error', 'share setup failed', errorDetails(error));
    setStatus(error.name === 'NotAllowedError' ? 'Compartilhamento cancelado.' : `Não foi possível compartilhar: ${error.message}`);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = undefined;
    preview.srcObject = null;
    preview.hidden = true;
    if (peer) peer.close();
    peer = undefined;
  }
});
stopButton.addEventListener('click', () => stopTransmission());

window.addEventListener('error', (event) => emit('error', 'window error', { message: event.message, source: event.filename, line: event.lineno }));
window.addEventListener('unhandledrejection', (event) => emit('error', 'unhandled rejection', errorDetails(event.reason)));

if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
  setStatus('Este navegador não disponibiliza captura de tela nesta origem. Abra http://localhost:8000 no notebook.');
} else {
  connectSocket();
}
