// woflo - the lens: zero-dependency client-side EXIF parser
// Parses EXIF metadata from JPEG/TIFF files using raw ArrayBuffer manipulation.
// No files ever leave the browser.

// ── Types ────────────────────────────────────────────────────

export type ExifValueType = string | number | number[] | null;

export interface ExifField {
  id: string;
  label: string;
  value: ExifValueType;
  displayValue: string;
  rawTag?: number;
  explanation: string;
  sensitive?: boolean;
}

export interface ExifCategory {
  id: string;
  title: string;
  fields: ExifField[];
  expanded: boolean;
}

export interface LensData {
  categories: ExifCategory[];
  totalFields: number;
  populatedFields: number;
  hasGps: boolean;
  hasExif: boolean;
  cameraName: string | null;
  fileName: string;
  fileSize: number;
  parsedAt: number;
  /** Structural family detected from bytes */
  formatFamily: string;
  /** Human-readable format name */
  formatName: string;
  /** How the UI should preview this file */
  previewType: "image" | "audio" | "video" | "text" | "none";
  /** Text content preview (first ~200 lines) */
  textPreview?: string;
  /** Dynamic summary items (replaces hardcoded camera/GPS) */
  summaryItems: { label: string; value: string }[];
}

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

// ── EXIF Tag Maps ────────────────────────────────────────────

interface LensFieldCounts {
  totalFields: number;
  populatedFields: number;
}

function normalizeCountText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function countKey(field: ExifField): string {
  return `${normalizeCountText(field.label)}|${normalizeCountText(field.displayValue)}`;
}

function shouldCountAsPopulated(field: ExifField): boolean {
  return field.value !== null && field.id !== "gps.warning";
}

function isCountDuplicate(existingCategories: Set<string> | undefined, categoryId: string): boolean {
  if (!existingCategories) return false;
  // Always drop exact repeats in the same category.
  if (existingCategories.has(categoryId)) return true;
  // Deduplicate overlap between PROFILE and any other category.
  return categoryId === "profile" || existingCategories.has("profile");
}

function computeFieldCounts(categories: ExifCategory[]): LensFieldCounts {
  let totalFields = 0;
  let populatedFields = 0;
  const seenTotal = new Map<string, Set<string>>();
  const seenPopulated = new Map<string, Set<string>>();

  for (const category of categories) {
    if (category.id === "profile") continue;
    for (const f of category.fields) {
      const key = countKey(f);

      const totalCategories = seenTotal.get(key);
      const totalDuplicate = isCountDuplicate(totalCategories, category.id);
      if (totalCategories) totalCategories.add(category.id);
      else seenTotal.set(key, new Set([category.id]));
      if (!totalDuplicate) totalFields++;

      if (!shouldCountAsPopulated(f)) continue;
      const populatedCategories = seenPopulated.get(key);
      const populatedDuplicate = isCountDuplicate(populatedCategories, category.id);
      if (populatedCategories) populatedCategories.add(category.id);
      else seenPopulated.set(key, new Set([category.id]));
      if (!populatedDuplicate) populatedFields++;
    }
  }

  return { totalFields, populatedFields };
}

const IFD_TAGS: Record<number, string> = {
  0x00fe: "NewSubfileType",
  0x0100: "ImageWidth",
  0x0101: "ImageHeight",
  0x0102: "BitsPerSample",
  0x0103: "Compression",
  0x0106: "PhotometricInterpretation",
  0x010e: "ImageDescription",
  0x010f: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x0115: "SamplesPerPixel",
  0x011a: "XResolution",
  0x011b: "YResolution",
  0x0128: "ResolutionUnit",
  0x0131: "Software",
  0x0132: "DateTime",
  0x013b: "Artist",
  0x0213: "YCbCrPositioning",
  0x8298: "Copyright",
  0x8769: "ExifIFDPointer",
  0x8825: "GPSInfoIFDPointer",
};

const EXIF_TAGS: Record<number, string> = {
  0x829a: "ExposureTime",
  0x829d: "FNumber",
  0x8822: "ExposureProgram",
  0x8827: "ISOSpeedRatings",
  0x8830: "SensitivityType",
  0x9000: "ExifVersion",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x9010: "OffsetTime",
  0x9011: "OffsetTimeOriginal",
  0x9012: "OffsetTimeDigitized",
  0x9101: "ComponentsConfiguration",
  0x9102: "CompressedBitsPerPixel",
  0x9201: "ShutterSpeedValue",
  0x9202: "ApertureValue",
  0x9203: "BrightnessValue",
  0x9204: "ExposureBiasValue",
  0x9205: "MaxApertureValue",
  0x9206: "SubjectDistance",
  0x9207: "MeteringMode",
  0x9208: "LightSource",
  0x9209: "Flash",
  0x920a: "FocalLength",
  0x9214: "SubjectArea",
  0x927c: "MakerNote",
  0x9286: "UserComment",
  0xa001: "ColorSpace",
  0xa002: "PixelXDimension",
  0xa003: "PixelYDimension",
  0xa20e: "FocalPlaneXResolution",
  0xa20f: "FocalPlaneYResolution",
  0xa210: "FocalPlaneResolutionUnit",
  0xa217: "SensingMethod",
  0xa300: "FileSource",
  0xa301: "SceneType",
  0xa401: "CustomRendered",
  0xa402: "ExposureMode",
  0xa403: "WhiteBalance",
  0xa404: "DigitalZoomRatio",
  0xa405: "FocalLengthIn35mmFilm",
  0xa406: "SceneCaptureType",
  0xa407: "GainControl",
  0xa408: "Contrast",
  0xa409: "Saturation",
  0xa40a: "Sharpness",
  0xa431: "BodySerialNumber",
  0xa432: "LensInfo",
  0xa433: "LensMake",
  0xa434: "LensModel",
  0xa435: "LensSerialNumber",
  0xa420: "ImageUniqueID",
  0xa500: "Gamma",
};

const GPS_TAGS: Record<number, string> = {
  0x0000: "GPSVersionID",
  0x0001: "GPSLatitudeRef",
  0x0002: "GPSLatitude",
  0x0003: "GPSLongitudeRef",
  0x0004: "GPSLongitude",
  0x0005: "GPSAltitudeRef",
  0x0006: "GPSAltitude",
  0x0007: "GPSTimeStamp",
  0x0008: "GPSSatellites",
  0x0009: "GPSStatus",
  0x000a: "GPSMeasureMode",
  0x000b: "GPSDOP",
  0x000c: "GPSSpeedRef",
  0x000d: "GPSSpeed",
  0x000e: "GPSTrackRef",
  0x000f: "GPSTrack",
  0x0010: "GPSImgDirectionRef",
  0x0011: "GPSImgDirection",
  0x0012: "GPSMapDatum",
  0x001d: "GPSDateStamp",
};

// ── Value Lookups ────────────────────────────────────────────

const ORIENTATION_MAP: Record<number, string> = {
  1: "Normal",
  2: "Mirrored horizontal",
  3: "Rotated 180\u00B0",
  4: "Mirrored vertical",
  5: "Mirrored horizontal + rotated 270\u00B0",
  6: "Rotated 90\u00B0 CW",
  7: "Mirrored horizontal + rotated 90\u00B0",
  8: "Rotated 270\u00B0 CW",
};

const EXPOSURE_PROGRAM_MAP: Record<number, string> = {
  0: "Not defined",
  1: "Manual",
  2: "Normal program",
  3: "Aperture priority",
  4: "Shutter priority",
  5: "Creative program",
  6: "Action program",
  7: "Portrait mode",
  8: "Landscape mode",
};

const METERING_MODE_MAP: Record<number, string> = {
  0: "Unknown",
  1: "Average",
  2: "Center-weighted average",
  3: "Spot",
  4: "Multi-spot",
  5: "Pattern",
  6: "Partial",
  255: "Other",
};

const FLASH_MAP: Record<number, string> = {
  0x00: "No flash",
  0x01: "Fired",
  0x05: "Fired, return not detected",
  0x07: "Fired, return detected",
  0x08: "On, did not fire",
  0x09: "On, fired",
  0x0d: "On, return not detected",
  0x0f: "On, return detected",
  0x10: "Off, did not fire",
  0x14: "Off, did not fire, return not detected",
  0x18: "Auto, did not fire",
  0x19: "Auto, fired",
  0x1d: "Auto, fired, return not detected",
  0x1f: "Auto, fired, return detected",
  0x20: "No flash function",
  0x30: "Off, no flash function",
  0x41: "Fired, red-eye reduction",
  0x45: "Fired, red-eye reduction, return not detected",
  0x47: "Fired, red-eye reduction, return detected",
  0x49: "On, red-eye reduction",
  0x4d: "On, red-eye reduction, return not detected",
  0x4f: "On, red-eye reduction, return detected",
  0x58: "Auto, did not fire, red-eye reduction",
  0x59: "Auto, fired, red-eye reduction",
  0x5d: "Auto, fired, red-eye reduction, return not detected",
  0x5f: "Auto, fired, red-eye reduction, return detected",
};

