import type { ServerMessage } from '../../src/shared/events.js';
import { parseRecording, ReplayPlayer } from '../../src/shared/replay.js';

export type LinkStatus = 'connecting' | 'open' | 'offline';

export interface Feed {
  close(): void;
  /** Only the in-browser demo can change speed. */
  setSpeed?(speed: number): void;
}

/** Websocket to the local daemon, reconnecting with backoff if it restarts. */
export function connectDaemon(onMessage: (m: ServerMessage) => void, onStatus: (s: LinkStatus) => void): Feed {
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 500;
  let closed = false;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const open = () => {
    onStatus('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 500;
      onStatus('open');
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        // Ignore anything we can't read.
      }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus('offline');
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };
  };
  open();

  return {
    close() {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    },
  };
}

/** Hosted demo: play a bundled recording entirely in the browser. */
export function playDemo(url: string, speed: number, onMessage: (m: ServerMessage) => void, onStatus: (s: LinkStatus) => void): Feed {
  let player: ReplayPlayer | undefined;
  let closed = false;
  onStatus('connecting');
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .then((text) => {
      if (closed) return;
      player = new ReplayPlayer(parseRecording(text), onMessage, { speed, loop: true });
      onStatus('open');
      player.start();
    })
    .catch(() => onStatus('offline'));

  return {
    close() {
      closed = true;
      player?.stop();
    },
    setSpeed(s) {
      player?.setSpeed(s);
    },
  };
}
