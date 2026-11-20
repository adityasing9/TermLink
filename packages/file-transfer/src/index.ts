import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  TermLinkError,
  resolveSafeDownloadPath,
  sanitizeFilename,
} from '../../core/src/index';
import { FILE_CHUNK_SIZE } from '../../protocol/src/index';

export interface FileMetadata {
  transferId: string;
  filename: string;
  size: number;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
}

export interface TransferProgress {
  transferId: string;
  filename: string;
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  speedBytesPerSec: number;
  etaSeconds: number;
  chunkIndex: number;
  totalChunks: number;
  status: 'offering' | 'transferring' | 'paused' | 'verifying' | 'completed' | 'cancelled' | 'rejected' | 'failed';
}

export interface TransferHistoryEntry {
  transferId: string;
  direction: 'send' | 'receive';
  filename: string;
  size: number;
  peerName: string;
  sha256: string;
  verified: boolean;
  status: TransferProgress['status'];
  savedPath?: string;
  completedAt: number;
}

/**
 * Computes SHA-256 of a file using streaming I/O (never loads full file into RAM).
 */
export async function computeFileSha256(filePath: string): Promise<{ sha256: string; size: number }> {
  const stat = await fs.promises.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new TermLinkError('SYMLINK_REJECTED', 'Refusing to transfer symbolic link directly for security.');
  }
  if (!stat.isFile()) {
    throw new TermLinkError('NOT_A_FILE', 'Path must point to a regular file.');
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: FILE_CHUNK_SIZE });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size: stat.size }));
  });
}

export function sha256Buffer(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Prepares file offer metadata safely using streaming hash calculation.
 */
export async function prepareFileOffer(
  filePath: string,
  maxFileSizeBytes: number = 2 * 1024 * 1024 * 1024
): Promise<FileMetadata> {
  const { sha256, size } = await computeFileSha256(filePath);
  if (size > maxFileSizeBytes) {
    throw new TermLinkError(
      'FILE_TOO_LARGE',
      `File exceeds configured limit of ${maxFileSizeBytes} bytes.`
    );
  }
  const baseName = path.basename(filePath);
  const check = sanitizeFilename(baseName);
  if (!check.safe) {
    throw new TermLinkError('INVALID_FILENAME', check.reason || 'Filename is not safe.');
  }

  const totalChunks = Math.max(1, Math.ceil(size / FILE_CHUNK_SIZE));
  return {
    transferId: `ft_${crypto.randomBytes(10).toString('hex')}`,
    filename: check.filename,
    size,
    sha256,
    chunkSize: FILE_CHUNK_SIZE,
    totalChunks,
  };
}

/**
 * Resolves a non-overwriting destination path inside downloadDir.
 * Never silently overwrites existing files — appends (1), (2), etc.
 */
export function resolveConflictFreePath(downloadDir: string, rawFilename: string): string {
  fs.mkdirSync(downloadDir, { recursive: true });
  const safePath = resolveSafeDownloadPath(downloadDir, rawFilename);
  if (!fs.existsSync(safePath)) {
    return safePath;
  }

  const dir = path.dirname(safePath);
  const ext = path.extname(safePath);
  const stem = path.basename(safePath, ext);
  for (let i = 1; i <= 9999; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new TermLinkError('FILENAME_CONFLICT', 'Could not allocate unique destination filename.');
}

/**
 * Streams a file in fixed-size chunks with checksum per chunk, pause/resume/cancel,
 * and backpressure (awaits `onChunk` acknowledgement before reading the next chunk).
 */
export class StreamingFileSender {
  private paused = false;
  private cancelled = false;
  private resumeResolvers: Array<() => void> = [];

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const resolvers = this.resumeResolvers.splice(0);
    for (const r of resolvers) r();
  }

  cancel(): void {
    this.cancelled = true;
    this.resume();
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => this.resumeResolvers.push(resolve));
  }

  async send(params: {
    filePath: string;
    metadata: FileMetadata;
    startFromChunk?: number;
    onChunk: (chunkIndex: number, totalChunks: number, chunkSha256: string, dataBase64: string) => Promise<void>;
    onProgress?: (progress: TransferProgress) => void;
  }): Promise<{ completed: boolean; cancelled: boolean }> {
    const fd = await fs.promises.open(params.filePath, 'r');
    const startChunk = Math.max(0, params.startFromChunk ?? 0);
    const startTime = Date.now();
    let bytesSent = startChunk * params.metadata.chunkSize;

    try {
      const buf = Buffer.allocUnsafe(params.metadata.chunkSize);
      for (let idx = startChunk; idx < params.metadata.totalChunks; idx++) {
        await this.waitIfPaused();
        if (this.cancelled) {
          return { completed: false, cancelled: true };
        }

        const offset = idx * params.metadata.chunkSize;
        const remaining = Math.max(0, params.metadata.size - offset);
        const toRead = Math.min(params.metadata.chunkSize, remaining);
        let slice: Buffer;
        if (toRead === 0) {
          slice = Buffer.alloc(0);
        } else {
          const { bytesRead } = await fd.read(buf, 0, toRead, offset);
          slice = buf.subarray(0, bytesRead);
        }

        const chunkHash = sha256Buffer(slice);
        await params.onChunk(idx, params.metadata.totalChunks, chunkHash, slice.toString('base64'));
        bytesSent += slice.length;

        if (params.onProgress) {
          const elapsedSec = Math.max(0.05, (Date.now() - startTime) / 1000);
          const speed = bytesSent / elapsedSec;
          const leftBytes = Math.max(0, params.metadata.size - bytesSent);
          params.onProgress({
            transferId: params.metadata.transferId,
            filename: params.metadata.filename,
            bytesTransferred: bytesSent,
            totalBytes: params.metadata.size,
            percent: params.metadata.size === 0 ? 100 : Math.min(100, Math.round((bytesSent / params.metadata.size) * 100)),
            speedBytesPerSec: speed,
            etaSeconds: speed > 0 ? Math.ceil(leftBytes / speed) : 0,
            chunkIndex: idx + 1,
            totalChunks: params.metadata.totalChunks,
            status: 'transferring',
          });
        }
      }
      return { completed: true, cancelled: false };
    } finally {
      await fd.close();
    }
  }
}

