export type QuarterTurn = 0 | 1 | 2 | 3;
export type GateTurns = readonly [QuarterTurn, QuarterTurn, QuarterTurn];
export type Mat4 = readonly [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number
];

export const IDENT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function quarterTurnsQuaternion(turns: GateTurns): [number, number, number, number] {
    const hx = (turns[0] * Math.PI) / 4;
    const hy = (turns[1] * Math.PI) / 4;
    const hz = (turns[2] * Math.PI) / 4;
    const cx = Math.cos(hx);
    const sx = Math.sin(hx);
    const cy = Math.cos(hy);
    const sy = Math.sin(hy);
    const cz = Math.cos(hz);
    const sz = Math.sin(hz);
    return [
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    ];
}

export function trsToMat4(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
    const [x, y, z, w] = q;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const [sx, sy, sz] = s;
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        t[0], t[1], t[2], 1,
    ];
}

export function mulMat4(a: Mat4, b: Mat4): Mat4 {
    const out = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] =
                a[r] * b[c * 4] +
                a[4 + r] * b[c * 4 + 1] +
                a[8 + r] * b[c * 4 + 2] +
                a[12 + r] * b[c * 4 + 3];
        }
    }
    return out as unknown as Mat4;
}

export function applyPos(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
}

export function det3x3(m: Mat4): number {
    const c00 = m[5] * m[10] - m[9] * m[6];
    const c01 = m[9] * m[2] - m[1] * m[10];
    const c02 = m[1] * m[6] - m[5] * m[2];
    return m[0] * c00 + m[4] * c01 + m[8] * c02;
}

export function applyNormalInvTranspose(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    const c00 = m[5] * m[10] - m[9] * m[6];
    const c01 = m[9] * m[2] - m[1] * m[10];
    const c02 = m[1] * m[6] - m[5] * m[2];
    const c10 = m[8] * m[6] - m[4] * m[10];
    const c11 = m[0] * m[10] - m[8] * m[2];
    const c12 = m[4] * m[2] - m[0] * m[6];
    const c20 = m[4] * m[9] - m[8] * m[5];
    const c21 = m[8] * m[1] - m[0] * m[9];
    const c22 = m[0] * m[5] - m[4] * m[1];
    const sgn = m[0] * c00 + m[4] * c01 + m[8] * c02 < 0 ? -1 : 1;
    let nx = sgn * (c00 * x + c01 * y + c02 * z);
    let ny = sgn * (c10 * x + c11 * y + c12 * z);
    let nz = sgn * (c20 * x + c21 * y + c22 * z);
    let len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) {
        nx = m[0] * x + m[4] * y + m[8] * z;
        ny = m[1] * x + m[5] * y + m[9] * z;
        nz = m[2] * x + m[6] * y + m[10] * z;
        len = Math.hypot(nx, ny, nz) || 1;
    }
    return [nx / len, ny / len, nz / len];
}

export function extractRotationQuat(m: Mat4): [number, number, number, number] {
    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    if (sx < 1e-12 || sy < 1e-12 || sz < 1e-12)
        return [0, 0, 0, 1];
    if (det3x3(m) < 0)
        sx = -sx;
    const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
    const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
    const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
    const tr = r00 + r11 + r22;
    let x: number, y: number, z: number, w: number;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = 0.25 * s;
        x = (r21 - r12) / s;
        y = (r02 - r20) / s;
        z = (r10 - r01) / s;
    }
    else if (r00 > r11 && r00 > r22) {
        const s = Math.sqrt(Math.max(0, 1 + r00 - r11 - r22)) * 2;
        w = (r21 - r12) / s;
        x = 0.25 * s;
        y = (r10 + r01) / s;
        z = (r02 + r20) / s;
    }
    else if (r11 > r22) {
        const s = Math.sqrt(Math.max(0, 1 + r11 - r00 - r22)) * 2;
        w = (r02 - r20) / s;
        x = (r10 + r01) / s;
        y = 0.25 * s;
        z = (r21 + r12) / s;
    }
    else {
        const s = Math.sqrt(Math.max(0, 1 + r22 - r00 - r11)) * 2;
        w = (r10 - r01) / s;
        x = (r02 + r20) / s;
        y = (r21 + r12) / s;
        z = 0.25 * s;
    }
    const len = Math.hypot(x, y, z, w) || 1;
    const sgn = w < 0 ? -1 / len : 1 / len;
    return [x * sgn, y * sgn, z * sgn, w * sgn];
}

export function mulQuat(a: readonly [number, number, number, number], b: readonly [number, number, number, number]): [number, number, number, number] {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    const x = aw * bx + ax * bw + ay * bz - az * by;
    const y = aw * by - ax * bz + ay * bw + az * bx;
    const z = aw * bz + ax * by - ay * bx + az * bw;
    const w = aw * bw - ax * bx - ay * by - az * bz;
    const len = Math.hypot(x, y, z, w) || 1;
    const s = w < 0 ? -1 / len : 1 / len;
    return [x * s, y * s, z * s, w * s];
}

export function applyQuat(q: readonly [number, number, number, number], x: number, y: number, z: number): [number, number, number] {
    const [qx, qy, qz, qw] = q;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return [
        ix * qw + iw * -qx + iy * -qz - iz * -qy,
        iy * qw + iw * -qy + iz * -qx - ix * -qz,
        iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
}
