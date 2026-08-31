export interface BodyCapture {
  kind: 'text' | 'binary';
  /** Decoded utf8 text (kind === 'text'). Undefined for binary. */
  text?: string;
  /** Total bytes observed (even past the cap). */
  bytes: number;
  /** True when buffering stopped early (cap hit or capture deadline). */
  truncated: boolean;
}

export interface RequestRecord {
  id: string;
  tunnelId: string;
  timestamp: number;
  method: string;
  /** Pathname only (query kept separately). */
  path: string;
  query: Record<string, string>;
  httpVersion: string;
  ws: boolean;
  request: {
    headers: Record<string, string>;
    body: BodyCapture | null;
  };
  response: {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: BodyCapture | null;
  } | null;
  /** Null while in-flight. */
  durationMs: number | null;
  /** 'upstream_down' | 'timeout' | 'proxy_error' when the request failed. */
  error?: string;
}
