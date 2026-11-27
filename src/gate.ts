import { computeWorldMatrices, createGlbBinWriter, flipAccessorTriplesBytes, hasOverlappingAccessor, parseGlbChunks, resolveFloatVec3Accessor, swapVec3Triples } from "./glb-io.js";
import { normalizeKhrHierarchy, scaleWheelMetadata } from "./glb-khr.js";
import { type GateTurns, type QuarterTurn, applyNormalInvTranspose, applyPos, det3x3, extractRotationQuat, mulMat4, quarterTurnsQuaternion, trsToMat4 } from "./glb-math.js";

export { quarterTurnsQuaternion, type GateTurns, type QuarterTurn };

export type GateAxis = "maxSpan" | "widthX" | "heightY" | "lengthZ" | "wheelbase";

export interface GateNormalizeOptions {
    readonly targetMeters: number;
    readonly axis?: GateAxis;
    readonly turns?: GateTurns;
}

export interface GateInspectionResult {
    readonly min: [number, number, number];
    readonly max: [number, number, number];
    readonly sizeMeters: [number, number, number];
    readonly wheelbaseMeters: number | null;
    readonly nodeCount: number;
    readonly meshCount: number;
    readonly extensionsUsed: string[];
}

export interface GateNormalizedGlbResult extends GateInspectionResult {
    readonly glb: ArrayBuffer;
    readonly scaleApplied: number;
}

const WHEEL_RE = /wheel|tire|rim|tyre/i;

