import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * An o1js cache that can hold a key larger than 2 GiB.
 *
 * `Cache.FileSystem` writes each entry with one `writeFileSync`, and Node caps a
 * single write at 2,147,483,647 bytes. `FdcLeaf`'s step proving key is
 * 2,613,645,615 — it hashes 1344 bytes at `numChunks: 4` — so the write threw
 * `ERR_OUT_OF_RANGE`, o1js swallowed it (`writeCache` only reports when
 * `debug`), and the entry was left at zero bytes.
 *
 * The header had already been written by then. So every later start found a
 * valid-looking header, read an empty key, and recompiled — 158 s of the cold
 * start, silently, for as long as the process lived.
 *
 * Two changes fix it: slice the write, and write the header **last** so a failed
 * data write leaves the entry absent rather than falsely valid.
 */

/** Comfortably under Node's per-call ceiling, and a round number in a profile. */
const SLICE = 1024 * 1024 * 1024;

type Header = { persistentId: string; uniqueId: string; dataType: 'string' | 'bytes' };

export function chunkedCache(directory: string, debug = false) {
  const log = (...args: unknown[]) => {
    if (debug) console.log('[cache]', ...args);
  };

  return {
    read({ persistentId, uniqueId, dataType }: Header): Uint8Array | undefined {
      const headerPath = join(directory, `${persistentId}.header`);
      const dataPath = join(directory, persistentId);

      try {
        if (!existsSync(headerPath) || !existsSync(dataPath)) return undefined;
        // Written last, so its presence means the data beneath it is complete.
        if (readFileSync(headerPath, 'utf8') !== uniqueId) return undefined;

        if (dataType === 'string') {
          return new TextEncoder().encode(readFileSync(dataPath, 'utf8'));
        }

        const size = statSync(dataPath).size;
        const buffer = Buffer.allocUnsafe(size);
        const fd = openSync(dataPath, 'r');
        try {
          let read = 0;
          while (read < size) {
            const n = readSync(fd, buffer, read, Math.min(SLICE, size - read), read);
            if (n === 0) return undefined;
            read += n;
          }
        } finally {
          closeSync(fd);
        }
        return new Uint8Array(buffer.buffer, buffer.byteOffset, size);
      } catch (e) {
        log('read failed', persistentId, e);
        return undefined;
      }
    },

    write({ persistentId, uniqueId, dataType }: Header, data: Uint8Array): void {
      mkdirSync(directory, { recursive: true });
      const headerPath = join(directory, `${persistentId}.header`);
      const dataPath = join(directory, persistentId);

      // Drop any previous header first: between here and the last line, this
      // entry must read as absent rather than as some earlier version.
      rmSync(headerPath, { force: true });

      if (dataType === 'string') {
        writeFileSync(dataPath, data, { encoding: 'utf8' });
      } else {
        const fd = openSync(dataPath, 'w');
        try {
          let written = 0;
          while (written < data.length) {
            written += writeSync(fd, data, written, Math.min(SLICE, data.length - written));
          }
        } finally {
          closeSync(fd);
        }
      }

      writeFileSync(headerPath, uniqueId, { encoding: 'utf8' });
      log('wrote', persistentId, data.length);
    },

    canWrite: true,
    debug,
  };
}
