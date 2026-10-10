/**
 * A tiny in-process stand-in for RTCPeerConnection (Node has none): an
 * offer/answer pair is matched through a shared registry by SDP string, ICE
 * candidates are exchanged but meaningless, and the data channel is a
 * microtask pipe. Enough to test signaling, glare avoidance and the link.
 */
/** offer sdp -> the answering peer connection */
const answerers = new Map();
let counter = 0;

class FakeChannel {
  readyState = 'connecting';
  binaryType = 'blob';
  peer = null;
  onopen = null;
  onmessage = null;
  onclose = null;
  send(bytes) {
    if (this.readyState !== 'open') throw new Error('channel not open');
    const copy = bytes.slice().buffer;
    queueMicrotask(() => this.peer?.readyState === 'open' && this.peer.onmessage?.({ data: copy }));
  }
  close() {
    for (const ch of [this, this.peer]) {
      if (!ch || ch.readyState === 'closed') continue;
      ch.readyState = 'closed';
      queueMicrotask(() => ch.onclose?.());
    }
  }
}

export class FakeRTCPeerConnection {
  static created = 0;
  localDescription = null;
  remoteDescription = null;
  connectionState = 'new';
  onicecandidate = null;
  ondatachannel = null;
  onconnectionstatechange = null;
  channel = null;

  constructor() {
    FakeRTCPeerConnection.created++;
  }
  createDataChannel() {
    this.channel = new FakeChannel();
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: `fake-offer-${++counter}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `fake-answer-${this.remoteDescription.sdp}` };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
    queueMicrotask(() => this.onicecandidate?.({ candidate: { candidate: 'candidate:fake', sdpMid: '0' } }));
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    if (description.type === 'offer') answerers.set(description.sdp, this);
    if (description.type === 'answer') {
      const answerer = answerers.get(description.sdp.replace('fake-answer-', ''));
      answerers.delete(this.localDescription.sdp);
      if (!answerer || !this.channel) return;
      const remote = new FakeChannel();
      answerer.channel = remote; // closing either connection closes both ends, as in a real browser
      this.channel.peer = remote;
      remote.peer = this.channel;
      for (const pc of [this, answerer]) pc.connectionState = 'connected';
      queueMicrotask(() => {
        answerer.ondatachannel?.({ channel: remote });
        queueMicrotask(() => {
          for (const ch of [this.channel, remote]) {
            ch.readyState = 'open';
            ch.onopen?.();
          }
        });
      });
    }
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = 'closed';
    this.channel?.close();
  }
}
