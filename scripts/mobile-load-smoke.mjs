import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";

const requireFromProject = createRequire(import.meta.url);
class ObsidianStub {}

const obsidian = {
  App: ObsidianStub,
  FileSystemAdapter: ObsidianStub,
  FuzzySuggestModal: ObsidianStub,
  MarkdownView: ObsidianStub,
  Modal: ObsidianStub,
  Notice: ObsidianStub,
  Platform: { isDesktopApp: false, isMobile: true },
  Plugin: ObsidianStub,
  PluginSettingTab: ObsidianStub,
  Setting: ObsidianStub,
  htmlToMarkdown: () => "",
  requestUrl: async () => {
    throw new Error("Network access is unavailable in the load test");
  },
};

const bundle = await readFile(
  new URL("../main.js", import.meta.url),
  "utf8",
);
const module = { exports: {} };

vm.runInNewContext(bundle, {
  AbortController,
  URL,
  clearTimeout,
  console,
  exports: module.exports,
  module,
  require(id) {
    if (id === "obsidian") return obsidian;
    if (id.startsWith("node:")) {
      throw new Error(`Mobile bundle loaded Node module at startup: ${id}`);
    }
    return requireFromProject(id);
  },
  setTimeout,
});

if (
  !module.exports ||
  typeof module.exports !== "object" ||
  typeof module.exports.default !== "function"
) {
  throw new Error("Mobile bundle did not export the Onward plugin");
}

console.log("Mobile bundle loaded without Node built-ins");
