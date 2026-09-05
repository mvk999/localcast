export const debugEnabled = new URLSearchParams(location.search).get('debug') === '1';

function defined(value) {
  return value === undefined || value === null ? undefined : value;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function errorDetails(error) {
  return compact({ name: error?.name ?? 'Error', message: error?.message ?? String(error) });
}

export function trackDetails(track) {
  if (!track) return {};
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
  return compact({
    kind: track.kind,
    id: track.id,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate,
    displaySurface: settings.displaySurface
  });
}

export function candidateDetails(candidate) {
  const parts = candidate?.candidate?.trim().split(/\s+/) ?? [];
  const typ = parts.indexOf('typ');
  return compact({
    type: typ >= 0 ? parts[typ + 1] : undefined,
    protocol: parts[2],
    address: parts[4],
    port: parts[5],
    sdpMid: candidate?.sdpMid,
    sdpMLineIndex: candidate?.sdpMLineIndex
  });
}

export function sdpDetails(sdp) {
  const lines = typeof sdp === 'string' ? sdp.split(/\r?\n/) : [];
  const media = lines.filter((line) => line.startsWith('m=')).map((line) => line.split(' ')[0].slice(2));
  const directions = lines.filter((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)).map((line) => line.slice(2));
  return { videoMediaSection: media.includes('video'), media, directions };
}

export function transceiverDetails(peer) {
  if (typeof peer.getTransceivers !== 'function') return [];
  return peer.getTransceivers().map((transceiver) => compact({
    mid: transceiver.mid,
    direction: transceiver.direction,
    currentDirection: transceiver.currentDirection,
    senderTrack: transceiver.sender?.track?.kind,
    receiverTrack: transceiver.receiver?.track?.kind
  }));
}

export function videoCapabilities(api) {
  try {
    return api?.getCapabilities?.('video')?.codecs
      ?.filter((codec) => !/rtx|red|ulpfec|flexfec/i.test(codec.mimeType))
      .map((codec) => ({ mimeType: codec.mimeType, clockRate: codec.clockRate, sdpFmtpLine: codec.sdpFmtpLine })) ?? [];
  } catch {
    return [];
  }
}

export async function videoStats(peer, direction) {
  const reports = [...await peer.getStats()];
  const codecs = new Map(reports.filter((report) => report.type === 'codec').map((report) => [report.id, report]));
  const type = direction === 'outbound' ? 'outbound-rtp' : 'inbound-rtp';
  const report = reports.find((item) => item.type === type && (item.kind === 'video' || item.mediaType === 'video'));
  if (!report) return { available: false };
  const codec = codecs.get(report.codecId);
  const common = {
    available: true,
    bytes: direction === 'outbound' ? report.bytesSent : report.bytesReceived,
    packets: direction === 'outbound' ? report.packetsSent : report.packetsReceived,
    packetsLost: report.packetsLost,
    frameWidth: report.frameWidth,
    frameHeight: report.frameHeight,
    framesPerSecond: report.framesPerSecond,
    codec: codec && compact({ mimeType: codec.mimeType, clockRate: codec.clockRate, sdpFmtpLine: codec.sdpFmtpLine, payloadType: codec.payloadType })
  };
  return compact(direction === 'outbound'
    ? { ...common, framesEncoded: report.framesEncoded, framesSent: report.framesSent }
    : { ...common, framesReceived: report.framesReceived, framesDecoded: report.framesDecoded, framesDropped: report.framesDropped,
      jitterBufferAvgMs: report.jitterBufferEmittedCount ? Math.round((report.jitterBufferTargetDelay / report.jitterBufferEmittedCount) * 1_000) : undefined });
}

export function videoElementDetails(video) {
  return {
    readyState: video.readyState,
    networkState: video.networkState,
    paused: video.paused,
    ended: video.ended,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    currentTime: Number(video.currentTime.toFixed(2))
  };
}
