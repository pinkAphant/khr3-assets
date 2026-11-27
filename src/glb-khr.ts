import { type createGlbBinWriter, flipAccessorTriplesBytes, hasOverlappingAccessor, resolveFloatVec3Accessor, swapVec3Triples } from "./glb-io.js";
import { type AnyRecord, scaleImplicitShape, scaleIndexedEntry, scalePhysicsJoint, scaleWheelMetadata } from "./glb-khr-shapes.js";
import { type GateTurns, type Mat4, applyQuat, det3x3, extractRotationQuat, mulQuat, quarterTurnsQuaternion } from "./glb-math.js";

export { scaleWheelMetadata };

type GlbBinWriter = ReturnType<typeof createGlbBinWriter>;
type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

interface LocalTrs {
    t: Vec3;
    q: Quat;
    sx: number;
    sy: number;
    sz: number;
    hadT: boolean;
}

function extractNodeTrs(n: AnyRecord): LocalTrs {
    if (Array.isArray(n.matrix) && n.matrix.length === 16) {
        const m = n.matrix as unknown as Mat4;
        let sx = Math.hypot(m[0], m[1], m[2]);
        const sy = Math.hypot(m[4], m[5], m[6]);
        const sz = Math.hypot(m[8], m[9], m[10]);
        if (det3x3(m) < 0) sx = -sx;
        return { t: [m[12], m[13], m[14]], q: extractRotationQuat(m), sx, sy, sz, hadT: true };
    }
    const hadT = Array.isArray(n.translation) && n.translation.length === 3;
    const t: Vec3 = hadT ? [n.translation[0], n.translation[1], n.translation[2]] : [0, 0, 0];
    const q: Quat = Array.isArray(n.rotation) && n.rotation.length === 4
        ? [n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]] : [0, 0, 0, 1];
    const sArr = Array.isArray(n.scale) && n.scale.length === 3 ? n.scale : [1, 1, 1];
    return { t, q, sx: sArr[0], sy: sArr[1], sz: sArr[2], hadT };
}

