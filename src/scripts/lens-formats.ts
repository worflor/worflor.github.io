// lens-formats.ts — Universal file format engine for The Lens.
// Detects file structure from bytes, walks containers, extracts metadata,
// probes via browser APIs, and falls back to text heuristics.
// Zero dependencies. All parsing via DataView / TextDecoder / browser-native APIs.

import type { ExifCategory, ExifField, ExifValueType } from "./lens-exif";

// ── Types ────────────────────────────────────────────────────

export type StructureFamily =
  | "riff"
  | "isobmff"
  | "ebml"
  | "id3"
  | "flac"
  | "ogg"
  | "zip"
  | "pdf"
  | "png"
  | "gif"
  | "jpeg"
  | "tiff"
  | "xml"
  | "text"
  | "font"
  | "unknown";

export interface FormatResult {
  categories: ExifCategory[];
  formatFamily: StructureFamily;
  formatName: string;
  previewType: "image" | "audio" | "video" | "text" | "none";
  textPreview?: string;
  summary: { label: string; value: string }[];
}

interface FormatSignature {
  name: string;
  family: StructureFamily;
  previewHint: "image" | "audio" | "video" | "text" | "none";
  test: (h: DataView, size: number, mime: string, ext: string) => boolean;
  subtype?: string;
}

interface ChunkEntry {
  id: string;
  offset: number;
  size: number;
}

interface BoxEntry {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
  dataOffset: number;
}

interface ID3Frame {
  id: string;
  offset: number;
  size: number;
  dataOffset: number;
}

interface ZipEntry {
  filename: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
}

interface PngChunk {
  type: string;
  offset: number;
  dataOffset: number;
  size: number;
}

// ── Helpers ──────────────────────────────────────────────────

function field(
  id: string,
  label: string,
  value: ExifValueType,
  displayValue?: string,
  explanation?: string,
): ExifField {
  return {
    id,
    label,
    value,
    displayValue: displayValue ?? (value === null ? "-" : String(value)),
    explanation: explanation ?? "",
  };
}

function ascii(view: DataView, offset: number, length: number): string {
  const end = Math.min(offset + length, view.byteLength);
  const count = end - offset;
  if (count <= 0) return "";
  // For short strings (most fourCC, field values) concat is fine.
  // For longer strings (PDF text scans, etc.) use batch decode.
  if (count <= 64) {
    let s = "";
    for (let i = offset; i < end; i++) {
      const c = view.getUint8(i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  // Batch: collect codes and convert in chunks to avoid call-stack limits
  // String.fromCharCode.apply can fail above ~65K args on some engines
  const codes: number[] = [];
  for (let i = offset; i < end; i++) {
    const c = view.getUint8(i);
    if (c === 0) break;
    codes.push(c);
  }
  if (codes.length <= 8192) return String.fromCharCode(...codes);
  // Chunked conversion for very large strings
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += 8192) {
    parts.push(String.fromCharCode(...codes.slice(i, i + 8192)));
  }
  return parts.join("");
}

function fourCC(view: DataView, offset: number): string {
  if (offset + 4 > view.byteLength) return "";
  return ascii(view, offset, 4);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}


function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// ── Layer 1: Signature Registry ──────────────────────────────

const SIGNATURES: FormatSignature[] = [
  // PNG
  {
    name: "PNG",
    family: "png",
    previewHint: "image",
    test: (h) =>
      h.byteLength >= 8 &&
      h.getUint32(0) === 0x89504e47 &&
      h.getUint32(4) === 0x0d0a1a0a,
  },
  // GIF
  {
    name: "GIF",
    family: "gif",
    previewHint: "image",
    test: (h) =>
      h.byteLength >= 6 &&
      ascii(h, 0, 3) === "GIF" &&
      (ascii(h, 3, 3) === "87a" || ascii(h, 3, 3) === "89a"),
  },
  // JPEG (for files without EXIF data)
  {
    name: "JPEG",
    family: "jpeg",
    previewHint: "image",
    test: (h) =>
      h.byteLength >= 3 &&
      h.getUint8(0) === 0xff &&
      h.getUint8(1) === 0xd8 &&
      h.getUint8(2) === 0xff,
  },
  // TIFF (for files without EXIF data)
  {
    name: "TIFF",
    family: "tiff",
    previewHint: "image",
    test: (h) =>
      h.byteLength >= 4 &&
      (
        (h.getUint8(0) === 0x49 &&
          h.getUint8(1) === 0x49 &&
          h.getUint8(2) === 0x2a &&
          h.getUint8(3) === 0x00) ||
        (h.getUint8(0) === 0x4d &&
          h.getUint8(1) === 0x4d &&
          h.getUint8(2) === 0x00 &&
          h.getUint8(3) === 0x2a)
      ),
  },
  // RIFF (WAV, AVI, WebP)
  {
    name: "RIFF",
    family: "riff",
    previewHint: "none",
    test: (h) => h.byteLength >= 12 && ascii(h, 0, 4) === "RIFF",
  },
  // FLAC
  {
    name: "FLAC",
    family: "flac",
    previewHint: "audio",
    test: (h) => h.byteLength >= 4 && ascii(h, 0, 4) === "fLaC",
  },
  // OGG
  {
    name: "OGG",
    family: "ogg",
    previewHint: "audio",
    test: (h) => h.byteLength >= 4 && ascii(h, 0, 4) === "OggS",
  },
  // ID3 (MP3 with ID3v2 header)
  {
    name: "MP3",
    family: "id3",
    previewHint: "audio",
    test: (h) => h.byteLength >= 3 && ascii(h, 0, 3) === "ID3",
  },
  // MP3 without ID3 — MPEG audio frame sync (11 bits set) + valid MPEG audio header.
  // We require: sync word (11 bits) + valid MPEG version (not 01) + valid layer (not 00)
  // + valid bitrate (not 1111). This eliminates most false positives from raw 0xFF bytes.
  {
    name: "MP3",
    family: "id3",
    previewHint: "audio",
    subtype: "bare",
    test: (h) => {
      if (h.byteLength < 4) return false;
      const w = h.getUint16(0);
      if ((w & 0xffe0) !== 0xffe0) return false;
      // Validate MPEG audio header fields in byte 1-2
      const b1 = h.getUint8(1);
      const b2 = h.getUint8(2);
      const version = (b1 >> 3) & 0x03;   // 00=2.5, 01=reserved, 10=2, 11=1
      const layer = (b1 >> 1) & 0x03;     // 00=reserved, 01=III, 10=II, 11=I
      const bitrate = (b2 >> 4) & 0x0f;   // 1111=bad
      return version !== 1 && layer !== 0 && bitrate !== 15;
    },
  },
  // ISOBMFF (MP4, MOV, M4A, HEIC, AVIF, 3GP)
  {
    name: "ISOBMFF",
    family: "isobmff",
    previewHint: "video",
    test: (h) => {
      if (h.byteLength < 8) return false;
      return fourCC(h, 4) === "ftyp";
    },
  },
  // EBML (MKV, WebM)
  {
    name: "Matroska",
    family: "ebml",
    previewHint: "video",
    test: (h) =>
      h.byteLength >= 4 &&
      h.getUint8(0) === 0x1a &&
      h.getUint8(1) === 0x45 &&
      h.getUint8(2) === 0xdf &&
      h.getUint8(3) === 0xa3,
  },
  // PDF
  {
    name: "PDF",
    family: "pdf",
    previewHint: "none",
    test: (h) => h.byteLength >= 5 && ascii(h, 0, 5) === "%PDF-",
  },
  // ZIP (and ZIP-based: DOCX, XLSX, PPTX, ODS, EPUB, JAR, APK)
  {
    name: "ZIP",
    family: "zip",
    previewHint: "none",
    test: (h) =>
      h.byteLength >= 4 &&
      h.getUint8(0) === 0x50 &&
      h.getUint8(1) === 0x4b &&
      h.getUint8(2) === 0x03 &&
      h.getUint8(3) === 0x04,
  },
  // WOFF2
  {
    name: "WOFF2",
    family: "font",
    previewHint: "none",
    test: (h) => h.byteLength >= 4 && ascii(h, 0, 4) === "wOF2",
  },
  // WOFF
  {
    name: "WOFF",
    family: "font",
    previewHint: "none",
    test: (h) => h.byteLength >= 4 && ascii(h, 0, 4) === "wOFF",
  },
  // TrueType (TTF)
  {
    name: "TrueType",
    family: "font",
    previewHint: "none",
    test: (h) =>
      h.byteLength >= 4 &&
      h.getUint8(0) === 0x00 &&
      h.getUint8(1) === 0x01 &&
      h.getUint8(2) === 0x00 &&
      h.getUint8(3) === 0x00,
  },
  // OpenType (OTF)
  {
    name: "OpenType",
    family: "font",
    previewHint: "none",
    test: (h) => h.byteLength >= 4 && ascii(h, 0, 4) === "OTTO",
  },
  // BMP
  {
    name: "BMP",
    family: "unknown",
    previewHint: "image",
    test: (h) => h.byteLength >= 2 && ascii(h, 0, 2) === "BM",
  },
  // ICO
  {
    name: "ICO",
    family: "unknown",
    previewHint: "image",
    test: (h) =>
      h.byteLength >= 4 &&
      h.getUint16(0, true) === 0 &&
      (h.getUint16(2, true) === 1 || h.getUint16(2, true) === 2),
  },
];

function detectFormat(
  header: DataView,
  fileSize: number,
  mime: string,
  ext: string,
): FormatSignature | null {
  for (const sig of SIGNATURES) {
    if (sig.test(header, fileSize, mime, ext)) return sig;
  }
  return null;
}

// ── Layer 2: Structure Walkers ───────────────────────────────

// Safety cap: no walker should ever yield more entries than this.
// Real-world files rarely exceed a few hundred chunks/boxes.
const MAX_WALKER_ENTRIES = 2048;

function walkChunks(
  view: DataView,
  startOffset: number,
  end?: number,
): ChunkEntry[] {
  const chunks: ChunkEntry[] = [];
  let offset = startOffset;
  const limit = end ?? view.byteLength;

  while (offset + 8 <= limit && chunks.length < MAX_WALKER_ENTRIES) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true); // RIFF is little-endian
    if (id === "") break;
    // size=0 is invalid for RIFF chunks — stop to avoid infinite loop
    if (size === 0) break;
    chunks.push({ id, offset, size });
    // Chunks are word-aligned (padded to even).
    // Clamp padded size to avoid 32-bit overflow on very large chunks.
    const paddedSize = size + (size % 2);
    if (paddedSize > limit) break; // chunk larger than remaining data
    const advance = 8 + paddedSize;
    if (advance <= 0 || offset + advance <= offset) break;
    offset += advance;
  }
  return chunks;
}

