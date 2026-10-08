'use strict';

// This module belongs to the main process. Never expose its tasks, encrypted
// bytes, or safeStorage methods over IPC; the controller supplies a safe view.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const FILE_NAME = 'pending-deployments.enc';
const MAX_BYTES = 1024 * 1024;
const MAX_TASKS = 100;
const APP_ID = 'com.enoch.gladosquickdeploy.resume';
const WARNINGS = Object.freeze({
  unavailable: '系统安全存储暂不可用，尚未上传的登录信息仅保留到退出；部署进度仍会保存，重启后必要时需重新登录。',
  damaged: '无法读取已有的加密恢复记录，原文件已保留且不会被覆盖。请检查系统钥匙串或账户权限后重试；也可明确清除恢复记录后重新开始。',
  unsafe: '恢复记录路径不是可信的普通文件或目录，已停止读取和写入。现有文件未被改动。',
  invalid: '恢复记录格式或大小超出限制，未写入文件。最多允许 100 项任务和 1 MiB 数据。',
  write: '加密恢复记录未能保存，现有文件已保留。当前进度仍可在本次运行中继续，请检查磁盘空间与目录权限。',
  clear: '未能清除本机恢复记录，请检查目录权限后重试。',
  expired: '部分本地登录会话已过保存期限，已移除登录信息；云端部署及运行进度已保留，可继续核对，必要时再登录。',
});

function problem(kind) { const error = new Error(kind); error.kind = kind; return error; }
function ordinaryTasks(tasks) {
  return Array.isArray(tasks) && tasks.length <= MAX_TASKS && tasks.every(task => task && typeof task === 'object' && !Array.isArray(task));
}
function serialize(tasks) {
  if (!ordinaryTasks(tasks)) throw problem('invalid');
  let text;
  try { text = JSON.stringify({ appId: APP_ID, version: 1, tasks }); } catch { throw problem('invalid'); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw problem('invalid');
  return text;
}
function decode(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw problem('damaged');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw problem('damaged'); }
  if (parsed?.appId !== APP_ID || parsed.version !== 1 || !ordinaryTasks(parsed.tasks)) throw problem('damaged');
  return parsed.tasks;
}

class ResumeStore {
  constructor({ directory, safeStorage, now = Date.now, ttlMs = 7 * 86400000 } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof now !== 'function' || !Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('恢复记录存储参数无效。');
    this.directory = directory;
    this.file = path.join(directory, FILE_NAME);
    this.safeStorage = safeStorage;
    this.now = now;
    this.ttlMs = ttlMs;
    this._loaded = false;
    this._blocked = false;
    this._queue = Promise.resolve();
  }

  // Serialize disk operations so an old save cannot overtake a later clear.
  _exclusive(work) {
    const result = this._queue.then(work, work);
    this._queue = result.then(() => undefined, () => undefined);
    return result;
  }

  load() { return this._exclusive(() => this._load()); }
  save(tasks) {
    // Clone at invocation time: the controller may erase its credential object
    // as soon as the returned promise resolves, or mutate later checkpoints.
    let captured;
    try { captured = decode(serialize(tasks)); }
    catch { return Promise.resolve({ durable: false, warning: WARNINGS.invalid }); }
    return this._exclusive(() => this._save(captured));
  }

  async _provider() {
    const storage = this.safeStorage;
    if (!storage) return null;
    try {
      if (typeof storage.getSelectedStorageBackend === 'function' && storage.getSelectedStorageBackend() === 'basic_text') return null;
      if (typeof storage.encryptStringAsync === 'function' && typeof storage.decryptStringAsync === 'function') {
        const available = typeof storage.isAsyncEncryptionAvailable === 'function'
          ? await storage.isAsyncEncryptionAvailable()
          : typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable();
        if (!available) return null;
        return {
          encrypt: text => storage.encryptStringAsync(text),
          decrypt: async bytes => {
            const decoded = await storage.decryptStringAsync(bytes);
            if (!decoded || decoded.isTemporarilyUnavailable || typeof decoded.result !== 'string') throw problem('damaged');
            return decoded;
          },
        };
      }
      // Older Electron builds only: do not switch to the synchronous provider
      // when the async provider exists but is locked or temporarily unavailable.
      if (typeof storage.isEncryptionAvailable !== 'function' || !storage.isEncryptionAvailable() || typeof storage.encryptString !== 'function' || typeof storage.decryptString !== 'function') return null;
      return { encrypt: text => storage.encryptString(text), decrypt: async bytes => ({ result: storage.decryptString(bytes), shouldReEncrypt: false }) };
    } catch { return null; }
  }

