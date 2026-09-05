import {
  candidateDetails,
  debugEnabled,
  errorDetails,
  sdpDetails,
  trackDetails,
  transceiverDetails,
  videoCapabilities,
  videoElementDetails,
  videoStats
} from './diagnostics.js';

const codeElement = document.querySelector('#code');
const status = document.querySelector('#status');
const diagnostic = document.querySelector('#diagnostic');
const video = document.querySelector('#video');
const debugPanel = document.querySelector('#debug-panel');
const playOverlay = document.querySelector('#play-overlay');
const playButton = document.querySelector('#play-button');
const playResult = document.querySelector('#play-result');
let socket;
let peer;
let pendingCandidates = [];
let remoteIceComplete = false;
let peerSequence = 0;
let statsTimer;
let authorized = false;
let playAttemptInProgress = false;
const debugState = { websocket: 'connecting', session: 'waiting', peer: 'not created', ice: 'new', signaling: 'stable', track: 'not received', video: 'not attached', rtp: 'not sampled', codec: 'unknown' };

function renderDebug() {
  if (!debugEnabled) return;
  debugPanel.hidden = false;
  debugPanel.textContent = `LocalCast Debug\n${Object.entries(debugState).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n')}`;
}

function emit(level, message, details) {
  const line = `[TV] ${message}`;
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](line, details ?? '');
  if ((debugEnabled || level !== 'info') && socket?.readyState === WebSocket.OPEN) send({ type: 'debug-log', level, message, details });
}

function setStatus(message) { status.textContent = message; }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function showCode(code) { codeElement.textContent = `${code.slice(0, 3)} ${code.slice(3)}`; }
function stopStats() { clearInterval(statsTimer); statsTimer = undefined; }

function bindTrackEvents(track) {
  for (const eventName of ['ended', 'mute', 'unmute']) {
    track.addEventListener(eventName, () => emit(eventName === 'ended' ? 'warn' : 'info', `remote track ${eventName}`, trackDetails(track)));
  }
}

function resetPeer() {
  stopStats();
  pendingCandidates = [];
  remoteIceComplete = false;
  if (peer) peer.close();
  peer = undefined;
  video.pause();
  video.srcObject = null;
  playOverlay.hidden = true;
  document.body.classList.remove('has-video');
  debugState.peer = 'not created';
  debugState.track = 'not received';
  debugState.video = 'not attached';
  debugState.rtp = 'not sampled';
  renderDebug();
}

async function attemptPlay(origin) {
  if (playAttemptInProgress) return;
  playAttemptInProgress = true;
  if (origin === 'manual button') {
    playButton.disabled = true;
    playResult.textContent = 'Tentando iniciar vídeo…';
    emit('info', 'manual playback requested');
  }
  try {
    video.muted = true;
    await video.play();
    playOverlay.hidden = true;
    playResult.textContent = '';
    emit('info', `video.play resolved (${origin})`, videoElementDetails(video));
    debugState.video = { playing: true, ...videoElementDetails(video) };
  } catch (error) {
    playOverlay.hidden = false;
    playResult.textContent = `Não foi possível iniciar: ${error.name}.`;
    setStatus('Transmissão recebida, mas o navegador não iniciou o vídeo.');
    emit('error', `video.play rejected (${origin})`, errorDetails(error));
    debugState.video = { playing: false, error: error.name, ...videoElementDetails(video) };
    setTimeout(() => playButton.focus?.(), 0);
  } finally {
    playButton.disabled = false;
    playAttemptInProgress = false;
  }
  renderDebug();
}

function observeVideoEvents() {
  for (const eventName of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'pause', 'waiting', 'stalled', 'suspend', 'emptied', 'error']) {
    video.addEventListener(eventName, () => {
      const details = videoElementDetails(video);
      emit(eventName === 'error' ? 'error' : 'info', `video event: ${eventName}`, details);
      debugState.video = details;
      renderDebug();
    });
  }
}

function startStats(instance) {
  if (!debugEnabled) return;
  stopStats();
  const sample = async () => {
    if (peer !== instance || instance.connectionState === 'closed') return stopStats();
    try {
      const stats = await videoStats(instance, 'inbound');
      debugState.rtp = stats;
      debugState.codec = stats.codec?.mimeType ?? 'unknown';
      debugState.video = { ...videoElementDetails(video), playing: !video.paused };
      renderDebug();
      emit('info', 'inbound RTP stats', stats);
    } catch (error) { emit('warn', 'getStats inbound failed', errorDetails(error)); }
  };
  sample();
  statsTimer = setInterval(sample, 2_000);
}

