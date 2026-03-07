import { sha256 } from "./wasm";
import { TE, hkdf, pbkdf2, hmacSha256, constantTimeEqual } from "./live-crypto";
import { loopExpand } from "./live-loop";
import { handshake16D } from "./live-wasm-kizuna";

export type HandshakeRole = "offerer" | "answerer";

const ZERO_SALT_32 = new Uint8Array(32);
const PHRASE_ROOT_SALT = TE.encode("whisper-live-phrase-root-v1");
const INFO_PHRASE_NAMESPACE = TE.encode("whisper-live-phrase-namespace-v1");
const INFO_SESSION_ROOT = TE.encode("whisper-live-session-root-v1");
const INFO_CONFIRM_KEY = TE.encode("whisper-live-confirm-key-v1");
const INFO_CONFIRM_PROOF = TE.encode("whisper-live-confirm-proof-v1");
const HANDSHAKE_CONTEXT = TE.encode("whisper-live-transcript-v1");
const CONFIRM_CONTEXT = TE.encode("whisper-live-confirm-context-v1");
const KIZUNA_CONTEXT = TE.encode("whisper-live-kizuna-witness-v1");
const INFO_SILENT_KEY = TE.encode("whisper-live-silent-key-v1");
const INFO_AUDIO_KEY = TE.encode("whisper-live-audio-key-v1");
const PBKDF2_ITERATIONS = 310_000;

function le32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

function concatU8(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function framedField(label: string, value: Uint8Array): Uint8Array {
  const name = TE.encode(label);
  return concatU8(le32(name.length), name, le32(value.length), value);
}

function roleBytes(role: HandshakeRole): Uint8Array {
  return TE.encode(role);
}

export async function derivePhraseRoot(phrase: string): Promise<Uint8Array> {
  return pbkdf2(TE.encode(phrase), PHRASE_ROOT_SALT, PBKDF2_ITERATIONS, 32);
}

export async function derivePhraseScopedKey(
  phraseRoot: Uint8Array,
  scope: string,
  length: number,
  salt: Uint8Array = ZERO_SALT_32,
): Promise<Uint8Array> {
  return hkdf(phraseRoot, salt, concatU8(INFO_PHRASE_NAMESPACE, TE.encode(scope)), length);
}

export async function deriveHandshakeTranscriptHash(params: {
  offerSdpBytes: Uint8Array;
  answerSdpBytes: Uint8Array;
  offererEphemeralKey: Uint8Array;
  answererEphemeralKey: Uint8Array;
}): Promise<Uint8Array> {
  return sha256(concatU8(
    HANDSHAKE_CONTEXT,
    framedField("offer-sdp", params.offerSdpBytes),
    framedField("answer-sdp", params.answerSdpBytes),
    framedField("offerer-ecdh", params.offererEphemeralKey),
    framedField("answerer-ecdh", params.answererEphemeralKey),
  ));
}

export async function deriveSessionRoot(
  ecdhSecret: Uint8Array,
  transcriptHash: Uint8Array,
  phraseRoot: Uint8Array | null,
): Promise<Uint8Array> {
  const ikm = phraseRoot
    ? concatU8(le32(ecdhSecret.length), ecdhSecret, le32(phraseRoot.length), phraseRoot)
    : concatU8(le32(ecdhSecret.length), ecdhSecret, le32(0));
  try {
    return await hkdf(ikm, transcriptHash, INFO_SESSION_ROOT, 32);
  } finally {
    ikm.fill(0);
  }
}

/** Derive a purpose-specific 32-byte key for Silent mode, isolated from the session root. */
export async function deriveSilentKey(sessionRoot: Uint8Array): Promise<Uint8Array> {
  return hkdf(sessionRoot, ZERO_SALT_32, INFO_SILENT_KEY, 32);
}

/** Derive a purpose-specific 16-byte key for the WASM audio codec, isolated from the session root. */
export async function deriveAudioKey(sessionRoot: Uint8Array): Promise<Uint8Array> {
  return hkdf(sessionRoot, ZERO_SALT_32, INFO_AUDIO_KEY, 16);
}

export async function deriveKizunaWitness(sessionRoot: Uint8Array): Promise<Uint8Array> {
  const witnessSeed = await hkdf(sessionRoot, ZERO_SALT_32, KIZUNA_CONTEXT, 32);
  const block = await loopExpand(witnessSeed);
  witnessSeed.fill(0);
  try {
    const residual = handshake16D(block).residual;
    return le32(residual >>> 0);
  } finally {
    block.fill(0);
  }
}

export async function deriveConfirmContextHash(params: {
  transcriptHash: Uint8Array;
  offererRatchetKey: Uint8Array;
  answererRatchetKey: Uint8Array;
  kizunaWitness: Uint8Array;
}): Promise<Uint8Array> {
  return sha256(concatU8(
    CONFIRM_CONTEXT,
    framedField("transcript", params.transcriptHash),
    framedField("offerer-ratchet", params.offererRatchetKey),
    framedField("answerer-ratchet", params.answererRatchetKey),
    framedField("kizuna-witness", params.kizunaWitness),
  ));
}

async function deriveConfirmKey(
  sessionRoot: Uint8Array,
  confirmContextHash: Uint8Array,
  senderRole: HandshakeRole,
): Promise<Uint8Array> {
  return hkdf(sessionRoot, confirmContextHash, concatU8(INFO_CONFIRM_KEY, roleBytes(senderRole)), 32);
}

export async function buildConfirmProof(
  sessionRoot: Uint8Array,
  confirmContextHash: Uint8Array,
  senderRole: HandshakeRole,
): Promise<Uint8Array> {
  const key = await deriveConfirmKey(sessionRoot, confirmContextHash, senderRole);
  try {
    const mac = await hmacSha256(
      key,
      concatU8(INFO_CONFIRM_PROOF, confirmContextHash, roleBytes(senderRole)),
    );
    try {
      return mac.slice(0, 16);
    } finally {
      mac.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

export async function verifyConfirmProof(
  proof: Uint8Array,
  sessionRoot: Uint8Array,
  confirmContextHash: Uint8Array,
  senderRole: HandshakeRole,
): Promise<boolean> {
  const expected = await buildConfirmProof(sessionRoot, confirmContextHash, senderRole);
  try {
    return constantTimeEqual(proof, expected);
  } finally {
    expected.fill(0);
  }
}