import { type GateTurns, type Mat4, IDENT4, mulMat4, quarterTurnsQuaternion, trsToMat4 } from "./glb-math.js";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK_MAGIC = 0x4e4f534a;
const BIN_CHUNK_MAGIC = 0x004e4942;
const COMP_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_ARITY: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export function parseGlbChunks(source: ArrayBuffer | Uint8Array): { gltf: AnyRecord; bin: Uint8Array } {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    if (bytes.byteLength < 20) throw new Error("Truncated GLB header (< 20 bytes)");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("Invalid GLB magic header");
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new Error(`Unsupported GLB version ${version} (expected 2)`);
    const declaredLen = dv.getUint32(8, true);
    if (declaredLen < 20 || declaredLen > bytes.byteLength) {
        throw new Error(`Invalid GLB declared byteLength ${declaredLen} (buffer has ${bytes.byteLength})`);
    }
    const jsonLen = dv.getUint32(12, true);
    if (dv.getUint32(16, true) !== JSON_CHUNK_MAGIC) throw new Error("Invalid GLB JSON chunk magic");
    if (jsonLen === 0 || jsonLen > declaredLen - 20) throw new Error("GLB JSON chunk length out of bounds");
    let gltf: unknown;
    try {
        gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
    } catch {
        throw new Error("Malformed JSON in GLB JSON chunk");
    }
    if (!gltf || typeof gltf !== "object" || Array.isArray(gltf)) throw new Error("Invalid glTF root object");
    const binOff = 20 + jsonLen;
    if (binOff === declaredLen) return { gltf: gltf as AnyRecord, bin: new Uint8Array(0) };
    if (binOff > declaredLen - 8) throw new Error("Truncated GLB BIN chunk header");
    const binLen = dv.getUint32(binOff, true);
    if (dv.getUint32(binOff + 4, true) !== BIN_CHUNK_MAGIC) throw new Error("Invalid GLB BIN chunk magic");
    if (binLen > declaredLen - (binOff + 8)) throw new Error("Truncated GLB BIN chunk payload");
    return { gltf: gltf as AnyRecord, bin: bytes.subarray(binOff + 8, binOff + 8 + binLen) };
}

export function packGlbChunks(gltf: AnyRecord, binChunks: Uint8Array[], totalBinBytes: number): ArrayBuffer {
    const padBinLen = (totalBinBytes + 3) & ~3;
    if (gltf.buffers?.[0]) gltf.buffers[0].byteLength = padBinLen;
    else if (padBinLen > 0) gltf.buffers = [{ byteLength: padBinLen }];
    const rawJson = new TextEncoder().encode(JSON.stringify(gltf));
    const padJson = (rawJson.byteLength + 3) & ~3;
    const total = 12 + 8 + padJson + 8 + padBinLen;
    const out = new ArrayBuffer(total);
    const outDv = new DataView(out);
    const outU8 = new Uint8Array(out);
    outDv.setUint32(0, GLB_MAGIC, true);
    outDv.setUint32(4, 2, true);
    outDv.setUint32(8, total, true);
    outDv.setUint32(12, padJson, true);
    outDv.setUint32(16, JSON_CHUNK_MAGIC, true);
    outU8.fill(0x20, 20, 20 + padJson);
    outU8.set(rawJson, 20);
    outDv.setUint32(20 + padJson, padBinLen, true);
    outDv.setUint32(24 + padJson, BIN_CHUNK_MAGIC, true);
    let cursor = 28 + padJson;
    for (const ch of binChunks) {
        outU8.set(ch, cursor);
        cursor += ch.byteLength;
    }
    return out;
}

