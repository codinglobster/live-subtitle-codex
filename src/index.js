import { register } from "./sub-provider";
import { transcribeCurrentMedia } from "./transcribe";

const { core, sidebar, console, menu, event } = iina;

console.log("Plugin is running");

menu.addItem(
  menu.item(
    "Show Sidebar",
    () => {
      sidebar.show();
    },
    { keyBinding: "Meta+p" },
  ),
);

menu.addItem(
  menu.item("Transcribe Current Media", () => {
    sidebar.show();
    sidebar.postMessage("ai-filename", { name: core.status.title || "" });
  }),
);

event.on("iina.window-loaded", () => {
  sidebar.loadFile("sidebar.html");

  const updateProgress = (message) => {
    core.osd(message);
    sidebar.postMessage("ai-progress", { message });
  };

  sidebar.onMessage("ai-sidebar-ready", () => {
    console.log("AI sidebar ready");
  });

  sidebar.onMessage("ai-fill-filename", () => {
    sidebar.postMessage("ai-filename", { name: core.status.title || "" });
  });

  sidebar.onMessage("ai-transcribe", async () => {
    try {
      const result = await transcribeCurrentMedia(updateProgress);
      core.osd("AI subtitles loaded");
      sidebar.postMessage("ai-result", { ok: true, result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      sidebar.postMessage("ai-result", { ok: false, error: message });
    }
  });
});

register();
