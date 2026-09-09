// SPDX-License-Identifier: GPL-3.0-or-later
export class MaintenanceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function maintenanceRequest<T>(path: string, body?: object): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), path === "theme" ? 65_000 : 6000);
  try {
    const response = await fetch("/maintenance/api/" + path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      signal: controller.signal,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json", "x-yonder-maintenance": "1" }, body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new MaintenanceError(value.error || "The device refused the request.", response.status);
    return value as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("The device did not answer in time. Check its state before retrying.");
    throw error;
  } finally { clearTimeout(timer); }
}
