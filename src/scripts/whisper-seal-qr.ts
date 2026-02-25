import { qrcodegen } from "./_qrcodegen_ref";

const QR_QUIET_ZONE_MODULES = 4;
const QR_SCAN_INTERVAL_MS = 180;
const QR_CAMERA_MAX_DIM = 960;
const QR_SAVEABLE_IMG_CLASS = "ws-seal-qr-image";

interface DetectedQr {
  rawValue?: string;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedQr[]>;
}

interface BarcodeDetectorCtorLike {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

interface TextBlockLike {
  rawValue?: string;
}

interface TextDetectorLike {
  detect(source: ImageBitmapSource): Promise<TextBlockLike[]>;
}

interface TextDetectorCtorLike {
  new (): TextDetectorLike;
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtorLike | null {
  const maybeCtor = (window as Window & { BarcodeDetector?: BarcodeDetectorCtorLike }).BarcodeDetector;
  return maybeCtor ?? null;
}

function getTextDetectorCtor(): TextDetectorCtorLike | null {
  const maybeCtor = (window as Window & { TextDetector?: TextDetectorCtorLike }).TextDetector;
  return maybeCtor ?? null;
}

function extractWs2FromText(text: string): string | null {
  const match = text.match(/WS2:[A-Za-z0-9_-]{40,}/i);
  if (!match) return null;
  const raw = match[0];
  return `WS2:${raw.slice(4)}`;
}

function extractWs2FromBytes(bytes: Uint8Array): string | null {
  const upperW = 0x57;
  const lowerW = 0x77;
  const upperS = 0x53;
  const lowerS = 0x73;
  const two = 0x32;
  const colon = 0x3a;

  const isCodeByte = (b: number): boolean =>
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    b === 0x5f || b === 0x2d;

  for (let i = 0; i + 4 < bytes.length; i++) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    if (!((b0 === upperW || b0 === lowerW) && (b1 === upperS || b1 === lowerS))) continue;
    if (bytes[i + 2] !== two || bytes[i + 3] !== colon) continue;

    let j = i + 4;
    while (j < bytes.length && isCodeByte(bytes[j])) j++;
    const len = j - (i + 4);
    if (len < 24) continue;

    const view = bytes.subarray(i + 4, j);
    let suffix = "";
    for (let k = 0; k < view.length; k++) suffix += String.fromCharCode(view[k]);
    return `WS2:${suffix}`;
  }

  return null;
}

function ensureQrSaveableImage(canvas: HTMLCanvasElement): HTMLImageElement {
  const targetId = `${canvas.id}--img`;
  const parent = canvas.parentElement;
  if (!parent) throw new Error("Canvas parent unavailable");

  const existing = document.getElementById(targetId);
  if (existing instanceof HTMLImageElement && parent.contains(existing)) return existing;

  const img = document.createElement("img");
  img.id = targetId;
  img.className = `${canvas.className} ${QR_SAVEABLE_IMG_CLASS}`.trim();
  img.alt = canvas.getAttribute("aria-label") || "QR code";
  img.decoding = "async";
  img.loading = "eager";
  img.referrerPolicy = "no-referrer";
  parent.insertBefore(img, canvas.nextSibling);
  return img;
}

export interface QrScannerCapability {
  supported: boolean;
  reason?: string;
}

export async function getQrScannerCapability(): Promise<QrScannerCapability> {
  const ctor = getBarcodeDetectorCtor();
  if (!ctor) {
    return {
      supported: false,
      reason: "qr scan not supported",
    };
  }

  if (!ctor.getSupportedFormats) {
    return { supported: true };
  }

  try {
    const formats = await ctor.getSupportedFormats();
    if (formats.includes("qr_code")) return { supported: true };
    return {
      supported: false,
      reason: "qr format not supported",
    };
  } catch {
    return {
      supported: false,
      reason: "qr check failed",
    };
  }
}

export async function createQrDetector(): Promise<BarcodeDetectorLike | null> {
  const capability = await getQrScannerCapability();
  if (!capability.supported) return null;

  const ctor = getBarcodeDetectorCtor();
  if (!ctor) return null;
  return new ctor({ formats: ["qr_code"] });
}

export interface QrImageDecodeResult {
  rawValue: string;
  method: "barcode" | "text" | "bytes";
}

export interface QrTextDecodeResult {
  rawValue: string;
  method: "barcode" | "text";
}

export async function decodeQrTextFromImage(file: File): Promise<QrTextDecodeResult | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      bitmap = null;
    }

    if (!bitmap) return null;

    try {
      const barcode = await createQrDetector();
      if (barcode) {
        const found = await barcode.detect(bitmap);
        for (const entry of found) {
          if (!entry.rawValue) continue;
          const value = entry.rawValue.trim();
          if (value) return { rawValue: value, method: "barcode" };
        }
      }
    } catch {
      // Soft-fail and continue with OCR fallback.
    }

    try {
      const textCtor = getTextDetectorCtor();
      if (textCtor) {
        const textDetector = new textCtor();
        const blocks = await textDetector.detect(bitmap);
        const joined = blocks.map((block) => block.rawValue ?? "").join("\n").trim();
        if (joined) return { rawValue: joined, method: "text" };
      }
    } catch {
      // Soft-fail with null.
    }
  } finally {
    bitmap?.close();
  }

  return null;
}