const LIGHT_SOURCE_MAP: Record<number, string> = {
  0: "Unknown",
  1: "Daylight",
  2: "Fluorescent",
  3: "Tungsten (incandescent)",
  4: "Flash",
  9: "Fine weather",
  10: "Cloudy weather",
  11: "Shade",
  12: "Daylight fluorescent",
  13: "Day white fluorescent",
  14: "Cool white fluorescent",
  15: "White fluorescent",
  17: "Standard light A",
  18: "Standard light B",
  19: "Standard light C",
  20: "D55",
  21: "D65",
  22: "D75",
  23: "D50",
  24: "ISO studio tungsten",
  255: "Other",
};

const COLOR_SPACE_MAP: Record<number, string> = {
  1: "sRGB",
  2: "Adobe RGB",
  65535: "Uncalibrated",
};

const SCENE_CAPTURE_MAP: Record<number, string> = {
  0: "Standard",
  1: "Landscape",
  2: "Portrait",
  3: "Night scene",
};

const CONTRAST_MAP: Record<number, string> = {
  0: "Normal",
  1: "Soft",
  2: "Hard",
};

const SATURATION_MAP: Record<number, string> = {
  0: "Normal",
  1: "Low saturation",
  2: "High saturation",
};

const SHARPNESS_MAP: Record<number, string> = {
  0: "Normal",
  1: "Soft",
  2: "Hard",
};

const RESOLUTION_UNIT_MAP: Record<number, string> = {
  1: "No unit",
  2: "inches",
  3: "centimeters",
};

// ── Maker-Specific Tags ──────────────────────────────────────

const NIKON_TAGS: Record<number, string> = {
  0x0001: "MakerNoteVersion",
  0x0002: "ISOSpeed",
  0x0004: "Quality",
  0x0005: "WhiteBalance",
  0x0007: "FocusMode",
  0x001d: "SerialNumber",
  0x0084: "Lens",
  0x00a7: "ShutterCount",
};

const CANON_TAGS: Record<number, string> = {
  0x0001: "CanonSettings",
  0x0004: "ShotInfo",
  0x000c: "SerialNumber",
  0x0095: "LensModel",
};

const SENSING_METHOD_MAP: Record<number, string> = {
  1: "Not defined",
  2: "One-chip color area sensor",
  3: "Two-chip color area sensor",
  4: "Three-chip color area sensor",
  5: "Color sequential area sensor",
  7: "Trilinear sensor",
  8: "Color sequential linear sensor",
};

const GAIN_CONTROL_MAP: Record<number, string> = {
  0: "None",
  1: "Low gain up",
  2: "High gain up",
  3: "Low gain down",
  4: "High gain down",
};

const COMPRESSION_MAP: Record<number, string> = {
  1: "Uncompressed",
  6: "JPEG",
  7: "JPEG (new)",
  34712: "JPEG 2000",
};

// ── TIFF type constants ──────────────────────────────────────

const TIFF_BYTE = 1;
const TIFF_ASCII = 2;
const TIFF_SHORT = 3;
const TIFF_LONG = 4;
const TIFF_RATIONAL = 5;
const TIFF_UNDEFINED = 7;
const TIFF_SLONG = 9;
const TIFF_SRATIONAL = 10;

const TIFF_TYPE_SIZES: Record<number, number> = {
  [TIFF_BYTE]: 1,
  [TIFF_ASCII]: 1,
  [TIFF_SHORT]: 2,
  [TIFF_LONG]: 4,
  [TIFF_RATIONAL]: 8,
  6: 1, // SBYTE
  [TIFF_UNDEFINED]: 1,
  8: 2, // SSHORT
  [TIFF_SLONG]: 4,
  [TIFF_SRATIONAL]: 8,
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

// ── Low-Level Parsing ────────────────────────────────────────

type RawExif = Record<string, ExifValueType>;

function readRational(
  view: DataView,
  offset: number,
  le: boolean,
): number {
  if (offset + 8 > view.byteLength) return 0;
  const num = view.getUint32(offset, le);
  const den = view.getUint32(offset + 4, le);
  return den === 0 ? 0 : num / den;
}

function readSRational(
  view: DataView,
  offset: number,
  le: boolean,
): number {
  if (offset + 8 > view.byteLength) return 0;
  const num = view.getInt32(offset, le);
  const den = view.getInt32(offset + 4, le);
  return den === 0 ? 0 : num / den;
}

function readAscii(
  view: DataView,
  offset: number,
  count: number,
): string {
  const end = Math.min(offset + count, view.byteLength);
  let str = "";
  for (let i = offset; i < end; i++) {
    const ch = view.getUint8(i);
    if (ch === 0) break;
    str += String.fromCharCode(ch);
  }
  return str.trim();
}

function matchesAsciiSignature(
  view: DataView,
  offset: number,
  signature: string,
): boolean {
  if (offset < 0 || offset + signature.length > view.byteLength) return false;
  for (let i = 0; i < signature.length; i++) {
    if (view.getUint8(offset + i) !== (signature.charCodeAt(i) & 0xff)) return false;
  }
  return true;
}

/**
 * Parse UserComment (UNDEFINED type, starts with 8-byte charset prefix).
 * Common prefixes: "ASCII\0\0\0", "UNICODE\0", "\0\0\0\0\0\0\0\0" (undefined).
 */
function readUserComment(
  view: DataView,
  offset: number,
  count: number,
): string | null {
  if (count <= 8) return null;

  // Read 8-byte charset prefix
  const prefix = readAscii(view, offset, 8);
  const dataOffset = offset + 8;
  const dataLen = count - 8;

  if (prefix.startsWith("ASCII")) {
    return readAscii(view, dataOffset, dataLen);
  }

  // For UNICODE (UTF-16) or undefined charset, try ASCII fallback
  const end = Math.min(dataOffset + dataLen, view.byteLength);
  let str = "";
  for (let i = dataOffset; i < end; i++) {
    const ch = view.getUint8(i);
    if (ch === 0) continue; // skip nulls (common in UTF-16 ASCII range)
    if (ch >= 32 && ch < 127) str += String.fromCharCode(ch);
  }
  return str.trim() || null;
}

function parseIFD(
  view: DataView,
  tiffStart: number,
  ifdOffset: number,
  le: boolean,
  tagMap: Record<number, string>,
): RawExif {
  const result: RawExif = {};
  const absOffset = tiffStart + ifdOffset;

  if (absOffset + 2 > view.byteLength) return result;
  const entryCount = view.getUint16(absOffset, le);
  if (entryCount > 500) return result; // sanity check

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = absOffset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;

    try {
      const tag = view.getUint16(entryOffset, le);
      const type = view.getUint16(entryOffset + 2, le);
      const count = view.getUint32(entryOffset + 4, le);

      const tagName = tagMap[tag];
      if (!tagName) continue;

      const typeSize = TIFF_TYPE_SIZES[type] ?? 1;
      const totalBytes = typeSize * count;

      // Sanity: skip unreasonably large entries (>64KB)
      if (totalBytes > 65536) continue;

      // value fits in 4 bytes → inline; otherwise it's an offset
      let valueOffset: number;
      if (totalBytes <= 4) {
        valueOffset = entryOffset + 8;
      } else {
        valueOffset = tiffStart + view.getUint32(entryOffset + 8, le);
      }

      if (valueOffset < 0 || valueOffset + totalBytes > view.byteLength) continue;

      let value: ExifValueType = null;

      // UserComment has special encoding
      if (tagName === "UserComment" && type === TIFF_UNDEFINED) {
        const comment = readUserComment(view, valueOffset, count);
        if (comment) value = comment;
        if (value !== null) result[tagName] = value;
        continue;
      }

      switch (type) {
        case TIFF_BYTE:
          value = count === 1
            ? view.getUint8(valueOffset)
            : Array.from({ length: Math.min(count, 32) }, (_, j) =>
              view.getUint8(valueOffset + j),
            );
          break;

        case TIFF_ASCII:
          value = readAscii(view, valueOffset, count);
          break;

        case TIFF_SHORT:
          if (count === 1) {
            value = view.getUint16(valueOffset, le);
          } else {
            value = Array.from({ length: Math.min(count, 32) }, (_, j) =>
              view.getUint16(valueOffset + j * 2, le),
            ) as number[];
          }
          break;

        case TIFF_LONG:
          value = count === 1
            ? view.getUint32(valueOffset, le)
            : Array.from({ length: Math.min(count, 32) }, (_, j) =>
              view.getUint32(valueOffset + j * 4, le),
            );
          break;

        case TIFF_RATIONAL:
          if (count === 1) {
            value = readRational(view, valueOffset, le);
          } else {
            value = Array.from({ length: Math.min(count, 16) }, (_, j) =>
              readRational(view, valueOffset + j * 8, le),
            );
          }
          break;

        case TIFF_SRATIONAL:
          if (count === 1) {
            value = readSRational(view, valueOffset, le);
          } else {
            value = Array.from({ length: Math.min(count, 16) }, (_, j) =>
              readSRational(view, valueOffset + j * 8, le),
            );
          }
          break;

        case TIFF_SLONG:
          value = count === 1
            ? view.getInt32(valueOffset, le)
            : Array.from({ length: Math.min(count, 32) }, (_, j) =>
              view.getInt32(valueOffset + j * 4, le),
            );
          break;

        case TIFF_UNDEFINED:
          if (count <= 32) {
            value = Array.from({ length: count }, (_, j) =>
              view.getUint8(valueOffset + j),
            );
          }
          break;
      }

      if (value !== null) {
        result[tagName] = value;
      }
    } catch {
      // skip corrupt entries
    }
  }

  return result;
}


