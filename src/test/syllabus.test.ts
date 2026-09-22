import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CliError } from "../core/errors.js";
import { buildSyllabusLinks, checkSyllabus, downloadSyllabusPdf, normalizeSyllabusCourseCode } from "../services/syllabus.js";

const PDF = new TextEncoder().encode("%PDF-1.7\nfixture syllabus\n%%EOF\n");
const PDF_URL = "https://mirrors.sustech.edu.cn/courses/syllabus/CLE022.pdf";

test("syllabus links normalize course codes and explicitly leave both formats unchecked", () => {
  const links = buildSyllabusLinks(" cle022 \n");
  assert.equal(links.courseCode, "CLE022");
  assert.equal(links.pdfUrl, PDF_URL);
  assert.equal(links.htmlUrl, "https://mirrors.sustech.edu.cn/courses/syllabus/html/CLE022.html");
  assert.equal(links.availability, "unchecked");
  assert.equal(links.htmlAvailability, "unchecked");
  assert.equal(links.source, "sustech-mirror");
  assert.equal(links.provenance, "public-course-syllabus");
  assert.equal(normalizeSyllabusCourseCode("cs101-a"), "CS101-A");
  for (const invalid of ["", "../CLE022", "CLE022.pdf", "CS 101", "CS101?token=x", "CS101#pdf", "CS%2f101", "https://example.com", "A".repeat(65)]) {
    assert.throws(() => buildSyllabusLinks(invalid), hasCode("SYLLABUS_COURSE_CODE_INVALID"));
  }
});

