// SPDX-License-Identifier: GPL-3.0-or-later
export class DataFetchError extends Error {
  constructor(
    message: string,
    readonly retryMs = 0,
  ) {
    super(message);
  }
}
/** Fixed provider URLs are assembled by callers; redirects cannot change the host. */
export async function boundedFetch(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; type: string }> {
  const response = await fetch(url, {
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(4000)])
      : AbortSignal.timeout(4000),
    headers: {
      accept: "*/*",
      "user-agent": "Yonder/0.1 (+https://github.com/JJ-Boyd/OpenUAS)",
    },
  });
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    let ms = retry ? Number(retry) * 1000 : 0;
    if (retry && !Number.isFinite(ms)) ms = Date.parse(retry) - Date.now();
    await response.body?.cancel();
    throw new DataFetchError(
      `Provider HTTP ${response.status}`,
      Number.isFinite(ms) ? Math.min(3600000, Math.max(0, ms)) : 0,
    );
  }
  if (!response.body) throw new DataFetchError("Provider returned no data");
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes)
        throw new DataFetchError("Provider response exceeded its size limit");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return {
    bytes: Buffer.concat(chunks),
    type:
      response.headers.get("content-type")?.split(";")[0] ??
      "application/octet-stream",
  };
}
