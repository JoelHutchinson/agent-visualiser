import http from 'node:http';
import http2 from 'node:http2';
import zlib from 'node:zlib';
import type { VisEvent } from '../shared/events.js';
import { otlpToEvents, type OtlpRequest } from '../shared/otel.js';
import { decodeLogsRequest, decodeTracesRequest } from './otlp-proto.js';

// A local OTLP endpoint so any OpenTelemetry-instrumented agent can drive the
// scene. Loopback only; bodies are decoded, mapped to events and discarded.
// Metrics are accepted (so exporters don't log errors) but ignored.

const MAX_BODY = 16 * 1024 * 1024;

type Signal = 'logs' | 'traces' | 'metrics';

function decode(signal: Signal, body: Buffer, json: boolean): OtlpRequest {
  if (signal === 'metrics') return {};
  if (json) return JSON.parse(body.toString('utf8'));
  return signal === 'logs' ? decodeLogsRequest(body) : decodeTracesRequest(body);
}

function inflate(body: Buffer, encoding: string | undefined): Buffer {
  if (!encoding || encoding === 'identity') return body;
  if (encoding === 'gzip') return zlib.gunzipSync(body, { maxOutputLength: MAX_BODY });
  if (encoding === 'deflate') return zlib.inflateSync(body, { maxOutputLength: MAX_BODY });
  throw new Error(`unsupported encoding ${encoding}`);
}

export interface OtlpServer {
  close(): Promise<void>;
}

/** OTLP/HTTP: POST /v1/logs, /v1/traces, /v1/metrics with JSON or protobuf. */
export function startOtlpHttp(port: number, onEvents: (evs: VisEvent[]) => void): Promise<OtlpServer> {
  const server = http.createServer((req, res) => {
    const signal = /^\/v1\/(logs|traces|metrics)\/?$/.exec(req.url?.split('?')[0] ?? '')?.[1] as Signal | undefined;
    if (req.method !== 'POST' || !signal) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const json = (req.headers['content-type'] ?? '').includes('json');
      try {
        const body = inflate(Buffer.concat(chunks), req.headers['content-encoding']);
        onEvents(otlpToEvents(decode(signal, body, json)));
        // An empty Export*ServiceResponse means full success.
        res.writeHead(200, { 'content-type': json ? 'application/json' : 'application/x-protobuf' });
        res.end(json ? '{}' : undefined);
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  return listen(server, port);
}

const GRPC_PATHS: Record<string, Signal> = {
  '/opentelemetry.proto.collector.logs.v1.LogsService/Export': 'logs',
  '/opentelemetry.proto.collector.trace.v1.TraceService/Export': 'traces',
  '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export': 'metrics',
};

/** OTLP/gRPC over cleartext HTTP/2, the default for many exporters (port 4317). */
export function startOtlpGrpc(port: number, onEvents: (evs: VisEvent[]) => void): Promise<OtlpServer> {
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const signal = GRPC_PATHS[String(headers[':path'])];
    const respond = (status: number, message = '') => {
      if (stream.closed) return;
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () =>
        stream.sendTrailers({ 'grpc-status': String(status), ...(message ? { 'grpc-message': encodeURIComponent(message) } : {}) }),
      );
      // Empty response message: uncompressed flag + zero length.
      stream.end(status === 0 ? Buffer.alloc(5) : undefined);
    };
    if (!signal) return respond(12, 'unimplemented');

    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) stream.close(http2.constants.NGHTTP2_CANCEL);
      else chunks.push(c);
    });
    stream.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const events: VisEvent[] = [];
        // A gRPC body is a sequence of length-prefixed messages.
        for (let off = 0; off + 5 <= buf.length; ) {
          const compressed = buf[off] === 1;
          const len = buf.readUInt32BE(off + 1);
          let msg: Buffer = buf.subarray(off + 5, off + 5 + len);
          off += 5 + len;
          if (compressed) msg = inflate(msg, String(headers['grpc-encoding'] ?? 'gzip'));
          events.push(...otlpToEvents(decode(signal, msg, false)));
        }
        onEvents(events);
        respond(0);
      } catch (err) {
        respond(3, err instanceof Error ? err.message : 'invalid request');
      }
    });
    stream.on('error', () => {});
  });
  return listen(server, port);
}

function listen(server: http.Server | http2.Http2Server, port: number): Promise<OtlpServer> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        close: () => new Promise((done) => server.close(() => done())),
      }),
    );
  });
}
