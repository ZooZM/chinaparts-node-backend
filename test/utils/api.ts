import request from 'supertest';
import type { Server } from 'node:http';

/**
 * Both envelopes in one shape (constitution IV): `{ success, data, message }` on success and
 * `{ success: false, error, message, statusCode }` on failure. A test reads `data` or `error`.
 */
export interface Envelope<T> {
  success: boolean;
  data: T;
  message: string;
  error?: string;
  statusCode?: number;
  details?: unknown;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: Envelope<T>;
  headers: Record<string, string | string[] | undefined>;
  /** `body.data`. Only meaningful when the call succeeded. */
  data: T;
  /** `body.error`: the sentinel, when the call failed. */
  error: string | undefined;
}

export interface CallOptions {
  /** A full `Bearer id|secret` value, as `issueToken` returns it. */
  token?: string;
  installationId?: string;
  adminKey?: string;
  language?: 'ar' | 'en';
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  /** A JSON body. */
  body?: Record<string, unknown>;
  /** A multipart upload instead of a JSON body. */
  multipart?: {
    fields?: Record<string, string>;
    files?: Array<{ field: string; path: string; contentType?: string }>;
  };
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A typed wrapper over supertest, so suites never touch an `any` body. */
export class TestApi {
  constructor(private readonly server: Server) {}

  get<T = unknown>(path: string, options?: CallOptions) {
    return this.call<T>('get', path, options);
  }
  post<T = unknown>(path: string, options?: CallOptions) {
    return this.call<T>('post', path, options);
  }
  put<T = unknown>(path: string, options?: CallOptions) {
    return this.call<T>('put', path, options);
  }
  patch<T = unknown>(path: string, options?: CallOptions) {
    return this.call<T>('patch', path, options);
  }
  delete<T = unknown>(path: string, options?: CallOptions) {
    return this.call<T>('delete', path, options);
  }

  /** For the routes outside the envelope: the store page, `.well-known`. */
  async raw(
    path: string,
    options: { userAgent?: string } = {},
  ): Promise<{
    status: number;
    text: string;
    headers: Record<string, string | string[] | undefined>;
    contentType: string | undefined;
  }> {
    const req = request(this.server).get(path);
    if (options.userAgent) req.set('User-Agent', options.userAgent);
    const res = await req;
    return {
      status: res.status,
      text: res.text,
      headers: res.headers,
      contentType: res.headers['content-type'],
    };
  }

  private async call<T>(
    method: Method,
    path: string,
    options: CallOptions = {},
  ): Promise<ApiResponse<T>> {
    let req = request(this.server)[method](path);
    if (options.token) req = req.set('Authorization', options.token);
    if (options.installationId)
      req = req.set('X-Installation-Id', options.installationId);
    if (options.adminKey !== undefined)
      req = req.set('x-admin-key', options.adminKey);
    if (options.language) req = req.set('Accept-Language', options.language);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      req = req.set(name, value);
    }
    if (options.query) {
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) query[key] = String(value);
      }
      req = req.query(query);
    }
    if (options.multipart) {
      for (const [name, value] of Object.entries(
        options.multipart.fields ?? {},
      )) {
        req = req.field(name, value);
      }
      for (const file of options.multipart.files ?? []) {
        req = req.attach(
          file.field,
          file.path,
          file.contentType ? { contentType: file.contentType } : undefined,
        );
      }
    } else if (options.body) {
      req = req.send(options.body);
    }

    const res = await req;
    const body = res.body as Envelope<T>;
    return {
      status: res.status,
      body,
      headers: res.headers,
      data: body.data,
      error: body.error,
    };
  }
}
