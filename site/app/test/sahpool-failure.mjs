import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const sqlite = await sqlite3InitModule();
const original = FileSystemFileHandle.prototype.createSyncAccessHandle;
let failed = false;
FileSystemFileHandle.prototype.createSyncAccessHandle = function (...args) {
  if (!failed && !this.name.startsWith(".opfs-sahpool-sync-check")) {
    failed = true;
    return new Promise((_, reject) => setTimeout(() => reject(new DOMException("Injected access failure", "UnknownError")), 200));
  }
  return original.apply(this, args);
};
try {
  await sqlite.installOpfsSAHPoolVfs({ name: "piano-duet", directory: "/piano-duet-sqlite", preserveOnInitFailure: true });
  self.postMessage({ error: "The injected failure did not occur" });
} catch (error) {
  self.postMessage({ message: error.message });
} finally {
  FileSystemFileHandle.prototype.createSyncAccessHandle = original;
}
