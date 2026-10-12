// Lets the scripts import the mod's TypeScript files from Node: adds `.ts` to
// relative imports that have no extension, as the Claude Code engine does.
// Node 22.18 or newer strips the types itself.

export async function resolve(specifier, context, nextResolve) {
  if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context)
    } catch {
      // Not a .ts file: let Node resolve it as written.
    }
  }
  return nextResolve(specifier, context)
}
