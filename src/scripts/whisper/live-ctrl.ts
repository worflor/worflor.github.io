/**
 * Whisper Live — control protocol (CTRL frames).
 *
 * Opcode ranges:
 *   0x01–0x0F  history/storage    CLEAR_REQ=0x01, CLEAR_CONFIRM=0x02
 *   0x10–0x1F  presence/status    (future)
 *   0x20–0x2F  reactions          (future)
 *   0x30–0x3F  session policy     (future)
 *
 * Frame format (payload after LIVE_MSG.CTRL type byte):
 *   [0]       opcode      (1B)
 *   [1]       payload_len (1B, 0–255)
 *   [2..2+N]  payload     (N bytes)
 */

export const CTRL_OP = {
  CLEAR_REQ:     0x01,
  CLEAR_CONFIRM: 0x02,
} as const;

export function encodeCtrl(opcode: number, payload?: Uint8Array): Uint8Array {
  const n = payload?.length ?? 0;
  if (n > 255) throw new RangeError("ctrl payload > 255 bytes");
  const buf = new Uint8Array(2 + n);
  buf[0] = opcode; buf[1] = n;
  if (payload && n > 0) buf.set(payload, 2);
  return buf;
}

export function decodeCtrl(bytes: Uint8Array): { opcode: number; payload: Uint8Array } | null {
  if (bytes.length < 2) return null;
  const payloadLen = bytes[1];
  if (bytes.length < 2 + payloadLen) return null;
  return { opcode: bytes[0], payload: bytes.subarray(2, 2 + payloadLen) };
}
