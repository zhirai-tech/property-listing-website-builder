/**
 * ZIP 读取（仅支持 STORE 存储模式）。
 *
 * 与 util/zip.ts 配对：本项目的备份归档由 createZip 生成，
 * 全部使用 STORE，因此读取端只需处理这一种情况即可完成「备份可恢复」的验证。
 */

export interface ZipReadEntry {
  path: string;
  data: Uint8Array;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

function u16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function u32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16) | ((data[offset + 3] ?? 0) << 24)) >>> 0
  );
}

/**
 * 读取 STORE 模式的 ZIP。
 * 遇到压缩条目（method = 8）会明确报错，而不是静默返回损坏数据。
 */
export function readZip(data: Uint8Array): ZipReadEntry[] {
  const decoder = new TextDecoder('utf-8');
  const entries: ZipReadEntry[] = [];

  // 定位中央目录结尾记录（EOCD）
  let eocd = -1;
  for (let i = data.length - 22; i >= 0; i -= 1) {
    if (u32(data, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('不是有效的 ZIP 文件：未找到中央目录结尾记录');

  const entryCount = u16(data, eocd + 10);
  let cursor = u32(data, eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (u32(data, cursor) !== 0x02014b50) {
      throw new ZipFormatError(`中央目录第 ${index + 1} 条记录签名不正确`);
    }

    const method = u16(data, cursor + 10);
    const compressedSize = u32(data, cursor + 20);
    const nameLength = u16(data, cursor + 28);
    const extraLength = u16(data, cursor + 30);
    const commentLength = u16(data, cursor + 32);
    const localOffset = u32(data, cursor + 42);

    const name = decoder.decode(data.subarray(cursor + 46, cursor + 46 + nameLength));

    if (method !== 0) {
      throw new ZipFormatError(`条目不支持：${name} 使用了压缩方法 ${method}，本读取器仅支持 STORE`);
    }

    // 从本地文件头取数据起点（本地头的名称/扩展长度可能与中央目录不同）
    if (u32(data, localOffset) !== 0x04034b50) {
      throw new ZipFormatError(`条目 ${name} 的本地文件头签名不正确`);
    }
    const localNameLength = u16(data, localOffset + 26);
    const localExtraLength = u16(data, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      path: name,
      data: data.subarray(dataStart, dataStart + compressedSize),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}