test("syllabus info uses unauthenticated HEAD and distinguishes 404 from available", async () => {
  for (const status of [200, 404] as const) {
    let calls = 0;
    const result = await checkSyllabus("cle022", {
      fetchImpl: async (input, init) => {
        calls += 1;
        assert.equal(String(input), PDF_URL);
        assert.equal(init?.method, "HEAD");
        assert.equal(init?.credentials, "omit");
        assert.equal(init?.redirect, "manual");
        assert.equal(new Headers(init?.headers).get("cookie"), null);
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        return new Response(null, { status });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, status);
    assert.equal(result.availability, status === 200 ? "available" : "not-found");
    assert.equal(result.htmlAvailability, "unchecked");
  }
});

test("syllabus info keeps HTTP failures and transport failures distinct from absence", async () => {
  for (const status of [204, 206, 401, 403, 405, 429, 500, 503]) {
    await assert.rejects(checkSyllabus("CLE022", { fetchImpl: async () => new Response(null, { status }) }),
      (error: unknown) => error instanceof CliError && error.code === "SYLLABUS_HTTP_ERROR" && error.details?.status === status);
  }
  await assert.rejects(checkSyllabus("CLE022", { fetchImpl: async () => { throw new TypeError("connection failed"); } }), hasCode("NETWORK_ERROR"));
});

test("syllabus requests retain HEAD through safe redirects and reject other hosts or paths", async () => {
  let calls = 0;
  const result = await checkSyllabus("CLE022", {
    fetchImpl: async (input, init) => {
      assert.equal(init?.method, "HEAD");
      calls += 1;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: "./CLE022-v2.pdf" } });
      assert.equal(String(input), "https://mirrors.sustech.edu.cn/courses/syllabus/CLE022-v2.pdf");
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(result.availability, "available");
  assert.equal(calls, 2);
  for (const location of ["http://mirrors.sustech.edu.cn/courses/syllabus/CLE022.pdf", "https://example.com/CLE022.pdf", "https://mirrors.sustech.edu.cn/login", "https://user:password@mirrors.sustech.edu.cn/courses/syllabus/CLE022.pdf", "https://mirrors.sustech.edu.cn:8443/courses/syllabus/CLE022.pdf"]) {
    let unsafeCalls = 0;
    await assert.rejects(checkSyllabus("CLE022", { fetchImpl: async () => {
      unsafeCalls += 1;
      return new Response(null, { status: 302, headers: { location } });
    } }), hasCode("SYLLABUS_URL_UNSAFE"));
    assert.equal(unsafeCalls, 1);
  }
  await assert.rejects(checkSyllabus("CLE022", { fetchImpl: async () => new Response(null, { status: 302 }) }), hasCode("SYLLABUS_REDIRECT_INVALID"));
  await assert.rejects(checkSyllabus("CLE022", { fetchImpl: async () => new Response(null, { status: 302, headers: { location: PDF_URL } }) }), hasCode("SYLLABUS_REDIRECT_LIMIT"));
});

test("syllabus downloads atomically publish PDF bytes and return provenance and a digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sustech-syllabus-download-"));
  const destination = join(directory, "CLE022.pdf");
  try {
    const result = await downloadSyllabusPdf("cle022", destination, {
      fetchImpl: async (input, init) => {
        assert.equal(String(input), PDF_URL);
        assert.equal(init?.method, "GET");
        assert.equal(init?.credentials, "omit");
        assert.deepEqual(await readdir(directory), []);
        return pdfResponse();
      },
    });
    assert.deepEqual(await readFile(destination), Buffer.from(PDF));
    assert.equal(result.courseCode, "CLE022");
    assert.equal(result.destination, destination);
    assert.equal(result.sourceHost, "mirrors.sustech.edu.cn");
    assert.equal(result.availability, "available");
    assert.equal(result.htmlAvailability, "unchecked");
    assert.equal(result.sha256, createHash("sha256").update(PDF).digest("hex"));
    assert.equal(result.size, PDF.byteLength);
    assert.equal(result.contentType, "application/pdf");
    assert.equal(result.overwritten, false);
    assert.deepEqual(await readdir(directory), ["CLE022.pdf"]);
    await assert.rejects(downloadSyllabusPdf("CLE022", destination, { fetchImpl: mustNotFetch }), hasCode("SYLLABUS_DOWNLOAD_DESTINATION_EXISTS"));
    await writeFile(destination, "old syllabus");
    const replacement = await downloadSyllabusPdf("CLE022", destination, { overwrite: true, fetchImpl: async () => pdfResponse() });
    assert.equal(replacement.overwritten, true);
    assert.deepEqual(await readFile(destination), Buffer.from(PDF));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("syllabus download requires a destination and validates limits before requesting the mirror", async () => {
  await assert.rejects(downloadSyllabusPdf("CLE022", "", { fetchImpl: mustNotFetch }), hasCode("SYLLABUS_DOWNLOAD_DESTINATION_INVALID"));
  for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(downloadSyllabusPdf("CLE022", "ignored.pdf", { maxBytes, fetchImpl: mustNotFetch }), hasCode("SYLLABUS_DOWNLOAD_LIMIT_INVALID"));
  }
  for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(checkSyllabus("CLE022", { timeoutMs, fetchImpl: mustNotFetch }), hasCode("SYLLABUS_TIMEOUT_INVALID"));
  }
});