export function inspectGlbBuffer(source: ArrayBuffer | Uint8Array, turns: GateTurns = [0, 0, 0]): GateInspectionResult {
    const { gltf, bin } = parseGlbChunks(source);
    if ((gltf.extensionsRequired ?? []).includes("KHR_draco_mesh_compression")) {
        throw new Error("Draco-compressed GLB meshes (KHR_draco_mesh_compression) are not supported");
    }
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const nodes = gltf.nodes ?? [];
    const meshes = gltf.meshes ?? [];
    const accessors = gltf.accessors ?? [];
    const views = gltf.bufferViews ?? [];
    const world = computeWorldMatrices(gltf, turns);
    let min: [number, number, number] = [Infinity, Infinity, Infinity];
    let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const wheelZs: number[] = [];
    const omiWheels = Array.isArray(gltf.extensions?.OMI_vehicle_wheel?.wheels) ? gltf.extensions.OMI_vehicle_wheel.wheels : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodes.forEach((n: Record<string, any>, ni: number) => {
        const nodeOmiIdx = n.extensions?.OMI_vehicle_wheel?.wheel;
        const hasOmiWheel = typeof nodeOmiIdx === "number" && Number.isInteger(nodeOmiIdx) && nodeOmiIdx >= 0 && (omiWheels === null || nodeOmiIdx < omiWheels.length);
        const isExplicitWheel = Boolean(n.extras?.ecctrlWheel) || hasOmiWheel;
        const isWheelNode = WHEEL_RE.test(n.name ?? "") || isExplicitWheel;
        if (n.mesh === undefined) {
            if (isExplicitWheel) wheelZs.push(world[ni][14]);
            return;
        }
        let wMinZ = Infinity, wMaxZ = -Infinity;
        for (const prim of meshes[n.mesh]?.primitives ?? []) {
            if (prim.extensions?.KHR_draco_mesh_compression) {
                throw new Error("Draco-compressed GLB meshes (KHR_draco_mesh_compression) are not supported");
            }
            if (prim.attributes?.POSITION === undefined) continue;
            const { base, stride, count } = resolveFloatVec3Accessor(accessors, views, prim.attributes.POSITION, bin.byteLength, "POSITION");
            for (let i = 0; i < count; i++) {
                const o = base + i * stride;
                const [wx, wy, wz] = applyPos(world[ni], dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
                min = [Math.min(min[0], wx), Math.min(min[1], wy), Math.min(min[2], wz)];
                max = [Math.max(max[0], wx), Math.max(max[1], wy), Math.max(max[2], wz)];
                wMinZ = Math.min(wMinZ, wz);
                wMaxZ = Math.max(wMaxZ, wz);
            }
        }
        if (isWheelNode) {
            if (Number.isFinite(wMinZ)) wheelZs.push((wMinZ + wMaxZ) * 0.5);
            else if (isExplicitWheel) wheelZs.push(world[ni][14]);
        }
    });
    if (!Number.isFinite(min[0])) { min = [0, 0, 0]; max = [0, 0, 0]; }
    return {
        min, max,
        sizeMeters: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        wheelbaseMeters: wheelZs.length >= 2 ? Math.max(...wheelZs) - Math.min(...wheelZs) : null,
        nodeCount: nodes.length, meshCount: meshes.length,
        extensionsUsed: Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed : [],
    };
}

export function normalizeGlbBuffer(source: ArrayBuffer | Uint8Array, options: GateNormalizeOptions): GateNormalizedGlbResult {
    if (!options || typeof options.targetMeters !== "number" || !Number.isFinite(options.targetMeters) || options.targetMeters <= 0) {
        throw new Error(`normalizeGlbBuffer: targetMeters must be a finite positive number (got ${String(options?.targetMeters)})`);
    }
    const turns = options.turns ?? [0, 0, 0];
    const info = inspectGlbBuffer(source, turns);
    const { gltf, bin: srcBin } = parseGlbChunks(source);
    const srcDv = new DataView(srcBin.buffer, srcBin.byteOffset, srcBin.byteLength);
    const writer = createGlbBinWriter(gltf, srcBin);
    const axis = options.axis ?? "maxSpan";
    if (axis === "wheelbase" && (!info.wheelbaseMeters || info.wheelbaseMeters <= 1e-4)) {
        throw new Error("normalizeGlbBuffer: axis 'wheelbase' requires at least two wheel nodes with distinct Z positions");
    }
    const span = axis === "wheelbase" && info.wheelbaseMeters ? info.wheelbaseMeters :
        axis === "widthX" ? Math.max(info.sizeMeters[0], 1e-5) :
            axis === "heightY" ? Math.max(info.sizeMeters[1], 1e-5) :
                axis === "lengthZ" ? Math.max(info.sizeMeters[2], 1e-5) :
                    Math.max(info.sizeMeters[0], info.sizeMeters[1], info.sizeMeters[2], 1e-5);
    const scale = options.targetMeters / span;
    const cx = (info.min[0] + info.max[0]) * 0.5, cz = (info.min[2] + info.max[2]) * 0.5;
    const worldBake = mulMat4(trsToMat4([-cx * scale, -info.min[1] * scale, -cz * scale], [0, 0, 0, 1], [1, 1, 1]), trsToMat4([0, 0, 0], [0, 0, 0, 1], [scale, scale, scale]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes: Record<string, any>[] = gltf.nodes ?? [], meshes: Record<string, any>[] = gltf.meshes ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accessors: Record<string, any>[] = gltf.accessors ?? [], views: Record<string, any>[] = gltf.bufferViews ?? [];
    const extUsed: string[] = Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed : [];
    const hasKhrPhysics =
        extUsed.some((e) => e === "KHR_physics_rigid_bodies" || e === "KHR_implicit_shapes" || e === "OMI_vehicle_wheel") ||
        Boolean(gltf.extensions?.KHR_physics_rigid_bodies || gltf.extensions?.KHR_implicit_shapes || gltf.extensions?.OMI_vehicle_wheel) ||
        nodes.some((n) => Boolean(n.extensions?.KHR_physics_rigid_bodies || n.extensions?.KHR_implicit_shapes || n.extensions?.OMI_vehicle_wheel || n.extras?.ecctrlWheel));
    if (hasKhrPhysics) {
        normalizeKhrHierarchy(gltf, srcBin, srcDv, writer, turns, scale, [-cx * scale, -info.min[1] * scale, -cz * scale]);
        const out = writer.pack();
        return { ...inspectGlbBuffer(out), glb: out, scaleApplied: scale };
    }
    const world = computeWorldMatrices(gltf, turns);
    const finalMats = nodes.map((_, ni) => mulMat4(worldBake, world[ni]));
    const usedMeshes = new Set<number>(), posDetIndexRefs = new Set<number>();
    nodes.forEach((n, ni) => {
        if (n.mesh === undefined) return;
        if (usedMeshes.has(n.mesh)) {
            const orig = meshes[n.mesh];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            meshes.push({ ...orig, primitives: (orig.primitives ?? []).map((p: Record<string, any>) => ({ ...p, attributes: { ...p.attributes } })) });
            n.mesh = meshes.length - 1;
        } else usedMeshes.add(n.mesh);
        if (det3x3(finalMats[ni]) >= 0) {
            for (const p of meshes[n.mesh]?.primitives ?? []) if (p.indices !== undefined) posDetIndexRefs.add(p.indices);
        }
    });
    const bakedPos = new Set<number>(), bakedNrm = new Set<number>(), flippedIdx = new Map<number, number>();
    nodes.forEach((n, ni) => {
        const finalM = finalMats[ni];
        delete n.matrix;
        delete n.children;
        delete n.scale;
        if (n.mesh === undefined) {
            n.translation = [finalM[12], finalM[13], finalM[14]];
            const q = extractRotationQuat(finalM);
            if (Math.hypot(q[0], q[1], q[2], 1 - q[3]) > 1e-7) n.rotation = q;
            else delete n.rotation;
            return;
        }
        delete n.translation;
        delete n.rotation;
        const negDet = det3x3(finalM) < 0;
        const posMemo = new Map<string, number>(), nrmMemo = new Map<string, number>();
        for (const prim of meshes[n.mesh]?.primitives ?? []) {
            const triMode = (prim.mode ?? 4) === 4;
            const flipNonIdx = negDet && triMode && prim.indices === undefined;
            if (prim.attributes?.POSITION !== undefined) {
                const pIdx = prim.attributes.POSITION;
                const memoKey = `${pIdx}:${flipNonIdx ? 1 : 0}`;
                const hit = posMemo.get(memoKey);
                if (hit !== undefined) {
                    prim.attributes.POSITION = hit;
                } else {
                    const { base, stride, count } = resolveFloatVec3Accessor(accessors, views, pIdx, srcBin.byteLength, "POSITION");
                    const out = new Float32Array(count * 3);
                    let lo: [number, number, number] = [Infinity, Infinity, Infinity];
                    let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
                    for (let i = 0; i < count; i++) {
                        const o = base + i * stride;
                        const [wx, wy, wz] = applyPos(finalM, srcDv.getFloat32(o, true), srcDv.getFloat32(o + 4, true), srcDv.getFloat32(o + 8, true));
                        out[i * 3] = wx; out[i * 3 + 1] = wy; out[i * 3 + 2] = wz;
                        lo = [Math.min(lo[0], wx), Math.min(lo[1], wy), Math.min(lo[2], wz)];
                        hi = [Math.max(hi[0], wx), Math.max(hi[1], wy), Math.max(hi[2], wz)];
                    }
                    if (flipNonIdx) swapVec3Triples(out, count);
                    const baked = writer.writeOrCloneVec3(pIdx, out, bakedPos, [lo, hi]);
                    posMemo.set(memoKey, baked);
                    prim.attributes.POSITION = baked;
                }
            }
            if (prim.attributes?.NORMAL !== undefined && accessors[prim.attributes.NORMAL]?.componentType === 5126) {
                const nIdx = prim.attributes.NORMAL;
                const memoKey = `${nIdx}:${flipNonIdx ? 1 : 0}`;
                const hit = nrmMemo.get(memoKey);
                if (hit !== undefined) {
                    prim.attributes.NORMAL = hit;
                } else {
                    const { base, stride, count } = resolveFloatVec3Accessor(accessors, views, nIdx, srcBin.byteLength, "NORMAL");
                    const out = new Float32Array(count * 3);
                    for (let i = 0; i < count; i++) {
                        const o = base + i * stride;
                        const [nx, ny, nz] = applyNormalInvTranspose(finalM, srcDv.getFloat32(o, true), srcDv.getFloat32(o + 4, true), srcDv.getFloat32(o + 8, true));
                        out[i * 3] = nx; out[i * 3 + 1] = ny; out[i * 3 + 2] = nz;
                    }
                    if (flipNonIdx) swapVec3Triples(out, count);
                    const baked = writer.writeOrCloneVec3(nIdx, out, bakedNrm);
                    nrmMemo.set(memoKey, baked);
                    prim.attributes.NORMAL = baked;
                }
            }
            if (flipNonIdx) {
                for (const [attr, aIdx] of Object.entries(prim.attributes ?? {}) as [string, number][]) {
                    if (attr === "POSITION" || attr === "NORMAL") continue;
                    const flipped = flipAccessorTriplesBytes(accessors, views, srcBin, aIdx);
                    if (flipped) {
                        accessors.push({ ...accessors[aIdx], bufferView: writer.appendView(flipped, 34962), byteOffset: 0 });
                        prim.attributes[attr] = accessors.length - 1;
                    }
                }
            }
            if (negDet && triMode && prim.indices !== undefined) {
                const iIdx = prim.indices;
                const cached = flippedIdx.get(iIdx);
                if (cached !== undefined) {
                    prim.indices = cached;
                } else {
                    const flipped = flipAccessorTriplesBytes(accessors, views, srcBin, iIdx);
                    if (flipped) {
                        const iAcc = accessors[iIdx], iBv = views[iAcc.bufferView];
                        if (!hasOverlappingAccessor(accessors, views, iIdx, posDetIndexRefs) && !iBv.byteStride) {
                            writer.workBin.set(flipped, (iBv.byteOffset ?? 0) + (iAcc.byteOffset ?? 0));
                            posDetIndexRefs.add(iIdx);
                            flippedIdx.set(iIdx, iIdx);
                        } else {
                            accessors.push({ ...iAcc, bufferView: writer.appendView(flipped, 34963), byteOffset: 0 });
                            flippedIdx.set(iIdx, accessors.length - 1);
                            prim.indices = accessors.length - 1;
                        }
                    }
                }
            }
        }
    });
    if (gltf.scenes?.[gltf.scene ?? 0])
        gltf.scenes[gltf.scene ?? 0].nodes = nodes.map((_, i) => i);
    scaleWheelMetadata(gltf, scale, finalMats.map((m) => Math.hypot(m[0], m[1], m[2]) || scale));
    const out = writer.pack();
    return { ...inspectGlbBuffer(out), glb: out, scaleApplied: scale };
}
