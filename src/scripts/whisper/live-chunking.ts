/**
 * Whisper Live — DataChannel chunking and reassembly.
 *
 * A DataChannel message can't exceed the peers' negotiated max-message-size. RFC
 * 8841 says assume 65536 when the SDP carries no `a=max-message-size`, so 60 KB is
 * the safe default here; live.ts raises it toward the real negotiated size (often
 * 256 KB) once the SCTP transport reports it. We chunk larger messages and
 * reassemble on the other side.
 *
 * Chunk format:
 *   [0]      chunk type (0x01 = start, 0x02 = continue, 0x03 = end, 0x04 = single)
 *   [1..4]   total message length (4B LE, only in start chunk)
 *   [5..]    chunk data
 */

/** Safe default payload per chunk when the negotiated max-message-size is unknown. */
export const CHUNK_SIZE = 61_440; // 60 KB, comfortably under the RFC 8841 assumed 64 KB
const CHUNK_START = 0x01;
const CHUNK_CONTINUE = 0x02;
const CHUNK_END = 0x03;
const CHUNK_SINGLE = 0x04;
/** Resume sending once the DataChannel's send buffer drains to here (low-water). */
export const BUFFERED_AMOUNT_LOW = 256 * 1024;
/** Pause sending once it climbs above here (high-water). The gap between the two is
 *  the pipe depth — deep enough to ride out network jitter without a drain stall
 *  every few frames, shallow enough that a cancel isn't buried under megabytes. */
export const BUFFERED_AMOUNT_HIGH = 2 * 1024 * 1024;

const START_TOTAL_LENGTH_BYTES = 4;
const SINGLE_DATA_OFFSET = 1;
const START_DATA_OFFSET = 5;
const CONT_DATA_OFFSET = 1;

/**
 * Exact wire-byte estimate for chunkMessagePrefixed without materializing chunks.
 * Pass the same chunkSize iterateChunksPrefixed will be called with.
 */
export function estimateChunkedPrefixedSize(payloadBytes: number, chunkSize: number = CHUNK_SIZE): number {
  // Math.floor, not | 0: the bitwise-or coerces through a 32-bit signed int and
  // wraps negative for payloads over 2 GB, which real file transfers exceed.
  const len = Math.max(0, Math.floor(payloadBytes));
  if (len <= chunkSize) return 2 + len; // prefix + single type + payload

  const startPayload = Math.min(chunkSize - START_TOTAL_LENGTH_BYTES, len);
  const remaining = len - startPayload;
  // Start chunk: prefix + type + totalLen(4) + payload
  let total = 6 + startPayload;

  if (remaining <= 0) return total;
  const tailChunks = Math.ceil(remaining / chunkSize);
  // each tail chunk: prefix + type + payload slice
  total += tailChunks * 2 + remaining;
  return total;
}

/**
 * Iterate chunked, prefixed wire frames lazily.
 *
 * accepts a single buffer or multiple parts (virtual concatenation).
 * multi-part avoids a full-payload concat when the caller has
 * [header, ciphertext] as separate buffers — the cursor reads
 * across part boundaries with zero intermediate allocation.
 */
export function* iterateChunksPrefixed(
  data: Uint8Array | readonly Uint8Array[],
  prefix: number,
  chunkSize: number = CHUNK_SIZE,
): Generator<Uint8Array> {
  const parts = data instanceof Uint8Array ? [data] : data;
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;

  // cursor into the virtual concatenation of parts
  let pi = 0, po = 0;
  const fill = (dest: Uint8Array, off: number, len: number) => {
    let n = 0;
    while (n < len) {
      const avail = parts[pi].length - po;
      const take = avail < len - n ? avail : len - n;
      dest.set(parts[pi].subarray(po, po + take), off + n);
      n += take;
      po += take;
      if (po >= parts[pi].length) { pi++; po = 0; }
    }
  };

  if (totalLen <= chunkSize) {
    const chunk = new Uint8Array(2 + totalLen);
    chunk[0] = prefix;
    chunk[1] = CHUNK_SINGLE;
    fill(chunk, 2, totalLen);
    yield chunk;
    return;
  }

  const startPayload = Math.min(chunkSize - START_TOTAL_LENGTH_BYTES, totalLen);
  const startChunk = new Uint8Array(6 + startPayload);
  startChunk[0] = prefix;
  startChunk[1] = CHUNK_START;
  new DataView(startChunk.buffer).setUint32(2, totalLen, true);
  fill(startChunk, 6, startPayload);
  yield startChunk;
  let sent = startPayload;

  while (sent < totalLen) {
    const remaining = totalLen - sent;
    const payloadSize = remaining < chunkSize ? remaining : chunkSize;
    const chunk = new Uint8Array(2 + payloadSize);
    chunk[0] = prefix;
    chunk[1] = sent + payloadSize >= totalLen ? CHUNK_END : CHUNK_CONTINUE;
    fill(chunk, 2, payloadSize);
    yield chunk;
    sent += payloadSize;
  }
}

/**
 * Chunk a message for DataChannel transport, baking in a wire prefix byte
 * at position [0] of each chunk. This avoids a second allocation + copy
 * in encryptAndSend — chunks are ready to send directly.
 */
export function chunkMessagePrefixed(data: Uint8Array, prefix: number, chunkSize: number = CHUNK_SIZE): Uint8Array[] {
  return Array.from(iterateChunksPrefixed(data, prefix, chunkSize));
}

export class ChunkAssembler {
  private chunks: Uint8Array[] = [];
  private receiving = false;
  // peer-declared total from the start chunk, not used to pre-allocate, only to
  // validate the assembled result against what the peer claimed on CHUNK_END.
  private declaredTotalLength = 0;

  /** Feed a chunk. Returns the complete message when all chunks received, or null if incomplete. */
  feed(chunk: Uint8Array): Uint8Array | null {
    const type = chunk[0];

    if (type === CHUNK_SINGLE) {
      // a single-frame message arriving mid-reassembly means the peer abandoned the
      // in-progress multi-chunk message: drop that partial state, don't merge it in.
      if (this.receiving) this.reset();
      return chunk.subarray(SINGLE_DATA_OFFSET);
    }

    if (type === CHUNK_START) {
      this.reset();
      if (chunk.length < START_DATA_OFFSET) return null; // truncated, no length field to read: drop
      this.receiving = true;
      // don't pre-allocate from peer-declared totalLength, just start collecting,
      // but remember it to validate the assembled result against on CHUNK_END.
      this.declaredTotalLength = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        .getUint32(1, true); // offset 1: type(1) precedes totalLength(4)
      const payload = chunk.subarray(START_DATA_OFFSET); // skip type(1) + totalLength(4)
      if (payload.length > 0) this.chunks.push(payload.slice());
      return null;
    }

    if ((type === CHUNK_CONTINUE || type === CHUNK_END) && this.receiving) {
      const payload = chunk.subarray(CONT_DATA_OFFSET);
      if (payload.length > 0) this.chunks.push(payload.slice());

      if (type === CHUNK_END) {
        // Concatenate all collected payloads — bounded by what peer actually sent
        const parts = this.chunks;
        const declared = this.declaredTotalLength;
        this.reset();
        let total = 0;
        for (const p of parts) total += p.length;
        if (total !== declared) return null; // declared length mismatch: drop, never hand a corrupt buffer to decrypt
        if (parts.length === 1) return parts[0];
        const result = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) { result.set(p, offset); offset += p.length; }
        return result;
      }
    }

    return null;
  }

  reset(): void {
    this.chunks = [];
    this.receiving = false;
    this.declaredTotalLength = 0;
  }
}
