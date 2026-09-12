// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27/28: the daemon's trusted HTTP boundary, durable store and router UDP path work together.
import {createSocket, type Socket} from 'node:dgram';
import {readFileSync} from 'node:fs';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {common, minimal, standard, MavLinkProtocolV2, type MavLinkData} from 'node-mavlink';
import {afterEach, describe, expect, it} from 'vitest';
import {saveConfig} from '../../config/save.js';
import {ADMIN_PASSWORD_SECRET} from '../../console/credential.js';
import {hashPassword} from '../../console/password.js';
import {decodeDatagram} from '../../mav/protocol.js';
import type {OpenPort} from '../../mav/detect.js';
import type {CounterReader} from '../../net/reach/counters.js';
import type {CommandRunner} from '../../net/runner.js';
import {DEFAULT_CONFIG, type Config} from '../../schema/config.js';
import {SecretStore} from '../../secrets/store.js';
import {startServer} from '../../daemon/server.js';
import {acquireOfficialTile} from './provider.js';

const HGT_SAMPLES = 3601;
const HGT_BYTES = HGT_SAMPLES * HGT_SAMPLES * 2;
const roots: string[] = [];

interface ReferenceManifest {
  request: {originE7: {lat: number; lon: number}; spacingM: 30};
  realWindows: Array<{file: string; coversSubgridBit: number; originalRowStart: number;
    originalColumnStart: number; rows: number; columns: number}>;
  expected: {subgrids: Array<{bit: number; heightsM: number[]}>};
}

const reference = JSON.parse(readFileSync(
  new URL('./fixtures/expected.json', import.meta.url), 'utf8',
)) as ReferenceManifest;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A valid single-member ZIP around a full HGT; zeros outside copied real windows are synthetic. */
function terrainArchive(): Buffer {
  const raw = Buffer.alloc(HGT_BYTES);
  for (const window of reference.realWindows) {
    const bytes = readFileSync(new URL(`./fixtures/${window.file}`, import.meta.url));
    for (let row = 0; row < window.rows; row += 1) {
      const width = window.columns * 2;
      bytes.copy(raw, ((window.originalRowStart + row) * HGT_SAMPLES + window.originalColumnStart) * 2,
        row * width, (row + 1) * width);
    }
  }
  const name = Buffer.from('N35W084.hgt');
  const packed = deflateRawSync(raw);
  const checksum = crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}

async function freePort(): Promise<number> {
  const socket = createSocket('udp4');
  const port = await new Promise<number>(resolve => {
    socket.bind({address: '127.0.0.1', port: 0}, () => resolve(socket.address().port));
  });
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

async function eventually<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let turn = 0; turn < 4_000 && !ready(value); turn += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 1));
    value = await read();
  }
  expect(ready(value), JSON.stringify(value)).toBe(true);
  return value;
}

