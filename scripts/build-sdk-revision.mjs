const SDK_PACKAGE = "@sonparkserver/plugin-sdk";
const SDK_PACKAGE_PATH = "node_modules/@sonparkserver/plugin-sdk";
const SDK_GITHUB_SPEC = /^github:Powerpunch777\/sps-plugin-sdk#([0-9a-f]{40})$/;
const SDK_GITHUB_RESOLVED = /^(?:git\+)?(?:https|ssh):\/\/(?:git@)?github\.com\/Powerpunch777\/sps-plugin-sdk(?:\.git)?#([0-9a-f]{40})$/;

function objectAt(value, key) {
  return value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
}

function requiredPin(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is missing.`);
  const match = SDK_GITHUB_SPEC.exec(value);
  if (!match) throw new Error(`${label} must be an exact GitHub commit pin for Powerpunch777/sps-plugin-sdk.`);
  return match[1];
}

/** Resolve a truthful SDK revision from matching package.json and package-lock.json pins. */
export function resolveDeclaredSdkRevision(packageJson, packageLock) {
  const manifestSpec = objectAt(objectAt(packageJson, "devDependencies"), SDK_PACKAGE);
  const manifestRevision = requiredPin(manifestSpec, `package.json devDependencies.${SDK_PACKAGE}`);

  const rootLockPackage = objectAt(objectAt(packageLock, "packages"), "");
  const lockSpec = objectAt(objectAt(rootLockPackage, "devDependencies"), SDK_PACKAGE);
  const lockRevision = requiredPin(lockSpec, `package-lock.json packages[""].devDependencies.${SDK_PACKAGE}`);
  if (lockSpec !== manifestSpec || lockRevision !== manifestRevision) {
    throw new Error("package.json and package-lock.json SDK pins must match exactly.");
  }

  const sdkLockEntry = objectAt(objectAt(packageLock, "packages"), SDK_PACKAGE_PATH);
  const resolved = objectAt(sdkLockEntry, "resolved");
  if (typeof resolved !== "string") {
    throw new Error(`package-lock.json packages["${SDK_PACKAGE_PATH}"].resolved is missing.`);
  }
  const resolvedMatch = SDK_GITHUB_RESOLVED.exec(resolved);
  if (!resolvedMatch) {
    throw new Error(`package-lock.json packages["${SDK_PACKAGE_PATH}"].resolved must reference the expected GitHub repository and a full commit SHA.`);
  }
  if (resolvedMatch[1] !== manifestRevision) {
    throw new Error("The SDK resolved commit in package-lock.json does not match the declared pin.");
  }

  return manifestRevision;
}
