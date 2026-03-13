export function downsample48To16(buffer: Buffer): Buffer {
    const outLength = Math.floor(buffer.length / 3);
    const adjustedLength = outLength % 2 === 0 ? outLength : outLength - 1;
    const outBuffer = Buffer.allocUnsafe(adjustedLength);

    let outIdx = 0;
    for (let i = 0; i < buffer.length - 1; i += 6) {
        outBuffer.writeInt16LE(buffer.readInt16LE(i), outIdx);
        outIdx += 2;
    }
    return outBuffer.subarray(0, outIdx);
}

export function upsample24MonoTo48Stereo(input: Buffer): Buffer {
    const safeLength = input.length - (input.length % 2);
    const out = Buffer.allocUnsafe(safeLength * 4);
    let outIdx = 0;
    for (let i = 0; i < safeLength; i += 2) {
        const sample = input.readInt16LE(i);
        out.writeInt16LE(sample, outIdx);
        out.writeInt16LE(sample, outIdx + 2);
        out.writeInt16LE(sample, outIdx + 4);
        out.writeInt16LE(sample, outIdx + 6);
        outIdx += 8;
    }
    return out;
}