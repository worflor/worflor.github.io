function encodeULEB(v) {
    v = v >>> 0;
    const out = [];
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v !== 0) b |= 0x80;
        out.push(b);
    } while (v !== 0);
    return out;
}
function encodeSLEB(v) {
    v = v | 0;
    const out = [];
    let done = false;
    while (!done) {
        let b = v & 0x7f;
        v >>= 7;
        const sign = (b & 0x40) !== 0;
        done = (v === 0 && !sign) || (v === -1 && sign);
        if (!done) b |= 0x80;
        out.push(b);
    }
    return out;
}
function nameSec(s) {
    const b = Array.from(new TextEncoder().encode(s));
    return [...encodeULEB(b.length), ...b];
}
function section(id, body) {
    return [id, ...encodeULEB(body.length), ...body];
}
function encodeLocals(decls) {
    return [...encodeULEB(decls.length), ...decls.flatMap(d => [...encodeULEB(d.count), d.type])];
}
function funcBody(locals, instr) {
    const body = [...encodeLocals(locals), ...instr.flat()];
    return [...encodeULEB(body.length), ...body];
}

const I32 = 0x7f;
const VOID = 0x40;
const GET = (i) => [0x20, ...encodeULEB(i)];
const SET = (i) => [0x21, ...encodeULEB(i)];
const CI32 = (v) => [0x41, ...encodeSLEB(v)];
const END = [0x0b];
const ADD = [0x6a];
const XOR = [0x73];
const ROTL = [0x77];

function QROUND(a, b, c, d) {
    return [
        ...GET(a), ...GET(b), ...ADD, ...SET(a),
        ...GET(d), ...GET(a), ...XOR, ...CI32(16), ...ROTL, ...SET(d),
        ...GET(c), ...GET(d), ...ADD, ...SET(c),
        ...GET(b), ...GET(c), ...XOR, ...CI32(12), ...ROTL, ...SET(b),
        ...GET(a), ...GET(b), ...ADD, ...SET(a),
        ...GET(d), ...GET(a), ...XOR, ...CI32(8), ...ROTL, ...SET(d),
        ...GET(c), ...GET(d), ...ADD, ...SET(c),
        ...GET(b), ...GET(c), ...XOR, ...CI32(7), ...ROTL, ...SET(b),
    ];
}

const body = funcBody([{count: 4, type: I32}], [
    ...CI32(1), ...SET(0),
    ...CI32(2), ...SET(1),
    ...CI32(3), ...SET(2),
    ...CI32(4), ...SET(3),
    ...QROUND(0, 1, 2, 3),
    ...GET(0),
    ...END
]);

const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const typeSection = section(1, [
    ...encodeULEB(1),
    0x60, ...encodeULEB(0), ...encodeULEB(1), I32,
]);
const funcSection = section(3, [
    ...encodeULEB(1),
    ...encodeULEB(0),
]);
const exportSection = section(7, [
    ...encodeULEB(1),
    ...nameSec("test"), 0x00, ...encodeULEB(0),
]);
const codeSection = section(10, [
    ...encodeULEB(1),
    ...body,
]);

const wasm = new Uint8Array([
    ...magic, ...typeSection, ...funcSection, ...exportSection, ...codeSection
]);

WebAssembly.instantiate(wasm).then(m => console.log("QROUND a:", m.instance.exports.test().toString(16))).catch(console.error);