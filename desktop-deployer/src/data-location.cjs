'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicJSON, readJSON } = require('./report-vault.cjs');

function selectDataDirectory({ standard, platform = process.platform, external = '/Volumes/MacData/Applications/GLaDOSQuickDeploy/Data', externalVolume = '/Volumes/MacData' }) {
  if (!path.isAbsolute(standard)) throw new Error('系统数据目录无效。');
  const locator = path.join(standard, 'data-location.v1.json');
  const previous = readJSON(locator, null);
  let selected;
  if (previous) {
    if (previous.version !== 1 || typeof previous.directory !== 'string' || !path.isAbsolute(previous.directory)) throw new Error('数据位置记录异常，未建立空账号库。');
    selected = previous.directory;
    if (!fs.existsSync(selected)) throw new Error('原账号数据目录暂时不可用，请连接原磁盘后重新打开。程序没有切换到空目录。');
  } else {
    const mounted = platform === 'darwin' && fs.existsSync(externalVolume);
    const oldStandard = fs.existsSync(path.join(standard, 'deployment-state.json'));
    const oldExternal = mounted && fs.existsSync(path.join(external, 'deployment-state.json'));
    if (oldStandard && oldExternal && path.resolve(standard) !== path.resolve(external)) {
      const a = fs.readFileSync(path.join(standard, 'deployment-state.json'));
      const b = fs.readFileSync(path.join(external, 'deployment-state.json'));
      if (!a.equals(b)) throw new Error('发现两个不同的旧账号数据目录，未自动覆盖或合并。请保留两个 Data 位置并先核对。');
    }
    selected = oldExternal ? external : oldStandard ? standard : mounted ? external : standard;
    fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
  }
  fs.accessSync(selected, fs.constants.R_OK | fs.constants.W_OK);
  // This tiny location pointer stays under the OS user-data root. Account data
  // and the report key remain in the chosen directory, outside the application.
  if (!previous) atomicJSON(locator, { version: 1, directory: selected });
  return selected;
}
module.exports = { selectDataDirectory };
