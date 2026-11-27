import {
    DEFAULT_VAULT_URL,
    VAULT_CARS,
    createAssetVault,
    inspectGlbBuffer,
    normalizeGlbBuffer,
    vaultAssetUrl,
} from "../src/index.js";

console.log("Default vault:", DEFAULT_VAULT_URL);
console.log("Lexus URL:", vaultAssetUrl("cars/lexus_is300.glb"));
console.log("Catalog match:", VAULT_CARS.lexus_is300 === createAssetVault().url("cars/lexus_is300.glb"));

const pos = new Float32Array([0, 2, 0, 4, 2, 0, 0, 6, 8]);
const rawBin = new Uint8Array(pos.buffer);
const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "sample", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 2, 0], max: [4, 6, 8] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: rawBin.byteLength, target: 34962 }],
    buffers: [{ byteLength: rawBin.byteLength }],
};
const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
const padJson = (jsonBytes.byteLength + 3) & ~3;
const buf = new ArrayBuffer(12 + 8 + padJson + 8 + rawBin.byteLength);
const dv = new DataView(buf);
const u8 = new Uint8Array(buf);
dv.setUint32(0, 0x46546c67, true);
dv.setUint32(4, 2, true);
dv.setUint32(8, buf.byteLength, true);
dv.setUint32(12, padJson, true);
dv.setUint32(16, 0x4e4f534a, true);
u8.fill(0x20, 20, 20 + padJson);
u8.set(jsonBytes, 20);
dv.setUint32(20 + padJson, rawBin.byteLength, true);
dv.setUint32(24 + padJson, 0x004e4942, true);
u8.set(rawBin, 28 + padJson);

console.log("Before:", inspectGlbBuffer(buf).sizeMeters);
const norm = normalizeGlbBuffer(buf, { axis: "lengthZ", targetMeters: 4 });
console.log("After:", { min: norm.min, sizeMeters: norm.sizeMeters, scaleApplied: norm.scaleApplied });
