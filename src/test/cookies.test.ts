import assert from "node:assert/strict";
import test from "node:test";
import { CookieJar } from "../sso/cookies.js";

test("cookies respect expiration, deletion, host-only domains, secure flags and path boundaries", () => {
  const jar = new CookieJar();
  const url = "https://bb.sustech.edu.cn/webapps/login/index.jsp";
  function add(value: string): void {
    jar.add(new Response(null, { headers: { "set-cookie": value } }), url);
  }
  add("root=secret; Path=/; Secure");
  add("default=narrow");
  add("shared=yes; Domain=.bb.sustech.edu.cn; Path=/");
  add("foreign=no; Domain=evil.example; Path=/");
  add("expired=no; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/");
  add("ageWins=yes; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600; Path=/");
  assert.match(jar.header(new URL(url))!, /default=narrow/);
  assert.doesNotMatch(jar.header(new URL("https://bb.sustech.edu.cn/webapps/login-other"))!, /default=/);
  assert.doesNotMatch(jar.header(new URL("https://child.bb.sustech.edu.cn/"))!, /root=/);
  assert.match(jar.header(new URL("https://child.bb.sustech.edu.cn/"))!, /shared=yes/);
  assert.doesNotMatch(jar.header(new URL("http://bb.sustech.edu.cn/"))!, /root=/);
  assert.doesNotMatch(jar.header(new URL(url))!, /foreign|expired/);
  assert.match(jar.header(new URL(url))!, /ageWins=yes/);
  add("root=gone; Max-Age=0; Path=/");
  assert.doesNotMatch(jar.header(new URL(url))!, /root=/);
  add("past=gone; Max-Age=-1; Path=/");
  assert.doesNotMatch(jar.header(new URL(url))!, /past=/);
});

test("cookie snapshots exclude CAS and parent-domain cookies and reject invalid imports", () => {
  const jar = new CookieJar();
  for (const [url, cookie] of [
    ["https://cas.sustech.edu.cn/cas", "TGC=cas-secret; Path=/"],
    ["https://bb.sustech.edu.cn/", "BbRouter=bb-secret; Path=/"],
    ["https://cas.sustech.edu.cn/", "broad=cas-secret; Domain=.sustech.edu.cn; Path=/"],
  ]) jar.add(new Response(null, { headers: { "set-cookie": cookie } }), url);
  const url = new URL("https://bb.sustech.edu.cn/");
  assert.deepEqual(jar.snapshot(url).map((cookie) => cookie.name), ["BbRouter"]);
  const restored = new CookieJar();
  assert.equal(restored.restore(jar.snapshot(url), url), true);
  assert.equal(restored.header(url), "BbRouter=bb-secret");
  assert.equal(restored.restore([{ ...jar.snapshot(url)[0], domain: "evil.example" }], url), false);
  assert.equal(restored.restore([{ ...jar.snapshot(url)[0], value: "bad\r\nheader" }], url), false);
});