function walkBoxes(
  view: DataView,
  startOffset: number,
  end?: number,
): BoxEntry[] {
  const boxes: BoxEntry[] = [];
  let offset = startOffset;
  const limit = end ?? view.byteLength;

  while (offset + 8 <= limit && boxes.length < MAX_WALKER_ENTRIES) {
    let size = view.getUint32(offset); // big-endian
    const type = fourCC(view, offset + 4);
    let headerSize = 8;

    if (size === 1 && offset + 16 <= limit) {
      // Extended size: 8-byte big-endian uint at offset+8.
      // If the high 32 bits are non-zero the box is >4GB — clamp to limit.
      const hi = view.getUint32(offset + 8);
      const lo = view.getUint32(offset + 12);
      size = hi > 0 ? limit - offset : lo;
      headerSize = 16;
    } else if (size === 0) {
      // Box extends to end of file — only valid for the last box
      size = limit - offset;
    }

    if (type === "" || size < headerSize) break;

    boxes.push({
      type,
      offset,
      size,
      headerSize,
      dataOffset: offset + headerSize,
    });

    // Guard: ensure forward progress
    if (offset + size <= offset) break;
    offset += size;
  }
  return boxes;
}

function walkPngChunks(view: DataView): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8; // Skip PNG signature

  while (offset + 12 <= view.byteLength && chunks.length < MAX_WALKER_ENTRIES) {
    const length = view.getUint32(offset);
    const type = fourCC(view, offset + 4);
    if (type === "") break;

    chunks.push({
      type,
      offset,
      dataOffset: offset + 8,
      size: length,
    });

    // 4 (length field) + 4 (type) + data (length bytes) + 4 (CRC)
    const advance = 12 + length;
    // Guard: chunk length could be enormous on malformed PNG
    if (advance <= 0 || offset + advance <= offset) break;
    offset += advance;

    if (type === "IEND") break;
  }
  return chunks;
}

function walkID3Frames(
  view: DataView,
  startOffset: number,
  tagSize: number,
  version: number,
): ID3Frame[] {
  const frames: ID3Frame[] = [];
  let offset = startOffset;
  const end = Math.min(startOffset + tagSize, view.byteLength);
  const frameHeaderSize = version >= 3 ? 10 : 6;

  while (offset + frameHeaderSize <= end && frames.length < MAX_WALKER_ENTRIES) {
    let id: string;
    let size: number;

    if (version >= 3) {
      id = fourCC(view, offset);
      if (id === "" || id[0] === "\0") break;

      if (version === 4) {
        // v2.4: syncsafe integer
        size =
          ((view.getUint8(offset + 4) & 0x7f) << 21) |
          ((view.getUint8(offset + 5) & 0x7f) << 14) |
          ((view.getUint8(offset + 6) & 0x7f) << 7) |
          (view.getUint8(offset + 7) & 0x7f);
      } else {
        // v2.3: plain 32-bit
        size = view.getUint32(offset + 4);
      }
    } else {
      // v2.2: 3-byte ID, 3-byte size
      id = ascii(view, offset, 3);
      if (id === "" || id[0] === "\0") break;
      size =
        (view.getUint8(offset + 3) << 16) |
        (view.getUint8(offset + 4) << 8) |
        view.getUint8(offset + 5);
    }

    if (size <= 0 || offset + frameHeaderSize + size > end) break;

    frames.push({
      id,
      offset,
      size,
      dataOffset: offset + frameHeaderSize,
    });

    offset += frameHeaderSize + size;
  }
  return frames;
}