export async function decodeWs2FromImage(file: File): Promise<QrImageDecodeResult | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      bitmap = null;
    }

    if (bitmap) {
      try {
        const barcode = await createQrDetector();
        if (barcode) {
          const found = await barcode.detect(bitmap);
          for (const entry of found) {
            if (!entry.rawValue) continue;
            const value = extractWs2FromText(entry.rawValue);
            if (value) return { rawValue: value, method: "barcode" };
          }
        }
      } catch {
        // Soft-fail and continue with the next decode layer.
      }

      try {
        const textCtor = getTextDetectorCtor();
        if (textCtor) {
          const textDetector = new textCtor();
          const blocks = await textDetector.detect(bitmap);
          const joined = blocks.map((block) => block.rawValue ?? "").join("\n");
          const value = extractWs2FromText(joined);
          if (value) return { rawValue: value, method: "text" };
        }
      } catch {
        // Soft-fail and continue with byte-level fallback.
      }
    }
  } finally {
    bitmap?.close();
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const fromBytes = extractWs2FromBytes(bytes);
    if (fromBytes) return { rawValue: fromBytes, method: "bytes" };
  } catch {
    return null;
  }

  return null;
}

/**
 * Trust boundary note:
 * QR encodes the exact full WS2 public key string only. It is not a new identity format
 * and does not replace WS2 validation; callers must always re-validate decoded payload.
 */
export function renderSealQrToCanvas(canvas: HTMLCanvasElement, ws2Code: string): void {
  renderQrToCanvas(canvas, ws2Code);
}

export function renderQrToCanvas(canvas: HTMLCanvasElement, value: string): void {
  const qr = qrcodegen.QrCode.encodeText(value, qrcodegen.QrCode.Ecc.MEDIUM);
  const modules = qr.size;
  const margin = QR_QUIET_ZONE_MODULES;

  const cssSize = Number(canvas.dataset.qrSize || 220);
  const pixelRatio = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  canvas.width = cssSize * pixelRatio;
  canvas.height = cssSize * pixelRatio;
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");

  const totalModules = modules + margin * 2;
  const moduleSize = canvas.width / totalModules;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#000000";
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!qr.getModule(x, y)) continue;
      const px = Math.round((x + margin) * moduleSize);
      const py = Math.round((y + margin) * moduleSize);
      const pw = Math.ceil(moduleSize);
      const ph = Math.ceil(moduleSize);
      ctx.fillRect(px, py, pw, ph);
    }
  }

  try {
    const img = ensureQrSaveableImage(canvas);
    img.src = canvas.toDataURL("image/png");
    img.style.width = canvas.style.width;
    img.style.height = canvas.style.height;
    canvas.style.display = "none";
  } catch {
    canvas.style.display = "";
  }
}

export function getQrScanIntervalMs(): number {
  return QR_SCAN_INTERVAL_MS;
}

export function getQrCameraConstraints(): MediaTrackConstraints {
  return {
    facingMode: { ideal: "environment" },
    width: { ideal: QR_CAMERA_MAX_DIM },
    height: { ideal: QR_CAMERA_MAX_DIM },
  };
}
