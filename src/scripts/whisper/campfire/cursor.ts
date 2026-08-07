/**
 * cursor.ts — the algebra that makes a truncated frame unreadable rather than
 * merely rejected.
 *
 * THE SHAPE OF THE BUG THIS REMOVES. A parser is a fold over bytes carrying an
 * offset: that is the State monad. Written as State alone, failure has nowhere
 * to live, so a read past the end becomes an exception (RangeError escaping the
 * parser) or, worse, a silent nonsense value — `data[o]` on a short frame gives
 * `undefined`, `1 + undefined * 5` gives NaN, and `subarray(NaN)` cheerfully
 * returns the whole buffer. Both happened here, on bytes supplied by a relay,
 * before any signature or tag was checked.
 *
 * The cure is not more checks. It is giving failure a representation and making
 * it ABSORBING: State ⊗ Maybe, where Nothing is a zero for the composition.
 * Once a read runs out of bytes the cursor is failed, every later read is a
 * no-op returning a harmless zero value, and `finish` refuses to hand back a
 * result at all. There is no expressible way to read a field without first
 * proving it is there, so the bug class stops being a thing you remember and
 * starts being a thing you cannot write.
 *
 * Cost is identical to the hand-written form: one comparison per field. What
 * changes is that the comparison is structural instead of remembered.
 */

const EMPTY = new Uint8Array(0);

export class Cursor {
  private off = 0;
  private failed = false;

  constructor(private readonly buf: Uint8Array) {}

  /** true while every read so far has been in range. */
  get ok(): boolean {
    return !this.failed;
  }

  get remaining(): number {
    return this.failed ? 0 : this.buf.length - this.off;
  }

  /** the zero of the composition: once failed, always failed. */
  private need(n: number): boolean {
    if (this.failed) return false;
    if (n < 0 || this.off + n > this.buf.length) {
      this.failed = true;
      return false;
    }
    return true;
  }

  bytes(n: number): Uint8Array {
    if (!this.need(n)) return EMPTY;
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  u8(): number {
    if (!this.need(1)) return 0;
    return this.buf[this.off++];
  }

  u16(): number {
    if (!this.need(2)) return 0;
    const v = this.buf[this.off] | (this.buf[this.off + 1] << 8);
    this.off += 2;
    return v;
  }

  u32(): number {
    if (!this.need(4)) return 0;
    const b = this.buf;
    const o = this.off;
    const v = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    this.off += 4;
    return v;
  }

  f64(): number {
    if (!this.need(8)) return 0;
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 8);
    this.off += 8;
    return view.getFloat64(0, true);
  }

  /** everything not yet consumed. empty on a failed cursor. */
  rest(): Uint8Array {
    if (this.failed) return EMPTY;
    const out = this.buf.subarray(this.off);
    this.off = this.buf.length;
    return out;
  }

  /** require at least `n` bytes to remain, without consuming them. */
  expect(n: number): void {
    if (this.failed) return;
    if (this.buf.length - this.off < n) this.failed = true;
  }

  /** reject trailing bytes: a frame that parses must be FULLY consumed. */
  expectEnd(): void {
    if (this.failed) return;
    if (this.off !== this.buf.length) this.failed = true;
  }

  /**
   * The only way to produce a result. A parser cannot forget to check, because
   * checking is how it returns: on a failed cursor this yields null and the
   * half-read fields never escape.
   */
  finish<T>(value: T): T | null {
    return this.failed ? null : value;
  }
}