function walkZipCentralDir(
  view: DataView,
  baseOffset: number = 0,
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const bufLen = view.byteLength;

  // Find End of Central Directory (scan backwards from end of buffer).
  // EOCD signature: PK\x05\x06
  // We scan the buffer itself — the EOCD is always in the last 65557 bytes of the file.
  let eocdBufPos = -1;
  const scanStart = Math.max(0, bufLen - 65557);

  for (let i = bufLen - 22; i >= scanStart; i--) {
    if (
      view.getUint8(i) === 0x50 &&
      view.getUint8(i + 1) === 0x4b &&
      view.getUint8(i + 2) === 0x05 &&
      view.getUint8(i + 3) === 0x06
    ) {
      eocdBufPos = i;
      break;
    }
  }

  if (eocdBufPos < 0 || eocdBufPos + 22 > bufLen) return entries;

  const entryCount = view.getUint16(eocdBufPos + 10, true);
  // cdOffset is an absolute file offset — translate to buffer-relative
  const cdFileOffset = view.getUint32(eocdBufPos + 16, true);

  // If the central directory starts before our buffer window, we can't read it
  if (cdFileOffset < baseOffset) return entries;
  let bufPos = cdFileOffset - baseOffset;

  const maxEntries = Math.min(entryCount, 500);

  for (let i = 0; i < maxEntries && bufPos + 46 <= bufLen; i++) {
    // Central directory file header signature
    if (view.getUint32(bufPos, true) !== 0x02014b50) break;

    const method = view.getUint16(bufPos + 10, true);
    const compressedSize = view.getUint32(bufPos + 20, true);
    const uncompressedSize = view.getUint32(bufPos + 24, true);
    const nameLen = view.getUint16(bufPos + 28, true);
    const extraLen = view.getUint16(bufPos + 30, true);
    const commentLen = view.getUint16(bufPos + 32, true);

    const filename =
      bufPos + 46 + nameLen <= bufLen
        ? ascii(view, bufPos + 46, nameLen)
        : "";

    entries.push({ filename, compressedSize, uncompressedSize, method });

    bufPos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// ── Layer 3: Metadata Extractors ─────────────────────────────

function extractRiffMeta(
  view: DataView,
  chunks: ChunkEntry[],
  riffType: string,
): ExifCategory[] {
  const categories: ExifCategory[] = [];
  const fields: ExifField[] = [];

  fields.push(field("riff.type", "Container Type", `RIFF/${riffType}`));

  // fmt chunk (audio format info)
  const fmt = chunks.find((c) => c.id === "fmt ");
  if (fmt && fmt.offset + 8 + 16 <= view.byteLength) {
    const base = fmt.offset + 8;
    const audioFormat = view.getUint16(base, true);
    const channels = view.getUint16(base + 2, true);
    const sampleRate = view.getUint32(base + 4, true);
    const byteRate = view.getUint32(base + 8, true);
    const bitsPerSample = view.getUint16(base + 14, true);

    const formatNames: Record<number, string> = {
      1: "PCM",
      3: "IEEE Float",
      6: "A-law",
      7: "μ-law",
      0xfffe: "Extensible",
    };

    fields.push(
      field("riff.audioFormat", "Audio Format", formatNames[audioFormat] ?? `0x${audioFormat.toString(16)}`),
      field("riff.channels", "Channels", channels, channels === 1 ? "1 (Mono)" : channels === 2 ? "2 (Stereo)" : String(channels)),
      field("riff.sampleRate", "Sample Rate", sampleRate, `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz`),
      field("riff.bitDepth", "Bit Depth", bitsPerSample, `${bitsPerSample}-bit`),
      field("riff.bitRate", "Bit Rate", byteRate * 8, `${Math.round((byteRate * 8) / 1000)} kbps`),
    );
  }

  // LIST/INFO chunks
  const listChunk = chunks.find((c) => c.id === "LIST");
  if (listChunk && listChunk.offset + 12 <= view.byteLength) {
    const listType = fourCC(view, listChunk.offset + 8);
    if (listType === "INFO") {
      const infoChunks = walkChunks(view, listChunk.offset + 12, listChunk.offset + 8 + listChunk.size);
      const infoFields: Record<string, string> = {
        INAM: "Title",
        IART: "Artist",
        ICRD: "Date Created",
        IGNR: "Genre",
        ICMT: "Comment",
        ICOP: "Copyright",
        ISFT: "Software",
        IENG: "Engineer",
        ITCH: "Technician",
        ISRC: "Source",
        ISBJ: "Subject",
      };
      for (const ic of infoChunks) {
        const label = infoFields[ic.id];
        if (label && ic.offset + 8 + ic.size <= view.byteLength) {
          const val = ascii(view, ic.offset + 8, ic.size).trim();
          if (val) {
            fields.push(field(`riff.info.${ic.id}`, label, val));
          }
        }
      }
    }
  }

  // data chunk → compute duration
  const dataChunk = chunks.find((c) => c.id === "data");
  if (dataChunk && fmt && fmt.offset + 8 + 16 <= view.byteLength) {
    const fmtByteRate = view.getUint32(fmt.offset + 8 + 8, true);
    if (fmtByteRate > 0) {
      const duration = dataChunk.size / fmtByteRate;
      fields.push(field("riff.duration", "Duration", duration, formatDuration(duration)));
    }
  }

  if (fields.length > 0) {
    const isAudio = riffType === "WAVE";
    const isVideo = riffType === "AVI ";
    const isImage = riffType === "WEBP";
    const title = isAudio
      ? "AUDIO"
      : isVideo
        ? "VIDEO"
        : isImage
          ? "IMAGE"
          : "RIFF";
    const id = isAudio ? "audio" : isVideo ? "video" : isImage ? "image" : "structure";
    categories.push({
      id,
      title,
      fields,
      expanded: true,
    });
  }

  return categories;
}

function extractIsobmffMeta(
  view: DataView,
  boxes: BoxEntry[],
): ExifCategory[] {
  const categories: ExifCategory[] = [];
  const fields: ExifField[] = [];

  // ftyp box
  const ftyp = boxes.find((b) => b.type === "ftyp");
  if (ftyp && ftyp.dataOffset + 8 <= view.byteLength) {
    const brand = fourCC(view, ftyp.dataOffset);
    const minorVersion = view.getUint32(ftyp.dataOffset + 4);

    const brandNames: Record<string, string> = {
      isom: "ISO Base Media",
      iso2: "ISO Base Media v2",
      mp41: "MP4 v1",
      mp42: "MP4 v2",
      M4V: "M4V (iTunes Video)",
      M4A: "M4A (iTunes Audio)",
      M4P: "M4P (iTunes Protected)",
      qt: "QuickTime",
      "3gp4": "3GPP",
      "3gp5": "3GPP v5",
      avc1: "AVC/H.264",
      heic: "HEIC (H.265 Image)",
      heix: "HEIC (Extended)",
      avif: "AVIF",
      mif1: "HEIF Image",
    };

    fields.push(
      field("isobmff.brand", "Brand", brand, brandNames[brand] ?? brand),
      field("isobmff.minorVersion", "Minor Version", minorVersion),
    );

    // Compatible brands
    const compatCount = Math.floor((ftyp.size - ftyp.headerSize - 8) / 4);
    const compatBrands: string[] = [];
    for (let i = 0; i < Math.min(compatCount, 10); i++) {
      const off = ftyp.dataOffset + 8 + i * 4;
      if (off + 4 <= view.byteLength) {
        const cb = fourCC(view, off).trim();
        if (cb) compatBrands.push(cb);
      }
    }
    if (compatBrands.length > 0) {
      fields.push(field("isobmff.compat", "Compatible Brands", compatBrands.join(", ")));
    }
  }

  // moov box → mvhd (movie header)
  const moov = boxes.find((b) => b.type === "moov");
  if (moov) {
    const moovBoxes = walkBoxes(view, moov.dataOffset, moov.offset + moov.size);
    const mvhd = moovBoxes.find((b) => b.type === "mvhd");
    if (mvhd && mvhd.dataOffset + 4 <= view.byteLength) {
      const version = view.getUint8(mvhd.dataOffset);
      // v0: 1(version) + 3(flags) + 4(created) + 4(modified) + 4(timescale) + 4(duration) = 20 bytes
      // v1: 1(version) + 3(flags) + 8(created) + 8(modified) + 4(timescale) + 8(duration) = 32 bytes
      const minSize = version === 0 ? 20 : 32;

      if (mvhd.dataOffset + minSize <= view.byteLength) {
        let timescale: number;
        let duration: number;

        if (version === 0) {
          timescale = view.getUint32(mvhd.dataOffset + 12);
          duration = view.getUint32(mvhd.dataOffset + 16);
        } else {
          timescale = view.getUint32(mvhd.dataOffset + 20);
          duration = view.getUint32(mvhd.dataOffset + 24); // Using lower 32 bits of 64-bit field
        }

        if (timescale > 0) {
          const durationSec = duration / timescale;
          fields.push(
            field("isobmff.duration", "Duration", durationSec, formatDuration(durationSec)),
            field("isobmff.timescale", "Timescale", timescale, `${timescale} Hz`),
          );
        }
      }
    }

    // trak boxes → tkhd (track header) for dimensions
    const traks = moovBoxes.filter((b) => b.type === "trak");
    for (let ti = 0; ti < traks.length; ti++) {
      const trak = traks[ti];
      const trakBoxes = walkBoxes(view, trak.dataOffset, trak.offset + trak.size);
      const tkhd = trakBoxes.find((b) => b.type === "tkhd");
      if (tkhd) {
        const tkhdVersion = view.getUint8(tkhd.dataOffset);
        const dimOffset = tkhd.dataOffset + (tkhdVersion === 0 ? 76 : 88);
        if (dimOffset + 8 <= view.byteLength) {
          const width = view.getUint32(dimOffset) >> 16; // Fixed-point 16.16
          const height = view.getUint32(dimOffset + 4) >> 16;
          if (width > 0 && height > 0) {
            fields.push(
              field(`isobmff.track${ti}.dimensions`, `Track ${ti + 1} Dimensions`, `${width} × ${height}`),
            );
          }
        }
      }
    }
  }

  if (fields.length > 0) {
    // Determine if this is audio-only or video
    const brand = ftyp ? fourCC(view, ftyp.dataOffset) : "";
    const isAudio = brand === "M4A " || brand === "M4P ";
    categories.push({
      id: isAudio ? "audio" : "video",
      title: isAudio ? "AUDIO" : "VIDEO",
      fields,
      expanded: true,
    });
  }

  return categories;
}

function extractID3Meta(
  view: DataView,
  frames: ID3Frame[],
): ExifCategory[] {
  const fields: ExifField[] = [];

  const frameLabels: Record<string, string> = {
    // v2.3/v2.4
    TIT2: "Title",
    TPE1: "Artist",
    TALB: "Album",
    TRCK: "Track",
    TDRC: "Year",
    TYER: "Year",
    TCON: "Genre",
    COMM: "Comment",
    TPE2: "Album Artist",
    TCOM: "Composer",
    TPUB: "Publisher",
    TCOP: "Copyright",
    TENC: "Encoder",
    TSSE: "Encoder Settings",
    TLEN: "Length",
    TBPM: "BPM",
    TKEY: "Key",
    // v2.2 equivalents
    TT2: "Title",
    TP1: "Artist",
    TAL: "Album",
    TRK: "Track",
    TYE: "Year",
    TCO: "Genre",
    COM: "Comment",
  };

  for (const frame of frames) {
    const label = frameLabels[frame.id];
    if (!label) continue;
    if (frame.dataOffset + frame.size > view.byteLength) continue;

    // Text frames: first byte is encoding, rest is text
    if (frame.id.startsWith("T") || frame.id.startsWith("t")) {
      const encoding = view.getUint8(frame.dataOffset);
      let text = "";

      if (encoding === 0 || encoding === 3) {
        // ISO-8859-1 or UTF-8
        text = ascii(view, frame.dataOffset + 1, frame.size - 1);
      } else if (encoding === 1 || encoding === 2) {
        // UTF-16 (with or without BOM)
        try {
          const bytes = new Uint8Array(view.buffer, frame.dataOffset + 1, frame.size - 1);
          const decoder = new TextDecoder(encoding === 1 ? "utf-16" : "utf-16be");
          text = decoder.decode(bytes);
        } catch {
          text = ascii(view, frame.dataOffset + 1, frame.size - 1);
        }
      }

      text = text.replace(/\0/g, "").trim();
      if (text) {
        fields.push(field(`id3.${frame.id}`, label, text));
      }
    }
  }

  // Check for APIC (attached picture)
  const apic = frames.find((f) => f.id === "APIC" || f.id === "PIC");
  if (apic) {
    fields.push(field("id3.artwork", "Artwork", "embedded", "Present"));
  }

  if (fields.length === 0) return [];
  return [{
    id: "audio",
    title: "AUDIO",
    fields,
    expanded: true,
  }];
}

function extractFlacMeta(view: DataView): ExifCategory[] {
  const fields: ExifField[] = [];

  // After "fLaC" signature, metadata blocks
  let offset = 4;
  let blocks = 0;

  while (offset + 4 <= view.byteLength && blocks < 128) {
    blocks++;
    const blockHeader = view.getUint8(offset);
    const isLast = (blockHeader & 0x80) !== 0;
    const blockType = blockHeader & 0x7f;
    const blockSize =
      (view.getUint8(offset + 1) << 16) |
      (view.getUint8(offset + 2) << 8) |
      view.getUint8(offset + 3);

    if (blockType === 0 && offset + 4 + 18 <= view.byteLength) {
      // STREAMINFO
      const base = offset + 4;
      const minBlockSize = view.getUint16(base);
      const maxBlockSize = view.getUint16(base + 2);

      // Sample rate: 20 bits starting at byte 10
      const sampleRate =
        (view.getUint8(base + 10) << 12) |
        (view.getUint8(base + 11) << 4) |
        (view.getUint8(base + 12) >> 4);

      // Channels: 3 bits at byte 12[3:1]
      const channels = ((view.getUint8(base + 12) >> 1) & 0x07) + 1;

      // Bits per sample: 5 bits at byte 12[0] + byte 13[7:4], then +1
      const bitsPerSample =
        (((view.getUint8(base + 12) & 0x01) << 4) |
        (view.getUint8(base + 13) >> 4)) + 1;

      // Total samples: 36 bits at byte 13[3:0] + bytes 14-17
      const totalSamples =
        ((view.getUint8(base + 13) & 0x0f) * 0x100000000) +
        view.getUint32(base + 14);

      fields.push(
        field("flac.sampleRate", "Sample Rate", sampleRate, `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz`),
        field("flac.channels", "Channels", channels, channels === 1 ? "1 (Mono)" : channels === 2 ? "2 (Stereo)" : String(channels)),
        field("flac.bitDepth", "Bit Depth", bitsPerSample, `${bitsPerSample}-bit`),
        field("flac.blockSize", "Block Size", `${minBlockSize}–${maxBlockSize}`, `${minBlockSize}–${maxBlockSize} samples`),
      );

      if (sampleRate > 0 && totalSamples > 0) {
        const duration = totalSamples / sampleRate;
        fields.push(
          field("flac.duration", "Duration", duration, formatDuration(duration)),
          field("flac.totalSamples", "Total Samples", totalSamples, totalSamples.toLocaleString()),
        );
      }
    }

    const advance = 4 + blockSize;
    if (advance <= 0 || offset + advance <= offset) break;
    offset += advance;
    if (isLast) break;
  }

  if (fields.length === 0) return [];

  fields.unshift(field("flac.format", "Format", "FLAC", "Free Lossless Audio Codec"));

  return [{
    id: "audio",
    title: "AUDIO",
    fields,
    expanded: true,
  }];
}

function extractPngMeta(
  view: DataView,
  chunks: PngChunk[],
): ExifCategory[] {
  const categories: ExifCategory[] = [];
  const imageFields: ExifField[] = [];

  // IHDR (always first chunk after signature)
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (ihdr && ihdr.dataOffset + 13 <= view.byteLength) {
    const width = view.getUint32(ihdr.dataOffset);
    const height = view.getUint32(ihdr.dataOffset + 4);
    const bitDepth = view.getUint8(ihdr.dataOffset + 8);
    const colorType = view.getUint8(ihdr.dataOffset + 9);
    const compression = view.getUint8(ihdr.dataOffset + 10);
    // byte 11 = filter method (always 0 in valid PNG, skip)
    const interlace = view.getUint8(ihdr.dataOffset + 12);

    const colorTypes: Record<number, string> = {
      0: "Grayscale",
      2: "RGB",
      3: "Indexed",
      4: "Grayscale + Alpha",
      6: "RGBA",
    };

    imageFields.push(
      field("png.dimensions", "Dimensions", `${width} × ${height}`),
      field("png.bitDepth", "Bit Depth", bitDepth, `${bitDepth}-bit`),
      field("png.colorType", "Color Type", colorTypes[colorType] ?? `Type ${colorType}`),
      field("png.interlace", "Interlace", interlace === 1 ? "Adam7" : "None"),
    );

    if (compression !== 0) {
      imageFields.push(field("png.compression", "Compression", `Method ${compression}`));
    }
  }

  // pHYs (pixel dimensions)
  const phys = chunks.find((c) => c.type === "pHYs");
  if (phys && phys.dataOffset + 9 <= view.byteLength) {
    const ppuX = view.getUint32(phys.dataOffset);
    const ppuY = view.getUint32(phys.dataOffset + 4);
    const unit = view.getUint8(phys.dataOffset + 8);
    if (unit === 1) {
      // Meters → DPI
      const dpiX = Math.round(ppuX / 39.3701);
      const dpiY = Math.round(ppuY / 39.3701);
      imageFields.push(field("png.dpi", "Resolution", `${dpiX} × ${dpiY} DPI`));
    }
  }

  if (imageFields.length > 0) {
    categories.push({
      id: "image",
      title: "IMAGE",
      fields: imageFields,
      expanded: true,
    });
  }

  // Text chunks (tEXt, iTXt)
  const textFields: ExifField[] = [];
  for (const chunk of chunks) {
    if (chunk.type !== "tEXt" && chunk.type !== "iTXt") continue;
    if (chunk.dataOffset + chunk.size > view.byteLength) continue;

    if (chunk.type === "tEXt") {
      const raw = ascii(view, chunk.dataOffset, Math.min(chunk.size, 1024));
      const nullIdx = raw.indexOf("\0");
      if (nullIdx > 0) {
        const key = raw.slice(0, nullIdx);
        const val = raw.slice(nullIdx + 1).trim();
        if (val) {
          textFields.push(field(`png.text.${key}`, key, val));
        }
      }
    }
  }

  if (textFields.length > 0) {
    categories.push({
      id: "metadata",
      title: "METADATA",
      fields: textFields,
      expanded: false,
    });
  }

  // Chunk summary
  const structureFields: ExifField[] = [];
  const chunkTypes = new Map<string, number>();
  for (const chunk of chunks) {
    chunkTypes.set(chunk.type, (chunkTypes.get(chunk.type) ?? 0) + 1);
  }
  const chunkSummary = Array.from(chunkTypes.entries())
    .map(([type, count]) => count > 1 ? `${type} ×${count}` : type)
    .join(", ");
  structureFields.push(
    field("png.chunks", "Chunks", chunkSummary, `${chunks.length} chunks: ${chunkSummary}`),
  );

  // Detect animation (acTL chunk = APNG)
  if (chunks.some((c) => c.type === "acTL")) {
    structureFields.push(field("png.animated", "Animated", 1, "APNG"));
  }

  if (structureFields.length > 0) {
    categories.push({
      id: "structure",
      title: "STRUCTURE",
      fields: structureFields,
      expanded: false,
    });
  }

  return categories;
}

function extractGifMeta(view: DataView): ExifCategory[] {
  const fields: ExifField[] = [];

  if (view.byteLength < 13) return [];

  const version = ascii(view, 3, 3); // "87a" or "89a"
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const packed = view.getUint8(10);
  const hasGCT = (packed & 0x80) !== 0;
  const colorRes = ((packed >> 4) & 0x07) + 1;
  const gctSize = hasGCT ? 1 << ((packed & 0x07) + 1) : 0;

  fields.push(
    field("gif.version", "Version", `GIF${version}`),
    field("gif.dimensions", "Dimensions", `${width} × ${height}`),
    field("gif.colorDepth", "Color Depth", colorRes, `${colorRes}-bit (${1 << colorRes} colors)`),
  );

  if (hasGCT) {
    fields.push(field("gif.palette", "Palette", `${gctSize} colors`));
  }

  // Count frames by scanning GIF block structure.
  // Cap both frame count and scan depth to avoid runaway loops on malformed data.
  let frameCount = 0;
  const MAX_GIF_FRAMES = 10000;
  let offset = 13 + (hasGCT ? gctSize * 3 : 0);
  // Track consecutive unknown bytes — if we hit too many, the structure is broken
  let unknownRun = 0;
  const MAX_UNKNOWN_RUN = 16;

  while (offset < view.byteLength && frameCount <= MAX_GIF_FRAMES) {
    const intro = view.getUint8(offset);
    if (intro === 0x2c) {
      unknownRun = 0;
      frameCount++;
      // Image descriptor is 10 bytes (intro + 4 shorts + packed)
      if (offset + 10 > view.byteLength) break;
      offset += 10;
      const localPacked = view.getUint8(offset - 1);
      if (localPacked & 0x80) {
        offset += (1 << ((localPacked & 0x07) + 1)) * 3;
      }
      // Skip LZW min code size + data sub-blocks
      if (offset >= view.byteLength) break;
      offset++; // LZW min code size
      while (offset < view.byteLength) {
        const blockSize = view.getUint8(offset);
        offset++;
        if (blockSize === 0) break;
        offset += blockSize;
      }
    } else if (intro === 0x21) {
      unknownRun = 0;
      // Extension block: skip label byte + sub-blocks
      offset += 2;
      while (offset < view.byteLength) {
        const blockSize = view.getUint8(offset);
        offset++;
        if (blockSize === 0) break;
        offset += blockSize;
      }
    } else if (intro === 0x3b) {
      // Trailer
      break;
    } else {
      // Unknown intro byte — tolerate a few, then bail
      unknownRun++;
      if (unknownRun >= MAX_UNKNOWN_RUN) break;
      offset++;
    }
  }

  if (frameCount > 1) {
    fields.push(field("gif.frames", "Frames", frameCount, `${frameCount} (animated)`));
  }

  return [{
    id: "image",
    title: "IMAGE",
    fields,
    expanded: true,
  }];
}

function extractPdfMeta(view: DataView): ExifCategory[] {
  const fields: ExifField[] = [];

  // PDF version from header
  const header = ascii(view, 0, Math.min(20, view.byteLength));
  const versionMatch = header.match(/%PDF-(\d+\.\d+)/);
  if (versionMatch) {
    fields.push(field("pdf.version", "PDF Version", versionMatch[1]));
  }

  // Scan for /Info dictionary entries
  // We search the raw bytes for common PDF info dict keys
  const searchRegion = Math.min(view.byteLength, 65536);
  const textSlice = ascii(view, 0, searchRegion);

  const infoPatterns: Array<{ key: string; label: string }> = [
    { key: "/Title", label: "Title" },
    { key: "/Author", label: "Author" },
    { key: "/Subject", label: "Subject" },
    { key: "/Creator", label: "Creator" },
    { key: "/Producer", label: "Producer" },
    { key: "/CreationDate", label: "Created" },
    { key: "/ModDate", label: "Modified" },
    { key: "/Keywords", label: "Keywords" },
  ];

  for (const { key, label } of infoPatterns) {
    const idx = textSlice.indexOf(key);
    if (idx < 0) continue;

    // Try to extract value — look for (string) or <hex> or /name after key
    let afterKey = textSlice.slice(idx + key.length, idx + key.length + 256).trimStart();

    if (afterKey.startsWith("(")) {
      // Literal string
      const end = afterKey.indexOf(")");
      if (end > 0) {
        let val = afterKey.slice(1, end);
        // PDF date format: D:YYYYMMDDHHmmSS
        if (val.startsWith("D:")) {
          const d = val.slice(2);
          const formatted = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
          val = formatted;
        }
        fields.push(field(`pdf.${label.toLowerCase()}`, label, val));
      }
    } else if (afterKey.startsWith("<")) {
      // Hex string
      const end = afterKey.indexOf(">");
      if (end > 0) {
        const hex = afterKey.slice(1, end);
        // Try to decode as UTF-16BE if it starts with FEFF
        if (hex.startsWith("FEFF") || hex.startsWith("feff")) {
          let decoded = "";
          for (let i = 4; i + 3 < hex.length; i += 4) {
            const code = parseInt(hex.slice(i, i + 4), 16);
            if (code > 0) decoded += String.fromCharCode(code);
          }
          if (decoded) fields.push(field(`pdf.${label.toLowerCase()}`, label, decoded));
        }
      }
    }
  }

  // Count pages heuristic — /Type /Page (without trailing 's') minus /Type /Pages nodes
  const pageMatches = textSlice.match(/\/Type\s*\/Page(?!s)\b/g);
  if (pageMatches && pageMatches.length > 0) {
    fields.push(
      field("pdf.pages", "Pages", pageMatches.length, `~${pageMatches.length}`, "Estimated from internal object count"),
    );
  }

  // Check for encryption
  if (textSlice.includes("/Encrypt")) {
    fields.push(field("pdf.encrypted", "Encrypted", 1, "Yes"));
  }

  if (fields.length === 0) return [];
  return [{
    id: "document",
    title: "DOCUMENT",
    fields,
    expanded: true,
  }];
}

function extractFontMeta(view: DataView, formatName: string): ExifCategory[] {
  const fields: ExifField[] = [];

  fields.push(field("font.format", "Format", formatName));

  if (formatName === "WOFF" || formatName === "WOFF2") {
    // WOFF header
    if (view.byteLength >= 44) {
      const numTables = view.getUint16(12);
      const totalSize = view.getUint32(16);
      const majorVersion = view.getUint16(20);
      const minorVersion = view.getUint16(22);

      fields.push(
        field("font.tables", "Tables", numTables),
        field("font.totalSize", "Original Size", totalSize, formatBytes(totalSize)),
        field("font.version", "Version", `${majorVersion}.${minorVersion}`),
      );
    }
    // WOFF/WOFF2 wraps the original table structure — name table parsing would
    // require decompression, so we stop here for these formats.
    if (fields.length === 0) return [];
    return [{ id: "document", title: "FONT", fields, expanded: true }];
  }

  // TTF / OTF — read offset table and find name table
  if (view.byteLength < 12) return [];

  const numTables = view.getUint16(4);
  fields.push(field("font.tables", "Tables", numTables));

  // Find name table
  let nameOffset = 0;
  for (let i = 0; i < numTables && 12 + i * 16 + 16 <= view.byteLength; i++) {
    const tableOffset = 12 + i * 16;
    const tag = fourCC(view, tableOffset);
    if (tag === "name") {
      nameOffset = view.getUint32(tableOffset + 8);
      break;
    }
  }

  if (nameOffset > 0 && nameOffset + 6 <= view.byteLength) {
    const nameCount = view.getUint16(nameOffset + 2);
    const stringOffset = view.getUint16(nameOffset + 4);

    const nameIds: Record<number, string> = {
      0: "Copyright",
      1: "Family",
      2: "Subfamily",
      4: "Full Name",
      5: "Version",
      6: "PostScript Name",
      8: "Manufacturer",
      9: "Designer",
      11: "URL",
      13: "License",
    };

    const seen = new Set<number>();

    for (let i = 0; i < nameCount && nameOffset + 6 + i * 12 + 12 <= view.byteLength; i++) {
      const recordOffset = nameOffset + 6 + i * 12;
      const platformID = view.getUint16(recordOffset);
      const nameID = view.getUint16(recordOffset + 6);
      const length = view.getUint16(recordOffset + 8);
      const offset = view.getUint16(recordOffset + 10);

      const label = nameIds[nameID];
      if (!label || seen.has(nameID)) continue;

      const strStart = nameOffset + stringOffset + offset;
      if (strStart + length > view.byteLength) continue;

      let text = "";
      if (platformID === 3 || platformID === 0) {
        // Unicode (UTF-16BE) — read pairs of bytes, rounding down to even length
        const evenLen = length & ~1;
        for (let j = 0; j < evenLen; j += 2) {
          text += String.fromCharCode(view.getUint16(strStart + j));
        }
      } else {
        text = ascii(view, strStart, length);
      }

      text = text.trim();
      if (text) {
        seen.add(nameID);
        fields.push(field(`font.name.${nameID}`, label, text));
      }
    }
  }

  if (fields.length === 0) return [];
  return [{ id: "document", title: "FONT", fields, expanded: true }];
}

function extractZipMeta(
  entries: ZipEntry[],
): ExifCategory[] {
  const fields: ExifField[] = [];

  fields.push(field("zip.entries", "File Count", entries.length));

  // Detect sub-format from contained files
  const filenames = entries.map((e) => e.filename);
  let subFormat = "ZIP";

  if (filenames.some((f) => f === "[Content_Types].xml") && filenames.some((f) => f.startsWith("word/"))) {
    subFormat = "DOCX (Word)";
  } else if (filenames.some((f) => f === "[Content_Types].xml") && filenames.some((f) => f.startsWith("xl/"))) {
    subFormat = "XLSX (Excel)";
  } else if (filenames.some((f) => f === "[Content_Types].xml") && filenames.some((f) => f.startsWith("ppt/"))) {
    subFormat = "PPTX (PowerPoint)";
  } else if (filenames.some((f) => f === "META-INF/MANIFEST.MF")) {
    subFormat = filenames.some((f) => f === "AndroidManifest.xml") ? "APK (Android)" : "JAR (Java)";
  } else if (filenames.some((f) => f === "meta.xml") && filenames.some((f) => f === "content.xml")) {
    if (filenames.some((f) => f === "mimetype")) {
      subFormat = "ODF (OpenDocument)";
    }
  } else if (filenames.some((f) => f === "META-INF/container.xml") || filenames.some((f) => f.endsWith(".opf"))) {
    subFormat = "EPUB";
  }

  fields.push(field("zip.subFormat", "Format", subFormat));

  // Total sizes
  const totalCompressed = entries.reduce((sum, e) => sum + e.compressedSize, 0);
  const totalUncompressed = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);

  if (totalUncompressed > 0) {
    fields.push(
      field("zip.uncompressedSize", "Uncompressed Size", totalUncompressed, formatBytes(totalUncompressed)),
    );
    if (totalCompressed > 0 && totalCompressed < totalUncompressed) {
      const ratio = ((1 - totalCompressed / totalUncompressed) * 100).toFixed(1);
      fields.push(
        field("zip.compression", "Compression", `${ratio}%`, `${ratio}% smaller`),
      );
    }
  }

  // File listing (first 20 entries)
  const listing = entries.slice(0, 20).map((e) => e.filename).filter(Boolean);
  if (listing.length > 0) {
    const display = listing.join("\n");
    const suffix = entries.length > 20 ? `\n…and ${entries.length - 20} more` : "";
    fields.push(
      field("zip.listing", "Contents", display + suffix, display + suffix),
    );
  }

  // Extension distribution
  const extCounts = new Map<string, number>();
  for (const e of entries) {
    if (e.filename.endsWith("/")) continue; // Directory
    const ext = fileExtension(e.filename) || "(none)";
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  if (extCounts.size > 0) {
    const sorted = Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ext, count]) => `${ext}: ${count}`)
      .join(", ");
    fields.push(field("zip.extensions", "File Types", sorted));
  }

  return [{
    id: "structure",
    title: "ARCHIVE",
    fields,
    expanded: true,
  }];
}