function call(socketPath: string, method: string, path: string, body?: unknown): Promise<{status: number; body: any}> {
  return new Promise((resolve, reject) => {
    const req = request({socketPath, method, path}, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined});
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

class RouterPeer {
  private socket: Socket = createSocket('udp4');
  private protocol = new MavLinkProtocolV2(1, 1);
  private sequence = 0;
  received: Uint8Array[] = [];

  async open(): Promise<void> {
    this.socket.on('message', bytes => this.received.push(new Uint8Array(bytes)));
    await new Promise<void>(resolve => this.socket.bind({address: '127.0.0.1', port: 0}, resolve));
  }
  async send(port: number, message: MavLinkData): Promise<void> {
    const bytes = this.protocol.serialize(message, this.sequence++ & 255);
    await new Promise<void>((resolve, reject) => {
      this.socket.send(bytes, port, '127.0.0.1', error => error ? reject(error) : resolve());
    });
  }
  frames() { return this.received.flatMap(bytes => decodeDatagram(bytes)); }
  clear(): void { this.received.splice(0); }
  async close(): Promise<void> { await new Promise<void>(resolve => this.socket.close(() => resolve())); }
}

function heartbeat(): minimal.Heartbeat {
  return Object.assign(new minimal.Heartbeat(), {autopilot: 3, type: 1, baseMode: 0, systemStatus: 4, mavlinkVersion: 3});
}

async function supplyControllerObservations(peer: RouterPeer, port: number): Promise<void> {
  await peer.send(port, Object.assign(new standard.AutopilotVersion(), {
    capabilities: 512n, flightSwVersion: 0x040701ff,
  }));
  for (const [paramId, paramValue] of [
    ['TERRAIN_ENABLE', 1], ['TERRAIN_OPTIONS', 2], ['TERRAIN_SPACING', 30], ['RALLY_TOTAL', 0],
  ] as const) await peer.send(port, Object.assign(new common.ParamValue(), {paramId, paramValue}));
}

function terrainRequest(bit: number, lat = reference.request.originE7.lat, lon = reference.request.originE7.lon): common.TerrainRequest {
  return Object.assign(new common.TerrainRequest(), {lat, lon, gridSpacing: 30, mask: 1n << BigInt(bit)});
}

describe('official terrain daemon boundary', () => {
  it('prepares through Unix HTTP, serves through the router, and reopens without the upstream', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'yonder-terrain-daemon-')));
    roots.push(base);
    const socketPath = join(base, 'core.sock');
    const configPath = join(base, 'config.yaml');
    const journalPath = join(base, 'apply.json');
    const secretsPath = join(base, 'secrets.yaml');
    const terrainRoot = join(base, 'terrain');
    const confPath = join(base, 'mavlink', 'main.conf');
    const hintPath = join(base, 'mavlink-link.json');
    const loopbackPort = await freePort();
    const archive = terrainArchive();
    const peer = new RouterPeer();
    await peer.open();

    const config: Config = {
      ...DEFAULT_CONFIG,
      terrain: {...DEFAULT_CONFIG.terrain, enabled: true},
      mavlink: {...DEFAULT_CONFIG.mavlink, serial: {device: '/dev/ttyYonderTest', baud: 57600}},
    };
    saveConfig(configPath, config);
    new SecretStore(secretsPath).ensureValue(
      ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"),
    );
    let fetches = 0;
    let upstreamAvailable = true;
    const acquire: typeof acquireOfficialTile = (tile, options) => acquireOfficialTile(tile, {
      ...options,
      fetch: async input => {
        fetches += 1;
        if (!upstreamAvailable) throw new Error('synthetic upstream is offline');
        expect(String(input)).toBe(`https://terrain.ardupilot.org/SRTM1/${tile}.hgt.zip`);
        return new Response(archive);
      },
    });
    let serialOpens = 0;
    const neverOpen: OpenPort = async () => {
      serialOpens += 1;
      throw new Error('a pinned integration link must never open serial');
    };
    const runner: CommandRunner = async argv => argv[0] === 'systemctl'
      ? {code: 0, stdout: argv[1] === 'is-active' ? 'active\n' : '', stderr: ''}
      : {code: 0, stdout: '', stderr: ''};
    const counters: CounterReader = () => null;
    const probe = async () => ({persistent: true, writable: true, freeBytes: 8 * 1024 ** 3,
      filesystem: 'integration-test', reason: null});
    const start = () => startServer({
      socketPath, configPath, journalPath, secretsPath, renderers: [], runner, counters,
      terrain: {root: terrainRoot, probe, acquire},
      mavlink: {open: neverOpen, confPath, hintPath, loopbackPort},
    });

    let server = await start();
    // A connected controller keeps transmitting while an operator download is
    // in progress. A lone initial heartbeat legitimately expires on busy CI.
    const heartbeatErrors: unknown[] = [];
    const heartbeatTimer = setInterval(() => {
      void peer.send(loopbackPort, heartbeat()).catch(error => heartbeatErrors.push(error));
    }, 500);
    try {
      await peer.send(loopbackPort, heartbeat());
      const state = await eventually(
        () => call(socketPath, 'GET', '/cockpit/state'),
        value => value.body?.connected === true && typeof value.body?.identity?.generation === 'string',
      );
      const generation = state.body.identity.generation as string;
      const ready = await eventually(
        () => call(socketPath, 'GET', '/cockpit/terrain-service'),
        value => value.status === 200 && value.body.loading === false && value.body.preparationAllowed === true,
      );
      expect(ready.body.storage).toMatchObject({objects: 0, areas: []});
      expect(serialOpens).toBe(0);
      expect(peer.frames()).toEqual([]);

      const refresh = await call(socketPath, 'POST', '/cockpit/terrain-service/refresh-controller', {
        sessionId: 'trusted-unix-session', vehicleGeneration: generation,
      });
      expect(refresh.status).toBe(200);
      await eventually(() => peer.frames(), frames => frames.length === 5);
      expect(peer.frames().map(frame => frame.data.constructor)).toEqual([
        common.CommandLong, common.ParamRequestRead, common.ParamRequestRead,
        common.ParamRequestRead, common.ParamRequestRead,
      ]);
      peer.clear();
      await supplyControllerObservations(peer, loopbackPort);
      await eventually(
        () => call(socketPath, 'GET', '/cockpit/terrain-service'),
        value => value.body?.controllerRefresh?.state === 'complete' && value.body?.service?.compatible === true,
      );

      const preview = await call(socketPath, 'POST', '/cockpit/terrain-service/preview', {
        sessionId: 'trusted-unix-session', kind: 'manual', name: 'Real reference windows in synthetic tile',
        bufferM: 50, bounds: {south: 35.698, north: 35.706, west: -83.363, east: -83.35},
      });
      expect(preview.status).toBe(200);
      expect(preview.body.coverage.tiles).toEqual(['N35W084']);
      const prepare = await call(socketPath, 'POST', '/cockpit/terrain-service/prepare', {
        sessionId: 'trusted-unix-session', previewId: preview.body.id,
      });
      expect(prepare.status).toBe(200);
      await eventually(
        () => call(socketPath, 'GET', '/cockpit/terrain-service'),
        value => value.body?.coverage?.job?.state === 'complete',
      );
      expect(fetches).toBe(1);
      upstreamAvailable = false;

      const initialConfig = (await call(socketPath, 'GET', '/config')).body as Config;
      const initialPolicy = await call(socketPath, 'GET', '/cockpit/terrain-service/policy');
      expect(initialPolicy).toMatchObject({status: 200, body: {
        policy: {enabled: true, provider: 'ardupilot-srtm1', quotaMiB: 2048},
        revision: expect.stringMatching(/^[a-f0-9]{64}$/), pendingId: null,
        apply: expect.objectContaining({state: expect.any(String)}),
      }});
      const initialRevision = initialPolicy.body.revision as string;
      expect((await call(socketPath, 'POST', '/cockpit/terrain-service/policy/apply', {
        sessionId: 'trusted-unix-session', expectedRevision: initialRevision,
        policy: {enabled: false, provider: 'ardupilot-srtm1', quotaMiB: 2048, sourcePath: '/tmp/not-allowed'},
      })).status).toBe(400);

      const disabled = await call(socketPath, 'POST', '/cockpit/terrain-service/policy/apply', {
        sessionId: 'trusted-unix-session', expectedRevision: initialRevision,
        policy: {enabled: false, provider: 'ardupilot-srtm1', quotaMiB: 2048},
      });
      expect(disabled).toMatchObject({status: 200, body: {id: expect.any(String)}});
      expect(disabled.body).toHaveProperty('expiresAt');
      expect(disabled.body.expiresAt === null || typeof disabled.body.expiresAt === 'number').toBe(true);
      const disabledControl = await call(socketPath, 'GET', '/cockpit/terrain-service/policy');
      expect(disabledControl.body).toMatchObject({
        policy: {enabled: false, provider: 'ardupilot-srtm1', quotaMiB: 2048},
        pendingId: disabled.body.expiresAt === null ? null : disabled.body.id,
      });
      expect((await call(socketPath, 'GET', '/config')).body.network).toEqual(initialConfig.network);
      expect((await call(socketPath, 'POST', '/cockpit/terrain-service/policy/apply', {
        sessionId: 'trusted-unix-session', expectedRevision: initialRevision,
        policy: {enabled: true, provider: 'ardupilot-srtm1', quotaMiB: 2048},
      })).status).toBe(409);
      expect((await call(socketPath, 'POST', '/cockpit/terrain-service/policy/confirm', {
        sessionId: 'trusted-unix-session', id: 'an-unrelated-apply',
      })).status).toBe(409);
      expect((await call(socketPath, 'POST', '/cockpit/terrain-service/policy/revert', {
        sessionId: 'trusted-unix-session', id: 'an-unrelated-apply',
      })).status).toBe(409);
      if (disabled.body.expiresAt === null) {
        expect(disabledControl.body.apply.state).toBe('confirmed');
      } else {
        expect(disabledControl.body.apply).toMatchObject({state: 'pending', id: disabled.body.id});
        expect((await call(socketPath, 'POST', '/cockpit/terrain-service/policy/confirm', {
          sessionId: 'trusted-unix-session', id: disabled.body.id,
        }))).toMatchObject({status: 200, body: {state: 'confirmed'}});
      }

      expect((await call(socketPath, 'GET', '/cockpit/terrain-service/policy')).body.pendingId).toBeNull();
      peer.clear();
      await peer.send(loopbackPort, heartbeat());
      await peer.send(loopbackPort, terrainRequest(0));
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      expect(peer.frames().some(frame => frame.data instanceof common.TerrainData)).toBe(false);
      expect((await call(socketPath, 'GET', '/cockpit/terrain-service')).body.service.enabled).toBe(false);

      const disabledPolicy = await call(socketPath, 'GET', '/cockpit/terrain-service/policy');
      const enabled = await call(socketPath, 'POST', '/cockpit/terrain-service/policy/apply', {
        sessionId: 'trusted-unix-session', expectedRevision: disabledPolicy.body.revision,
        policy: {enabled: true, provider: 'ardupilot-srtm1', quotaMiB: 2048},
      });
      expect(enabled.status).toBe(200);
      if (enabled.body.expiresAt !== null) {
        expect((await call(socketPath, 'POST', '/cockpit/terrain-service/policy/confirm', {
          sessionId: 'trusted-unix-session', id: enabled.body.id,
        })).status).toBe(200);
      }
      await eventually(
        () => call(socketPath, 'GET', '/cockpit/terrain-service'),
        value => value.body?.loading === false && value.body?.service?.enabled === true,
      );
      peer.clear();
      await peer.send(loopbackPort, heartbeat());
      await peer.send(loopbackPort, terrainRequest(0));
      await eventually(
        () => peer.frames(), frames => frames.some(frame => frame.data instanceof common.TerrainData),
      );
      expect(fetches).toBe(1);

      // The browser can now disappear: request handling below uses only the router UDP path.
      peer.clear();
      await peer.send(loopbackPort, heartbeat());
      await peer.send(loopbackPort, Object.assign(new common.TerrainRequest(), {
        lat: reference.request.originE7.lat, lon: reference.request.originE7.lon,
        gridSpacing: 30, mask: (1n << 0n) | (1n << 55n),
      }));
      const terrainFrames = await eventually(
        () => peer.frames().filter(frame => frame.data instanceof common.TerrainData),
        frames => frames.length === 2,
      );
      for (const expected of reference.expected.subgrids) {
        const reply = terrainFrames.find(frame => (frame.data as common.TerrainData).gridbit === expected.bit);
        expect(reply).toMatchObject({system: 254, component: 192});
        expect(reply?.data).toMatchObject({
          lat: reference.request.originE7.lat, lon: reference.request.originE7.lon,
          gridSpacing: 30, gridbit: expected.bit, data: expected.heightsM,
        });
      }
      expect(fetches).toBe(1);

      peer.clear();
      await peer.send(loopbackPort, terrainRequest(0, 360_000_000, -840_000_000));
      await eventually(
        () => call(socketPath, 'GET', '/cockpit/terrain-service'),
        value => value.body?.service?.missing >= 1,
      );
      expect(peer.frames().some(frame => frame.data instanceof common.TerrainData)).toBe(false);
      await peer.send(loopbackPort, terrainRequest(56));
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      expect(peer.frames().some(frame => frame.data instanceof common.TerrainData)).toBe(false);
      expect(fetches).toBe(1);

      await peer.send(loopbackPort, Object.assign(new common.GlobalPositionInt(), {timeBootMs: 100_000}));
      await peer.send(loopbackPort, Object.assign(new common.GlobalPositionInt(), {timeBootMs: 10}));
      peer.clear();
      await peer.send(loopbackPort, heartbeat());
      await peer.send(loopbackPort, terrainRequest(0));
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      expect(peer.frames().some(frame => frame.data instanceof common.TerrainData)).toBe(false);
      expect((await call(socketPath, 'GET', '/cockpit/terrain-service')).body.service.compatible).toBe(false);

      await call(socketPath, 'POST', '/cockpit/terrain-service/refresh-controller', {
        sessionId: 'trusted-unix-session', vehicleGeneration: generation,
      });
      await eventually(() => peer.frames(), frames => frames.length >= 5);
      peer.clear();
      await supplyControllerObservations(peer, loopbackPort);
      await eventually(
        () => call(socketPath, 'GET', '/cockpit/terrain-service'),
        value => value.body?.controllerRefresh?.state === 'complete' && value.body?.service?.compatible === true,
      );

      peer.clear();
      const command = await call(socketPath, 'POST', '/cockpit/command', {
        id: 'terrain-priority-command', sessionId: 'trusted-unix-session', vehicleGeneration: generation,
        confirmed: true, action: {kind: 'immediate', command: 206, params: [0, 0, 0, 0, 0, 0, 0]},
      });
      expect(command.status).toBe(202);
      await eventually(
        () => peer.frames(),
        frames => frames.some(frame => frame.data instanceof common.CommandLong && frame.data.command === 206),
      );
      await peer.send(loopbackPort, terrainRequest(0));
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      expect(peer.frames().some(frame => frame.data instanceof common.TerrainData)).toBe(false);
      await peer.send(loopbackPort, Object.assign(new common.CommandAck(), {
        command: 206, result: 0, targetSystem: 254, targetComponent: 191,
      }));
      await eventually(
        () => peer.frames(), frames => frames.some(frame => frame.data instanceof common.TerrainData),
      );
      expect(fetches).toBe(1);

      const beforeRollback = (await call(socketPath, 'GET', '/config')).body as Config;
      const changedConfig: Config = {
        ...beforeRollback,
        network: {...beforeRollback.network, ap: {...beforeRollback.network.ap, ssid: 'terrain-rollback-check'}},
        terrain: {enabled: false, provider: 'ardupilot-srtm1', quotaMiB: 128},
      };
      const fullApply = await call(socketPath, 'POST', '/apply', changedConfig);
      expect(fullApply).toMatchObject({status: 200, body: {
        id: expect.any(String), expiresAt: expect.any(Number),
      }});
      expect((await call(socketPath, 'GET', '/cockpit/terrain-service/policy')).body.policy)
        .toEqual(changedConfig.terrain);
      expect((await call(socketPath, 'POST', '/cockpit/terrain-service/policy/confirm', {
        sessionId: 'trusted-unix-session', id: fullApply.body.id,
      })).status).toBe(409);
      expect((await call(socketPath, 'POST', '/cockpit/terrain-service/policy/revert', {
        sessionId: 'trusted-unix-session', id: fullApply.body.id,
      })).status).toBe(409);
      expect((await call(socketPath, 'POST', '/revert', {id: fullApply.body.id})))
        .toMatchObject({status: 200, body: {state: 'idle', lastResult: {outcome: 'reverted'}}});
      await eventually(
        () => call(socketPath, 'GET', '/cockpit/terrain-service'),
        value => value.body?.loading === false && value.body?.policy?.enabled === true,
      );
      expect((await call(socketPath, 'GET', '/config')).body.network).toEqual(beforeRollback.network);
      expect((await call(socketPath, 'GET', '/cockpit/terrain-service/policy')).body.policy)
        .toEqual(beforeRollback.terrain);

      await server.close();
      server = await start();
      peer.clear();
      await peer.send(loopbackPort, heartbeat());
      await eventually(
        () => call(socketPath, 'GET', '/cockpit/terrain-service'),
        value => value.body?.loading === false && value.body?.storage?.objects === 1,
      );
      await supplyControllerObservations(peer, loopbackPort);
      peer.clear();
      await peer.send(loopbackPort, heartbeat());
      await peer.send(loopbackPort, terrainRequest(55));
      const reopened = await eventually(
        () => peer.frames().find(frame => frame.data instanceof common.TerrainData),
        value => value !== undefined,
      );
      expect((reopened.data as common.TerrainData).data)
        .toEqual(reference.expected.subgrids.find(value => value.bit === 55)?.heightsM);
      expect(fetches).toBe(1);
      expect(serialOpens).toBe(0);
      expect(heartbeatErrors).toEqual([]);
    } finally {
      clearInterval(heartbeatTimer);
      await server.close();
      await peer.close();
    }
  }, 30_000);
});