export function computeWorldMatrices(gltf: AnyRecord, turns: GateTurns = [0, 0, 0]): Mat4[] {
    const nodes: AnyRecord[] = gltf.nodes ?? [];
    const rootM = trsToMat4([0, 0, 0], quarterTurnsQuaternion(turns), [1, 1, 1]);
    const world: Mat4[] = nodes.map(() => IDENT4);
    const hasParent = new Set<number>();
    for (const n of nodes) {
        for (const c of n.children ?? []) {
            if (!Number.isInteger(c) || c < 0 || c >= nodes.length) throw new Error(`Invalid glTF child node index: ${c}`);
            hasParent.add(c);
        }
    }
    const visiting = new Set<number>();
    const visited = new Set<number>();
    const walk = (idx: number, parentM: Mat4): void => {
        if (!Number.isInteger(idx) || idx < 0 || idx >= nodes.length) throw new Error(`Invalid glTF node index: ${idx}`);
        if (visiting.has(idx)) throw new Error(`Cyclic glTF node hierarchy detected at node ${idx}`);
        if (visited.has(idx)) throw new Error(`Shared/cyclic glTF node reference at node ${idx}`);
        visiting.add(idx);
        visited.add(idx);
        const n = nodes[idx];
        const local = Array.isArray(n.matrix) && n.matrix.length === 16
            ? (n.matrix as unknown as Mat4)
            : trsToMat4(n.translation, n.rotation, n.scale);
        const m = mulMat4(parentM, local);
        world[idx] = m;
        for (const c of n.children ?? []) walk(c, m);
        visiting.delete(idx);
    };
    for (const r of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) walk(r, rootM);
    for (let i = 0; i < nodes.length; i++) {
        if (!visited.has(i) && !hasParent.has(i)) walk(i, rootM);
    }
    if (visited.size < nodes.length) throw new Error("Cyclic glTF node hierarchy detected");
    return world;
}

export function resolveFloatVec3Accessor(
    accessors: AnyRecord[],
    views: AnyRecord[],
    accIdx: number,
    binLen: number,
    label: string,
): { acc: AnyRecord; base: number; stride: number; count: number } {
    const acc = accessors[accIdx];
    if (!acc)
        throw new Error(`Missing ${label} accessor ${accIdx}`);
    if (acc.componentType !== 5126 || acc.type !== "VEC3" || acc.normalized) {
        throw new Error(`Unsupported quantized or non-float32 ${label} accessor (componentType=${acc.componentType}, type=${acc.type})`);
    }
    if (acc.bufferView === undefined || !views[acc.bufferView]) {
        throw new Error(`${label} accessor ${accIdx} has no uncompressed bufferView (Draco compression is not supported)`);
    }
    const bv = views[acc.bufferView];
    if (bv.extensions?.EXT_meshopt_compression)
        throw new Error("EXT_meshopt_compression bufferViews are not supported");
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;
    const count = acc.count ?? 0;
    if (stride < 12 || (count > 0 && (base < 0 || base + (count - 1) * stride + 12 > binLen))) {
        throw new Error(`${label} accessor ${accIdx} exceeds BIN chunk bounds`);
    }
    return { acc, base, stride, count };
}

export function swapVec3Triples(floats: Float32Array, count: number): void {
    const triEnd = count - (count % 3);
    for (let v = 0; v < triEnd; v += 3) {
        const b = (v + 1) * 3;
        const c = (v + 2) * 3;
        for (let k = 0; k < 3; k++) {
            const tmp = floats[b + k];
            floats[b + k] = floats[c + k];
            floats[c + k] = tmp;
        }
    }
}

export function flipAccessorTriplesBytes(
    accessors: AnyRecord[],
    views: AnyRecord[],
    srcBin: Uint8Array,
    accIdx: number,
): Uint8Array | null {
    const acc = accessors[accIdx];
    const bv = acc ? views[acc.bufferView] : undefined;
    const elem = acc ? (COMP_BYTES[acc.componentType] ?? 0) * (TYPE_ARITY[acc.type] ?? 1) : 0;
    if (!acc || !bv || elem <= 0)
        return null;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? elem;
    const cnt = acc.count ?? 0;
    if (cnt > 0 && (base < 0 || base + (cnt - 1) * stride + elem > srcBin.byteLength))
        return null;
    const flipped = new Uint8Array(cnt * elem);
    const triEnd = cnt - (cnt % 3);
    for (let k = 0; k < cnt; k++) {
        const srcK = k < triEnd && k % 3 !== 0 ? (k % 3 === 1 ? k + 1 : k - 1) : k;
        flipped.set(srcBin.subarray(base + srcK * stride, base + srcK * stride + elem), k * elem);
    }
    return flipped;
}

