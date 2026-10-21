/**
 * 极简 ZIP 打包器（仅存储模式，不压缩）。
 *
 * 方案第 3 阶段要求导出 HTML 页面及所需静态资源；为了不引入第三方压缩库，
 * 这里实现 ZIP 的最小可用子集：
 *  - 使用 STORE 方法（不压缩），图片与视频本身已是压缩格式，收益有限；
 *  - UTF-8 文件名标志位（0x0800），保证中文文件名正确；
 *  - 结果可用系统自带解压工具打开。
 */

export interface ZipEntry {
  /** 归档内的路径，使用 / 分隔 */
  path: string;
  data: Uint8Array;
  /** 文件修改时间，默认当前时间 */
  date?: Date;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 转换 DOS 时间/日期格式 */
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2) & 0x1f) << 0);
  const d =
    (((Math.max(date.getFullYear(), 1980) - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    ((date.getDate() & 0x1f) << 0);
  return { time, date: d };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]));
  }

  bytes(value: Uint8Array): void {
    this.push(value);
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  get size(): number {
    return this.length;
  }
}

export interface ZipResult {
  data: Uint8Array;
  entryCount: number;
  totalBytes: number;
}

/** 生成 ZIP 归档 */
export function createZip(entries: readonly ZipEntry[]): ZipResult {
  const encoder = new TextEncoder();
  const local = new ByteWriter();
  const central = new ByteWriter();

  let totalBytes = 0;
  const offsets: number[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path.replace(/\\/g, '/'));
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.date ?? new Date());
    offsets.push(local.size);

    // 本地文件头
    local.u32(0x04034b50);
    local.u16(20); // version needed
    local.u16(0x0800); // UTF-8 文件名
    local.u16(0); // method = store
    local.u16(time);
    local.u16(date);
    local.u32(crc);
    local.u32(entry.data.length);
    local.u32(entry.data.length);
    local.u16(nameBytes.length);
    local.u16(0); // extra length
    local.bytes(nameBytes);
    local.bytes(entry.data);

    totalBytes += entry.data.length;
  }

  // 中央目录
  entries.forEach((entry, index) => {
    const nameBytes = encoder.encode(entry.path.replace(/\\/g, '/'));
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.date ?? new Date());

    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(time);
    central.u16(date);
    central.u32(crc);
    central.u32(entry.data.length);
    central.u32(entry.data.length);
    central.u16(nameBytes.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(offsets[index] ?? 0);
    central.bytes(nameBytes);
  });

  const centralBytes = central.concat();
  const localBytes = local.concat();

  const end = new ByteWriter();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(centralBytes.length);
  end.u32(localBytes.length);
  end.u16(0);

  const out = new ByteWriter();
  out.bytes(localBytes);
  out.bytes(centralBytes);
  out.bytes(end.concat());

  return { data: out.concat(), entryCount: entries.length, totalBytes };
}