test("syllabus overwrite receipt reflects a destination created during download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sustech-syllabus-overwrite-"));
  const destination = join(directory, "CLE022.pdf");
  try {
    const result = await downloadSyllabusPdf("CLE022", destination, { overwrite: true, fetchImpl: async () => {
      await writeFile(destination, "created by another writer");
      return pdfResponse();
    } });
    assert.equal(result.overwritten, true);
    assert.deepEqual(await readFile(destination), Buffer.from(PDF));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("syllabus download rejects missing PDFs, HTML, malformed signatures, size mismatches, and oversized streams", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sustech-syllabus-invalid-"));
  const destination = join(directory, "CLE022.pdf");
  const cases: { response: () => Response; code: string; maxBytes?: number }[] = [
    { response: () => new Response(null, { status: 404 }), code: "SYLLABUS_NOT_FOUND" },
    { response: () => new Response(null, { status: 429 }), code: "SYLLABUS_HTTP_ERROR" },
    { response: () => new Response(null, { status: 503 }), code: "SYLLABUS_HTTP_ERROR" },
    { response: () => new Response(null), code: "SYLLABUS_DOWNLOAD_EMPTY" },
    { response: () => new Response("<html>%PDF-1.7 login page</html>"), code: "SYLLABUS_DOWNLOAD_NOT_PDF" },
    { response: () => new Response("%PDF"), code: "SYLLABUS_DOWNLOAD_NOT_PDF" },
    { response: () => pdfResponse({ "content-length": "100" }), code: "SYLLABUS_DOWNLOAD_SIZE_MISMATCH" },
    { response: () => pdfResponse(), maxBytes: 10, code: "SYLLABUS_DOWNLOAD_TOO_LARGE" },
    { response: () => new Response(PDF), maxBytes: 10, code: "SYLLABUS_DOWNLOAD_TOO_LARGE" },
  ];
  try {
    for (const fixture of cases) {
      await assert.rejects(downloadSyllabusPdf("CLE022", destination, { fetchImpl: async () => fixture.response(), maxBytes: fixture.maxBytes }), hasCode(fixture.code));
      assert.deepEqual(await readdir(directory), [], fixture.code);
    }
    await writeFile(destination, "keep original");
    await assert.rejects(downloadSyllabusPdf("CLE022", destination, { overwrite: true, fetchImpl: async () => new Response("<html>error</html>") }), hasCode("SYLLABUS_DOWNLOAD_NOT_PDF"));
    assert.equal(await readFile(destination, "utf8"), "keep original");
    assert.deepEqual(await readdir(directory), ["CLE022.pdf"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("syllabus download handles split PDF signatures and detects body transport errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sustech-syllabus-stream-"));
  const destination = join(directory, "CLE022.pdf");
  try {
    const chunks = [PDF.slice(0, 2), PDF.slice(2, 4), PDF.slice(4)];
    await downloadSyllabusPdf("CLE022", destination, { fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    })) });
    assert.deepEqual(await readFile(destination), Buffer.from(PDF));
    await rm(destination);
    await assert.rejects(downloadSyllabusPdf("CLE022", destination, { fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new TypeError("connection reset")); },
    })) }), hasCode("NETWORK_ERROR"));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("syllabus download refuses symbolic links and detects destination changes during the request", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "sustech-syllabus-symlink-"));
  const target = join(directory, "target.pdf");
  const destination = join(directory, "CLE022.pdf");
  const realParent = join(directory, "real-parent");
  const linkedParent = join(directory, "linked-parent");
  try {
    await writeFile(target, "keep original");
    await symlink(target, destination);
    for (const overwrite of [false, true]) {
      await assert.rejects(downloadSyllabusPdf("CLE022", destination, { overwrite, fetchImpl: mustNotFetch }), hasCode("SYLLABUS_DOWNLOAD_DESTINATION_INVALID"));
    }
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    await assert.rejects(downloadSyllabusPdf("CLE022", join(linkedParent, "CLE022.pdf"), { fetchImpl: mustNotFetch }), hasCode("UNSAFE_LOCAL_PATH"));
    await rm(destination);
    await assert.rejects(downloadSyllabusPdf("CLE022", destination, { overwrite: true, fetchImpl: async () => {
      await symlink(target, destination);
      return pdfResponse();
    } }), hasCode("SYLLABUS_DOWNLOAD_DESTINATION_INVALID"));
    assert.equal(await readFile(target, "utf8"), "keep original");
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
    await rm(destination);
    await assert.rejects(downloadSyllabusPdf("CLE022", destination, { fetchImpl: async () => {
      await writeFile(destination, "created by another writer");
      return pdfResponse();
    } }), hasCode("SYLLABUS_DOWNLOAD_DESTINATION_EXISTS"));
    assert.equal(await readFile(destination, "utf8"), "created by another writer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function pdfResponse(headers: Record<string, string> = {}): Response {
  return new Response(PDF, { headers: { "content-type": "application/pdf; charset=binary", "content-length": String(PDF.byteLength), ...headers } });
}

async function mustNotFetch(): Promise<Response> {
  assert.fail("network must not run");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CliError && error.code === code;
}