  async _directory(create = false) {
    let info;
    try { info = await fsp.lstat(this.directory); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
      info = await fsp.lstat(this.directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw problem('unsafe');
    return true;
  }

  async _fileInfo() {
    try {
      const info = await fsp.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink()) throw problem('unsafe');
      return info;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  _expire(tasks) {
    let changed = false;
    const current = Number(this.now());
    for (const task of tasks) {
      if (task.credential == null) continue;
      const updated = typeof task.updatedAt === 'number' ? task.updatedAt : typeof task.updatedAt === 'string' ? Date.parse(task.updatedAt) : NaN;
      if (!Number.isFinite(current) || !Number.isFinite(updated) || current - updated >= this.ttlMs) {
        delete task.credential;
        task.needsLogin = true;
        task.credentialExpired = true;
        changed = true;
      }
    }
    return changed;
  }

  async _read() {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    let handle;
    try {
      handle = await fsp.open(this.file, flags);
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw problem('damaged');
      const bytes = await handle.readFile();
      if (bytes.length < 1 || bytes.length > MAX_BYTES) throw problem('damaged');
      return bytes;
    } finally { await handle?.close(); }
  }

  async _write(tasks, provider) {
    const text = serialize(tasks);
    const encrypted = await provider.encrypt(text);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_BYTES) throw problem('invalid');
    await this._directory(true);
    await this._fileInfo();
    const temporary = `${this.file}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    let handle;
    try {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
      handle = await fsp.open(temporary, flags, 0o600);
      await handle.writeFile(encrypted);
      await handle.sync();
      await handle.close();
      handle = null;
      // Recheck the destination immediately before replacing it. rename never
      // follows a destination symlink, and a known one is rejected explicitly.
      await this._directory();
      await this._fileInfo();
      await fsp.rename(temporary, this.file);
    } finally {
      await handle?.close().catch(() => {});
      await fsp.unlink(temporary).catch(() => {});
    }
  }

  async _load() {
    this._loaded = true;
    let exists = false;
    try {
      const directoryExists = await this._directory();
      const info = directoryExists ? await this._fileInfo() : null;
      exists = Boolean(info);
      if (info && (info.size < 1 || info.size > MAX_BYTES)) throw problem('damaged');
      // Even checking provider availability can initialize Keychain access.
      // An empty recovery state needs no key; a later nonempty save still
      // verifies the provider before reporting credentials as durable.
      if (!exists) { this._blocked = false; return { tasks: [], warning: '', durable: true }; }
      const provider = await this._provider();
      if (!provider) {
        this._blocked = exists;
        return { tasks: [], warning: WARNINGS.unavailable, durable: false };
      }
      const decoded = await provider.decrypt(await this._read());
      const tasks = decode(decoded.result);
      this._blocked = false;
      const expired = this._expire(tasks);
      if (expired || decoded.shouldReEncrypt === true) {
        try { await this._write(tasks, provider); }
        catch { return { tasks, warning: `${expired ? `${WARNINGS.expired} ` : ''}${WARNINGS.write}`, durable: false }; }
      }
      return { tasks, warning: expired ? WARNINGS.expired : '', durable: true };
    } catch (error) {
      // A failed read is never interpreted as an empty file eligible for
      // replacement. Only an explicit save([]) can discard such a record.
      this._blocked = true;
      return { tasks: [], warning: error.kind === 'unsafe' ? WARNINGS.unsafe : WARNINGS.damaged, durable: false };
    }
  }

  async _save(tasks) {
    if (tasks.length === 0) {
      try {
        if (await this._directory()) {
          const info = await this._fileInfo();
          if (info) await fsp.unlink(this.file);
        }
        this._loaded = true; this._blocked = false;
        return { durable: true, warning: '' };
      } catch (error) { return { durable: false, warning: error.kind === 'unsafe' ? WARNINGS.unsafe : WARNINGS.clear }; }
    }
    if (!this._loaded || this._blocked) {
      const previous = await this._load();
      if (this._blocked) return { durable: false, warning: previous.warning };
    }
    const provider = await this._provider();
    if (!provider) return { durable: false, warning: WARNINGS.unavailable };
    const expired = this._expire(tasks);
    try {
      await this._write(tasks, provider);
      return { durable: true, warning: expired ? WARNINGS.expired : '' };
    } catch (error) {
      return { durable: false, warning: error.kind === 'unsafe' ? WARNINGS.unsafe : error.kind === 'invalid' ? WARNINGS.invalid : WARNINGS.write };
    }
  }
}

module.exports = { ResumeStore };