function isJpeg(view: DataView): boolean {
  return view.byteLength >= 2 && view.getUint16(0) === 0xffd8;
}

function isTiff(view: DataView): boolean {
  if (view.byteLength < 4) return false;
  const bom = view.getUint16(0);
  if (bom !== 0x4949 && bom !== 0x4d4d) return false;
  const le = bom === 0x4949;
  return view.getUint16(2, le) === 0x002a;
}

const XMP_SIG = "http://ns.adobe.com/xap/1.0/\0";
const ICC_SIG = "ICC_PROFILE\0";

function parseExifFromBuffer(buffer: ArrayBuffer): RawExif {
  const view = new DataView(buffer);
  const result: RawExif = {};

  if (isJpeg(view)) {
    let offset = 2;
    const MAX_SEGMENTS = 1024;
    let segments = 0;

    while (offset + 1 < view.byteLength && segments < MAX_SEGMENTS) {
      // Find marker prefix (skip non-marker padding/noise safely).
      while (offset < view.byteLength && view.getUint8(offset) !== 0xff) {
        offset++;
      }
      if (offset + 1 >= view.byteLength) break;

      // Skip fill bytes 0xFF..0xFF
      while (offset + 1 < view.byteLength && view.getUint8(offset + 1) === 0xff) {
        offset++;
      }
      if (offset + 1 >= view.byteLength) break;

      const marker = (0xff << 8) | view.getUint8(offset + 1);
      offset += 2;

      // End of image or start of scan: no more metadata segments.
      if (marker === 0xffd9 || marker === 0xffda) break;

      // Standalone markers without segment length.
      if (
        marker === 0xff01 || // TEM
        (marker >= 0xffd0 && marker <= 0xffd7) // RST0..RST7
      ) {
        continue;
      }

      if (offset + 2 > view.byteLength) break;
      const segLen = view.getUint16(offset);
      if (segLen < 2) break;
      const segStart = offset + 2;
      if (segStart + (segLen - 2) > view.byteLength) break;

      // APP1: EXIF or XMP
      if (marker === 0xffe1) {
        // EXIF?
        if (matchesAsciiSignature(view, segStart, "Exif\0\0")) {
          const exifData = parseExifStructure(view, segStart + 6);
          Object.assign(result, exifData);
        }
        // XMP?
        else if (matchesAsciiSignature(view, segStart, XMP_SIG)) {
          result["_xmp"] = readAscii(view, segStart + XMP_SIG.length, segLen - 2 - XMP_SIG.length);
        }
      }
      // APP2: ICC_PROFILE
      else if (marker === 0xffe2) {
        if (matchesAsciiSignature(view, segStart, ICC_SIG)) {
          // Note: ICC segments can be split across multiple APP2 markers.
          // For now, we take the first one or just look for basic info.
          result["_icc"] = parseIcc(view, segStart + 14, segLen - 2 - 14);
        }
      }
      // APP13: IPTC (Photoshop IRB)
      else if (marker === 0xffed) {
        if (readAscii(view, segStart, 13) === "Photoshop 3.0") {
          const iptcData = parseIptc(view, segStart, segLen - 2);
          Object.assign(result, iptcData);
        }
      }

      offset += segLen;
      segments++;
    }
  } else if (isTiff(view)) {
    Object.assign(result, parseExifStructure(view, 0));
  }

  return result;
}

