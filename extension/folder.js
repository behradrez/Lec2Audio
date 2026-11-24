// Full-tab page for picking the output folder / re-granting access. Pickers and
// permission prompts are unreliable inside a popup (it closes when focus moves).

import { getFolder, setFolder, folderPermission } from "./lib/folder.js";

const $ = (id) => document.getElementById(id);

function say(text, kind = "") {
  $("message").hidden = !text;
  $("message").textContent = text;
  $("message").className = "message " + kind;
}

async function render() {
  const h = await getFolder();
  const perm = await folderPermission(h);
  $("current").textContent = !h
    ? "No folder chosen yet."
    : perm === "granted"
      ? `Current folder: ${h.name}`
      : `Current folder: ${h.name} (access needed — click “Re-grant access”)`;
  $("choose").textContent = h ? "Change folder…" : "Choose folder…";
  $("grant").hidden = !h || perm === "granted";
}

$("choose").onclick = async () => {
  try {
    const h = await window.showDirectoryPicker({ id: "lec2mp3", mode: "readwrite", startIn: "documents" });
    await setFolder(h);
    say(`Saved. Recordings will go to “${h.name}”. You can close this tab.`, "ok");
  } catch (e) {
    if (e.name !== "AbortError") say(String(e), "err");
  }
  await render();
};

$("grant").onclick = async () => {
  const h = await getFolder();
  try {
    const p = await h.requestPermission({ mode: "readwrite" });
    say(p === "granted" ? "Access granted. You can close this tab." : "Access was not granted.", p === "granted" ? "ok" : "err");
  } catch (e) {
    say(String(e), "err");
  }
  await render();
};

render();