// ── Layer 4: Browser-Native Probes ───────────────────────────

const MEDIA_PROBE_TIMEOUT = 5000;

async function probeMedia(
  file: File,
  type: "audio" | "video",
): Promise<ExifField[]> {
  return new Promise((resolve) => {
    const el = document.createElement(type);
    el.preload = "metadata";
    const url = URL.createObjectURL(file);
    let settled = false;

    const cleanup = () => {
      el.onloadedmetadata = null;
      el.onerror = null;
      URL.revokeObjectURL(url);
      // Detach from any source to release underlying media resource.
      // Wrapping in try/catch because some browsers fire AbortError
      // when load() is called without a valid src.
      try {
        el.removeAttribute("src");
        el.load();
      } catch {
        // Ignore — element is being discarded anyway
      }
    };

    const finish = (fields: ExifField[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(fields);
    };

    el.src = url;

    const timer = setTimeout(() => finish([]), MEDIA_PROBE_TIMEOUT);

    el.onloadedmetadata = () => {
      const fields: ExifField[] = [];

      if (isFinite(el.duration) && el.duration > 0) {
        fields.push(
          field("probe.duration", "Duration", el.duration, formatDuration(el.duration)),
        );
      }

      if (type === "video") {
        const vid = el as HTMLVideoElement;
        if (vid.videoWidth > 0 && vid.videoHeight > 0) {
          fields.push(
            field("probe.dimensions", "Dimensions", `${vid.videoWidth} × ${vid.videoHeight}`),
          );
        }
      }

      finish(fields);
    };

    el.onerror = () => finish([]);
  });
}

// ── Layer 5: Text Analysis ───────────────────────────────────

const TEXT_SAMPLE_SIZE = 8192;
const TEXT_PREVIEW_MAX_LINES = 200;
const TEXT_READ_LIMIT = 65536; // 64KB for text analysis

interface TextAnalysis {
  isText: boolean;
  encoding: string;
  lineCount: number;
  charCount: number;
  wordCount: number;
  subFormat: string;
  preview: string;
  fields: ExifField[];
}

function isProbablyText(buffer: ArrayBuffer): boolean {
  const sampleLen = Math.min(buffer.byteLength, TEXT_SAMPLE_SIZE);
  if (sampleLen === 0) return false;
  const sample = new Uint8Array(buffer, 0, sampleLen);
  let nullCount = 0;
  let controlCount = 0;
  let textLikeCount = 0;
  // Track high-byte density (0x80-0xFF) — binary formats tend to have
  // more evenly distributed high bytes than real text
  let highByteCount = 0;

  for (let i = 0; i < sampleLen; i++) {
    const byte = sample[i];
    if (byte === 0) nullCount++;
    else if (byte < 8 || (byte > 13 && byte < 32 && byte !== 27)) controlCount++;
    else {
      textLikeCount++;
      if (byte >= 0x80) highByteCount++;
    }
  }

  // Too many nulls → binary (unless very small file)
  if (nullCount > sample.length * 0.05 && sample.length > 32) return false;
  // Too many control characters → binary
  if (controlCount > sample.length * 0.1) return false;
  // High byte ratio: UTF-8 text typically has <30% high bytes.
  // Pure binary with ASCII-range headers might pass the text-like check
  // but will have higher density of 0x80-0xFF bytes.
  if (highByteCount > sample.length * 0.35) return false;
  // Require a strong majority of text-like bytes
  return textLikeCount > sample.length * 0.75;
}

type BomEncoding = "utf-8" | "utf-16be" | "utf-16le" | null;

function detectBomEncoding(buffer: ArrayBuffer): BomEncoding {
  const view = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) return "utf-8";
  if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) return "utf-16be";
  if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) return "utf-16le";
  return null;
}

