// RID -> { filename, savedAt } cache in chrome.storage.local (the extension equivalent of
// .cache/recordings.tsv). Semantics match the shell script:
//   - key is the RID, or the full URL if the URL has no rid
//   - strictly 1:1: saving replaces any existing entry for the key, and if another
//     key already points at the same filename (that file was just overwritten) that
//     entry is dropped.

const KEY = "recordings";

export async function getAll() {
  return (await chrome.storage.local.get(KEY))[KEY] || {};
}

export async function put(key, filename) {
  const all = await getAll();
  for (const [k, v] of Object.entries(all)) if (k !== key && v.filename === filename) delete all[k];
  all[key] = { filename, savedAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: all });
}

export async function remove(key) {
  const all = await getAll();
  delete all[key];
  await chrome.storage.local.set({ [KEY]: all });
}
