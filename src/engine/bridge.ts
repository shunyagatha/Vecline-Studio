/**
 * Talking to a Vecline CLI running on the user's own machine.
 *
 * Office documents need a real office engine. A browser tab has none, and the
 * two ways to get one — bundling a ~300 MB LibreOffice-in-WASM, or uploading
 * the document to a server — each cost something the product is built on:
 * instant load in the first case, and the privacy claim in the second.
 *
 * So neither. If the user runs `vecline serve`, the Studio hands the document
 * to *their* machine and gets it back converted. The bytes travel from the tab
 * to a process the user started, and no further. When the bridge is absent, the
 * studio says what to install instead of failing at the moment of conversion.
 *
 * The full chain this unlocks is worth stating, because each link is local:
 *
 *   .docx → (bridge → your LibreOffice) → PDF → (mupdf WASM, in this tab)
 *         → pixels → traced SVG, scored against those pixels
 *
 * Nothing in that line touches a network beyond loopback.
 */

const DEFAULT_PORT = 7654;

/** How long to wait for a bridge that probably is not there. */
const PROBE_TIMEOUT_MS = 1200;

export interface BridgeStatus {
  available: boolean;
  /** True only when the bridge is up *and* it found LibreOffice. */
  office: boolean;
  version?: string;
  formats?: string[];
  port: number;
}

const OFFICE_EXTENSIONS = new Set([
  'docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp',
]);

/** Is this a document only an office engine can read? */
export function isOfficeDocument(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return OFFICE_EXTENSIONS.has(ext);
}

/**
 * Ask whether a bridge is listening.
 *
 * Failure is the expected case — almost nobody will be running one — so this
 * never throws and never blocks the UI for long. A short timeout matters more
 * than it looks: without one, a port that silently drops packets would leave
 * the probe hanging and the studio unable to say either way.
 */
export async function probeBridge(port = DEFAULT_PORT, token?: string): Promise<BridgeStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
      headers: token ? { 'X-Vecline-Token': token } : {},
    });
    if (!res.ok) return { available: false, office: false, port };
    const body = await res.json() as {
      name?: string; version?: string; capabilities?: { office?: boolean; formats?: string[] };
    };
    // Check the name: something else could be sitting on this port, and
    // assuming it speaks our protocol would produce a baffling failure later.
    if (body.name !== 'vecline') return { available: false, office: false, port };
    return {
      available: true,
      office: Boolean(body.capabilities?.office),
      version: body.version,
      formats: body.capabilities?.formats,
      port,
    };
  } catch {
    return { available: false, office: false, port };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert an Office document through the local bridge.
 *
 * The filename is sent as a header purely so the far side can pick the right
 * input extension for LibreOffice; it never becomes a path there.
 */
export async function convertViaBridge(
  file: Blob,
  filename: string,
  to: string,
  port = DEFAULT_PORT,
  token?: string,
): Promise<Uint8Array> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Vecline-Filename': filename,
  };
  if (token) headers['X-Vecline-Token'] = token;

  const res = await fetch(`http://127.0.0.1:${port}/office?to=${encodeURIComponent(to)}`, {
    method: 'POST',
    headers,
    body: file,
  });

  if (!res.ok) {
    // The bridge reports LibreOffice's own complaint, which is far more useful
    // than a generic failure — a password-protected file says so.
    const detail = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(detail?.error ?? `The local bridge returned ${res.status}.`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
