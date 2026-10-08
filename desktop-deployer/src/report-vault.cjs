'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function readJSON(file, fallback = {}) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4 * 1024 * 1024) throw new Error('数据文件不符合安全要求，未覆盖原文件。');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function keyId(publicKey) { return crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 32); }
function validReporting(report) {
  if (!report || typeof report.publicKey !== 'string' || report.publicKey.length > 4000 || report.keyId !== keyId(report.publicKey)) throw new Error('云端报告公钥不符合预期。');
  const key = crypto.createPublicKey(report.publicKey);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072) throw new Error('云端报告公钥不符合预期。');
  return { keyId: report.keyId, publicKey: report.publicKey };
}
class ReportVault {
  constructor({ directory, safeStorage }) { this.directory = directory; this.safeStorage = safeStorage; this.cache = new Map(); this.file = path.join(directory, 'report-keys.v1.json'); }
  async available() {
    if (typeof this.safeStorage?.isAsyncEncryptionAvailable === 'function') return this.safeStorage.isAsyncEncryptionAvailable();
    return Boolean(this.safeStorage?.isEncryptionAvailable());
  }
  async encrypt(value) {
    if (typeof this.safeStorage?.encryptStringAsync === 'function') return this.safeStorage.encryptStringAsync(value);
    return this.safeStorage.encryptString(value);
  }
  async ensure(reporting) {
    if (reporting) return validReporting(reporting); // Do not rotate another device's key.
    const records = readJSON(this.file, { version: 1, keys: {} });
    if (records.version !== 1 || !records.keys || typeof records.keys !== 'object') throw new Error('报告密钥格式不兼容，原文件已保留。');
    const existing = Object.values(records.keys)[0];
    if (existing) return validReporting(existing);
    if (!await this.available()) throw new Error('系统安全存储尚不可用，请完成系统授权后再升级云端配置。');
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const id = keyId(pair.publicKey);
    const encrypted = await this.encrypt(pair.privateKey);
    const record = { keyId: id, publicKey: pair.publicKey, encryptedPrivateKey: encrypted.toString('base64') };
    atomicJSON(this.file, { version: 1, keys: { ...records.keys, [id]: record } });
    const verify = readJSON(this.file);
    if (verify.keys?.[id]?.encryptedPrivateKey !== record.encryptedPrivateKey) throw new Error('报告密钥写入未验证，未修改云端。');
    this.cache.set(id, crypto.createPrivateKey(pair.privateKey)); pair.privateKey = '';
    return { keyId: id, publicKey: pair.publicKey };
  }
  async unlock(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const records = readJSON(this.file, { version: 1, keys: {} });
    const record = records.keys?.[id];
    if (!record) throw Object.assign(new Error('此设备没有该部署的报告密钥；签到与设置仍可管理，详细信息需原数据目录。'), { code: 'REPORT_KEY_MISSING' });
    validReporting(record);
    if (!await this.available()) throw new Error('系统安全存储未授权，无法读取加密报告。');
    let plaintext;
    try {
      if (typeof this.safeStorage?.decryptStringAsync === 'function') {
        const restored = await this.safeStorage.decryptStringAsync(Buffer.from(record.encryptedPrivateKey, 'base64'));
        plaintext = restored.result;
      } else plaintext = this.safeStorage.decryptString(Buffer.from(record.encryptedPrivateKey, 'base64'));
      if (typeof plaintext !== 'string') throw new Error('Invalid native key response');
      const privateKey = crypto.createPrivateKey(plaintext);
      const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
      if (keyId(pub) !== id) throw new Error('Invalid key pair');
      this.cache.set(id, privateKey); return privateKey;
    } catch { throw new Error('系统无法恢复报告密钥，未删除或重新生成原密钥。'); }
    finally { plaintext = ''; }
  }
  async decrypt(envelope, { repository, runId, accountKey }) {
    if (!envelope || envelope.schemaVersion !== 1 || envelope.algorithm !== 'RSA-OAEP-SHA256+A256GCM' || !/^[a-f0-9]{32}$/.test(envelope.keyId || '')) throw new Error('报告格式无效。');
    for (const name of ['aad', 'iv', 'tag', 'wrappedKey', 'ciphertext']) if (typeof envelope[name] !== 'string' || envelope[name].length > 512 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(envelope[name])) throw new Error('报告内容无效。');
    const aad = Buffer.from(JSON.stringify([repository, String(runId), accountKey]), 'utf8');
    if (!Buffer.from(envelope.aad, 'base64').equals(aad)) throw new Error('报告与账号或运行编号不匹配。');
    const key = crypto.privateDecrypt({ key: await this.unlock(envelope.keyId), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64'));
    try {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const bytes = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]);
      if (bytes.length > 256 * 1024) throw new Error('报告超过大小限制。');
      const details = JSON.parse(bytes.toString('utf8')); bytes.fill(0);
      if (details.repository !== repository || String(details.runId) !== String(runId) || details.accountKey !== accountKey) throw new Error('报告身份不匹配。');
      return details;
    } finally { key.fill(0); }
  }
  clear() { this.cache.clear(); }
}
module.exports = { ReportVault, atomicJSON, readJSON, validReporting, keyId };