function createPeer() {
  const id = ++peerSequence;
  const instance = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  peer = instance;
  debugState.peer = `#${id} created`;
  emit('info', `PeerConnection #${id} created`, { iceServers: 0, receiverCapabilities: videoCapabilities(RTCRtpReceiver) });
  renderDebug();
  instance.onicecandidate = ({ candidate }) => {
    if (!candidate) {
      emit('info', `PC #${id} ICE gathering complete`);
      send({ type: 'ice-complete' });
      return;
    }
    emit('info', `PC #${id} ICE candidate generated/sent`, candidateDetails(candidate));
    send({ type: 'candidate', candidate });
  };
  instance.onsignalingstatechange = () => {
    debugState.signaling = instance.signalingState;
    emit('info', `PC #${id} signalingState`, { state: instance.signalingState });
    renderDebug();
  };
  instance.onconnectionstatechange = () => {
    debugState.peer = instance.connectionState;
    emit(instance.connectionState === 'failed' ? 'error' : 'info', `PC #${id} connectionState`, { state: instance.connectionState });
    if (instance.connectionState === 'failed') setStatus('A conexão WebRTC falhou. Veja o diagnóstico.');
    renderDebug();
  };
  instance.oniceconnectionstatechange = () => {
    debugState.ice = instance.iceConnectionState;
    emit(instance.iceConnectionState === 'failed' ? 'error' : 'info', `PC #${id} iceConnectionState`, { state: instance.iceConnectionState });
    renderDebug();
  };
  instance.onicegatheringstatechange = () => emit('info', `PC #${id} iceGatheringState`, { state: instance.iceGatheringState });
  instance.ontrack = async (event) => {
    const track = event.track;
    emit('info', 'REMOTE TRACK RECEIVED', { ...trackDetails(track), streams: event.streams.length });
    debugState.track = { received: true, ...trackDetails(track), streams: event.streams.length };
    bindTrackEvents(track);
    const inboundStream = event.streams.length > 0 ? event.streams[0] : new MediaStream();
    if (event.streams.length === 0) inboundStream.addTrack(track);
    video.srcObject = inboundStream;
    document.body.classList.add('has-video');
    emit('info', 'video.srcObject assigned', { streamId: inboundStream.id, ...videoElementDetails(video) });
    await attemptPlay('ontrack');
    renderDebug();
  };
  return instance;
}

async function receiveCandidate(candidate) {
  if (!peer?.remoteDescription) {
    pendingCandidates.push(candidate);
    emit('info', 'ICE candidate received and queued', { pending: pendingCandidates.length, ...candidateDetails(candidate) });
    return;
  }
  await peer.addIceCandidate(candidate);
  emit('info', 'ICE candidate received and added', candidateDetails(candidate));
}

async function handleMessage(message) {
  if (message.type === 'session-created') {
    authorized = false;
    debugState.session = 'waiting for PIN';
    showCode(message.code);
    setStatus('Digite este código no notebook.');
    emit('info', 'receiver session created');
    renderDebug();
  }
  if (message.type === 'authorized') {
    authorized = true;
    debugState.session = 'authorized';
    setStatus('Conectado. Aguardando compartilhamento…');
    emit('info', 'authorized');
    renderDebug();
  }
  if (message.type === 'offer') {
    const earlyCandidates = pendingCandidates;
    resetPeer();
    pendingCandidates = earlyCandidates;
    const instance = createPeer();
    emit('info', 'offer received', sdpDetails(message.description.sdp));
    await instance.setRemoteDescription(message.description);
    emit('info', 'remoteDescription set (offer)', { transceivers: transceiverDetails(instance) });
    for (const candidate of pendingCandidates.splice(0)) await receiveCandidate(candidate);
    if (remoteIceComplete) await instance.addIceCandidate(null);
    const answer = await instance.createAnswer();
    emit('info', 'answer created', sdpDetails(answer.sdp));
    await instance.setLocalDescription(answer);
    emit('info', 'localDescription set (answer)', { ...sdpDetails(instance.localDescription.sdp), transceivers: transceiverDetails(instance) });
    send({ type: 'answer', description: instance.localDescription });
    emit('info', 'answer sent to sender');
    setStatus('Conectando vídeo…');
    startStats(instance);
  }
  if (message.type === 'candidate') await receiveCandidate(message.candidate);
  if (message.type === 'ice-complete' && peer) {
    if (peer.remoteDescription) await peer.addIceCandidate(null);
    else remoteIceComplete = true;
    emit('info', 'remote ICE gathering complete');
  }
  if (message.type === 'session-ended') {
    authorized = false;
    debugState.session = `ended: ${message.reason}`;
    setStatus('Sessão encerrada. Criando novo código…');
    renderDebug();
  }
}

function connect() {
  socket = new WebSocket(`ws://${location.host}/signal`);
  socket.addEventListener('open', () => {
    debugState.websocket = 'connected';
    renderDebug();
    send({ type: 'tv-hello' });
  });
  socket.addEventListener('error', () => emit('error', 'WebSocket error'));
  socket.addEventListener('close', () => {
    authorized = false;
    debugState.websocket = 'closed; reconnecting';
    resetPeer();
    codeElement.textContent = '··· ···';
    setStatus('Criando novo código…');
    renderDebug();
    setTimeout(connect, 600);
  });
  socket.addEventListener('message', ({ data }) => {
    Promise.resolve(JSON.parse(data)).then(handleMessage).catch((error) => {
      emit('error', 'signaling message failed', errorDetails(error));
      setStatus(`Erro de sinalização: ${error.name}`);
    });
  });
}

function requestManualPlayback(event) {
  event?.preventDefault();
  attemptPlay('manual button');
}
playButton.addEventListener('click', requestManualPlayback);
playButton.addEventListener('touchend', requestManualPlayback);
playButton.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') requestManualPlayback(event);
});
observeVideoEvents();
window.addEventListener('error', (event) => emit('error', 'window error', { message: event.message, source: event.filename, line: event.lineno }));
window.addEventListener('unhandledrejection', (event) => emit('error', 'unhandled rejection', errorDetails(event.reason)));

const supported = window.WebSocket && window.RTCPeerConnection;
diagnostic.textContent = supported
  ? (debugEnabled ? 'Diagnóstico ativo. Logs também aparecem no notebook.' : 'Digite este código no notebook. Esta TV apenas recebe o vídeo.')
  : 'Este navegador não oferece as APIs WebSocket/WebRTC necessárias.';
renderDebug();
if (supported) connect();
