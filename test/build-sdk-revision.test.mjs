import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeclaredSdkRevision } from "../scripts/build-sdk-revision.mjs";

const revision = "e58138e6e153c31b813f62a88932abf5d4cd495c";
const otherRevision = "61a929f6c783f78e5af603682de1543c7e24abc0";
const spec = `github:Powerpunch777/sps-plugin-sdk#${revision}`;

function fixture({ manifestSpec = spec, lockSpec = manifestSpec, resolved = `git+ssh://git@github.com/Powerpunch777/sps-plugin-sdk.git#${revision}`, includeSdkLockEntry = true } = {}) {
  return {
    packageJson: { devDependencies: { "@sonparkserver/plugin-sdk": manifestSpec } },
    packageLock: {
      packages: {
        "": { devDependencies: { "@sonparkserver/plugin-sdk": lockSpec } },
        ...(includeSdkLockEntry ? { "node_modules/@sonparkserver/plugin-sdk": { resolved } } : {}),
      },
    },
  };
}

test("resolves the exact SDK commit shared by the manifest and lockfile", () => {
  const input = fixture();
  assert.equal(resolveDeclaredSdkRevision(input.packageJson, input.packageLock), revision);
});

test("accepts the expected GitHub repository over Git+HTTPS", () => {
  const input = fixture({ resolved: `git+https://github.com/Powerpunch777/sps-plugin-sdk.git#${revision}` });
  assert.equal(resolveDeclaredSdkRevision(input.packageJson, input.packageLock), revision);
});

test("rejects mismatched manifest and lockfile pins", () => {
  const input = fixture({ lockSpec: `github:Powerpunch777/sps-plugin-sdk#${otherRevision}` });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /pins must match exactly/);
});

test("rejects an SDK branch or unpinned GitHub dependency", () => {
  const input = fixture({ manifestSpec: "github:Powerpunch777/sps-plugin-sdk#main" });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /exact GitHub commit pin/);
});

test("rejects an SDK tag instead of a full commit pin", () => {
  const input = fixture({ manifestSpec: "github:Powerpunch777/sps-plugin-sdk#v0.11.0" });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /exact GitHub commit pin/);
});

test("rejects a different repository in the declared pin", () => {
  const input = fixture({ manifestSpec: `github:someone-else/sps-plugin-sdk#${revision}` });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /exact GitHub commit pin/);
});

test("rejects a different repository in the resolved lock entry", () => {
  const input = fixture({ resolved: `git+ssh://git@github.com/someone-else/sps-plugin-sdk.git#${revision}` });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /expected GitHub repository/);
});

test("rejects a resolved commit that differs from the exact declared pin", () => {
  const input = fixture({ resolved: `git+https://github.com/Powerpunch777/sps-plugin-sdk.git#${otherRevision}` });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /does not match the declared pin/);
});

test("rejects a missing SDK lock entry", () => {
  const input = fixture({ includeSdkLockEntry: false });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /resolved is missing/);
});

test("rejects a missing root lock dependency pin", () => {
  const input = fixture();
  delete input.packageLock.packages[""].devDependencies["@sonparkserver/plugin-sdk"];
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /package-lock.json packages\[""\]\.devDependencies/);
});

test("rejects malformed resolved lock URLs", () => {
  const input = fixture({ resolved: `https://example.com/sps-plugin-sdk.git#${revision}` });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /expected GitHub repository/);
});

test("rejects the expected GitHub repository over plaintext HTTP", () => {
  const input = fixture({ resolved: `git+http://github.com/Powerpunch777/sps-plugin-sdk.git#${revision}` });
  assert.throws(() => resolveDeclaredSdkRevision(input.packageJson, input.packageLock), /expected GitHub repository/);
});
