import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ReadableStreamReadResult } from "node:stream/web";
import { CliError } from "../core/errors.js";
import { assertPathAndParentsAreNotSymlinks } from "../core/local-store.js";
import type { ServiceStatus } from "./base.js";

export const SYLLABUS_MIRROR_BASE = "https://mirrors.sustech.edu.cn";
const SYLLABUS_PREFIX = "/courses/syllabus/";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;

export const SYLLABUS_STATUS: ServiceStatus = {
  service: "syllabus",
  availability: "implemented",
  auth: "none",
  campusNetwork: false,
  browser: false,
  summary: "Public course syllabus PDF links, availability checks, and downloads from the SUSTech mirror.",
  notes: [
    "Generated links do not confirm availability; availability checks inspect only the PDF endpoint, and HTML links remain unchecked.",
    "Downloads require an explicit local destination and reject symbolic links and accidental overwrites.",
    "The public mirror does not receive SSO cookies; no TIS grades or personal course records are requested.",
    "PDF text extraction, OCR, and department directory listings are not implemented.",
  ],
  endpoints: [`${SYLLABUS_MIRROR_BASE}${SYLLABUS_PREFIX}{courseCode}.pdf`],
};

interface SyllabusSource {
  courseCode: string;
  pdfUrl: string;
  htmlUrl: string;
  source: "sustech-mirror";
  provenance: "public-course-syllabus";
  htmlAvailability: "unchecked";
}

export interface SyllabusLinks extends SyllabusSource {
  /** Availability refers to the PDF. Generating a URL makes no HTTP request. */
  availability: "unchecked";
}

export interface SyllabusCheck extends SyllabusSource {
  /** HEAD availability does not validate or extract the PDF contents. */
  availability: "available" | "not-found";
  status: 200 | 404;
}

export interface SyllabusDownload extends SyllabusSource {
  availability: "available";
  destination: string;
  sourceHost: string;
  size: number;
  sha256: string;
  contentType: string;
  overwritten: boolean;
}

export interface SyllabusRequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function normalizeSyllabusCourseCode(courseCode: string): string {
  const normalized = typeof courseCode === "string" ? courseCode.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(normalized)) {
    throw new CliError("A syllabus course code must start with a letter and contain only letters, digits, underscores, or hyphens (up to 64 characters).", "SYLLABUS_COURSE_CODE_INVALID", 2);
  }
  return normalized;
}

export function buildSyllabusLinks(courseCode: string): SyllabusLinks {
  const code = normalizeSyllabusCourseCode(courseCode);
  return {
    courseCode: code,
    pdfUrl: `${SYLLABUS_MIRROR_BASE}${SYLLABUS_PREFIX}${code}.pdf`,
    htmlUrl: `${SYLLABUS_MIRROR_BASE}${SYLLABUS_PREFIX}html/${code}.html`,
    source: "sustech-mirror",
    provenance: "public-course-syllabus",
    availability: "unchecked",
    htmlAvailability: "unchecked",
  };
}

export async function checkSyllabus(courseCode: string, options: SyllabusRequestOptions = {}): Promise<SyllabusCheck> {
  const links = buildSyllabusLinks(courseCode);
  const response = await requestSyllabus(links.pdfUrl, "HEAD", options);
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404) return { ...links, availability: "not-found", status: 404 };
  if (response.status !== 200) throw syllabusHttpError(response.status);
  return { ...links, availability: "available", status: 200 };
}

export async function downloadSyllabusPdf(
  courseCode: string,
  destination: string,
  options: SyllabusRequestOptions & { overwrite?: boolean; maxBytes?: number } = {},
): Promise<SyllabusDownload> {
  const links = buildSyllabusLinks(courseCode);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new CliError("The syllabus PDF byte limit must be a positive safe integer.", "SYLLABUS_DOWNLOAD_LIMIT_INVALID", 2);
  }
  const output = await inspectDestination(destination, options.overwrite === true);
  const response = await requestSyllabus(links.pdfUrl, "GET", options);
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new CliError("The public mirror has no syllabus PDF for this course code.", "SYLLABUS_NOT_FOUND", 1, { courseCode: links.courseCode, pdfUrl: links.pdfUrl });
    throw syllabusHttpError(response.status);
  }
  const tempPath = join(dirname(output.destination), `.${basename(output.destination)}.sustech-${randomUUID()}.tmp`);
  try {
    const streamed = await streamPdf(response, tempPath, maxBytes);
    // Recheck after the network request before publishing the completed file.
    const beforePublish = await inspectDestination(output.destination, options.overwrite === true);
    try {
      if (options.overwrite === true) {
        await rename(tempPath, output.destination);
      } else {
        // Hard-linking the completed file is atomic and refuses a racing writer.
        await link(tempPath, output.destination);
      }
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") throw destinationExists(output.destination);
      throw fileError("The syllabus PDF could not be placed atomically.", output.destination, error);
    }
    return {
      ...links,
      availability: "available",
      destination: output.destination,
      sourceHost: new URL(SYLLABUS_MIRROR_BASE).hostname,
      ...streamed,
      overwritten: beforePublish.existed,
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function requestSyllabus(url: string, method: "HEAD" | "GET", options: SyllabusRequestOptions): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new CliError("The syllabus request timeout must be a positive integer no greater than 2147483647 milliseconds.", "SYLLABUS_TIMEOUT_INVALID", 2);
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let current = safeMirrorUrl(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        method,
        headers: { accept: "application/pdf,application/octet-stream;q=0.8" },
        credentials: "omit",
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw networkError(error, signal.aborted);
    }
    if (response.url) {
      try {
        safeMirrorUrl(response.url);
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) throw new CliError("The syllabus mirror returned a redirect without a destination.", "SYLLABUS_REDIRECT_INVALID", 1);
      try {
        current = safeMirrorUrl(new URL(location, current).toString());
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError("The syllabus mirror returned an invalid redirect URL.", "SYLLABUS_REDIRECT_INVALID", 1);
      }
      continue;
    }
    return response;
  }
  throw new CliError("The syllabus mirror redirected too many times.", "SYLLABUS_REDIRECT_LIMIT", 1);
}

function safeMirrorUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== SYLLABUS_MIRROR_BASE || url.username || url.password || !url.pathname.startsWith(SYLLABUS_PREFIX)) {
    throw new CliError("Syllabus requests must stay on the mirror's HTTPS syllabus directory.", "SYLLABUS_URL_UNSAFE", 1);
  }
  return url;
}

async function inspectDestination(destination: string, overwrite: boolean): Promise<{ destination: string; existed: boolean }> {
  if (typeof destination !== "string" || !destination.trim()) {
    throw new CliError("A syllabus download requires an explicit destination file.", "SYLLABUS_DOWNLOAD_DESTINATION_INVALID", 2);
  }
  const absolute = resolve(destination);
  const parent = dirname(absolute);
  await assertPathAndParentsAreNotSymlinks(parent);
  let parentInfo;
  try {
    parentInfo = await stat(parent);
  } catch (error) {
    throw fileError("The syllabus destination directory could not be accessed.", parent, error);
  }
  if (!parentInfo.isDirectory()) throw new CliError("The syllabus destination parent must be a directory.", "SYLLABUS_DOWNLOAD_DESTINATION_INVALID", 2, { destination: absolute });
  let existing;
  try {
    existing = await lstat(absolute);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw fileError("The syllabus destination could not be inspected.", absolute, error);
  }
  if (existing && !existing.isFile()) throw new CliError("The syllabus destination must be a regular file and must not be a symbolic link.", "SYLLABUS_DOWNLOAD_DESTINATION_INVALID", 2, { destination: absolute });
  if (existing && !overwrite) throw destinationExists(absolute);
  return { destination: absolute, existed: existing !== undefined };
}

async function streamPdf(response: Response, tempPath: string, maxBytes: number): Promise<{ size: number; sha256: string; contentType: string }> {
  if (!response.body) throw new CliError("The syllabus response did not include a PDF body.", "SYLLABUS_DOWNLOAD_EMPTY", 1);
  const rawLength = response.headers.get("content-length") ?? "";
  const expectedLength = /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
  if (expectedLength !== undefined && expectedLength > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw tooLarge(maxBytes, expectedLength);
  }
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  const signature: number[] = [];
  let size = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw networkError(error, error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw tooLarge(maxBytes, size);
      for (const byte of chunk.value) {
        if (signature.length === 5) break;
        signature.push(byte);
      }
      if (signature.length === 5 && String.fromCharCode(...signature) !== "%PDF-") throw notPdf(response);
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const result = await handle.write(chunk.value, offset, chunk.value.byteLength - offset, null);
        if (result.bytesWritten <= 0) throw new Error("zero-byte file write");
        offset += result.bytesWritten;
      }
    }
    if (String.fromCharCode(...signature) !== "%PDF-") throw notPdf(response);
    if (expectedLength !== undefined && !response.headers.get("content-encoding") && size !== expectedLength) {
      throw new CliError("The syllabus PDF size did not match the server response.", "SYLLABUS_DOWNLOAD_SIZE_MISMATCH", 1, { expectedSize: expectedLength, actualSize: size });
    }
    await handle.sync();
    return { size, sha256: hash.digest("hex"), contentType: (response.headers.get("content-type") ?? "application/pdf").split(";", 1)[0]!.trim() };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw fileError("The syllabus PDF could not be written safely.", tempPath, error);
  } finally {
    reader.releaseLock();
    await handle?.close().catch(() => undefined);
  }
}

function syllabusHttpError(status: number): CliError {
  return new CliError("The syllabus mirror returned an unexpected HTTP status; PDF availability could not be determined.", "SYLLABUS_HTTP_ERROR", 1, { status });
}

function networkError(error: unknown, timedOut: boolean): CliError {
  return new CliError(timedOut ? "The syllabus request timed out." : "The syllabus mirror request failed.", timedOut ? "NETWORK_TIMEOUT" : "NETWORK_ERROR", 1, { cause: error instanceof Error ? error.message : String(error) });
}

function destinationExists(destination: string): CliError {
  return new CliError("The syllabus destination already exists; pass --overwrite to replace it.", "SYLLABUS_DOWNLOAD_DESTINATION_EXISTS", 2, { destination });
}

function tooLarge(maxBytes: number, size: number): CliError {
  return new CliError("The syllabus PDF exceeds the configured download limit.", "SYLLABUS_DOWNLOAD_TOO_LARGE", 1, { size, maxBytes });
}

function notPdf(response: Response): CliError {
  return new CliError("The syllabus mirror response does not start with a PDF signature.", "SYLLABUS_DOWNLOAD_NOT_PDF", 1, { contentType: response.headers.get("content-type") ?? "" });
}

function fileError(message: string, path: string, error: unknown): CliError {
  return new CliError(message, "SYLLABUS_DOWNLOAD_FILE_ERROR", 2, { path, cause: error instanceof Error ? error.message : String(error) });
}

function nodeErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