function detectBom(buffer: ArrayBuffer): string {
  const encoding = detectBomEncoding(buffer);
  if (encoding === "utf-8") return "UTF-8 (BOM)";
  if (encoding === "utf-16be") return "UTF-16 BE";
  if (encoding === "utf-16le") return "UTF-16 LE";
  return "UTF-8";
}

// Extensions where content heuristics (Markdown, YAML, CSV, etc.) should not
// override extension-based identification.
const CODE_EXTENSIONS: Record<string, string> = {
  js: "JavaScript",
  ts: "TypeScript",
  jsx: "JSX",
  tsx: "TSX",
  py: "Python",
  rb: "Ruby",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  cpp: "C++",
  h: "C/C++ Header",
  cs: "C#",
  php: "PHP",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  fish: "Fish",
  ps1: "PowerShell",
  bat: "Batch",
  sql: "SQL",
  r: "R",
  lua: "Lua",
  vim: "Vim Script",
  el: "Emacs Lisp",
  ex: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  ml: "OCaml",
  scala: "Scala",
  clj: "Clojure",
  dart: "Dart",
  zig: "Zig",
  nim: "Nim",
  v: "V",
  d: "D",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  tex: "LaTeX",
  bib: "BibTeX",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  cmake: "CMake",
};

function detectTextSubFormat(text: string, ext: string): string {
  const codeMatch = CODE_EXTENSIONS[ext];
  if (codeMatch) return codeMatch;

  // Try JSON
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text);
      return "JSON";
    } catch {
      // Might be partial JSON (we only read 64KB)
      if (trimmed.startsWith("{") && text.includes('"')) return "JSON (partial)";
    }
  }

  // XML / SVG / HTML
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<!DOCTYPE")) {
    if (trimmed.includes("<svg") || trimmed.includes("<SVG")) return "SVG";
    if (trimmed.includes("<html") || trimmed.includes("<HTML") || trimmed.includes("<!DOCTYPE html")) return "HTML";
    return "XML";
  }
  if (trimmed.startsWith("<svg") || trimmed.startsWith("<SVG")) return "SVG";
  if (trimmed.startsWith("<html") || trimmed.startsWith("<HTML") || trimmed.startsWith("<!doctype html")) return "HTML";

  // CSV — check if first few lines have consistent delimiters
  const firstLines = text.split("\n", 5);
  if (firstLines.length >= 2) {
    for (const delim of [",", "\t", ";", "|"]) {
      const counts = firstLines.map((l) => l.split(delim).length);
      if (counts[0] >= 2 && counts.every((c) => c === counts[0])) {
        return delim === "\t" ? "TSV" : delim === "," ? "CSV" : `Delimited (${delim})`;
      }
    }
  }

  // YAML
  if (trimmed.startsWith("---") || /^[\w-]+:\s/m.test(trimmed)) {
    const colonLines = firstLines.filter((l) => /^[\w-]+:\s/.test(l)).length;
    if (colonLines >= 2) return "YAML";
  }

  // Markdown
  if (/^#{1,6}\s/m.test(text) || text.includes("```") || /^\s*[-*]\s/m.test(text)) {
    const headings = (text.match(/^#{1,6}\s/gm) ?? []).length;
    if (headings >= 1) return "Markdown";
  }

  // TOML
  if (/^\[[\w.-]+\]/m.test(trimmed)) return "TOML";

  // INI
  if (/^\[[\w\s]+\]/m.test(trimmed) && /^[\w.]+\s*=/m.test(trimmed)) return "INI";

  // Fallback to extension hints
  const extMap: Record<string, string> = {
    js: "JavaScript",
    ts: "TypeScript",
    jsx: "JSX",
    tsx: "TSX",
    py: "Python",
    rb: "Ruby",
    rs: "Rust",
    go: "Go",
    java: "Java",
    kt: "Kotlin",
    swift: "Swift",
    c: "C",
    cpp: "C++",
    h: "C/C++ Header",
    cs: "C#",
    php: "PHP",
    sh: "Shell",
    bash: "Bash",
    zsh: "Zsh",
    fish: "Fish",
    ps1: "PowerShell",
    bat: "Batch",
    sql: "SQL",
    r: "R",
    lua: "Lua",
    vim: "Vim Script",
    el: "Emacs Lisp",
    ex: "Elixir",
    erl: "Erlang",
    hs: "Haskell",
    ml: "OCaml",
    scala: "Scala",
    clj: "Clojure",
    dart: "Dart",
    zig: "Zig",
    nim: "Nim",
    v: "V",
    d: "D",
    css: "CSS",
    scss: "SCSS",
    sass: "Sass",
    less: "Less",
    log: "Log",
    env: "Environment",
    cfg: "Config",
    conf: "Config",
    txt: "Plain Text",
    md: "Markdown",
    rst: "reStructuredText",
    tex: "LaTeX",
    bib: "BibTeX",
    csv: "CSV",
    tsv: "TSV",
    json: "JSON",
    jsonl: "JSON Lines",
    xml: "XML",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    ini: "INI",
    properties: "Properties",
    dockerfile: "Dockerfile",
    makefile: "Makefile",
    cmake: "CMake",
    gitignore: "Gitignore",
    editorconfig: "EditorConfig",
  };

  return extMap[ext] ?? "Plain Text";
}

function analyzeJsonStructure(text: string): ExifField[] {
  const fields: ExifField[] = [];
  try {
    const parsed = JSON.parse(text);
    const type = Array.isArray(parsed) ? "array" : typeof parsed;
    fields.push(field("text.json.type", "Root Type", type));

    if (Array.isArray(parsed)) {
      fields.push(field("text.json.length", "Array Length", parsed.length));
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
        fields.push(field("text.json.itemKeys", "Item Keys", Object.keys(parsed[0]).join(", ")));
      }
    } else if (typeof parsed === "object" && parsed !== null) {
      const keys = Object.keys(parsed);
      fields.push(field("text.json.keys", "Keys", keys.length, `${keys.length} (${keys.slice(0, 8).join(", ")}${keys.length > 8 ? "…" : ""})`));

      // Measure nesting depth — iterative BFS to avoid stack overflow
      // on deeply nested or extremely wide objects
      let maxDepth = 0;
      const stack: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
      let visited = 0;
      const MAX_VISITS = 5000; // cap work to stay responsive

      while (stack.length > 0 && visited < MAX_VISITS) {
        const { value: node, depth: d } = stack.pop()!;
        if (d > maxDepth) maxDepth = d;
        if (d >= 20) continue; // don't go deeper than 20
        if (typeof node !== "object" || node === null) continue;
        visited++;
        // Sample children — for wide objects, only check first few
        const childKeys = Object.keys(node);
        const sampled = childKeys.length > 8 ? childKeys.slice(0, 8) : childKeys;
        for (const k of sampled) {
          stack.push({ value: (node as Record<string, unknown>)[k], depth: d + 1 });
        }
      }
      fields.push(field("text.json.depth", "Nesting Depth", maxDepth));
    }
  } catch {
    // Partial JSON
  }
  return fields;
}

