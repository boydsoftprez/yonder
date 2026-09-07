// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { captureHandler, captureRequestFor } from "./capture.js";
import { SAFE_CAPTURE_NAME } from "../video/recorder.js";
import { captureUrl } from "../video/media-path.js";

/**
 * The one route that carries bytes rather than JSON (R-CAM-18, R-SEC-13).
 *
 * Everything here is about a file reaching a browser without going through
 * `DaemonClient`, which would buffer it to a megabyte and mangle every byte
 * above 0x7f on the way through `toString("utf8")`. So the assertions are
 * about *bytes*: a JPEG whose magic number survives, a status and a content
 * type relayed unchanged, and a name that never reaches a request line
 * unless it is one the daemon would accept for a file.
 */

let daemon: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (daemon !== undefined) {
    await new Promise<void>((resolve) => { daemon?.close(() => { resolve(); }); });
    daemon = undefined;
  }
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** A daemon on a real Unix socket, answering whatever this test says. */
async function daemonAnswering(
  answer: (path: string) => { status: number; type: string; body: Buffer },
): Promise<{ socketPath: string; asked: string[] }> {
  const asked: string[] = [];
  dir = mkdtempSync(join(tmpdir(), "yonder-capture-"));
  const socketPath = join(dir, "d.sock");
  daemon = createServer((req, res) => {
    asked.push(req.url ?? "");
    const a = answer(req.url ?? "");
    res.writeHead(a.status, { "content-type": a.type, "content-length": String(a.body.length) });
    res.end(a.body);
  });
  await new Promise<void>((resolve) => { daemon?.listen(socketPath, () => { resolve(); }); });
  return { socketPath, asked };
}

/** Whatever came back, collected — a stream here, a sentence there. */
async function bodyOf(body: NodeJS.ReadableStream | string): Promise<Buffer> {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The first bytes of a real JPEG, which is the point: they are not UTF-8. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const NAME = "2026-09-07T14-22-05-123Z-1280x720.jpg";

describe("the capture proxy", () => {
  it("relays the daemon's bytes unchanged, magic number and all", async () => {
    const { socketPath, asked } = await daemonAnswering(() => (
      { status: 200, type: "image/jpeg", body: JPEG }
    ));
    const answer = await captureHandler(socketPath)({ camera: "cam0", name: NAME });

    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe("image/jpeg");
    // Byte for byte. A client that decoded this as text would give back the
    // replacement character where 0xff is, and the browser would show a
    // broken image with no error anywhere.
    expect(await bodyOf(answer.body)).toEqual(JPEG);
    expect(asked).toEqual([`/cameras/cam0/captures/${encodeURIComponent(NAME)}`]);
  });

  it("relays the daemon's own refusal rather than composing one of its own", async () => {
    const { socketPath } = await daemonAnswering(() => ({
      status: 404,
      type: "application/json",
      body: Buffer.from('{"error":"cam0 holds \\"x.jpg\\" on its own medium"}', "utf8"),
    }));
    const answer = await captureHandler(socketPath)({ camera: "cam0", name: NAME });

    expect(answer.status).toBe(404);
    expect((await bodyOf(answer.body)).toString("utf8")).toContain("its own medium");
  });

  it("asks for nothing at all when the name could not be one", async () => {
    const { socketPath, asked } = await daemonAnswering(() => (
      { status: 200, type: "image/jpeg", body: JPEG }
    ));
    const serve = captureHandler(socketPath);
    for (const name of ["../../etc/shadow", "a/b.jpg", "", ".hidden"]) {
      const answer = await serve({ camera: "cam0", name });
      expect(answer.status, name).toBe(404);
    }
    // The guard is that the daemon was never asked, not that it said no.
    expect(asked).toEqual([]);
  });

  it("asks for nothing at all when the camera could not be one", async () => {
    const { socketPath, asked } = await daemonAnswering(() => (
      { status: 200, type: "image/jpeg", body: JPEG }
    ));
    const answer = await captureHandler(socketPath)({ camera: "../admin", name: NAME });
    expect(answer.status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("answers, rather than throwing, when there is no daemon on the socket", async () => {
    dir = mkdtempSync(join(tmpdir(), "yonder-capture-"));
    const answer = await captureHandler(join(dir, "nothing.sock"))(
      { camera: "cam0", name: NAME },
    );
    expect(answer.status).toBe(503);
    expect(await bodyOf(answer.body)).toEqual(
      Buffer.from("the device's configuration service is not answering", "utf8"),
    );
  });

  /**
   * The trade `capture.ts` records in its own words: the name pattern is
   * written out there rather than imported, because importing `recorder.ts`
   * from a file `settings.js` loads would bring the schema, zod and yaml into
   * Node-RED's start-up. This is what makes "checked by hand" mean "checked
   * by a test".
   */
  it("guards names by the same pattern the recorder does", async () => {
    const { socketPath, asked } = await daemonAnswering(() => (
      { status: 200, type: "image/jpeg", body: JPEG }
    ));
    const serve = captureHandler(socketPath);
    const cases = [NAME, "a", "A.b-c_d.mkv", "-leading", "sp ace", "a".repeat(129), "a".repeat(128)];
    for (const name of cases) {
      const answer = await serve({ camera: "cam0", name });
      expect(answer.status === 200, name).toBe(SAFE_CAPTURE_NAME.test(name));
    }
    expect(asked).toHaveLength(cases.filter((n) => SAFE_CAPTURE_NAME.test(n)).length);
  });
});

describe("captureRequestFor", () => {
  it("reads back exactly what captureUrl writes", () => {
    // The two ends of one string, which is why they live in one place. A
    // name with a colon in it would be a different assertion; the recorder
    // replaces those precisely because a filename should not carry one.
    expect(captureRequestFor(captureUrl("cam0", NAME)))
      .toEqual({ camera: "cam0", name: NAME });
  });

  it("is not a request for anything that is not one", () => {
    for (const path of [
      "/video/cam0/whep",
      "/video/cam0/report",
      "/video/cam0/captures",
      "/video/cam0/captures/a/b",
      "/video/captures/x.jpg",
      "/captures/x.jpg",
    ]) {
      expect(captureRequestFor(path), path).toBeNull();
    }
  });

  it("is not a request when the escapes are malformed", () => {
    // `decodeURIComponent` throws on this. A name that is not a name is
    // refused as one rather than throwing out of the middleware.
    expect(captureRequestFor("/video/cam0/captures/%E0%A4%A")).toBeNull();
  });
});