function parseExifStructure(view: DataView, tiffStart: number): RawExif {
  if (tiffStart + 8 > view.byteLength) return {};

  // Determine byte order
  const bom = view.getUint16(tiffStart);
  const le = bom === 0x4949; // "II" = little-endian

  // Verify TIFF magic 0x002A
  if (view.getUint16(tiffStart + 2, le) !== 0x002a) return {};

  // IFD0 offset
  const ifd0Offset = view.getUint32(tiffStart + 4, le);
  if (ifd0Offset === 0) return {};

  const result: RawExif = {};

  // Parse IFD0
  const ifd0 = parseIFD(view, tiffStart, ifd0Offset, le, IFD_TAGS);
  Object.assign(result, ifd0);

  // Follow EXIF sub-IFD pointer
  const exifPointer = ifd0["ExifIFDPointer"];
  if (typeof exifPointer === "number" && exifPointer > 0) {
    const exifData = parseIFD(view, tiffStart, exifPointer, le, EXIF_TAGS);
    Object.assign(result, exifData);
  }

  // Follow GPS sub-IFD pointer
  const gpsPointer = ifd0["GPSInfoIFDPointer"];
  if (typeof gpsPointer === "number" && gpsPointer > 0) {
    const gpsData = parseIFD(view, tiffStart, gpsPointer, le, GPS_TAGS);
    Object.assign(result, gpsData);
  }

  // Follow IFD1 (thumbnail IFD) for additional metadata
  const ifd0AbsStart = tiffStart + ifd0Offset;
  if (ifd0AbsStart + 2 <= view.byteLength) {
    const ifd0EntryCount = view.getUint16(ifd0AbsStart, le);
    const ifd0AbsEnd = ifd0AbsStart + 2 + ifd0EntryCount * 12;
    if (ifd0AbsEnd + 4 <= view.byteLength) {
      try {
        const ifd1Offset = view.getUint32(ifd0AbsEnd, le);
        if (ifd1Offset > 0 && tiffStart + ifd1Offset < view.byteLength) {
          const ifd1 = parseIFD(view, tiffStart, ifd1Offset, le, IFD_TAGS);
          for (const [key, val] of Object.entries(ifd1)) {
            if (!(key in result) && key !== "ExifIFDPointer" && key !== "GPSInfoIFDPointer") {
              result[key] = val;
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Handle MakerNote specifically
  const makerNote = result["MakerNote"];
  const make = result["Make"];
  if (Array.isArray(makerNote) && typeof make === "string") {
    const makerData = handleMakerNote(makerNote, make);
    Object.assign(result, makerData);
  }

  // Remove internal pointer fields
  delete result["ExifIFDPointer"];
  delete result["GPSInfoIFDPointer"];
  delete result["NewSubfileType"];

  return result;
}

const EXIF_SIG_BYTES = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00] as const;

function findSignatureOffset(
  view: DataView,
  signature: readonly number[],
  startOffset: number,
): number {
  const end = view.byteLength - signature.length;
  for (let offset = Math.max(0, startOffset); offset <= end; offset++) {
    if (view.getUint8(offset) !== signature[0]) continue;
    let match = true;
    for (let i = 1; i < signature.length; i++) {
      if (view.getUint8(offset + i) !== signature[i]) {
        match = false;
        break;
      }
    }
    if (match) return offset;
  }
  return -1;
}

function extractEmbeddedExifFromBuffer(buffer: ArrayBuffer): RawExif {
  const view = new DataView(buffer);
  let searchFrom = 0;
  let best: RawExif = {};
  const MAX_EMBEDDED_EXIF_MATCHES = 24;
  let seen = 0;

  while (seen < MAX_EMBEDDED_EXIF_MATCHES) {
    const sigOffset = findSignatureOffset(view, EXIF_SIG_BYTES, searchFrom);
    if (sigOffset < 0) break;
    seen++;
    searchFrom = sigOffset + EXIF_SIG_BYTES.length;

    try {
      const parsed = parseExifStructure(view, sigOffset + EXIF_SIG_BYTES.length);
      if (Object.keys(parsed).length > Object.keys(best).length) {
        best = parsed;
      }
    } catch {
      // Continue scanning remaining signatures.
    }
  }

  return best;
}

function buildExifSupplementCategories(exif: RawExif): ExifCategory[] {
  const builders: Array<{
    id: string;
    title: string;
    build: () => ExifField[];
  }> = [
      { id: "image", title: "IMAGE", build: () => buildImageCategory(exif) },
      { id: "camera", title: "CAMERA", build: () => buildCameraCategory(exif) },
      { id: "exposure", title: "EXPOSURE", build: () => buildExposureCategory(exif) },
      { id: "focus", title: "FOCUS & FLASH", build: () => buildFocusCategory(exif) },
      { id: "datetime", title: "DATE & TIME", build: () => buildDateTimeCategory(exif) },
      { id: "gps", title: "GPS", build: () => buildGpsCategory(exif) },
      { id: "iptc", title: "IPTC METADATA", build: () => buildIptcCategory(exif) },
      { id: "xmp", title: "XMP METADATA", build: () => buildXmpCategory(exif) },
      { id: "icc", title: "COLOR PROFILE", build: () => buildIccCategory(exif) },
      { id: "software", title: "SOFTWARE", build: () => buildSoftwareCategory(exif) },
      { id: "advanced", title: "ADVANCED", build: () => buildAdvancedCategory(exif) },
    ];

  const categories: ExifCategory[] = [];
  for (const b of builders) {
    const fields = b.build();
    if (fields.length === 0) continue;
    categories.push({
      id: b.id,
      title: b.title,
      fields,
      expanded: b.id === "camera",
    });
  }
  return categories;
}

function mergeCategoryFields(
  target: ExifCategory[],
  incoming: ExifCategory[],
): void {
  for (const next of incoming) {
    const existing = target.find((cat) => cat.id === next.id);
    if (!existing) {
      target.push(next);
      continue;
    }

    const seen = new Set(
      existing.fields.map((field) => `${field.label.toLowerCase()}|${field.displayValue.toLowerCase()}`),
    );

    for (const field of next.fields) {
      const key = `${field.label.toLowerCase()}|${field.displayValue.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      existing.fields.push(field);
    }
  }
}

function deriveCameraName(exif: RawExif): string | null {
  const make = typeof exif["Make"] === "string" ? exif["Make"].trim() : "";
  const model = typeof exif["Model"] === "string" ? exif["Model"].trim() : "";
  if (model) {
    return make && !model.toLowerCase().startsWith(make.toLowerCase())
      ? `${make} ${model}`
      : model;
  }
  if (make) return make;
  return null;
}

// ── Formatting Helpers ───────────────────────────────────────

function formatExposureTime(val: number): string {
  if (val >= 1) {
    return val % 1 === 0 ? `${val}s` : `${val.toFixed(1)}s`;
  }
  const denom = Math.round(1 / val);
  return `1/${denom}s`;
}

function formatFNumber(val: number): string {
  if (val % 1 === 0) return `f/${val}`;
  // Show one decimal for typical f-stops (1.4, 2.8, 5.6), two for precision
  const oneDecimal = val.toFixed(1);
  return `f/${parseFloat(oneDecimal) === val ? oneDecimal : val.toFixed(2)}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(dateStr: string, tzOffset?: string): string {
  if (!dateStr || dateStr.trim().length < 10) return dateStr;
  // EXIF dates are "YYYY:MM:DD HH:MM:SS"
  const cleaned = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  const withTz = tzOffset ? `${cleaned}${tzOffset}` : cleaned;
  try {
    const d = new Date(withTz);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...(tzOffset ? { timeZoneName: "short" } : {}),
    });
  } catch {
    return dateStr;
  }
}

function convertGpsCoordinate(
  dmsArray: number[],
  ref: string,
): { decimal: number; display: string } | null {
  if (!dmsArray || dmsArray.length < 3) return null;
  const [deg, min, sec] = dmsArray;

  // Validate ranges (180 covers both lat and lon; callers provide valid ref)
  if (!isFinite(deg) || !isFinite(min) || !isFinite(sec)) return null;
  if (deg < 0 || deg > 180 || min < 0 || min >= 60 || sec < 0 || sec >= 60) return null;

  let decimal = deg + min / 60 + sec / 3600;
  if (ref === "S" || ref === "W") decimal = -decimal;

  const direction = ref || "";
  const secDisplay = sec % 1 === 0 ? String(sec) : sec.toFixed(2);
  const display = `${deg}\u00B0 ${min}\u2032 ${secDisplay}\u2033 ${direction}`;
  return { decimal, display };
}

// ── Category Builders ────────────────────────────────────────

function field(
  id: string,
  label: string,
  value: ExifValueType,
  displayValue: string | null,
  explanation: string,
  options?: { rawTag?: number; sensitive?: boolean },
): ExifField {
  return {
    id,
    label,
    value,
    displayValue: displayValue ?? (value === null ? "-" : String(value)),
    explanation,
    rawTag: options?.rawTag,
    sensitive: options?.sensitive,
  };
}

function buildFileCategory(meta: FileMetadata): ExifField[] {
  const dot = meta.name.lastIndexOf(".");
  const ext = dot > 0 && dot < meta.name.length - 1
    ? meta.name.slice(dot + 1).toUpperCase()
    : "";
  return [
    field("file.name", "File Name", meta.name, meta.name,
      "the name of the file on your device"),
    field("file.size", "File Size", meta.size, formatFileSize(meta.size),
      "how large the file is on disk"),
    field("file.type", "MIME Type", meta.type, meta.type || "unknown",
      "the file's media type as reported by your browser"),
    field("file.ext", "Extension", ext, ext || "none",
      "the file extension"),
    field("file.modified", "Last Modified", meta.lastModified,
      new Date(meta.lastModified).toLocaleString(),
      "when this file was last changed on your device"),
  ];
}

function buildImageCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];

  // Prefer EXIF dimensions, fall back to IFD0 dimensions
  const w = exif["PixelXDimension"] ?? exif["ImageWidth"];
  const h = exif["PixelYDimension"] ?? exif["ImageHeight"];
  if (typeof w === "number" && typeof h === "number") {
    const megapixels = (w * h) / 1_000_000;
    const mpStr = megapixels >= 1 ? ` (${megapixels.toFixed(1)} MP)` : "";
    fields.push(field("image.dimensions", "Dimensions", `${w} \u00D7 ${h}`,
      `${w} \u00D7 ${h} px${mpStr}`, "the image's pixel dimensions"));
  } else if (typeof w === "number") {
    fields.push(field("image.width", "Width", w, `${w} px`, "image width in pixels"));
  }

  const orient = exif["Orientation"];
  if (typeof orient === "number") {
    fields.push(field("image.orientation", "Orientation", orient,
      ORIENTATION_MAP[orient] ?? String(orient),
      "how the camera was held when the photo was taken"));
  }

  const cs = exif["ColorSpace"];
  if (typeof cs === "number") {
    fields.push(field("image.colorSpace", "Color Space", cs,
      COLOR_SPACE_MAP[cs] ?? String(cs),
      "the color model used to represent the image"));
  }

  const bps = exif["BitsPerSample"];
  if (typeof bps === "number") {
    fields.push(field("image.bitDepth", "Bit Depth", bps,
      `${bps}-bit`, "bits per color channel"));
  } else if (Array.isArray(bps) && bps.length > 0) {
    const allSame = bps.every((v: number) => v === bps[0]);
    const display = allSame ? `${bps[0]}-bit` : bps.join("/") + " bit";
    fields.push(field("image.bitDepth", "Bit Depth", bps[0],
      display, "bits per color channel"));
  }

  const compression = exif["Compression"];
  if (typeof compression === "number") {
    fields.push(field("image.compression", "Compression", compression,
      COMPRESSION_MAP[compression] ?? String(compression),
      "the compression method used to store the image"));
  }

  const xRes = exif["XResolution"];
  const yRes = exif["YResolution"];
  const resUnit = exif["ResolutionUnit"];
  if (typeof xRes === "number") {
    const unit = typeof resUnit === "number"
      ? RESOLUTION_UNIT_MAP[resUnit] ?? ""
      : "";
    const display = typeof yRes === "number" && yRes !== xRes
      ? `${Math.round(xRes)} \u00D7 ${Math.round(yRes)} DPI`
      : `${Math.round(xRes)} DPI`;
    const withUnit = unit && unit !== "No unit" ? `${display} (${unit})` : display;
    fields.push(field("image.resolution", "Resolution", xRes, withUnit,
      "dots per inch, indicating print quality"));
  }

  const ycbcr = exif["YCbCrPositioning"];
  if (typeof ycbcr === "number") {
    fields.push(field("image.ycbcr", "YCbCr Positioning", ycbcr,
      ycbcr === 1 ? "Centered" : ycbcr === 2 ? "Co-sited" : String(ycbcr),
      "how chroma samples are positioned relative to luma"));
  }

  return fields;
}

function buildCameraCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];

  const make = exif["Make"];
  if (typeof make === "string" && make) {
    fields.push(field("camera.make", "Make", make, make.trim(),
      "the manufacturer of the camera or phone"));
  }

  const model = exif["Model"];
  if (typeof model === "string" && model) {
    fields.push(field("camera.model", "Model", model, model.trim(),
      "the specific camera model used"));
  }

  const bodySerial = exif["BodySerialNumber"];
  if (typeof bodySerial === "string" && bodySerial) {
    fields.push(field("camera.bodySerial", "Body Serial", bodySerial, bodySerial,
      "uniquely identifies this specific camera body",
      { sensitive: true }));
  }

  // MakerNote specific fields
  const shutterCount = exif["ShutterCount"];
  if (typeof shutterCount === "number") {
    fields.push(field("camera.shutterCount", "Shutter Count", shutterCount,
      shutterCount.toLocaleString(),
      "total number of times the shutter has fired",
      { sensitive: true }));
  }

  const focusMode = exif["FocusMode"];
  if (typeof focusMode === "string") {
    fields.push(field("camera.focusMode", "Focus Mode", focusMode, focusMode,
      "the camera's focus configuration"));
  }

  const lens = exif["LensModel"] || exif["Lens"];
  if (typeof lens === "string" && lens) {
    fields.push(field("camera.lens", "Lens", lens, lens.trim(),
      "the lens attached when the photo was taken"));
  }

  const lensMake = exif["LensMake"];
  if (typeof lensMake === "string" && lensMake) {
    fields.push(field("camera.lensMake", "Lens Make", lensMake, lensMake.trim(),
      "the manufacturer of the lens"));
  }

  const lensInfo = exif["LensInfo"];
  if (Array.isArray(lensInfo) && lensInfo.length >= 4) {
    const [minFl, maxFl, minFn, maxFn] = lensInfo;
    const flRange = minFl === maxFl ? `${minFl}mm` : `${minFl}-${maxFl}mm`;
    const fnRange = minFn && maxFn
      ? (minFn === maxFn ? ` f/${minFn}` : ` f/${minFn}-${maxFn}`)
      : "";
    fields.push(field("camera.lensInfo", "Lens Spec", lensInfo,
      `${flRange}${fnRange}`,
      "the lens focal length range and maximum aperture"));
  }

  const serial = exif["LensSerialNumber"];
  if (typeof serial === "string" && serial) {
    fields.push(field("camera.lensSerial", "Lens Serial", serial, serial,
      "uniquely identifies this specific lens unit",
      { sensitive: true }));
  }

  const sensing = exif["SensingMethod"];
  if (typeof sensing === "number") {
    fields.push(field("camera.sensing", "Sensing Method", sensing,
      SENSING_METHOD_MAP[sensing] ?? String(sensing),
      "the type of image sensor in the camera"));
  }

  return fields;
}

function buildExposureCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];

  const et = exif["ExposureTime"];
  if (typeof et === "number") {
    fields.push(field("exposure.time", "Shutter Speed", et,
      formatExposureTime(et),
      "how long the sensor was exposed to light"));
  }

  const fn = exif["FNumber"];
  if (typeof fn === "number") {
    fields.push(field("exposure.fNumber", "Aperture", fn,
      formatFNumber(fn),
      "how wide the lens opening was (lower = more light)"));
  }

  const iso = exif["ISOSpeedRatings"];
  if (typeof iso === "number") {
    fields.push(field("exposure.iso", "ISO", iso, `ISO ${iso}`,
      "sensor sensitivity to light (higher = brighter but noisier)"));
  } else if (Array.isArray(iso) && iso.length > 0) {
    fields.push(field("exposure.iso", "ISO", iso[0], `ISO ${iso[0]}`,
      "sensor sensitivity to light (higher = brighter but noisier)"));
  }

  const prog = exif["ExposureProgram"];
  if (typeof prog === "number") {
    fields.push(field("exposure.program", "Exposure Program", prog,
      EXPOSURE_PROGRAM_MAP[prog] ?? String(prog),
      "the camera mode used to determine exposure settings"));
  }

  const mode = exif["ExposureMode"];
  if (typeof mode === "number") {
    const display = mode === 0 ? "Auto" : mode === 1 ? "Manual" : mode === 2 ? "Auto bracket" : String(mode);
    fields.push(field("exposure.mode", "Exposure Mode", mode, display,
      "whether exposure was set automatically or manually"));
  }

  const bias = exif["ExposureBiasValue"];
  if (typeof bias === "number") {
    const sign = bias > 0 ? "+" : "";
    fields.push(field("exposure.bias", "Exposure Compensation", bias,
      `${sign}${bias.toFixed(1)} EV`,
      "intentional over/underexposure applied by the photographer"));
  }

  const meter = exif["MeteringMode"];
  if (typeof meter === "number") {
    fields.push(field("exposure.metering", "Metering Mode", meter,
      METERING_MODE_MAP[meter] ?? String(meter),
      "how the camera measured the scene's brightness"));
  }

  const wb = exif["WhiteBalance"];
  if (typeof wb === "number") {
    fields.push(field("exposure.whiteBalance", "White Balance", wb,
      wb === 0 ? "Auto" : wb === 1 ? "Manual" : String(wb),
      "color temperature adjustment for natural-looking colors"));
  }

  const light = exif["LightSource"];
  if (typeof light === "number" && light !== 0) {
    fields.push(field("exposure.lightSource", "Light Source", light,
      LIGHT_SOURCE_MAP[light] ?? String(light),
      "the type of light illuminating the scene"));
  }

  const brightness = exif["BrightnessValue"];
  if (typeof brightness === "number") {
    fields.push(field("exposure.brightness", "Brightness", brightness,
      `${brightness.toFixed(2)} EV`,
      "the brightness of the scene as measured by the camera"));
  }

  const gain = exif["GainControl"];
  if (typeof gain === "number") {
    fields.push(field("exposure.gain", "Gain Control", gain,
      GAIN_CONTROL_MAP[gain] ?? String(gain),
      "whether the camera amplified the signal"));
  }

  return fields;
}

function buildFocusCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];

  const fl = exif["FocalLength"];
  if (typeof fl === "number") {
    fields.push(field("focus.focalLength", "Focal Length", fl,
      `${fl % 1 === 0 ? fl : fl.toFixed(1)} mm`,
      "the zoom level of the lens"));
  }

  const fl35 = exif["FocalLengthIn35mmFilm"];
  if (typeof fl35 === "number" && fl35 > 0) {
    fields.push(field("focus.focal35mm", "35mm Equivalent", fl35,
      `${fl35} mm`,
      "focal length normalized to full-frame, for comparison across cameras"));
  }

  const maxAp = exif["MaxApertureValue"];
  if (typeof maxAp === "number") {
    // APEX value → f-number: fn = 2^(maxAp/2)
    const fNum = Math.pow(2, maxAp / 2);
    fields.push(field("focus.maxAperture", "Max Aperture", maxAp,
      formatFNumber(fNum),
      "the widest aperture the lens can open to"));
  }

  const dist = exif["SubjectDistance"];
  if (typeof dist === "number" && dist > 0) {
    const display = dist >= 100 ? "Infinity" : `${dist.toFixed(2)} m`;
    fields.push(field("focus.distance", "Subject Distance", dist,
      display, "estimated distance to the focused subject"));
  }

  const flash = exif["Flash"];
  if (typeof flash === "number") {
    fields.push(field("focus.flash", "Flash", flash,
      FLASH_MAP[flash] ?? (flash & 1 ? "Fired" : "Did not fire"),
      "whether the flash fired and how it was configured"));
  }

  const zoom = exif["DigitalZoomRatio"];
  if (typeof zoom === "number" && zoom > 0 && zoom !== 1) {
    fields.push(field("focus.digitalZoom", "Digital Zoom", zoom,
      `${zoom.toFixed(1)}x`,
      "digital magnification applied (degrades quality unlike optical zoom)"));
  }

  const subjectArea = exif["SubjectArea"];
  if (Array.isArray(subjectArea) && subjectArea.length >= 2) {
    const display = subjectArea.length === 2
      ? `center at (${subjectArea[0]}, ${subjectArea[1]})`
      : subjectArea.length === 3
        ? `circle at (${subjectArea[0]}, ${subjectArea[1]}) r=${subjectArea[2]}`
        : `rect at (${subjectArea[0]}, ${subjectArea[1]}) ${subjectArea[2]}\u00D7${subjectArea[3]}`;
    fields.push(field("focus.subjectArea", "Subject Area", display,
      display, "the region the camera focused on"));
  }

  return fields;
}

function buildDateTimeCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];

  const tzOrig = typeof exif["OffsetTimeOriginal"] === "string" ? exif["OffsetTimeOriginal"] : undefined;
  const tzDigit = typeof exif["OffsetTimeDigitized"] === "string" ? exif["OffsetTimeDigitized"] : undefined;
  const tzMod = typeof exif["OffsetTime"] === "string" ? exif["OffsetTime"] : undefined;

  const orig = exif["DateTimeOriginal"];
  if (typeof orig === "string" && orig) {
    fields.push(field("datetime.original", "Date Taken", orig,
      formatDate(orig, tzOrig),
      "when the photo was originally captured"));
  }

  const digitized = exif["DateTimeDigitized"];
  if (typeof digitized === "string" && digitized && digitized !== orig) {
    fields.push(field("datetime.digitized", "Date Digitized", digitized,
      formatDate(digitized, tzDigit),
      "when the image was digitized (may differ for scanned photos)"));
  }

  const modified = exif["DateTime"];
  if (typeof modified === "string" && modified && modified !== orig) {
    fields.push(field("datetime.modified", "Date Modified", modified,
      formatDate(modified, tzMod),
      "when the file's metadata was last changed"));
  }

  // Show timezone info if present
  if (tzOrig) {
    fields.push(field("datetime.timezone", "Timezone", tzOrig, `UTC${tzOrig}`,
      "the timezone where the photo was taken"));
  }

  return fields;
}

function buildGpsCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];

  const latArr = exif["GPSLatitude"];
  const latRef = exif["GPSLatitudeRef"];
  const lonArr = exif["GPSLongitude"];
  const lonRef = exif["GPSLongitudeRef"];

  const hasCoords = Array.isArray(latArr) && latArr.length >= 3
    && Array.isArray(lonArr) && lonArr.length >= 3;

  if (hasCoords) {
    // Privacy notice
    fields.push(field("gps.warning", "\u26A0 Privacy Notice",
      "this image contains your exact location",
      "this image contains your exact location",
      "GPS coordinates embedded in photos can reveal where you live, work, or travel. " +
      "consider stripping this data before sharing files directly.",
      { sensitive: true }));

    const lat = convertGpsCoordinate(
      latArr,
      typeof latRef === "string" ? latRef : "N",
    );
    if (lat) {
      fields.push(field("gps.latitude", "Latitude", lat.decimal,
        `${lat.display} (${lat.decimal.toFixed(6)})`,
        "north-south position on Earth",
        { sensitive: true }));
    }

    const lon = convertGpsCoordinate(
      lonArr,
      typeof lonRef === "string" ? lonRef : "E",
    );
    if (lon) {
      fields.push(field("gps.longitude", "Longitude", lon.decimal,
        `${lon.display} (${lon.decimal.toFixed(6)})`,
        "east-west position on Earth",
        { sensitive: true }));
    }
  }

  const alt = exif["GPSAltitude"];
  const altRef = exif["GPSAltitudeRef"];
  if (typeof alt === "number") {
    const below = (typeof altRef === "number" && altRef === 1) ||
      (Array.isArray(altRef) && altRef[0] === 1);
    const displayAlt = below ? -alt : alt;
    fields.push(field("gps.altitude", "Altitude", displayAlt,
      `${displayAlt.toFixed(1)} m ${below ? "below" : "above"} sea level`,
      "elevation above or below sea level"));
  }

  const timeStamp = exif["GPSTimeStamp"];
  const dateStamp = exif["GPSDateStamp"];
  if (Array.isArray(timeStamp) && timeStamp.length >= 3) {
    const h = Math.floor(timeStamp[0]).toString().padStart(2, "0");
    const m = Math.floor(timeStamp[1]).toString().padStart(2, "0");
    const s = Math.floor(timeStamp[2]).toString().padStart(2, "0");
    const timeStr = `${h}:${m}:${s} UTC`;
    const display = typeof dateStamp === "string" && dateStamp
      ? `${dateStamp.replace(/:/g, "-")} ${timeStr}`
      : timeStr;
    fields.push(field("gps.timestamp", "GPS Timestamp", display, display,
      "the time recorded by GPS satellites when the photo was taken"));
  }

  const speed = exif["GPSSpeed"];
  const speedRef = exif["GPSSpeedRef"];
  if (typeof speed === "number") {
    const unit = typeof speedRef === "string"
      ? (speedRef === "K" ? "km/h" : speedRef === "M" ? "mph" : speedRef === "N" ? "knots" : speedRef)
      : "km/h";
    fields.push(field("gps.speed", "Speed", speed,
      `${speed.toFixed(1)} ${unit}`,
      "how fast you were moving when the photo was taken"));
  }

  const direction = exif["GPSImgDirection"];
  if (typeof direction === "number") {
    const ref = typeof exif["GPSImgDirectionRef"] === "string" ? exif["GPSImgDirectionRef"] : "T";
    const refName = ref === "M" ? "magnetic" : "true";
    fields.push(field("gps.direction", "Image Direction", direction,
      `${direction.toFixed(1)}\u00B0 (${refName} north)`,
      "the compass direction the camera was pointing"));
  }

  const datum = exif["GPSMapDatum"];
  if (typeof datum === "string" && datum) {
    fields.push(field("gps.datum", "Map Datum", datum, datum,
      "the geodetic coordinate system used (typically WGS-84)"));
  }

  const dop = exif["GPSDOP"];
  if (typeof dop === "number") {
    const quality = dop <= 1 ? "ideal" : dop <= 2 ? "excellent" : dop <= 5 ? "good"
      : dop <= 10 ? "moderate" : dop <= 20 ? "fair" : "poor";
    fields.push(field("gps.dop", "Dilution of Precision", dop,
      `${dop.toFixed(1)} (${quality})`,
      "GPS accuracy indicator \u2014 lower is more precise"));
  }

  return fields;
}

function buildSoftwareCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];

  const sw = exif["Software"];
  if (typeof sw === "string" && sw) {
    fields.push(field("software.name", "Software", sw, sw.trim(),
      "the application used to create or process this image"));
  }

  const artist = exif["Artist"];
  if (typeof artist === "string" && artist) {
    fields.push(field("software.artist", "Artist", artist, artist.trim(),
      "the creator credited in the file metadata"));
  }

  const copyright = exif["Copyright"];
  if (typeof copyright === "string" && copyright) {
    fields.push(field("software.copyright", "Copyright", copyright, copyright.trim(),
      "copyright information embedded in the image"));
  }

  const desc = exif["ImageDescription"];
  if (typeof desc === "string" && desc) {
    fields.push(field("software.description", "Description", desc, desc.trim(),
      "a text description embedded in the image"));
  }

  const comment = exif["UserComment"];
  if (typeof comment === "string" && comment) {
    fields.push(field("software.comment", "User Comment", comment, comment.trim(),
      "a user-provided note stored in the image"));
  }

  const custom = exif["CustomRendered"];
  if (typeof custom === "number") {
    fields.push(field("software.customRendered", "Custom Rendered", custom,
      custom === 0 ? "Normal" : custom === 1 ? "Custom" : String(custom),
      "whether special rendering was applied to the image"));
  }

  const uid = exif["ImageUniqueID"];
  if (typeof uid === "string" && uid) {
    fields.push(field("software.uniqueId", "Image Unique ID", uid, uid,
      "a unique identifier assigned to this image"));
  }

  return fields;
}

function buildAdvancedCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];

  const scene = exif["SceneCaptureType"];
  if (typeof scene === "number") {
    fields.push(field("advanced.sceneCaptureType", "Scene Capture", scene,
      SCENE_CAPTURE_MAP[scene] ?? String(scene),
      "the type of scene the camera detected"));
  }

  const contrast = exif["Contrast"];
  if (typeof contrast === "number") {
    fields.push(field("advanced.contrast", "Contrast", contrast,
      CONTRAST_MAP[contrast] ?? String(contrast),
      "contrast processing applied by the camera"));
  }

  const sat = exif["Saturation"];
  if (typeof sat === "number") {
    fields.push(field("advanced.saturation", "Saturation", sat,
      SATURATION_MAP[sat] ?? String(sat),
      "color saturation processing applied by the camera"));
  }

  const sharp = exif["Sharpness"];
  if (typeof sharp === "number") {
    fields.push(field("advanced.sharpness", "Sharpness", sharp,
      SHARPNESS_MAP[sharp] ?? String(sharp),
      "sharpness processing applied by the camera"));
  }

  const gamma = exif["Gamma"];
  if (typeof gamma === "number") {
    fields.push(field("advanced.gamma", "Gamma", gamma,
      gamma.toFixed(2),
      "gamma curve used for encoding the image"));
  }

  const ver = exif["ExifVersion"];
  if (ver !== null && ver !== undefined) {
    let display: string;
    if (Array.isArray(ver)) {
      display = ver.map((b: number) => String.fromCharCode(b)).join("");
    } else {
      display = String(ver);
    }
    if (/^\d{4}$/.test(display)) {
      display = display.slice(0, 2) + "." + display.slice(2);
    }
    fields.push(field("advanced.exifVersion", "EXIF Version", display, display,
      "the version of the EXIF standard used"));
  }

  const fileSource = exif["FileSource"];
  if (fileSource !== null && fileSource !== undefined) {
    const val = Array.isArray(fileSource) ? fileSource[0] : fileSource;
    let display: string;
    if (val === 3) display = "Digital camera";
    else if (val === 1) display = "Film scanner";
    else if (val === 2) display = "Reflection print scanner";
    else display = String(val);
    fields.push(field("advanced.fileSource", "File Source", display, display,
      "the source device that created this image"));
  }

  const sceneType = exif["SceneType"];
  if (sceneType !== null && sceneType !== undefined) {
    const val = Array.isArray(sceneType) ? sceneType[0] : sceneType;
    fields.push(field("advanced.sceneType", "Scene Type", val,
      val === 1 ? "Directly photographed" : String(val),
      "indicates this image was directly photographed"));
  }

  const bpp = exif["CompressedBitsPerPixel"];
  if (typeof bpp === "number") {
    fields.push(field("advanced.bpp", "Compressed Bits/Pixel", bpp,
      bpp.toFixed(2),
      "compression ratio expressed as bits per pixel"));
  }

  const compConfig = exif["ComponentsConfiguration"];
  if (Array.isArray(compConfig) && compConfig.length >= 4) {
    const names: Record<number, string> = { 0: "-", 1: "Y", 2: "Cb", 3: "Cr", 4: "R", 5: "G", 6: "B" };
    const display = compConfig
      .map((c: number) => names[c] ?? "?")
      .filter((s: string) => s !== "-")
      .join("");
    if (display) {
      fields.push(field("advanced.components", "Components", display, display,
        "the order of color components in the image data"));
    }
  }

  const samples = exif["SamplesPerPixel"];
  if (typeof samples === "number") {
    fields.push(field("advanced.samplesPerPixel", "Samples/Pixel", samples,
      String(samples),
      "number of components per pixel (3 for RGB, 4 for RGBA)"));
  }

  const fpXRes = exif["FocalPlaneXResolution"];
  const fpUnit = exif["FocalPlaneResolutionUnit"];
  if (typeof fpXRes === "number") {
    const unit = typeof fpUnit === "number"
      ? (RESOLUTION_UNIT_MAP[fpUnit] ?? "")
      : "";
    fields.push(field("advanced.focalPlaneRes", "Focal Plane Resolution", fpXRes,
      `${Math.round(fpXRes)} pixels/${unit || "unit"}`,
      "sensor resolution in pixels per unit on the focal plane"));
  }

  return fields;
}

