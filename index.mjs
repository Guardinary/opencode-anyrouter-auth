import { createProvider } from "./lib/provider.mjs";

// AnyRouter's provider plugin. Site credentials, model keys and request
// adaptation live in lib/provider.mjs and lib/site-client.mjs; this entry only
// exposes magpie's server entry; its hooks follow the OpenCode plugin style.
async function plugin(input = {}, options = {}) {
  return createProvider(input, options);
}

export default { id: "opencode-anyrouter-auth", server: plugin };