/**
 * Receives chunked files into a `.part` staging file, verifies every chunk SHA-256,
 * verifies full-file SHA-256 on completion, and atomically moves into a conflict-free path.
 */
export class StreamingFileReceiver {
  public readonly transferId: string;
  public readonly filename: string;
  public readonly expectedSize: number;
  public readonly expectedSha256: string;
  public readonly totalChunks: number;

  private readonly finalPath: string;
  private readonly tempPath: string;
  private readonly writeStream: fs.WriteStream;
  private readonly fileHash = crypto.createHash('sha256');
  private receivedChunks = 0;
  private bytesReceived = 0;
  private readonly startedAt = Date.now();
  private closed = false;

  constructor(params: {
    transferId: string;
    filename: string;
    expectedSize: number;
    expectedSha256: string;
    totalChunks: number;
    downloadDir: string;
  }) {
    this.transferId = params.transferId;
    this.filename = params.filename;
    this.expectedSize = params.expectedSize;
    this.expectedSha256 = params.expectedSha256;
    this.totalChunks = params.totalChunks;

    this.finalPath = resolveConflictFreePath(params.downloadDir, params.filename);
    this.tempPath = `${this.finalPath}.${params.transferId}.part`;
    this.writeStream = fs.createWriteStream(this.tempPath, { mode: 0o600 });
  }

  async writeChunk(chunkIndex: number, chunkSha256: string, dataBase64: string): Promise<TransferProgress> {
    if (this.closed) {
      throw new TermLinkError('TRANSFER_CLOSED', 'Transfer stream is already closed.');
    }
    if (chunkIndex !== this.receivedChunks) {
      throw new TermLinkError('CHUNK_OUT_OF_ORDER', `Expected chunk ${this.receivedChunks}, got ${chunkIndex}.`);
    }

    const data = Buffer.from(dataBase64, 'base64');
    const actualChunkHash = sha256Buffer(data);
    if (actualChunkHash !== chunkSha256) {
      throw new TermLinkError('CHUNK_CHECKSUM_MISMATCH', `Chunk ${chunkIndex} failed SHA-256 integrity check.`);
    }

    this.fileHash.update(data);
    await new Promise<void>((resolve, reject) => {
      const ok = this.writeStream.write(data, (err) => {
        if (err) reject(err);
      });
      if (ok) {
        resolve();
      } else {
        this.writeStream.once('drain', resolve);
      }
    });

    this.receivedChunks += 1;
    this.bytesReceived += data.length;

    const elapsedSec = Math.max(0.05, (Date.now() - this.startedAt) / 1000);
    const speed = this.bytesReceived / elapsedSec;
    const leftBytes = Math.max(0, this.expectedSize - this.bytesReceived);

    return {
      transferId: this.transferId,
      filename: this.filename,
      bytesTransferred: this.bytesReceived,
      totalBytes: this.expectedSize,
      percent: this.expectedSize === 0 ? 100 : Math.min(100, Math.round((this.bytesReceived / this.expectedSize) * 100)),
      speedBytesPerSec: speed,
      etaSeconds: speed > 0 ? Math.ceil(leftBytes / speed) : 0,
      chunkIndex: this.receivedChunks,
      totalChunks: this.totalChunks,
      status: 'transferring',
    };
  }

  async finalize(): Promise<{ verified: boolean; savedPath: string; actualSha256: string }> {
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    const actualSha256 = this.fileHash.digest('hex');
    if (actualSha256 !== this.expectedSha256) {
      await fs.promises.unlink(this.tempPath).catch(() => {});
      return { verified: false, savedPath: '', actualSha256 };
    }

    await fs.promises.rename(this.tempPath, this.finalPath);
    return { verified: true, savedPath: this.finalPath, actualSha256 };
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.writeStream.destroy();
    await fs.promises.unlink(this.tempPath).catch(() => {});
  }
}
