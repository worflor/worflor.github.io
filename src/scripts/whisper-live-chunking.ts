/**
 * Whisper Live — DataChannel chunking and reassembly.
 *
 * WebRTC DataChannels have message size limits (~256KB typically,
 * but 16KB is the safe max for interoperability). We chunk large
 * messages and reassemble on the other side.
 *
 * Chunk format:
 *   [0]      chunk type (0x01 = start, 0x02 = continue, 0x03 = end, 0x04 = single)
 *   [1..4]   total message length (4B LE, only in start chunk)
 *   [5..]    chunk data
 */

export const CHUNK_SIZE = 15_360; // 15KB payload per chunk (under 16KB DataChannel limit)
export const CHUNK_START = 0x01;
export const CHUNK_CONTINUE = 0x02;
export const CHUNK_END = 0x03;
export const CHUNK_SINGLE = 0x04;
export const BUFFERED_AMOUNT_LOW = 64 * 1024;    // 64 KB backpressure threshold

/**
 * Chunk a message for DataChannel transport, baking in a wire prefix byte
 * at position [0] of each chunk. This avoids a second allocation + copy
 * in encryptAndSend — chunks are ready to send directly.
 */
export function chunkMessagePrefixed(data: Uint8Array, prefix: number): Uint8Array[] {
  if (data.length <= CHUNK_SIZE) {
    const chunk = new Uint8Array(2 + data.length);
    chunk[0] = prefix;
    chunk[1] = CHUNK_SINGLE;
    chunk.set(data, 2);
    return [chunk];
  }

  const chunks: Uint8Array[] = [];
  let offset = 0;

  // Start chunk: prefix + type + total length (4B) + payload
  const startPayload = Math.min(CHUNK_SIZE - 4, data.length);
  const startChunk = new Uint8Array(6 + startPayload);
  startChunk[0] = prefix;
  startChunk[1] = CHUNK_START;
  new DataView(startChunk.buffer).setUint32(2, data.length, true);
  startChunk.set(data.subarray(0, startPayload), 6);
  chunks.push(startChunk);
  offset = startPayload;

  // Continue / end chunks
  while (offset < data.length) {
    const remaining = data.length - offset;
    const payloadSize = Math.min(CHUNK_SIZE, remaining);
    const isLast = offset + payloadSize >= data.length;

    const chunk = new Uint8Array(2 + payloadSize);
    chunk[0] = prefix;
    chunk[1] = isLast ? CHUNK_END : CHUNK_CONTINUE;
    chunk.set(data.subarray(offset, offset + payloadSize), 2);
    chunks.push(chunk);
    offset += payloadSize;
  }

  return chunks;
}

export class ChunkAssembler {
  private chunks: Uint8Array[] = [];
  private receiving = false;

  /** Feed a chunk. Returns the complete message when all chunks received, or null if incomplete. */
  feed(chunk: Uint8Array): Uint8Array | null {
    const type = chunk[0];

    if (type === CHUNK_SINGLE) {
      return chunk.subarray(1);
    }

    if (type === CHUNK_START) {
      // Don't pre-allocate from peer-declared totalLength — just start collecting
      this.reset();
      this.receiving = true;
      const payload = chunk.subarray(5); // skip type(1) + totalLength(4)
      if (payload.length > 0) this.chunks.push(payload.slice());
      return null;
    }

    if ((type === CHUNK_CONTINUE || type === CHUNK_END) && this.receiving) {
      const payload = chunk.subarray(1);
      if (payload.length > 0) this.chunks.push(payload.slice());

      if (type === CHUNK_END) {
        // Concatenate all collected payloads — bounded by what peer actually sent
        const parts = this.chunks;
        this.reset();
        if (parts.length === 1) return parts[0];
        let total = 0;
        for (const p of parts) total += p.length;
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
  }
}