async function analyzeText(
  buffer: ArrayBuffer,
  file: File,
): Promise<TextAnalysis | null> {
  const initialBom = detectBomEncoding(buffer);
  if (!initialBom && !isProbablyText(buffer)) return null;

  const readSize = Math.min(file.size, TEXT_READ_LIMIT);
  let textBuffer: ArrayBuffer;
  if (readSize <= buffer.byteLength) {
    // We already have enough data — use it directly (or a view into it)
    textBuffer = readSize < buffer.byteLength ? buffer.slice(0, readSize) : buffer;
  } else {
    // Need more data than the initial read provided
    textBuffer = await file.slice(0, readSize).arrayBuffer();
  }

  const bomEncoding = detectBomEncoding(textBuffer);
  const encoding = detectBom(textBuffer);
  let text: string;
  try {
    const decoderLabel =
      bomEncoding === "utf-16be"
        ? "utf-16be"
        : bomEncoding === "utf-16le"
          ? "utf-16le"
          : "utf-8";
    const decoder = new TextDecoder(decoderLabel, { fatal: false });
    text = decoder.decode(textBuffer);
  } catch {
    return null;
  }

  const ext = fileExtension(file.name);
  const subFormat = detectTextSubFormat(text, ext);

  const lines = text.split("\n");
  const lineCount = lines.length;
  const charCount = text.length;
  // Count words without creating a full split array — match and count
  const wordMatches = text.match(/\S+/g);
  const wordCount = wordMatches ? wordMatches.length : 0;

  const isPartial = file.size > TEXT_READ_LIMIT;
  const approx = isPartial ? "~" : "";

  const fields: ExifField[] = [
    field("text.encoding", "Encoding", encoding),
    field("text.format", "Format", subFormat),
    field("text.lines", "Lines", lineCount, `${approx}${lineCount.toLocaleString()}`),
    field("text.characters", "Characters", charCount, `${approx}${charCount.toLocaleString()}`),
    field("text.words", "Words", wordCount, `${approx}${wordCount.toLocaleString()}`),
  ];

  if (isPartial) {
    fields.push(
      field("text.partial", "Note", "partial", `Analysis based on first ${formatBytes(TEXT_READ_LIMIT)}`),
    );
  }

  // Sub-format specific analysis
  if (subFormat === "JSON" || subFormat === "JSON (partial)") {
    fields.push(...analyzeJsonStructure(text));
  }

  // Preview: first N lines
  const previewLines = lines.slice(0, TEXT_PREVIEW_MAX_LINES);
  const preview = previewLines.join("\n");

  return {
    isText: true,
    encoding,
    lineCount,
    charCount,
    wordCount,
    subFormat,
    preview,
    fields,
  };
}