export function hasOverlappingAccessor(accessors: AnyRecord[], views: AnyRecord[], accIdx: number, claimed: Set<number>): boolean {
    if (claimed.has(accIdx)) return true;
    const a = accessors[accIdx], bvA = a ? views[a.bufferView] : undefined;
    if (!a || !bvA) return false;
    const elemA = (COMP_BYTES[a.componentType] ?? 0) * (TYPE_ARITY[a.type] ?? 1);
    const offA = a.byteOffset ?? 0, baseA = (bvA.byteOffset ?? 0) + offA;
    const strideA = bvA.byteStride ?? elemA, endA = (a.count ?? 0) > 0 ? baseA + ((a.count ?? 1) - 1) * strideA + elemA : baseA;
    for (const cIdx of claimed) {
        const b = accessors[cIdx], bvB = b ? views[b.bufferView] : undefined;
        if (!b || !bvB) continue;
        const elemB = (COMP_BYTES[b.componentType] ?? 0) * (TYPE_ARITY[b.type] ?? 1);
        const offB = b.byteOffset ?? 0, baseB = (bvB.byteOffset ?? 0) + offB;
        const strideB = bvB.byteStride ?? elemB, endB = (b.count ?? 0) > 0 ? baseB + ((b.count ?? 1) - 1) * strideB + elemB : baseB;
        if (baseA < endB && baseB < endA) {
            if (a.bufferView === b.bufferView && bvA.byteStride && bvA.byteStride === bvB.byteStride) {
                if (offA % bvA.byteStride + elemA <= offB % bvA.byteStride || offB % bvA.byteStride + elemB <= offA % bvA.byteStride) continue;
            }
            return true;
        }
    }
    return false;
}

export function createGlbBinWriter(gltf: AnyRecord, srcBin: Uint8Array): {
    workBin: Uint8Array<ArrayBuffer>;
    appendView: (raw: Uint8Array, target?: number) => number;
    writeOrCloneVec3: (accIdx: number, out: Float32Array, claimed: Set<number>, bounds?: [number[], number[]]) => number;
    pack: () => ArrayBuffer;
} {
    const accessors: AnyRecord[] = (gltf.accessors ??= []);
    const views: AnyRecord[] = (gltf.bufferViews ??= []);
    const workBin = new Uint8Array(new ArrayBuffer((srcBin.byteLength + 3) & ~3));
    workBin.set(srcBin);
    const workDv = new DataView(workBin.buffer);
    const binChunks: Uint8Array[] = [workBin];
    let totalBinBytes = workBin.byteLength;
    const appendView = (raw: Uint8Array, target?: number): number => {
        const padded = new Uint8Array((raw.byteLength + 3) & ~3);
        padded.set(raw);
        views.push({ buffer: 0, byteOffset: totalBinBytes, byteLength: raw.byteLength, ...(target ? { target } : {}) });
        binChunks.push(padded);
        totalBinBytes += padded.byteLength;
        return views.length - 1;
    };
    const writeOrCloneVec3 = (accIdx: number, out: Float32Array, claimed: Set<number>, bounds?: [number[], number[]]): number => {
        const { acc, base, stride, count } = resolveFloatVec3Accessor(accessors, views, accIdx, srcBin.byteLength, "VEC3");
        if (!hasOverlappingAccessor(accessors, views, accIdx, claimed)) {
            claimed.add(accIdx);
            for (let i = 0; i < count; i++) {
                const o = base + i * stride;
                workDv.setFloat32(o, out[i * 3], true);
                workDv.setFloat32(o + 4, out[i * 3 + 1], true);
                workDv.setFloat32(o + 8, out[i * 3 + 2], true);
            }
            if (bounds && Number.isFinite(bounds[0][0])) {
                acc.min = bounds[0];
                acc.max = bounds[1];
            }
            return accIdx;
        }
        claimed.add(accIdx);
        const rawBytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
        const cloned: AnyRecord = { ...acc, bufferView: appendView(rawBytes, 34962), byteOffset: 0 };
        if (bounds && Number.isFinite(bounds[0][0])) {
            cloned.min = bounds[0];
            cloned.max = bounds[1];
        }
        else {
            delete cloned.min;
            delete cloned.max;
        }
        accessors.push(cloned);
        return accessors.length - 1;
    };
    return { workBin, appendView, writeOrCloneVec3, pack: () => packGlbChunks(gltf, binChunks, totalBinBytes) };
}
