// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRecord = Record<string, any>;

export const scaleNum = (obj: AnyRecord, key: string, f: number): void => {
    if (typeof obj[key] === "number" && Number.isFinite(obj[key])) obj[key] *= f;
};

export function scaleOmiWheel(w: AnyRecord, f: number): void {
    if (!w || typeof w !== "object") return;
    scaleNum(w, "radius", f);
    scaleNum(w, "width", f);
    scaleNum(w, "suspensionTravel", f);
}

export function scaleWheelMetadata(gltf: AnyRecord, scale: number, nodeScales?: number[]): void {
    const omiWheels: AnyRecord[] = Array.isArray(gltf.extensions?.OMI_vehicle_wheel?.wheels)
        ? gltf.extensions.OMI_vehicle_wheel.wheels
        : [];
    const wheelScales = new Map<number, number>();
    const nodes = (gltf.nodes ?? []) as AnyRecord[];
    nodes.forEach((n, ni) => {
        const sNode = nodeScales?.[ni] ?? scale;
        const ec = n.extras?.ecctrlWheel;
        if (ec && typeof ec === "object") {
            scaleNum(ec, "radius", sNode);
            scaleNum(ec, "width", sNode);
            scaleNum(ec, "travel", sNode);
            scaleNum(ec, "sag", sNode);
        }
        const wIdx = n.extensions?.OMI_vehicle_wheel?.wheel;
        scaleIndexedEntry(omiWheels, wIdx, sNode, wheelScales, scaleOmiWheel, (idx) => {
            n.extensions.OMI_vehicle_wheel.wheel = idx;
        });
    });
    omiWheels.forEach((w, idx) => {
        if (!wheelScales.has(idx)) scaleOmiWheel(w, scale);
    });
}

export function scaleImplicitShape(shape: AnyRecord, s: number): void {
    if (shape.type === "box" || shape.box) {
        const box = (shape.box ??= {});
        const sz = Array.isArray(box.size) && box.size.length === 3 ? box.size : [1, 1, 1];
        box.size = [sz[0] * s, sz[1] * s, sz[2] * s];
    }
    if (shape.type === "sphere" || shape.sphere) {
        const sp = (shape.sphere ??= {});
        const r = typeof sp.radius === "number" && Number.isFinite(sp.radius) ? sp.radius : 0.5;
        sp.radius = r * s;
    }
    for (const k of ["cylinder", "capsule"] as const) {
        if (shape.type !== k && !shape[k]) continue;
        const obj = (shape[k] ??= {});
        const defH = k === "cylinder" ? 2.0 : 1.0;
        const h = typeof obj.height === "number" && Number.isFinite(obj.height) ? obj.height : defH;
        const baseR = typeof obj.radius === "number" && Number.isFinite(obj.radius) ? obj.radius : 0.5;
        const rb = typeof obj.radiusBottom === "number" && Number.isFinite(obj.radiusBottom) ? obj.radiusBottom : baseR;
        const rt = typeof obj.radiusTop === "number" && Number.isFinite(obj.radiusTop) ? obj.radiusTop : baseR;
        obj.height = h * s;
        obj.radiusBottom = rb * s;
        obj.radiusTop = rt * s;
        if (typeof obj.radius === "number" && Number.isFinite(obj.radius)) obj.radius *= s;
    }
}

export function scalePhysicsJoint(j: AnyRecord, f: number): void {
    for (const lim of j.limits ?? []) {
        if (Array.isArray(lim.linearAxes) && lim.linearAxes.length > 0) {
            scaleNum(lim, "min", f);
            scaleNum(lim, "max", f);
        }
    }
    for (const drv of j.drives ?? []) {
        if (drv.type === "linear") {
            scaleNum(drv, "positionTarget", f);
            scaleNum(drv, "velocityTarget", f);
        }
    }
}

export function scaleIndexedEntry(
    arr: AnyRecord[],
    idx: unknown,
    sNode: number,
    scaleMap: Map<number, number>,
    scaleFn: (entry: AnyRecord, f: number) => void,
    assign: (newIdx: number) => void,
): void {
    if (typeof idx !== "number" || !Number.isInteger(idx) || !arr[idx]) return;
    const prevScale = scaleMap.get(idx);
    if (prevScale === undefined) {
        scaleMap.set(idx, sNode);
        scaleFn(arr[idx], sNode);
    }
    else if (Math.abs(prevScale - sNode) > 1e-6) {
        const cloned = structuredClone(arr[idx]) as AnyRecord;
        scaleFn(cloned, sNode / prevScale);
        const newIdx = arr.length;
        arr.push(cloned);
        scaleMap.set(newIdx, sNode);
        assign(newIdx);
    }
}
