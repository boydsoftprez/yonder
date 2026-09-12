// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach, expect, it, vi} from 'vitest';
const observation = vi.hoisted(() => ({opens: [] as string[], mount: '1 0 8:1 / / rw - ext4 /dev/test rw\n'}));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {...fs,
    readFile: (...args: any[]) => args[0] === '/proc/self/mountinfo' ? Promise.resolve(observation.mount) : (fs.readFile as any)(...args),
    open: (...args: any[]) => { observation.opens.push(String(args[0])); return (fs.open as any)(...args); },
  };
});
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {probeTerrainStorage} from './storage.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); observation.opens=[]; });
it('verifies writes explicitly once while subsequent admission/status observations are read-only', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'terrain-observation-'))); roots.push(root);
  expect(await probeTerrainStorage(root, true)).toMatchObject({persistent:true,writable:true});
  expect(observation.opens.filter(path=>path.includes('.write-probe-'))).toHaveLength(1);
  observation.opens=[];
  for(let index=0;index<3;index++)expect(await probeTerrainStorage(root, false)).toMatchObject({persistent:true,writable:true});
  expect(observation.opens).toEqual([]);
});