// ── Category Order ───────────────────────────────────────────

export const LENS_CATEGORY_ORDER = [
  { id: "file", title: "FILE" },
  { id: "image", title: "IMAGE" },
  { id: "audio", title: "AUDIO" },
  { id: "video", title: "VIDEO" },
  { id: "document", title: "DOCUMENT" },
  { id: "content", title: "CONTENT" },
  { id: "structure", title: "STRUCTURE" },
  { id: "iptc", title: "IPTC METADATA" },
  { id: "xmp", title: "XMP METADATA" },
  { id: "icc", title: "COLOR PROFILE" },
  { id: "metadata", title: "METADATA" },
  { id: "camera", title: "CAMERA" },
  { id: "exposure", title: "EXPOSURE" },
  { id: "focus", title: "FOCUS & FLASH" },
  { id: "datetime", title: "DATE & TIME" },
  { id: "gps", title: "GPS" },
  { id: "software", title: "SOFTWARE" },
  { id: "advanced", title: "ADVANCED" },
  { id: "integrity", title: "INTEGRITY" },
  { id: "profile", title: "PROFILE" },
] as const;

// ── Main Entry Point ─────────────────────────────────────────

type ExifContainerFormat = "JPEG" | "TIFF";

function detectExifContainerFormat(
  buffer: ArrayBuffer,
  mimeType: string,
): ExifContainerFormat | null {
  const view = new DataView(buffer);
  if (isJpeg(view)) return "JPEG";
  if (isTiff(view)) return "TIFF";

  const mime = mimeType.toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return "JPEG";
  if (mime === "image/tiff" || mime === "image/x-tiff") return "TIFF";
  return null;
}

export async function parseFile(file: File): Promise<LensData> {
  const meta: FileMetadata = {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };

  // Parse against full local file buffer (no Lens read-size caps).
  let buffer = await file.arrayBuffer();
  const containerFormat = detectExifContainerFormat(buffer, meta.type);

  // Parse EXIF only for JPEG/TIFF containers.
  let exif: RawExif = {};
  if (containerFormat) {
    try {
      exif = parseExifFromBuffer(buffer);
    } catch {
      // Parsing failed - fallback to universal analyzer.
    }

    // Full buffer is already loaded; no additional depth retries needed.
  }

  const hasExif = Object.keys(exif).length > 0;

  // If we found EXIF data, build image-specific categories (original path).
  if (hasExif) {
    const exifResult = buildExifResult(exif, meta, containerFormat);
    try {
      const { analyzeFile } = await import("./lens-formats");
      const fallbackResult = await analyzeFile(file, buffer);
      const profileCategory = fallbackResult.categories.find((category) => category.id === "profile");
      if (profileCategory && !exifResult.categories.some((category) => category.id === "profile")) {
        exifResult.categories.push(profileCategory);
      }
    } catch {
      // Ignore supplemental profile extraction failures.
    }
    return exifResult;
  }

  // No EXIF - use the universal format engine.
  const { analyzeFile } = await import("./lens-formats");
  let formatResult = await analyzeFile(file, buffer);

  // Full-buffer parsing is already the deepest capability path.

  // Build FILE category (always present).
  const fileFields = buildFileCategory(meta);
  const categories: ExifCategory[] = [{
    id: "file",
    title: "FILE",
    fields: fileFields,
    expanded: true,
  }];

  // Append format-specific categories.
  categories.push(...formatResult.categories);

  // Recover embedded EXIF from any container and merge into universal categories.
  const embeddedExif = extractEmbeddedExifFromBuffer(buffer);
  if (Object.keys(embeddedExif).length > 0) {
    const supplement = buildExifSupplementCategories(embeddedExif);
    if (supplement.length > 0) {
      mergeCategoryFields(categories, supplement);
    }
  }

  const { totalFields, populatedFields } = computeFieldCounts(categories);
  const cameraName = deriveCameraName(embeddedExif);
  const hasGps = categories.some(
    (c) => c.id === "gps" && c.fields.some((f) => f.id !== "gps.warning"),
  );

  return {
    categories,
    totalFields,
    populatedFields,
    hasGps,
    hasExif: formatResult.categories.length > 0 || Object.keys(embeddedExif).length > 0,
    cameraName,
    fileName: meta.name,
    fileSize: meta.size,
    parsedAt: Date.now(),
    formatFamily: formatResult.formatFamily,
    formatName: formatResult.formatName,
    previewType: formatResult.previewType,
    textPreview: formatResult.textPreview,
    summaryItems: formatResult.summary,
  };
}
/** Build result for files with EXIF data (JPEG/TIFF — the original path) */
function buildExifResult(
  exif: RawExif,
  meta: FileMetadata,
  containerFormat: ExifContainerFormat | null,
): LensData {
  const builders: Array<{
    id: string;
    title: string;
    build: () => ExifField[];
  }> = [
      { id: "file", title: "FILE", build: () => buildFileCategory(meta) },
      { id: "image", title: "IMAGE", build: () => buildImageCategory(exif) },
      { id: "camera", title: "CAMERA", build: () => buildCameraCategory(exif) },
      { id: "exposure", title: "EXPOSURE", build: () => buildExposureCategory(exif) },
      { id: "focus", title: "FOCUS & FLASH", build: () => buildFocusCategory(exif) },
      { id: "datetime", title: "DATE & TIME", build: () => buildDateTimeCategory(exif) },
      { id: "gps", title: "GPS", build: () => buildGpsCategory(exif) },
      { id: "iptc", title: "IPTC METADATA", build: () => buildIptcCategory(exif) },
      { id: "xmp", title: "XMP METADATA", build: () => buildXmpCategory(exif) },
      { id: "icc", title: "COLOR PROFILE", build: () => buildIccCategory(exif) },
      { id: "software", title: "SOFTWARE", build: () => buildSoftwareCategory(exif) },
      { id: "advanced", title: "ADVANCED", build: () => buildAdvancedCategory(exif) },
    ];

  const categories: ExifCategory[] = [];

  for (const b of builders) {
    const fields = b.build();
    if (fields.length > 0) {
      categories.push({
        id: b.id,
        title: b.title,
        fields,
        expanded: b.id === "file" || b.id === "camera",
      });
    }
  }

  const { totalFields, populatedFields } = computeFieldCounts(categories);

  // Determine camera name
  const make = typeof exif["Make"] === "string" ? exif["Make"].trim() : "";
  const model = typeof exif["Model"] === "string" ? exif["Model"].trim() : "";
  let cameraName: string | null = null;
  if (model) {
    cameraName = make && !model.toLowerCase().startsWith(make.toLowerCase())
      ? `${make} ${model}`
      : model;
  } else if (make) {
    cameraName = make;
  }

  const hasGps = categories.some(
    (c) => c.id === "gps" && c.fields.some((f) => f.id !== "gps.warning"),
  );
  const formatName = containerFormat
    ?? (meta.type === "image/jpeg" || meta.type === "image/jpg" ? "JPEG" : "TIFF");
  const formatFamily = formatName === "JPEG" ? "jpeg" : "tiff";

  return {
    categories,
    totalFields,
    populatedFields,
    hasGps,
    hasExif: true,
    cameraName,
    fileName: meta.name,
    fileSize: meta.size,
    parsedAt: Date.now(),
    formatFamily,
    formatName,
    previewType: "image",
    summaryItems: [
      { label: "camera", value: cameraName ?? "none" },
      { label: "GPS", value: hasGps ? "yes" : "no" },
    ],
  };
}

/**
 * Minimal IPTC/IIM parser for Photoshop APP13 segments.
 */
