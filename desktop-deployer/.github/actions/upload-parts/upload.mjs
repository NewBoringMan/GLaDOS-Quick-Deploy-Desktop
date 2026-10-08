import fs from 'node:fs';
import path from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';

const client = new DefaultArtifactClient();
const prefix = process.env.INPUT_PREFIX;
if (!/^[A-Za-z0-9-]+$/.test(prefix || '')) throw new Error('Invalid platform artifact prefix');
const root = path.join(process.env.GITHUB_WORKSPACE, 'desktop-deployer');
const delivery = path.join(root, 'delivery');
const meta = ['manifest.json', 'SHA256SUMS.txt'].map(name => path.join(delivery, name));
for (const name of ['package-lock.json', 'smoke-output/desktop-smoke.json', 'smoke-output/desktop-smoke.png', 'smoke-output/recovery-smoke.png', 'smoke-output/multi-account-smoke.png']) {
  const file = path.join(root, name); if (fs.existsSync(file)) meta.push(file);
}
await client.uploadArtifact(`${prefix}-metadata`, meta, root, { retentionDays: 30, compressionLevel: 6 });
const parts = fs.readdirSync(delivery).filter(name => /\.part\d+$/.test(name)).sort();
for (let index = 0; index < parts.length; index++) {
  const name = `${prefix}-part-${String(index).padStart(3, '0')}`;
  await client.uploadArtifact(name, [path.join(delivery, parts[index])], delivery, { retentionDays: 30, compressionLevel: 0 });
}
console.log(`Uploaded ${parts.length} bounded-size delivery parts and verification metadata.`);