// ── Layer 6: XML/SVG Analysis ────────────────────────────────

function analyzeXmlContent(text: string): ExifCategory[] {
  const categories: ExifCategory[] = [];
  const fields: ExifField[] = [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "text/xml");
    const errors = doc.querySelectorAll("parsererror");

    if (errors.length === 0) {
      const root = doc.documentElement;
      fields.push(field("xml.rootElement", "Root Element", root.tagName));

      // Count total elements
      const allElements = doc.querySelectorAll("*");
      fields.push(field("xml.elements", "Total Elements", allElements.length));

      // Unique element names
      const names = new Set<string>();
      allElements.forEach((el) => names.add(el.tagName));
      fields.push(field("xml.uniqueTags", "Unique Tags", names.size));

      // Namespace
      if (root.namespaceURI) {
        fields.push(field("xml.namespace", "Namespace", root.namespaceURI));
      }

      // SVG specific
      if (root.tagName === "svg" || root.tagName.toLowerCase() === "svg") {
        const viewBox = root.getAttribute("viewBox");
        const width = root.getAttribute("width");
        const height = root.getAttribute("height");

        if (viewBox) fields.push(field("svg.viewBox", "ViewBox", viewBox));
        if (width && height) {
          fields.push(field("svg.dimensions", "Dimensions", `${width} × ${height}`));
        }

        // Count SVG features
        const features: string[] = [];
        if (doc.querySelectorAll("linearGradient, radialGradient").length > 0) features.push("gradients");
        if (doc.querySelectorAll("filter").length > 0) features.push("filters");
        if (doc.querySelectorAll("animate, animateTransform, animateMotion, set").length > 0) features.push("animations");
        if (doc.querySelectorAll("text, tspan").length > 0) features.push("text");
        if (doc.querySelectorAll("clipPath").length > 0) features.push("clip paths");
        if (doc.querySelectorAll("mask").length > 0) features.push("masks");
        if (doc.querySelectorAll("use").length > 0) features.push("symbol refs");
        if (doc.querySelectorAll("image").length > 0) features.push("embedded images");

        if (features.length > 0) {
          fields.push(field("svg.features", "Features", features.join(", ")));
        }

        // Path count
        const paths = doc.querySelectorAll("path");
        if (paths.length > 0) {
          fields.push(field("svg.paths", "Paths", paths.length));
        }
      }
    }
  } catch {
    // XML parsing failed — not valid XML
  }

  if (fields.length > 0) {
    categories.push({
      id: "content",
      title: "CONTENT",
      fields,
      expanded: true,
    });
  }

  return categories;
}

// ── Orchestrator ─────────────────────────────────────────────