function parseIptc(view: DataView, offset: number, length: number): RawExif {
  const result: RawExif = {};
  let pos = offset;
  const end = offset + length;

  // Skip "Photoshop 3.0\0"
  pos += 14;

  while (pos + 12 < end) {
    const sig = readAscii(view, pos, 4);
    if (sig !== "8BIM") {
      pos++;
      continue;
    }
    pos += 4;

    const type = view.getUint16(pos);
    pos += 2;

    // Skip resource name (Pascal string, padded to even)
    const nameLen = view.getUint8(pos);
    pos += 1 + nameLen;
    if (pos % 2 !== 0) pos++;

    if (pos + 4 > end) break;
    const dataSize = view.getUint32(pos);
    pos += 4;

    // IPTC is type 0x0404
    if (type === 0x0404) {
      const iptcData = parseIptcIim(view, pos, dataSize);
      Object.assign(result, iptcData);
    }

    pos += dataSize;
    if (pos % 2 !== 0) pos++;
  }

  return result;
}

const IPTC_TAGS: Record<number, string> = {
  120: "IptcCaption",
  105: "IptcHeadline",
  80: "IptcByline",
  85: "IptcBylineTitle",
  110: "IptcCredit",
  115: "IptcSource",
  5: "IptcObjectName",
  15: "IptcCategory",
  20: "IptcSupplementalCategories",
  25: "IptcKeywords",
  90: "IptcCity",
  92: "IptcSublocation",
  95: "IptcProvinceState",
  101: "IptcCountry",
  103: "IptcOriginalTransmissionReference",
  55: "IptcDateCreated",
  60: "IptcTimeCreated",
};

function parseIptcIim(view: DataView, offset: number, length: number): RawExif {
  const result: RawExif = {};
  let pos = offset;
  const end = offset + length;

  while (pos + 5 < end) {
    if (view.getUint8(pos) !== 0x1c) {
      pos++;
      continue;
    }
    const record = view.getUint8(pos + 1);
    const dataset = view.getUint8(pos + 2);
    const size = view.getUint16(pos + 3);
    pos += 5;

    if (record === 2 && pos + size <= end) {
      const tagName = IPTC_TAGS[dataset];
      if (tagName) {
        const val = readAscii(view, pos, size).trim();
        if (tagName === "IptcKeywords") {
          if (!result[tagName]) result[tagName] = [];
          (result[tagName] as any).push(val);
        } else {
          result[tagName] = val;
        }
      }
    }
    pos += size;
  }
  return result;
}

/** Build IPTC category fields */
function buildIptcCategory(exif: RawExif): ExifField[] {
  const fields: ExifField[] = [];
  const mappings: Array<{ key: string; label: string; desc: string }> = [
    { key: "IptcObjectName", label: "Object Name", desc: "shorthand name for the content" },
    { key: "IptcHeadline", label: "Headline", desc: "a publishable headline of the content" },
    { key: "IptcCaption", label: "Caption", desc: "description or abstract of the content" },
    { key: "IptcByline", label: "Creator", desc: "name of the creator of the content" },
    { key: "IptcBylineTitle", label: "Creator Title", desc: "title of the creator" },
    { key: "IptcCredit", label: "Credit", desc: "identifies the provider of the content" },
    { key: "IptcSource", label: "Source", desc: "original source of the content" },
    { key: "IptcKeywords", label: "Keywords", desc: "keywords or tags associated with the content" },
    { key: "IptcCity", label: "City", desc: "city where content was created" },
    { key: "IptcProvinceState", label: "State/Province", desc: "state or province where content was created" },
    { key: "IptcCountry", label: "Country", desc: "country where content was created" },
    { key: "IptcDateCreated", label: "Date Created", desc: "the date the content was created" },
  ];

  for (const { key, label, desc } of mappings) {
    const val = exif[key];
    if (val !== undefined && val !== null) {
      const display = Array.isArray(val) ? val.join(", ") : String(val);
      fields.push(field(`iptc.${key.toLowerCase()}`, label, val, display, desc));
    }
  }

  return fields;
}

/** Build XMP category fields (Regex-based extraction for common tags) */
function buildXmpCategory(exif: RawExif): ExifField[] {
  const xmp = exif["_xmp"];
  if (typeof xmp !== "string" || !xmp) return [];

  const fields: ExifField[] = [];

  const extract = (tag: string, label: string, desc: string) => {
    let match = xmp.match(new RegExp(`${tag}="([^"]+)"`));
    if (!match) {
      match = xmp.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`));
    }
    if (!match) {
      match = xmp.match(new RegExp(`[:\\s]${tag}="([^"]+)"`));
    }

    if (match && match[1]) {
      const val = match[1].trim();
      fields.push(field(`xmp.${tag}`, label, val, val, desc));
    }
  };

  extract("CreatorTool", "Creator Tool", "the tool used to create the original resource");
  extract("CreateDate", "Create Date", "the date and time the resource was originally created");
  extract("MetadataDate", "Metadata Date", "the date and time that any metadata was last changed");
  extract("Rating", "Rating", "user-assigned rating of the resource");
  extract("Label", "Label", "user-assigned label or category");
  extract("format", "Format", "the MIME type of the resource");
  extract("title", "Title", "the title of the resource in various languages");
  extract("description", "Description", "a textual description of the resource");
  extract("subject", "Keywords", "a list of descriptive phrases or keywords");
  extract("rights", "Copyright", "informal rights statement, such as a copyright notice");
  extract("UsageTerms", "Usage Terms", "textual instruction on how the resource may be used");

  return fields;
}

/** 
 * Minimal ICC Profile parser for basic header info.
 */
function parseIcc(view: DataView, offset: number, length: number): any {
  if (length < 84) return null;

  return {
    size: view.getUint32(offset),
    cmm: readAscii(view, offset + 4, 4),
    version: `${view.getUint8(offset + 8)}.${(view.getUint8(offset + 9) >> 4)}.${(view.getUint8(offset + 9) & 0x0f)}`,
    deviceClass: readAscii(view, offset + 12, 4),
    colorSpace: readAscii(view, offset + 16, 4),
    connectionSpace: readAscii(view, offset + 20, 4),
    manufacturer: readAscii(view, offset + 48, 4),
    model: readAscii(view, offset + 52, 4),
    renderingIntent: view.getUint32(offset + 64),
    creator: readAscii(view, offset + 80, 4),
  };
}

/** Build ICC Profile category fields */
function buildIccCategory(exif: RawExif): ExifField[] {
  const icc = exif["_icc"] as any;
  if (!icc) return [];

  const intents: Record<number, string> = {
    0: "Perceptual",
    1: "Relative Colorimetric",
    2: "Saturation",
    3: "Absolute Colorimetric",
  };

  const classes: Record<string, string> = {
    "scnr": "Input Device (Scanner/Camera)",
    "mntr": "Display Device (Monitor)",
    "prtr": "Output Device (Printer)",
    "link": "Device Link",
    "spac": "Color Space Conversion",
    "abst": "Abstract",
    "nmcl": "Named Color",
  };

  const spaces: Record<string, string> = {
    "RGB ": "RGB",
    "CMYK": "CMYK",
    "Gray": "Grayscale",
    "Lab ": "L*a*b*",
    "XYZ ": "XYZ",
    "YCbr": "YCbCr",
  };

  const fields: ExifField[] = [
    field("icc.version", "ICC Version", icc.version, icc.version, "version of the ICC profile specification used"),
    field("icc.class", "Profile Class", icc.deviceClass, classes[icc.deviceClass] ?? icc.deviceClass, "the intended use of this color profile"),
    field("icc.colorSpace", "Color Space", icc.colorSpace, spaces[icc.colorSpace] ?? icc.colorSpace, "the underlying color model"),
    field("icc.intent", "Rendering Intent", icc.renderingIntent, intents[icc.renderingIntent] ?? String(icc.renderingIntent), "how color gamut compression is handled"),
    field("icc.creator", "Profile Creator", icc.creator, icc.creator, "the software or organization that created the profile"),
  ];

  if (icc.manufacturer && icc.manufacturer !== "\0\0\0\0") {
    fields.push(field("icc.manufacturer", "Manufacturer", icc.manufacturer, icc.manufacturer, "the manufacturer of the device this profile is for"));
  }

  return fields;
}

/** Proprietary MakerNote parsing for major camera brands */
function handleMakerNote(
  blob: number[],
  make: string,
): Record<string, any> {
  const result: Record<string, any> = {};
  const uint8 = new Uint8Array(blob);
  const makerView = new DataView(uint8.buffer);

  try {
    const makeLower = make.toLowerCase();

    // Nikon
    if (makeLower.includes("nikon")) {
      const head = readAscii(makerView, 0, 5);
      if (head === "Nikon") {
        // Nikon v3 starts with "Nikon" + header (total 10 bytes)
        // IFD follows at offset 10 (version 2 and 3)
        const ifdStart = 10;
        const le = makerView.getUint16(ifdStart) === 0x4949;
        const ifd = parseIFD(makerView, 0, ifdStart + 8, le, NIKON_TAGS);
        Object.assign(result, ifd);
      }
    }
    // Canon
    else if (makeLower.includes("canon")) {
      // Canon MakerNote is usually a pure IFD at offset 0, little-endian
      const ifd = parseIFD(makerView, 0, 0, true, CANON_TAGS);
      Object.assign(result, ifd);
    }
  } catch {
    // skip proprietary parsing if error occurs
  }

  return result;
}

