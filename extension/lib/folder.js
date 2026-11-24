// Output-folder handling: the FileSystemDirectoryHandle is persisted in IndexedDB
// (handles are structured-cloneable) and shared by the popup, the folder/player pages
// and the offscreen document, which all live on the same extension origin.

const DB = "lec2mp3";
const STORE = "kv";
const KEY = "dirHandle";

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const getFolder = () => tx("readonly", (s) => s.get(KEY));
export const setFolder = (handle) => tx("readwrite", (s) => s.put(handle, KEY));

/** "granted" | "prompt" | "denied" | "none" */
export async function folderPermission(handle, mode = "readwrite") {
  if (!handle) return "none";
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "denied";
  }
}

/** true / false, or null if the folder can't be read right now. */
export async function fileExists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    return e?.name === "NotFoundError" ? false : null;
  }
}

/** Make a safe `.mp3` filename (no path separators), like the script's `.mp3` rule. */
export function normalizeFilename(name) {
  let n = (name || "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^\.+/, "");
  if (!n) return "";
  if (!/\.mp3$/i.test(n)) n += ".mp3";
  return n;
}
