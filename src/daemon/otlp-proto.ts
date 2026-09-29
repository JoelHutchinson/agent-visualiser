// Minimal protobuf decoder for the parts of OTLP we read (opentelemetry-proto
// v1 logs and traces). It emits the same object model as OTLP/JSON so one
// mapper handles both encodings. Unknown fields are skipped, which keeps it
// forward compatible with newer proto revisions.

import type { AnyValue, KeyValue, LogRecord, OtlpRequest, Span } from '../shared/otel.js';

const utf8 = new TextDecoder();

class Reader {
  pos = 0;
  constructor(
    private readonly buf: Uint8Array,
    private readonly end = buf.length,
  ) {}

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new Error('truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('varint too long');
    }
  }

  fixed64(): bigint {
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.take(8), 8);
    return view.getBigUint64(0, true);
  }

  double(): number {
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.take(8), 8);
    return view.getFloat64(0, true);
  }

  bytes(): Uint8Array {
    const len = Number(this.varint());
    const start = this.take(len);
    return this.buf.subarray(start, start + len);
  }

  string(): string {
    return utf8.decode(this.bytes());
  }

  sub(): Reader {
    const b = this.bytes();
    return new Reader(b);
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.take(8);
    else if (wire === 2) this.take(Number(this.varint()));
    else if (wire === 5) this.take(4);
    else throw new Error(`unsupported wire type ${wire}`);
  }

  /** Iterate fields: calls fn(fieldNumber, wireType) until the end. */
  each(fn: (field: number, wire: number) => boolean | void): void {
    while (!this.done) {
      const tag = Number(this.varint());
      const field = tag >>> 3;
      const wire = tag & 7;
      if (fn(field, wire) !== true) this.skip(wire);
    }
  }

  private take(n: number): number {
    const start = this.pos;
    if (start + n > this.end) throw new Error('truncated message');
    this.pos += n;
    return start;
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function anyValue(r: Reader): AnyValue {
  const v: AnyValue = {};
  r.each((f, w) => {
    if (f === 1 && w === 2) v.stringValue = r.string();
    else if (f === 2 && w === 0) v.boolValue = r.varint() !== 0n;
    else if (f === 3 && w === 0) v.intValue = BigInt.asIntN(64, r.varint()).toString();
    else if (f === 4 && w === 1) v.doubleValue = r.double();
    else if (f === 5 && w === 2) v.arrayValue = { values: repeated(r.sub(), 1, anyValue) };
    else if (f === 6 && w === 2) v.kvlistValue = { values: repeated(r.sub(), 1, keyValue) };
    else if (f === 7 && w === 2) v.bytesValue = hex(r.bytes());
    else return false;
    return true;
  });
  return v;
}

function keyValue(r: Reader): KeyValue {
  const kv: KeyValue = { key: '' };
  r.each((f, w) => {
    if (f === 1 && w === 2) kv.key = r.string();
    else if (f === 2 && w === 2) kv.value = anyValue(r.sub());
    else return false;
    return true;
  });
  return kv;
}

function repeated<T>(r: Reader, field: number, decode: (r: Reader) => T): T[] {
  const out: T[] = [];
  r.each((f, w) => {
    if (f !== field || w !== 2) return false;
    out.push(decode(r.sub()));
    return true;
  });
  return out;
}

function resource(r: Reader) {
  return { attributes: repeated(r, 1, keyValue) };
}

function logRecord(r: Reader): LogRecord {
  const rec: LogRecord = { attributes: [] };
  r.each((f, w) => {
    if (f === 1 && w === 1) rec.timeUnixNano = r.fixed64().toString();
    else if (f === 11 && w === 1) rec.observedTimeUnixNano = r.fixed64().toString();
    else if (f === 5 && w === 2) rec.body = anyValue(r.sub());
    else if (f === 6 && w === 2) rec.attributes!.push(keyValue(r.sub()));
    else if (f === 9 && w === 2) rec.traceId = hex(r.bytes());
    else if (f === 12 && w === 2) rec.eventName = r.string();
    else return false;
    return true;
  });
  return rec;
}

function span(r: Reader): Span {
  const s: Span = { attributes: [] };
  r.each((f, w) => {
    if (f === 1 && w === 2) s.traceId = hex(r.bytes());
    else if (f === 2 && w === 2) s.spanId = hex(r.bytes());
    else if (f === 4 && w === 2) s.parentSpanId = hex(r.bytes());
    else if (f === 5 && w === 2) s.name = r.string();
    else if (f === 7 && w === 1) s.startTimeUnixNano = r.fixed64().toString();
    else if (f === 8 && w === 1) s.endTimeUnixNano = r.fixed64().toString();
    else if (f === 9 && w === 2) s.attributes!.push(keyValue(r.sub()));
    else if (f === 15 && w === 2) {
      const sr = r.sub();
      const st: NonNullable<Span['status']> = {};
      sr.each((sf, sw) => {
        if (sf === 2 && sw === 2) st.message = sr.string();
        else if (sf === 3 && sw === 0) st.code = Number(sr.varint());
        else return false;
        return true;
      });
      s.status = st;
    } else return false;
    return true;
  });
  return s;
}

export function decodeLogsRequest(buf: Uint8Array): OtlpRequest {
  const resourceLogs = repeated(new Reader(buf), 1, (rl) => {
    const out: NonNullable<OtlpRequest['resourceLogs']>[number] = { scopeLogs: [] };
    rl.each((f, w) => {
      if (f === 1 && w === 2) out.resource = resource(rl.sub());
      else if (f === 2 && w === 2) out.scopeLogs!.push({ logRecords: repeated(rl.sub(), 2, logRecord) });
      else return false;
      return true;
    });
    return out;
  });
  return { resourceLogs };
}

export function decodeTracesRequest(buf: Uint8Array): OtlpRequest {
  const resourceSpans = repeated(new Reader(buf), 1, (rs) => {
    const out: NonNullable<OtlpRequest['resourceSpans']>[number] = { scopeSpans: [] };
    rs.each((f, w) => {
      if (f === 1 && w === 2) out.resource = resource(rs.sub());
      else if (f === 2 && w === 2) out.scopeSpans!.push({ spans: repeated(rs.sub(), 2, span) });
      else return false;
      return true;
    });
    return out;
  });
  return { resourceSpans };
}