export async function analyzeFile(
  file: File,
  buffer: ArrayBuffer,
): Promise<FormatResult> {
  const view = new DataView(buffer);
  const mime = file.type || "";
  const ext = fileExtension(file.name);

  // Step 1: Detect format from bytes
  const sig = detectFormat(view, file.size, mime, ext);
  const family = sig?.family ?? "unknown";
  let formatName = sig?.name ?? "Unknown";
  let previewType = sig?.previewHint ?? "none";
  const categories: ExifCategory[] = [];
  let textPreview: string | undefined;
  const summary: { label: string; value: string }[] = [];

  // Step 2: Walk structure and extract metadata based on family
  try {
    switch (family) {
      case "jpeg":
      case "tiff":
        // No container-level walker needed; preview + format name are enough.
        break;

      case "riff": {
        const riffType = fourCC(view, 8);
        formatName = riffType === "WAVE" ? "WAV" : riffType === "AVI " ? "AVI" : riffType === "WEBP" ? "WebP" : `RIFF/${riffType}`;
        previewType = riffType === "WAVE" ? "audio" : riffType === "AVI " ? "video" : riffType === "WEBP" ? "image" : "none";

        const chunks = walkChunks(view, 12);
        categories.push(...extractRiffMeta(view, chunks, riffType));

        // Browser media probe only for audio/video RIFF variants.
        const mediaProbeType = riffType === "AVI " ? "video" : riffType === "WAVE" ? "audio" : null;
        if (mediaProbeType && !categories.some((c) => c.fields.some((f) => f.id === "riff.duration"))) {
          const probeFields = await probeMedia(file, mediaProbeType);
          if (probeFields.length > 0) {
            const cat = categories.find((c) => c.id === mediaProbeType);
            if (cat) cat.fields.push(...probeFields);
            else categories.push({
              id: mediaProbeType,
              title: mediaProbeType === "audio" ? "AUDIO" : "VIDEO",
              fields: probeFields,
              expanded: true,
            });
          }
        }
        break;
      }

      case "isobmff": {
        const boxes = walkBoxes(view, 0);
        categories.push(...extractIsobmffMeta(view, boxes));

        // Determine format name from brand
        const ftyp = boxes.find((b) => b.type === "ftyp");
        if (ftyp && ftyp.dataOffset + 4 <= view.byteLength) {
          const brand = fourCC(view, ftyp.dataOffset).trim();
          const nameMap: Record<string, string> = {
            isom: "MP4", mp41: "MP4", mp42: "MP4", M4V: "M4V", M4A: "M4A",
            qt: "QuickTime", "3gp4": "3GP", "3gp5": "3GP", heic: "HEIC",
            heix: "HEIC", avif: "AVIF", mif1: "HEIF",
          };
          formatName = nameMap[brand] ?? "ISOBMFF";

          const audioOnly = brand === "M4A" || brand === "M4P";
          previewType = audioOnly ? "audio" : (brand === "heic" || brand === "heix" || brand === "avif" || brand === "mif1") ? "image" : "video";
        }

        // Browser probe for additional metadata
        if (previewType === "audio" || previewType === "video") {
          const probeFields = await probeMedia(file, previewType);
          const cat = categories.find((c) => c.id === previewType);
          if (cat) {
            // Only add fields not already present
            for (const pf of probeFields) {
              if (!cat.fields.some((f) => f.label === pf.label)) {
                cat.fields.push(pf);
              }
            }
          }
        }
        break;
      }

      case "id3": {
        // Parse ID3v2 header
        if (sig?.subtype !== "bare" && view.byteLength >= 10) {
          const version = view.getUint8(3);
          const flags = view.getUint8(5);
          const tagSize =
            ((view.getUint8(6) & 0x7f) << 21) |
            ((view.getUint8(7) & 0x7f) << 14) |
            ((view.getUint8(8) & 0x7f) << 7) |
            (view.getUint8(9) & 0x7f);

          const headerOffset = (flags & 0x40) ? 20 : 10; // Extended header
          const frames = walkID3Frames(view, headerOffset, tagSize, version);
          categories.push(...extractID3Meta(view, frames));

          // Add ID3 version info
          const cat = categories.find((c) => c.id === "audio");
          if (cat) {
            cat.fields.unshift(
              field("id3.version", "Tag Format", `ID3v2.${version}`),
            );
          }
        }

        formatName = "MP3";
        previewType = "audio";

        // Browser probe for duration
        const probeFields = await probeMedia(file, "audio");
        if (probeFields.length > 0) {
          const cat = categories.find((c) => c.id === "audio");
          if (cat) cat.fields.push(...probeFields);
          else categories.push({ id: "audio", title: "AUDIO", fields: probeFields, expanded: true });
        }
        break;
      }

      case "flac": {
        categories.push(...extractFlacMeta(view));
        formatName = "FLAC";
        previewType = "audio";

        // Browser probe for duration validation
        const probeFields = await probeMedia(file, "audio");
        if (probeFields.length > 0) {
          const cat = categories.find((c) => c.id === "audio");
          if (cat) {
            for (const pf of probeFields) {
              if (!cat.fields.some((f) => f.label === pf.label)) {
                cat.fields.push(pf);
              }
            }
          }
        }
        break;
      }

      case "ogg": {
        formatName = "OGG";
        previewType = "audio";
        // OGG parsing is complex (page-based); rely on browser probe
        const probeFields = await probeMedia(file, "audio");
        if (probeFields.length > 0) {
          categories.push({ id: "audio", title: "AUDIO", fields: probeFields, expanded: true });
        }
        break;
      }

      case "ebml": {
        formatName = "Matroska";
        previewType = "video";
        // EBML is complex; browser probe for basic metadata
        const probeFields = await probeMedia(file, "video");
        if (probeFields.length > 0) {
          categories.push({ id: "video", title: "VIDEO", fields: probeFields, expanded: true });
        }
        break;
      }

      case "png": {
        const chunks = walkPngChunks(view);
        categories.push(...extractPngMeta(view, chunks));
        formatName = chunks.some((c) => c.type === "acTL") ? "APNG" : "PNG";
        previewType = "image";
        break;
      }

      case "gif": {
        categories.push(...extractGifMeta(view));
        previewType = "image";
        break;
      }

      case "pdf": {
        categories.push(...extractPdfMeta(view));
        break;
      }

      case "zip": {
        // ZIP central directory lives at the END of the file.
        // For files larger than our initial read, fetch the tail separately.
        // We pass the tail buffer and its base offset so walkZipCentralDir
        // can translate absolute file offsets into buffer-relative ones.
        let zipView: DataView;
        let zipBaseOffset: number; // file offset that corresponds to byte 0 of zipView

        if (file.size > buffer.byteLength) {
          const tailStart = Math.max(0, file.size - 65536);
          const tailSlice = await file.slice(tailStart).arrayBuffer();
          zipView = new DataView(tailSlice);
          zipBaseOffset = tailStart;
        } else {
          zipView = view;
          zipBaseOffset = 0;
        }

        const entries = walkZipCentralDir(zipView, zipBaseOffset);
        categories.push(...extractZipMeta(entries));
        break;
      }

      case "font": {
        categories.push(...extractFontMeta(view, formatName));
        break;
      }
    }
  } catch {
    // Structure walking failed — continue with what we have
  }

  // Step 3: Text analysis (for text family or as fallback for unknown)
  if (family === "text" || family === "xml" || (family === "unknown" && categories.length === 0)) {
    const textResult = await analyzeText(buffer, file);
    if (textResult) {
      categories.push({
        id: "content",
        title: "CONTENT",
        fields: textResult.fields,
        expanded: true,
      });
      textPreview = textResult.preview;
      formatName = textResult.subFormat;
      previewType = "text";

      // XML/SVG/HTML: deeper analysis via DOMParser
      if (textResult.subFormat === "XML" || textResult.subFormat === "SVG" || textResult.subFormat === "HTML") {
        const xmlCats = analyzeXmlContent(textResult.preview);
        categories.push(...xmlCats);

        // SVG can be rendered as image
        if (textResult.subFormat === "SVG") {
          previewType = "image";
        }
      }
    }
  }

  // Step 4: Build summary
  if (categories.length > 0) {
    // First category's most interesting fields
    const primaryCat = categories[0];

    if (primaryCat.id === "audio") {
      const dur = primaryCat.fields.find((f) => f.label === "Duration");
      summary.push(
        { label: "format", value: formatName },
        { label: "duration", value: dur?.displayValue ?? "unknown" },
      );
    } else if (primaryCat.id === "video") {
      const dur = primaryCat.fields.find((f) => f.label === "Duration");
      const dim = primaryCat.fields.find((f) => f.label.includes("Dimensions"));
      summary.push(
        { label: "format", value: formatName },
        { label: dur ? "duration" : "resolution", value: dur?.displayValue ?? dim?.displayValue ?? "unknown" },
      );
    } else if (primaryCat.id === "content") {
      const lines = primaryCat.fields.find((f) => f.label === "Lines");
      summary.push(
        { label: "type", value: formatName },
        { label: "lines", value: lines?.displayValue ?? "—" },
      );
    } else if (primaryCat.id === "image") {
      const dim = primaryCat.fields.find((f) => f.label === "Dimensions");
      summary.push(
        { label: "format", value: formatName },
        { label: "dimensions", value: dim?.displayValue ?? "unknown" },
      );
    } else if (primaryCat.id === "document") {
      const pages = primaryCat.fields.find((f) => f.label === "Pages");
      const name = primaryCat.fields.find((f) => f.label === "Family" || f.label === "Full Name");
      summary.push(
        { label: "format", value: formatName },
        { label: pages ? "pages" : "name", value: pages?.displayValue ?? name?.displayValue ?? "—" },
      );
    } else if (primaryCat.id === "structure") {
      const count = primaryCat.fields.find((f) => f.label === "File Count");
      const sub = primaryCat.fields.find((f) => f.label === "Format");
      summary.push(
        { label: "format", value: sub?.displayValue ?? formatName },
        { label: "files", value: count?.displayValue ?? "—" },
      );
    } else {
      summary.push({ label: "format", value: formatName });
    }
  } else {
    summary.push({ label: "format", value: formatName });
  }

  return {
    categories,
    formatFamily: family,
    formatName,
    previewType,
    textPreview,
    summary,
  };
}
