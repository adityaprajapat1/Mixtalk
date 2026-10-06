/**
 * WebRTC configuration with STUN/TURN integration points.
 * TURN credentials must come from server env — never hardcode secrets in the client.
 */

export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // Public STUN only by default. TURN is injected via /api/webrtc-config
  // when TURN_SERVER / TURN_USERNAME / TURN_PASSWORD are set on the server.
  return servers;
}

export interface WebRtcConfig {
  iceServers: RTCIceServer[];
  turnConfigured: boolean;
}

/** Client fetches this so TURN secrets never ship in the JS bundle. */
export async function fetchWebRtcConfig(): Promise<WebRtcConfig> {
  try {
    const res = await fetch("/api/webrtc-config");
    if (res.ok) return res.json();
  } catch {
    // fall through
  }
  return { iceServers: getIceServers(), turnConfigured: false };
}

export async function createPeerConnection(
  onIce: (c: RTCIceCandidate) => void,
  onTrack: (e: RTCTrackEvent) => void
): Promise<RTCPeerConnection> {
  const config = await fetchWebRtcConfig();
  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  pc.onicecandidate = (ev) => {
    if (ev.candidate) onIce(ev.candidate);
  };
  pc.ontrack = onTrack;
  return pc;
}
