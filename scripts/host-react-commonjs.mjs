// Bundle CommonJS-only transitive consumers against the same external Host React.
// No browser-global require shim or second bundled React instance is introduced.
export function hostReactCommonJs() {
  return {
    name: "builder-host-react-commonjs",
    setup(build) {
      build.onResolve({ filter: /^react$/ }, args => args.kind === "require-call"
        ? { path: "react", namespace: "builder-host-react" } : undefined);
      build.onLoad({ filter: /^react$/, namespace: "builder-host-react" }, () => ({
        contents: 'import * as HostReact from "react"; module.exports = HostReact;', loader: "js",
      }));
    },
  };
}
