// Chrome extensions can't reveal a folder in Finder, so "Play" opens the saved MP3 here.
import { getFolder, folderPermission } from "./lib/folder.js";

const $ = (id) => document.getElementById(id);
const name = new URLSearchParams(location.search).get("name") || "";
$("name").textContent = name;

function say(text) {
  $("message").hidden = !text;
  $("message").textContent = text;
}

async function play() {
  const dir = await getFolder();
  if (!dir) return say("No output folder is set.");
  if ((await folderPermission(dir, "read")) !== "granted") {
    $("grant").hidden = false;
    return say("Chrome needs your permission to read the folder again.");
  }
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    const audio = $("audio");
    audio.src = URL.createObjectURL(file);
    audio.hidden = false;
    $("grant").hidden = true;
    say("");
  } catch {
    say("That file is no longer in the output folder.");
  }
}

$("grant").onclick = async () => {
  const dir = await getFolder();
  await dir.requestPermission({ mode: "read" });
  play();
};

play();
