const codeElement = document.querySelector('#code');
const status = document.querySelector('#status');
const diagnostic = document.querySelector('#diagnostic');
const video = document.querySelector('#video');
let socket;
let peer;
let pendingCandidates = [];

const supported = window.WebSocket && window.RTCPeerConnection;
diagnostic.textContent = supported
  ? 'Digite este código no notebook. Esta TV apenas recebe o vídeo.'
  : 'Este navegador não oferece as APIs WebSocket/WebRTC necessárias.';

function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function showCode(code) { codeElement.textContent = `${code.slice(0, 3)} ${code.slice(3)}`; }
function resetPeer() {
  pendingCandidates = [];
  if (peer) peer.close();
  peer = undefined;
  video.srcObject = null;
  document.body.classList.remove('has-video');
}
function createPeer() {
  peer = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  peer.onicecandidate = ({ candidate }) => send(candidate ? { type: 'candidate', candidate } : { type: 'ice-complete' });
  peer.ontrack = async ({ streams }) => {
    video.srcObject = streams[0];
    try { await video.play(); } catch { status.textContent = 'Vídeo recebido. Se necessário, confirme a reprodução no controle da TV.'; }
    document.body.classList.add('has-video');
  };
  peer.onconnectionstatechange = () => {
    if (peer?.connectionState === 'failed') status.textContent = 'A conexão WebRTC falhou. A TV exibirá um novo código.';
  };
}
async function receiveCandidate(candidate) {
  if (!peer?.remoteDescription) pendingCandidates.push(candidate);
  else await peer.addIceCandidate(candidate);
}
function connect() {
  socket = new WebSocket(`ws://${location.host}/signal`);
  socket.addEventListener('open', () => send({ type: 'tv-hello' }));
  socket.addEventListener('close', () => {
    resetPeer();
    codeElement.textContent = '··· ···';
    status.textContent = 'Criando novo código…';
    setTimeout(connect, 600);
  });
  socket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'session-created') {
      showCode(message.code);
      status.textContent = 'Digite este código no notebook.';
    }
    if (message.type === 'authorized') status.textContent = 'Conectado. Aguardando compartilhamento…';
    if (message.type === 'offer') {
      const earlyCandidates = pendingCandidates;
      resetPeer();
      pendingCandidates = earlyCandidates;
      createPeer();
      await peer.setRemoteDescription(message.description);
      for (const candidate of pendingCandidates.splice(0)) await peer.addIceCandidate(candidate);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      send({ type: 'answer', description: peer.localDescription });
      status.textContent = 'Conectando vídeo…';
    }
    if (message.type === 'candidate') await receiveCandidate(message.candidate);
    if (message.type === 'ice-complete' && peer?.remoteDescription) await peer.addIceCandidate(null);
    if (message.type === 'session-ended') status.textContent = 'Sessão encerrada. Criando novo código…';
  });
}

if (supported) connect();