function scaleMeshPrimitives(
    meshIdx: number, meshes: AnyRecord[], accessors: AnyRecord[], views: AnyRecord[],
    srcBin: Uint8Array, srcDv: DataView, writer: GlbBinWriter,
    bakedPos: Set<number>, bakedNrm: Set<number>, posDetIndexRefs: Set<number>, flippedIdx: Map<number, number>,
    posMemo: Map<string, number>, nrmMemo: Map<string, number>,
    vsx: number, vsy: number, vsz: number,
): void {
    const negDet = vsx * vsy * vsz < 0;
    const needsNormalBake = vsx < 0 || vsy < 0 || vsz < 0 || Math.abs(vsx - vsy) > 1e-6 || Math.abs(vsy - vsz) > 1e-6;
    for (const prim of meshes[meshIdx]?.primitives ?? []) {
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
                let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
                for (let i = 0; i < count; i++) {
                    const o = base + i * stride;
                    const x = srcDv.getFloat32(o, true) * vsx, y = srcDv.getFloat32(o + 4, true) * vsy, z = srcDv.getFloat32(o + 8, true) * vsz;
                    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z;
                    lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
                    hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
                }
                if (flipNonIdx) swapVec3Triples(out, count);
                const baked = writer.writeOrCloneVec3(pIdx, out, bakedPos, [lo, hi]);
                posMemo.set(memoKey, baked);
                prim.attributes.POSITION = baked;
            }
        }
        let swappedNormal = false;
        if (needsNormalBake && prim.attributes?.NORMAL !== undefined && accessors[prim.attributes.NORMAL]?.componentType === 5126) {
            const nIdx = prim.attributes.NORMAL;
            const memoKey = `${nIdx}:${flipNonIdx ? 1 : 0}`;
            const hit = nrmMemo.get(memoKey);
            if (hit !== undefined) {
                prim.attributes.NORMAL = hit;
                swappedNormal = flipNonIdx;
            } else {
                const { base, stride, count } = resolveFloatVec3Accessor(accessors, views, nIdx, srcBin.byteLength, "NORMAL");
                const out = new Float32Array(count * 3);
                for (let i = 0; i < count; i++) {
                    const o = base + i * stride;
                    const nx = Math.abs(vsx) > 1e-12 ? srcDv.getFloat32(o, true) / vsx : 0;
                    const ny = Math.abs(vsy) > 1e-12 ? srcDv.getFloat32(o + 4, true) / vsy : 0;
                    const nz = Math.abs(vsz) > 1e-12 ? srcDv.getFloat32(o + 8, true) / vsz : 0;
                    const len = Math.hypot(nx, ny, nz) || 1;
                    out[i * 3] = nx / len; out[i * 3 + 1] = ny / len; out[i * 3 + 2] = nz / len;
                }
                if (flipNonIdx) {
                    swapVec3Triples(out, count);
                    swappedNormal = true;
                }
                const baked = writer.writeOrCloneVec3(nIdx, out, bakedNrm);
                nrmMemo.set(memoKey, baked);
                prim.attributes.NORMAL = baked;
            }
        }
        if (flipNonIdx) {
            for (const [attr, aIdx] of Object.entries(prim.attributes ?? {}) as [string, number][]) {
                if (attr === "POSITION" || (attr === "NORMAL" && swappedNormal)) continue;
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
}

export function normalizeKhrHierarchy(
    gltf: AnyRecord, srcBin: Uint8Array, srcDv: DataView, writer: GlbBinWriter,
    turns: GateTurns, scale: number, shift: Vec3,
): void {
    const nodes: AnyRecord[] = gltf.nodes ?? [];
    const meshes: AnyRecord[] = gltf.meshes ?? [];
    const accessors: AnyRecord[] = gltf.accessors ?? [];
    const views: AnyRecord[] = gltf.bufferViews ?? [];
    const hasParent = new Set<number>();
    for (const n of nodes) for (const c of n.children ?? []) hasParent.add(c);
    const trsList = nodes.map(extractNodeTrs);
    const parentCumScale = new Array<number>(nodes.length).fill(1);
    const nodeCumScale = new Array<number>(nodes.length).fill(1);
    const visited = new Set<number>();
    const propagate = (ni: number, pScale: number): void => {
        if (visited.has(ni)) return;
        visited.add(ni);
        const trs = trsList[ni], n = nodes[ni];
        const nonUniform = Math.max(Math.abs(trs.sx - trs.sy), Math.abs(trs.sy - trs.sz), Math.abs(trs.sx - trs.sz)) >
            1e-4 * Math.max(1, Math.abs(trs.sx), Math.abs(trs.sy), Math.abs(trs.sz));
        const hasNeg = trs.sx <= 0 || trs.sy <= 0 || trs.sz <= 0;
        const hasPhys = Boolean(n.extensions?.KHR_physics_rigid_bodies || n.extensions?.KHR_implicit_shapes);
        if ((hasPhys || (Array.isArray(n.children) && n.children.length > 0)) && (nonUniform || hasNeg)) {
            throw new Error(`KHR node "${n.name ?? ni}" has negative or non-uniform scale`);
        }
        parentCumScale[ni] = pScale;
        const nextScale = pScale * trs.sx;
        nodeCumScale[ni] = nextScale;
        for (const c of n.children ?? []) propagate(c, nextScale);
    };
    for (const r of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) propagate(r, 1);
    for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && !hasParent.has(i)) propagate(i, 1);
    const usedMeshes = new Set<number>(), bakedPos = new Set<number>(), bakedNrm = new Set<number>();
    const posDetIndexRefs = new Set<number>(), flippedIdx = new Map<number, number>();
    const nodeMeshes: number[][] = nodes.map(() => []);
    nodes.forEach((n, ni) => {
        const localMap = new Map<number, number>();
        const claimMesh = (mIdx: unknown, assign: (newIdx: number) => void): void => {
            if (typeof mIdx !== "number" || !Number.isInteger(mIdx) || !meshes[mIdx]) return;
            const existing = localMap.get(mIdx);
            if (existing !== undefined) { assign(existing); return; }
            let target = mIdx;
            if (usedMeshes.has(mIdx)) {
                const orig = meshes[mIdx];
                meshes.push({ ...orig, primitives: (orig.primitives ?? []).map((p: AnyRecord) => ({ ...p, attributes: { ...p.attributes } })) });
                target = meshes.length - 1;
                assign(target);
            } else usedMeshes.add(mIdx);
            localMap.set(mIdx, target);
            nodeMeshes[ni].push(target);
        };
        claimMesh(n.mesh, (idx) => { n.mesh = idx; });
        const khr = n.extensions?.KHR_physics_rigid_bodies;
        claimMesh(khr?.collider?.geometry?.mesh, (idx) => { khr.collider.geometry.mesh = idx; });
        claimMesh(khr?.trigger?.geometry?.mesh, (idx) => { khr.trigger.geometry.mesh = idx; });
        const trs = trsList[ni], pScale = parentCumScale[ni];
        const vsx = scale * pScale * trs.sx, vsy = scale * pScale * trs.sy, vsz = scale * pScale * trs.sz;
        const negDet = vsx * vsy * vsz < 0;
        const needsNormalBake = vsx < 0 || vsy < 0 || vsz < 0 || Math.abs(vsx - vsy) > 1e-6 || Math.abs(vsy - vsz) > 1e-6;
        for (const mIdx of nodeMeshes[ni]) {
            for (const p of meshes[mIdx]?.primitives ?? []) {
                if (!negDet && p.indices !== undefined) posDetIndexRefs.add(p.indices);
                if (!needsNormalBake && p.attributes?.NORMAL !== undefined) bakedNrm.add(p.attributes.NORMAL);
            }
        }
    });
    meshes.forEach((m, mi) => {
        if (usedMeshes.has(mi)) return;
        for (const p of m?.primitives ?? []) {
            if (p.indices !== undefined) posDetIndexRefs.add(p.indices);
            if (p.attributes?.POSITION !== undefined) bakedPos.add(p.attributes.POSITION);
            if (p.attributes?.NORMAL !== undefined) bakedNrm.add(p.attributes.NORMAL);
        }
    });
    const qTurns = quarterTurnsQuaternion(turns);
    const shapeScales = new Map<number, number>(), jointScales = new Map<number, number>();
    const shapes: AnyRecord[] = Array.isArray(gltf.extensions?.KHR_implicit_shapes?.shapes) ? gltf.extensions.KHR_implicit_shapes.shapes : [];
    const joints: AnyRecord[] = Array.isArray(gltf.extensions?.KHR_physics_rigid_bodies?.physicsJoints) ? gltf.extensions.KHR_physics_rigid_bodies.physicsJoints : [];
    const sNodes = nodes.map((_, ni) => scale * nodeCumScale[ni]);
    nodes.forEach((n, ni) => {
        const trs = trsList[ni], pScale = parentCumScale[ni], sNode = sNodes[ni];
        delete n.matrix;
        delete n.scale;
        const isRoot = !hasParent.has(ni);
        const nt: Vec3 = isRoot
            ? (([rx, ry, rz]) => [rx * scale + shift[0], ry * scale + shift[1], rz * scale + shift[2]] as Vec3)(applyQuat(qTurns, trs.t[0], trs.t[1], trs.t[2]))
            : [trs.t[0] * scale * pScale, trs.t[1] * scale * pScale, trs.t[2] * scale * pScale];
        if (trs.hadT || Math.hypot(nt[0], nt[1], nt[2]) > 1e-9) n.translation = nt;
        else delete n.translation;
        const nq = isRoot ? mulQuat(qTurns, trs.q) : trs.q;
        if (Math.hypot(nq[0], nq[1], nq[2], 1 - nq[3]) > 1e-7) n.rotation = nq;
        else delete n.rotation;
        const khrNode = n.extensions?.KHR_physics_rigid_bodies;
        if (khrNode?.motion) {
            const com = khrNode.motion.centerOfMass;
            if (Array.isArray(com) && com.length === 3) khrNode.motion.centerOfMass = [com[0] * sNode, com[1] * sNode, com[2] * sNode];
            const iner = khrNode.motion.inertiaDiagonal;
            if (Array.isArray(iner) && iner.length === 3) {
                const s2 = sNode * sNode;
                khrNode.motion.inertiaDiagonal = [iner[0] * s2, iner[1] * s2, iner[2] * s2];
            }
        }
        scaleIndexedEntry(shapes, khrNode?.collider?.geometry?.shape, sNode, shapeScales, scaleImplicitShape, (idx) => { khrNode.collider.geometry.shape = idx; });
        scaleIndexedEntry(shapes, khrNode?.trigger?.geometry?.shape, sNode, shapeScales, scaleImplicitShape, (idx) => { khrNode.trigger.geometry.shape = idx; });
        scaleIndexedEntry(joints, khrNode?.joint?.joint, sNode, jointScales, scalePhysicsJoint, (idx) => { khrNode.joint.joint = idx; });
        const posMemo = new Map<string, number>(), nrmMemo = new Map<string, number>();
        for (const mIdx of nodeMeshes[ni]) {
            scaleMeshPrimitives(mIdx, meshes, accessors, views, srcBin, srcDv, writer, bakedPos, bakedNrm, posDetIndexRefs, flippedIdx, posMemo, nrmMemo, scale * pScale * trs.sx, scale * pScale * trs.sy, scale * pScale * trs.sz);
        }
    });
    shapes.forEach((sh, idx) => { if (!shapeScales.has(idx)) scaleImplicitShape(sh, scale); });
    joints.forEach((j, idx) => { if (!jointScales.has(idx)) scalePhysicsJoint(j, scale); });
    scaleWheelMetadata(gltf, scale, sNodes);
}
