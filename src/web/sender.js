const codeInput = document.querySelector('#code');
const connectButton = document.querySelector('#connect');
const shareButton = document.querySelector('#share');
const stopButton = document.querySelector('#stop');
const pairing = document.querySelector('#pairing');
const sharing = document.querySelector('#sharing');
const status = document.querySelector('#status');
document.querySelector('#origin').textContent = location.origin;

let socket;
let peer;
let stream;
let paired = false;
let pendingCandidates = [];
let remoteIceComplete = false;

function setStatus(message) { status.textContent = message; }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function normalizeCode(value) { return value.replace(/\D/g, '').slice(0, 6); }

function reset(message = 'Aguardando uma TV…') {
  paired = false;
  pairing.hidden = false;
  sharing.hidden = true;
  shareButton.hidden = false;
  stopButton.hidden = true;
  codeInput.value = '';
  connectButton.disabled = true;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = undefined;
  if (peer) peer.close();
  peer = undefined;
  pendingCandidates = [];
  remoteIceComplete = false;
  setStatus(message);
}

function createPeer() {
  peer = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  peer.onicecandidate = ({ candidate }) => send(candidate ? { type: 'candidate', candidate } : { type: 'ice-complete' });
  peer.onconnectionstatechange = () => {
    if (peer?.connectionState === 'connected') setStatus('Transmitindo.');
    if (['failed', 'disconnected'].includes(peer?.connectionState)) setStatus('A conexão WebRTC foi interrompida.');
  };
}

function connectSocket() {
  socket = new WebSocket(`ws://${location.host}/signal`);
  socket.addEventListener('open', () => send({ type: 'sender-hello' }));
  socket.addEventListener('close', () => { if (paired) reset('Conexão local encerrada. Recarregue a página.'); });
  socket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'sender-ready') setStatus('Digite o código exibido na TV.');
    if (message.type === 'paired') {
      paired = true;
      pairing.hidden = true;
      sharing.hidden = false;
      setStatus('TV autorizada. Escolha o que compartilhar quando estiver pronto.');
    }
    if (message.type === 'pairing-denied') {
      setStatus(message.reason === 'attempts_exceeded' ? 'Tentativas excessivas. Recarregue esta página.' : `Código recusado. Tentativas restantes: ${message.remaining ?? 0}.`);
      if (message.reason === 'attempts_exceeded') connectButton.disabled = true;
    }
    if (message.type === 'answer' && peer) {
      await peer.setRemoteDescription(message.description);
      for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
      if (remoteIceComplete) await peer.addIceCandidate(null);
    }
    if (message.type === 'candidate' && peer) {
      if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
      else pendingCandidates.push(message.candidate);
    }
    if (message.type === 'ice-complete' && peer) {
      if (peer.remoteDescription) await peer.addIceCandidate(null);
      else remoteIceComplete = true;
    }
    if (message.type === 'session-ended') reset('Sessão encerrada. A TV exibirá um novo código.');
  });
}

codeInput.addEventListener('input', () => {
  codeInput.value = normalizeCode(codeInput.value);
  connectButton.disabled = codeInput.value.length !== 6 || socket?.readyState !== WebSocket.OPEN;
});
connectButton.addEventListener('click', () => send({ type: 'pair', code: codeInput.value }));
shareButton.addEventListener('click', async () => {
  if (!paired || peer) return;
  try {
    // This user gesture is the first and only point at which screen capture is requested.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    createPeer();
    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => { if (stream) stopButton.click(); }, { once: true });
      peer.addTrack(track, stream);
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    send({ type: 'offer', description: peer.localDescription });
    shareButton.hidden = true;
    stopButton.hidden = false;
    setStatus('Conectando vídeo à TV…');
  } catch (error) {
    setStatus(error.name === 'NotAllowedError' ? 'Compartilhamento cancelado.' : `Não foi possível compartilhar: ${error.message}`);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = undefined;
    if (peer) peer.close();
    peer = undefined;
  }
});
stopButton.addEventListener('click', () => {
  if (stream) stream.getTracks().forEach((track) => track.stop());
  send({ type: 'stop' });
  reset('Transmissão encerrada. A TV exibirá um novo código.');
});

if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
  setStatus('Este navegador não disponibiliza captura de tela nesta origem. Abra http://localhost:8000 no notebook.');
} else {
  connectSocket();
}
